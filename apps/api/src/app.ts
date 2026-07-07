import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { PrismaLike } from './db/prisma.js';
import { registerAdminAuth } from './plugins/adminAuth.js';
import { adminRoutes } from './routes/admin.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { cleanupExpiredActivityLogs } from './services/activityLogService.js';
import { HttpLiteLlmAdminClient, type LiteLlmAdminClient } from './services/litellmAdminClient.js';

export async function buildApp(
  env: Env,
  prisma: PrismaLike,
  litellmAdmin: LiteLlmAdminClient = new HttpLiteLlmAdminClient(env),
) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: false });
  registerJsonParser(app);
  registerAdminAuth(app, env);

  await app.register(healthRoutes);
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.register(async (scoped) => adminRoutes(scoped, prisma, env, litellmAdmin), {
    prefix: '/admin',
  });
  await app.register(async (scoped) => ingestRoutes(scoped, prisma, env), { prefix: '/ingest' });
  registerActivityLogCleanup(app, prisma, env);

  app.setErrorHandler((error: FastifyError & { issues?: unknown }, _request, reply) => {
    if (error.issues) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed.',
          recovery: 'Review the highlighted fields and retry.',
          retryable: false,
          details: error.issues,
        },
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The admin API could not complete the request.',
        recovery: 'Check server logs, then retry the operation.',
        retryable: true,
      },
    });
  });

  return app;
}

function registerActivityLogCleanup(app: FastifyInstance, prisma: PrismaLike, env: Env) {
  if (!env.PROMPT_LOG_CLEANUP_ENABLED) return;

  const runCleanup = () => {
    cleanupExpiredActivityLogs(prisma).catch((error) => {
      app.log.warn({ error }, 'activity log retention cleanup failed');
    });
  };
  const timer = setInterval(runCleanup, 24 * 60 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

function registerJsonParser(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (!body) {
      done(null, {});
      return;
    }

    try {
      const rawBody = typeof body === 'string' ? body : body.toString('utf8');
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}
