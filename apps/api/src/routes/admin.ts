import { Prisma, UsageStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { PrismaLike } from '../db/prisma.js';
import { monthWindow } from '../services/budgetService.js';
import {
  activityLogStatus,
  cleanupExpiredActivityLogs,
  createActivityLog,
  getActivityLogDetail,
  listActivityLogs,
  normalizeLiteLlmActivity,
  slugify,
  summarizeActivityLogs,
  type ActivityLogFilters,
} from '../services/activityLogService.js';
import type { LiteLlmAdminClient } from '../services/litellmAdminClient.js';
import {
  aggregateLiteLlmUsage,
  groupLiteLlmUsage,
  normalizeLiteLlmSpendLog,
  type LiteLlmUsageRecord,
} from '../services/litellmUsageService.js';
import {
  buildLiteLlmModelPayload,
  checkOpenAiCompatibleProvider,
  renderLiteLlmModelConfig,
  type ProviderModelTarget,
} from '../services/providerRegistry.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
  secretLast4,
} from '../services/providerSecrets.js';
import { hashApiKey, keyPrefix } from '../utils/apiKey.js';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.string().min(1).default('developer'),
  team: z
    .object({
      slug: z.string().min(1),
      name: z.string().min(1),
    })
    .optional(),
});

const createKeySchema = z.object({
  userId: z.string().min(1),
  teamId: z.string().min(1).optional(),
  name: z.string().min(1).default('default'),
  defaultProjectId: z.string().min(1).optional(),
  maxBudget: z.number().positive().optional(),
  budgetDuration: z.string().min(1).optional(),
  tpmLimit: z.number().int().positive().optional(),
  rpmLimit: z.number().int().positive().optional(),
});

const usageQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  source: z.enum(['litellm', 'local']).default('litellm'),
});

const usageMaxDays = 90;
const usageLogLimit = 2_000;
const modelAliasPattern = /^[a-z0-9][a-z0-9.-]*$/;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

const createBudgetSchema = z.object({
  userId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  monthlyTokenLimit: z.number().int().positive().optional(),
  monthlyCostLimit: z.number().positive().optional(),
});

const activityLogQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  keyAlias: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  status: z.nativeEnum(UsageStatus).optional(),
  clientName: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  teamId: z.string().min(1).optional().nullable(),
  description: z.string().min(1).optional().nullable(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  teamId: z.string().min(1).optional().nullable(),
  description: z.string().min(1).optional().nullable(),
});

const createProviderSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  authType: z.enum(['api_key', 'none']).default('api_key'),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
});

const updateProviderSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  authType: z.enum(['api_key', 'none']).optional(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  syncAliases: z.boolean().default(false),
});

const rotateProviderKeySchema = z.object({
  apiKey: z.string().min(1),
  syncAliases: z.boolean().default(true),
});

const createModelAliasSchema = z.object({
  alias: z.string().min(1).regex(modelAliasPattern),
  providerId: z.string().min(1),
  upstreamModel: z.string().min(1),
  description: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  syncToLiteLlm: z.boolean().default(true),
});

type StructuredError = {
  code: string;
  message: string;
  recovery: string;
  retryable: boolean;
  details?: unknown;
};

type OperationStatus = 'running' | 'success' | 'failed';

type AdminOperationRecord = {
  id: string;
  type: string;
  targetType: string;
  targetId: string;
  targetLabel: string | null;
  status: OperationStatus | string;
  result?: unknown;
  error?: unknown;
  startedAt: Date;
  finishedAt?: Date | null;
};

type UsageContextUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  teamId?: string | null;
};

type UsageContextTeam = {
  id: string;
  slug: string;
  name: string;
};

type UsageContextKey = {
  id: string;
  prefix: string;
  litellmKeyAlias?: string | null;
  litellmKeyId?: string | null;
  name: string;
  status: string;
  userId: string;
  teamId?: string | null;
  lastUsedAt?: Date | string | null;
  revokedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

type UsageContextBudget = {
  userId?: string | null;
  teamId?: string | null;
  monthlyTokenLimit?: number | null;
  monthlyCostLimit?: Prisma.Decimal | string | number | null;
};

const sectionRecovery: Record<string, string> = {
  users: 'Check the admin database connection and retry users.',
  providers: 'Check the provider registry database and retry providers.',
  aliases: 'Check provider registry aliases and retry aliases.',
  keys: 'Check LiteLLM key metadata and retry keys.',
  usage: 'Check LiteLLM spend logs or local ingest records and retry usage.',
};

const updateModelAliasSchema = z.object({
  alias: z.string().min(1).regex(modelAliasPattern).optional(),
  providerId: z.string().min(1).optional(),
  upstreamModel: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  syncToLiteLlm: z.boolean().default(true),
});

export async function adminRoutes(
  app: FastifyInstance,
  prisma: PrismaLike,
  env: Env,
  litellmAdmin: LiteLlmAdminClient,
) {
  app.addHook('onRequest', app.verifyAdmin);

  app.get('/client-config', async () => ({
    openaiBaseUrl: getOpenAiBaseUrl(env),
    defaultModel: 'code-premium',
  }));

  app.get('/dashboard/:section', async (request, reply) => {
    const params = z
      .object({ section: z.enum(['users', 'providers', 'aliases', 'keys', 'usage']) })
      .parse(request.params);
    const query = listQuerySchema.parse(request.query);
    const started = Date.now();

    try {
      if (params.section === 'users') {
        return withMeta(await listUsers(prisma, query), 'database', started);
      }
      if (params.section === 'providers') {
        return withMeta(await listProviders(prisma, query), 'provider-registry', started);
      }
      if (params.section === 'aliases') {
        return withMeta(await listAliases(prisma, query), 'provider-registry', started);
      }
      if (params.section === 'keys') {
        return withMeta(await listKeys(prisma, query), 'database', started);
      }

      return withMeta(
        await getUsageSummary(prisma, litellmAdmin, boundedUsageQuery({ source: 'litellm' })),
        'litellm',
        started,
      );
    } catch (error) {
      return reply.code(502).send({
        error: structuredError(
          `${params.section.toUpperCase()}_LOAD_FAILED`,
          `${titleCase(params.section)} failed to load.`,
          sectionRecovery[params.section],
          true,
          error,
        ),
        meta: {
          section: params.section,
          loadedAt: new Date().toISOString(),
          source: params.section === 'usage' ? 'litellm' : 'database',
          stale: true,
          durationMs: Date.now() - started,
        },
      });
    }
  });

  app.get('/operations/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const operation = await findOperation(prisma, params.id);
    if (!operation) {
      return reply.code(404).send({
        error: structuredError(
          'OPERATION_NOT_FOUND',
          'Operation was not found.',
          'Refresh the dashboard and retry the action if needed.',
          false,
        ),
      });
    }

    return operation;
  });

  app.get('/audit-events', async (request) => {
    return listAuditEvents(prisma, listQuerySchema.parse(request.query));
  });

  app.get('/activity-logs/status', async () => activityLogStatus(env));

  app.get('/activity-logs/summary', async (request) => {
    const query = boundedActivityQuery(
      activityLogQuerySchema.omit({ limit: true, cursor: true }).parse(request.query),
    );
    await recordAuditEvent(prisma, {
      action: 'activity_log.list',
      targetType: 'activity_log',
      result: 'success',
      message: 'Activity log summary viewed.',
      metadata: { filters: query },
    });
    return summarizeActivityLogs(prisma, query);
  });

  app.get('/activity-logs', async (request) => {
    const query = boundedActivityQuery(activityLogQuerySchema.parse(request.query));
    await recordAuditEvent(prisma, {
      action: 'activity_log.list',
      targetType: 'activity_log',
      result: 'success',
      message: 'Activity logs listed.',
      metadata: { filters: query },
    });
    return listActivityLogs(prisma, query);
  });

  app.get('/activity-logs/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!env.PROMPT_LOGS_ENABLED) {
      await recordAuditEvent(prisma, {
        action: 'activity_log.disabled_access_attempt',
        targetType: 'activity_log',
        targetId: params.id,
        result: 'blocked',
        message: 'Activity log detail requested while prompt logs are disabled.',
      });
    }

    const detail = await getActivityLogDetail(prisma, params.id, env);
    if (!detail) {
      return reply.code(404).send({
        error: structuredError(
          'ACTIVITY_LOG_NOT_FOUND',
          'Activity log was not found.',
          'Refresh activity logs and retry.',
          false,
        ),
      });
    }

    if (env.PROMPT_LOG_AUDIT_DETAIL_VIEW) {
      await recordAuditEvent(prisma, {
        action: 'activity_log.view_detail',
        targetType: 'activity_log',
        targetId: params.id,
        targetLabel: detail.requestId ?? detail.id,
        result: 'success',
        message: 'Activity log detail viewed.',
        metadata: {
          userId: detail.userId,
          teamId: detail.teamId,
          projectId: detail.projectId,
          model: detail.model,
          contentAvailable: detail.contentAvailable,
        },
      });
      if (detail.contentAvailable.fullPrompt) {
        await recordAuditEvent(prisma, {
          action: 'activity_log.view_full_prompt',
          targetType: 'activity_log',
          targetId: params.id,
          targetLabel: detail.requestId ?? detail.id,
          result: 'success',
          message: 'Full prompt viewed.',
          metadata: {
            userId: detail.userId,
            teamId: detail.teamId,
            projectId: detail.projectId,
            model: detail.model,
          },
        });
      }
    }

    return detail;
  });

  app.post('/activity-logs/cleanup-expired', async () => {
    const result = await cleanupExpiredActivityLogs(prisma);
    await recordAuditEvent(prisma, {
      action: 'activity_log.retention_cleanup',
      targetType: 'activity_log',
      result: 'success',
      message: `Deleted ${result.deleted} expired activity logs.`,
      metadata: result,
    });
    return result;
  });

  app.post('/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const project = await prisma.project.create({
      data: {
        name: input.name,
        slug: input.slug ?? slugify(input.name),
        teamId: input.teamId ?? null,
        description: input.description ?? null,
      },
    });
    return reply.code(201).send(project);
  });

  app.get('/projects', async (request) => {
    const query = listQuerySchema.parse(request.query);
    return paginate(
      await prisma.project.findMany({
        include: { team: { select: { id: true, slug: true, name: true } } },
        ...cursorPage(query),
      }),
      query.limit,
    );
  });

  app.patch('/projects/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateProjectSchema.parse(request.body);
    const existing = await prisma.project.findUnique({ where: { id: params.id } });
    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'PROJECT_NOT_FOUND',
          'Project was not found.',
          'Refresh projects and retry.',
          false,
        ),
      });
    }

    return prisma.project.update({
      where: { id: params.id },
      data: {
        name: input.name,
        slug: input.slug,
        teamId: input.teamId,
        description: input.description,
      },
    });
  });

  app.delete('/projects/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const existing = await prisma.project.findUnique({ where: { id: params.id } });
    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'PROJECT_NOT_FOUND',
          'Project was not found.',
          'Refresh projects and retry.',
          false,
        ),
      });
    }

    await prisma.apiKey.updateMany({
      where: { defaultProjectId: params.id },
      data: { defaultProjectId: null },
    });
    await prisma.project.delete({ where: { id: params.id } });
    return { id: params.id, deleted: true };
  });

  app.post('/users', async (request, reply) => {
    const input = createUserSchema.parse(request.body);
    const team =
      input.team &&
      (await prisma.team.upsert({
        where: { slug: input.team.slug },
        update: { name: input.team.name },
        create: input.team,
      }));

    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        teamId: team?.id,
      },
      include: { team: true },
    });

    return reply.code(201).send(user);
  });

  app.get('/users', async (request) => listUsers(prisma, listQuerySchema.parse(request.query)));

  app.post('/keys', async (request, reply) => {
    const input = createKeySchema.parse(request.body);
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      include: { team: true },
    });

    if (!user) {
      return reply.code(404).send({
        error: structuredError(
          'USER_NOT_FOUND',
          'Developer was not found.',
          'Refresh developers and retry issuing the key.',
          false,
        ),
      });
    }

    const teamId = input.teamId ?? user.teamId;
    const alias = `tlg_${randomUUID()}`;
    const virtualKeyInput = {
      alias,
      userId: user.id,
      teamId,
      ownerName: user.name,
      ownerEmail: user.email,
      role: user.role,
      budget: {
        maxBudget: input.maxBudget ?? env.DEFAULT_KEY_MAX_BUDGET,
        budgetDuration: input.budgetDuration ?? env.DEFAULT_KEY_BUDGET_DURATION,
        tpmLimit: input.tpmLimit ?? env.DEFAULT_KEY_TPM_LIMIT,
        rpmLimit: input.rpmLimit ?? env.DEFAULT_KEY_RPM_LIMIT,
      },
    };

    await litellmAdmin.ensureUser(virtualKeyInput);
    await litellmAdmin.ensureTeam(virtualKeyInput);
    const virtualKey = await litellmAdmin.createVirtualKey(virtualKeyInput);
    const litellmKeyAlias = virtualKey.keyAlias ?? alias;

    let key;
    try {
      key = await prisma.apiKey.create({
        data: {
          prefix: keyPrefix(virtualKey.key),
          keyHash: hashApiKey(virtualKey.key, env.API_KEY_PEPPER),
          litellmKeyAlias,
          litellmKeyId: virtualKey.tokenId,
          name: input.name,
          userId: input.userId,
          teamId,
          defaultProjectId: input.defaultProjectId,
        },
        select: {
          id: true,
          prefix: true,
          litellmKeyAlias: true,
          litellmKeyId: true,
          name: true,
          status: true,
          userId: true,
          teamId: true,
          defaultProjectId: true,
          createdAt: true,
        },
      });
    } catch (error) {
      await litellmAdmin.revokeVirtualKey(litellmKeyAlias).catch((revokeError) => {
        app.log.error({ revokeError, litellmKeyAlias }, 'failed to clean up LiteLLM key');
      });
      throw error;
    }

    return reply.code(201).send({ ...key, apiKey: virtualKey.key });
  });

  app.get('/keys', async (request) => listKeys(prisma, listQuerySchema.parse(request.query)));

  app.post('/keys/:id/revoke', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const existing = await prisma.apiKey.findUnique({
      where: { id: params.id },
      include: { user: true, team: true },
    });

    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'KEY_NOT_FOUND',
          'Developer key was not found.',
          'Refresh developer keys and retry the revoke action.',
          false,
        ),
      });
    }

    const operation = await startOperation(prisma, {
      type: 'key.revoke',
      targetType: 'key',
      targetId: existing.id,
      targetLabel: existing.prefix,
    });

    try {
      if (existing.litellmKeyAlias) {
        await litellmAdmin.revokeVirtualKey(existing.litellmKeyAlias);
      }

      const key = await prisma.apiKey.update({
        where: { id: params.id },
        data: { status: 'revoked', revokedAt: new Date() },
        select: {
          id: true,
          prefix: true,
          status: true,
          revokedAt: true,
          userId: true,
          teamId: true,
        },
      });
      const result = {
        key,
        revoked: true,
        message: `Developer key revoked: ${existing.prefix}.`,
        recovery: 'Issue a new developer key if this access is still needed.',
      };
      const completedOperation = await finishOperation(prisma, operation, 'success', result);
      await recordAuditEvent(prisma, {
        action: 'key.revoke',
        targetType: 'key',
        targetId: existing.id,
        targetLabel: existing.prefix,
        result: 'success',
        message: result.message,
        metadata: { userId: existing.userId, teamId: existing.teamId },
      });

      return reply.send({
        ...key,
        revoked: true,
        operation: completedOperation,
        message: result.message,
        recovery: result.recovery,
      });
    } catch (error) {
      const structured = structuredError(
        'KEY_REVOKE_FAILED',
        `Developer key revoke failed: ${existing.prefix}.`,
        'Check LiteLLM key state and retry. If the key was already revoked upstream, refresh keys.',
        true,
        error,
      );
      const failedOperation = await finishOperation(prisma, operation, 'failed', structured);
      await recordAuditEvent(prisma, {
        action: 'key.revoke',
        targetType: 'key',
        targetId: existing.id,
        targetLabel: existing.prefix,
        result: 'failed',
        message: structured.message,
        metadata: structured,
      });
      return reply.code(502).send({ error: structured, operation: failedOperation });
    }
  });

  app.get('/usage', async (request) => {
    const query = boundedUsageQuery(usageQuerySchema.parse(request.query));
    return getUsageSummary(prisma, litellmAdmin, query);
  });

  app.get('/usage/by-user', async (request) => {
    const query = boundedUsageQuery(usageQuerySchema.parse(request.query));
    if (query.source === 'litellm') {
      return groupLiteLlmUsage(await getLiteLlmUsage(litellmAdmin, query), 'userId');
    }

    const rows = await prisma.usageRecord.groupBy({
      by: ['userId'],
      where: usageWhere(query),
      _count: { _all: true },
      _sum: aggregateSums(),
    });

    return rows.map(formatAggregateRow('userId'));
  });

  app.get('/usage/by-model', async (request) => {
    const query = boundedUsageQuery(usageQuerySchema.parse(request.query));
    if (query.source === 'litellm') {
      return groupLiteLlmUsage(await getLiteLlmUsage(litellmAdmin, query), 'model');
    }

    const rows = await prisma.usageRecord.groupBy({
      by: ['model'],
      where: usageWhere(query),
      _count: { _all: true },
      _sum: aggregateSums(),
    });

    return rows.map(formatAggregateRow('model'));
  });

  app.post('/budgets', async (request, reply) => {
    const input = createBudgetSchema.parse(request.body);

    if (!input.userId && !input.teamId) {
      return reply.code(400).send({
        error: structuredError(
          'BUDGET_OWNER_REQUIRED',
          'Budget owner is required.',
          'Choose either a developer or a team, then retry.',
          false,
        ),
      });
    }

    const budget = await prisma.budgetLimit.create({
      data: {
        userId: input.userId,
        teamId: input.teamId,
        monthlyTokenLimit: input.monthlyTokenLimit,
        monthlyCostLimit:
          input.monthlyCostLimit == null ? undefined : new Prisma.Decimal(input.monthlyCostLimit),
      },
    });

    return reply
      .code(201)
      .send({ ...budget, monthlyCostLimit: decimalToString(budget.monthlyCostLimit) });
  });

  app.get('/budgets', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const budgets = await prisma.budgetLimit.findMany({
      ...cursorPage(query),
    });

    return paginate(budgets, query.limit, (budget) => ({
      ...budget,
      monthlyCostLimit: decimalToString(budget.monthlyCostLimit),
    }));
  });

  app.post('/providers', async (request, reply) => {
    const input = createProviderSchema.parse(request.body);

    if (input.authType === 'api_key' && !input.apiKey) {
      return reply.code(400).send({
        error: structuredError(
          'PROVIDER_API_KEY_REQUIRED',
          'Provider API key is required.',
          'Enter a provider API key or choose auth type none.',
          false,
        ),
      });
    }

    const provider = await prisma.provider.create({
      data: {
        slug: input.slug,
        name: input.name,
        baseUrl: input.baseUrl.replace(/\/$/, ''),
        authType: input.authType,
        encryptedApiKey: input.apiKey
          ? encryptProviderSecret(input.apiKey, env.PROVIDER_SECRET_KEY)
          : undefined,
        apiKeyLast4: input.apiKey ? secretLast4(input.apiKey) : undefined,
        enabled: input.enabled,
      },
      select: providerSelect(),
    });

    return reply.code(201).send(provider);
  });

  app.get('/providers', async (request) =>
    listProviders(prisma, listQuerySchema.parse(request.query)),
  );

  app.patch('/providers/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateProviderSchema.parse(request.body);
    const existing = await prisma.provider.findUnique({ where: { id: params.id } });

    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'PROVIDER_NOT_FOUND',
          'Provider was not found.',
          'Refresh providers and retry the update.',
          false,
        ),
      });
    }

    const nextAuthType = input.authType ?? existing.authType;
    if (nextAuthType === 'api_key' && !input.apiKey && !existing.encryptedApiKey) {
      return reply.code(400).send({
        error: structuredError(
          'PROVIDER_API_KEY_REQUIRED',
          'Provider API key is required.',
          'Enter a provider API key or choose auth type none.',
          false,
        ),
      });
    }

    const provider = await prisma.provider.update({
      where: { id: params.id },
      data: {
        slug: input.slug,
        name: input.name,
        baseUrl: input.baseUrl?.replace(/\/$/, ''),
        authType: input.authType,
        encryptedApiKey:
          input.authType === 'none'
            ? null
            : input.apiKey
              ? encryptProviderSecret(input.apiKey, env.PROVIDER_SECRET_KEY)
              : undefined,
        apiKeyLast4:
          input.authType === 'none' ? null : input.apiKey ? secretLast4(input.apiKey) : undefined,
        enabled: input.enabled,
      },
      select: providerSelect(),
    });

    if (input.syncAliases && provider.enabled) {
      await syncProviderAliases(prisma, litellmAdmin, provider.id, env.PROVIDER_SECRET_KEY);
    }

    return reply.send(provider);
  });

  app.post('/providers/:id/rotate-key', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = rotateProviderKeySchema.parse(request.body);
    const existing = await prisma.provider.findUnique({ where: { id: params.id } });

    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'PROVIDER_NOT_FOUND',
          'Provider was not found.',
          'Refresh providers and retry key rotation.',
          false,
        ),
      });
    }

    const operation = await startOperation(prisma, {
      type: 'provider.rotate_key',
      targetType: 'provider',
      targetId: existing.id,
      targetLabel: existing.slug,
    });

    try {
      const provider = await prisma.provider.update({
        where: { id: params.id },
        data: {
          authType: 'api_key',
          encryptedApiKey: encryptProviderSecret(input.apiKey, env.PROVIDER_SECRET_KEY),
          apiKeyLast4: secretLast4(input.apiKey),
        },
        select: providerSelect(),
      });

      const syncedAliases =
        input.syncAliases && provider.enabled
          ? await syncProviderAliases(prisma, litellmAdmin, provider.id, env.PROVIDER_SECRET_KEY)
          : 0;
      const result = {
        provider,
        rotated: true,
        syncedAliases,
        message: `Provider key rotated: ${provider.slug}. ${syncedAliases} aliases synced.`,
        recovery: 'If traffic fails, rotate back to a working key and run provider health check.',
      };
      const completedOperation = await finishOperation(prisma, operation, 'success', result);
      await recordAuditEvent(prisma, {
        action: 'provider.rotate_key',
        targetType: 'provider',
        targetId: provider.id,
        targetLabel: provider.slug,
        result: 'success',
        message: result.message,
        metadata: { syncedAliases },
      });

      return reply.send({
        ...provider,
        rotated: true,
        syncedAliases,
        operation: completedOperation,
        message: result.message,
        recovery: result.recovery,
      });
    } catch (error) {
      const structured = structuredError(
        'PROVIDER_ROTATE_KEY_FAILED',
        `Provider key rotation failed: ${existing.slug}.`,
        'Verify the new provider key and retry. Existing provider settings may still be in effect.',
        true,
        error,
      );
      const failedOperation = await finishOperation(prisma, operation, 'failed', structured);
      await recordAuditEvent(prisma, {
        action: 'provider.rotate_key',
        targetType: 'provider',
        targetId: existing.id,
        targetLabel: existing.slug,
        result: 'failed',
        message: structured.message,
        metadata: structured,
      });
      return reply.code(502).send({ error: structured, operation: failedOperation });
    }
  });

  app.delete('/providers/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const existing = await prisma.provider.findUnique({ where: { id: params.id } });

    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'PROVIDER_NOT_FOUND',
          'Provider was not found.',
          'Refresh providers and retry disable provider.',
          false,
        ),
      });
    }

    const operation = await startOperation(prisma, {
      type: 'provider.disable',
      targetType: 'provider',
      targetId: existing.id,
      targetLabel: existing.slug,
    });

    try {
      const affectedAliases = await prisma.modelAlias.updateMany({
        where: { providerId: params.id },
        data: { enabled: false },
      });
      const provider = await prisma.provider.update({
        where: { id: params.id },
        data: { enabled: false },
        select: providerSelect(),
      });
      const result = {
        provider,
        affectedAliases: affectedAliases.count,
        message: `Provider disabled: ${provider.slug}. ${affectedAliases.count} aliases were disabled.`,
        recovery: 'Re-enable or recreate the provider, then sync affected aliases.',
      };
      const completedOperation = await finishOperation(prisma, operation, 'success', result);
      await recordAuditEvent(prisma, {
        action: 'provider.disable',
        targetType: 'provider',
        targetId: provider.id,
        targetLabel: provider.slug,
        result: 'success',
        message: result.message,
        metadata: { affectedAliases: affectedAliases.count },
      });

      return reply.send({
        ...provider,
        deleted: false,
        disabled: true,
        affectedAliases: affectedAliases.count,
        operation: completedOperation,
        message: result.message,
        recovery: result.recovery,
      });
    } catch (error) {
      const structured = structuredError(
        'PROVIDER_DISABLE_FAILED',
        `Provider disable failed: ${existing.slug}.`,
        'Refresh providers and retry. Check aliases before sending traffic.',
        true,
        error,
      );
      const failedOperation = await finishOperation(prisma, operation, 'failed', structured);
      return reply.code(502).send({ error: structured, operation: failedOperation });
    }
  });

  app.get('/providers/:id/health', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const provider = await prisma.provider.findUnique({ where: { id: params.id } });

    if (!provider) {
      return reply.code(404).send({
        error: structuredError(
          'PROVIDER_NOT_FOUND',
          'Provider was not found.',
          'Refresh providers and retry health check.',
          false,
        ),
      });
    }

    const operation = await startOperation(prisma, {
      type: 'provider.health_check',
      targetType: 'provider',
      targetId: provider.id,
      targetLabel: provider.slug,
    });
    const apiKey = provider.encryptedApiKey
      ? decryptProviderSecret(provider.encryptedApiKey, env.PROVIDER_SECRET_KEY)
      : undefined;
    const health = await checkOpenAiCompatibleProvider({
      baseUrl: provider.baseUrl,
      apiKey,
    });
    const healthStatus = health.ok ? 'healthy' : 'unhealthy';

    await prisma.provider.update({
      where: { id: provider.id },
      data: { healthStatus, lastHealthAt: new Date() },
    });

    const result = {
      providerId: provider.id,
      providerSlug: provider.slug,
      healthStatus,
      health,
      message: `Provider health checked: ${provider.slug} is ${titleCase(healthStatus)}.`,
      recovery: health.ok
        ? 'No recovery needed.'
        : 'Verify provider endpoint, credentials, and /models compatibility, then retry.',
    };
    const completedOperation = await finishOperation(
      prisma,
      operation,
      health.ok ? 'success' : 'failed',
      result,
    );
    await recordAuditEvent(prisma, {
      action: 'provider.health_check',
      targetType: 'provider',
      targetId: provider.id,
      targetLabel: provider.slug,
      result: health.ok ? 'success' : 'failed',
      message: result.message,
      metadata: health,
    });

    return reply.code(health.ok ? 200 : 502).send({ ...result, operation: completedOperation });
  });

  app.post('/model-aliases', async (request, reply) => {
    const input = createModelAliasSchema.parse(request.body);
    const provider = await prisma.provider.findUnique({ where: { id: input.providerId } });

    if (!provider) {
      return reply.code(404).send({
        error: structuredError(
          'PROVIDER_NOT_FOUND',
          'Provider was not found.',
          'Refresh providers and retry creating the alias.',
          false,
        ),
      });
    }

    let alias = await prisma.modelAlias.create({
      data: {
        alias: input.alias,
        providerId: provider.id,
        upstreamModel: input.upstreamModel,
        description: input.description,
        enabled: input.enabled,
      },
      include: { provider: true },
    });

    if (input.syncToLiteLlm && alias.enabled && provider.enabled) {
      const target = aliasToTarget(alias, env.PROVIDER_SECRET_KEY);
      await litellmAdmin.upsertModel(buildLiteLlmModelPayload(target));
      alias = await markAliasSynced(prisma, alias.id);
    }

    return reply.code(201).send(formatModelAlias(alias));
  });

  app.get('/model-aliases', async (request) =>
    listAliases(prisma, listQuerySchema.parse(request.query)),
  );

  app.post('/model-aliases/sync-all', async () => {
    const aliases = await prisma.modelAlias.findMany({
      where: { enabled: true, provider: { enabled: true } },
      include: { provider: true },
      orderBy: { alias: 'asc' },
    });
    const results = [];

    for (const alias of aliases) {
      await syncAliasToLiteLlm(alias, litellmAdmin, env.PROVIDER_SECRET_KEY);
      const syncedAt = new Date();
      await prisma.modelAlias.update({
        where: { id: alias.id },
        data: { lastSyncedAt: syncedAt },
        include: { provider: true },
      });
      results.push({
        id: alias.id,
        alias: alias.alias,
        provider: alias.provider.slug,
        upstreamModel: alias.upstreamModel,
        synced: true,
        lastSyncedAt: syncedAt,
      });
    }

    await recordAuditEvent(prisma, {
      action: 'alias.sync_all',
      targetType: 'alias',
      result: 'success',
      message: `Synced ${results.length} model aliases to LiteLLM.`,
      metadata: { aliases: results.map((result) => result.alias) },
    });

    return {
      syncedAliases: results.length,
      aliases: results,
      message: `Synced ${results.length} model aliases to LiteLLM.`,
    };
  });

  app.patch('/model-aliases/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateModelAliasSchema.parse(request.body);
    const existing = await prisma.modelAlias.findUnique({ where: { id: params.id } });

    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'MODEL_ALIAS_NOT_FOUND',
          'Model alias was not found.',
          'Refresh model aliases and retry the update.',
          false,
        ),
      });
    }

    if (input.providerId) {
      const provider = await prisma.provider.findUnique({ where: { id: input.providerId } });
      if (!provider) {
        return reply.code(404).send({
          error: structuredError(
            'PROVIDER_NOT_FOUND',
            'Provider was not found.',
            'Refresh providers and retry the alias update.',
            false,
          ),
        });
      }
    }

    let alias = await prisma.modelAlias.update({
      where: { id: params.id },
      data: {
        alias: input.alias,
        providerId: input.providerId,
        upstreamModel: input.upstreamModel,
        description: input.description,
        enabled: input.enabled,
      },
      include: { provider: true },
    });

    if (input.syncToLiteLlm && alias.enabled && alias.provider.enabled) {
      await syncAliasToLiteLlm(alias, litellmAdmin, env.PROVIDER_SECRET_KEY);
      alias = await markAliasSynced(prisma, alias.id);
    }

    return reply.send(formatModelAlias(alias));
  });

  app.post('/model-aliases/:id/sync', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const alias = await prisma.modelAlias.findUnique({
      where: { id: params.id },
      include: { provider: true },
    });

    if (!alias) {
      return reply.code(404).send({
        error: structuredError(
          'MODEL_ALIAS_NOT_FOUND',
          'Model alias was not found.',
          'Refresh model aliases and retry sync alias.',
          false,
        ),
      });
    }

    if (!alias.enabled || !alias.provider.enabled) {
      return reply.code(400).send({
        error: structuredError(
          'MODEL_ALIAS_OR_PROVIDER_DISABLED',
          'Alias or provider is disabled.',
          'Re-enable the alias and provider before syncing.',
          false,
        ),
      });
    }

    const operation = await startOperation(prisma, {
      type: 'alias.sync',
      targetType: 'alias',
      targetId: alias.id,
      targetLabel: alias.alias,
    });

    try {
      const target = aliasToTarget(alias, env.PROVIDER_SECRET_KEY);
      await litellmAdmin.upsertModel(buildLiteLlmModelPayload(target));
      const syncedAlias = await markAliasSynced(prisma, alias.id);
      const result = {
        ...formatModelAlias(syncedAlias),
        synced: true,
        message: `Alias synced: ${alias.alias}.`,
        recovery: 'No recovery needed.',
      };
      const completedOperation = await finishOperation(prisma, operation, 'success', result);
      await recordAuditEvent(prisma, {
        action: 'alias.sync',
        targetType: 'alias',
        targetId: alias.id,
        targetLabel: alias.alias,
        result: 'success',
        message: result.message,
        metadata: { provider: alias.provider.slug, upstreamModel: alias.upstreamModel },
      });

      return reply.send({ ...result, operation: completedOperation });
    } catch (error) {
      const structured = structuredError(
        'ALIAS_SYNC_FAILED',
        `Alias sync failed: ${alias.alias}.`,
        'Check provider credentials and upstream model ID, then retry sync alias.',
        true,
        error,
      );
      const failedOperation = await finishOperation(prisma, operation, 'failed', structured);
      await recordAuditEvent(prisma, {
        action: 'alias.sync',
        targetType: 'alias',
        targetId: alias.id,
        targetLabel: alias.alias,
        result: 'failed',
        message: structured.message,
        metadata: structured,
      });
      return reply.code(502).send({ error: structured, operation: failedOperation });
    }
  });

  app.delete('/model-aliases/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const existing = await prisma.modelAlias.findUnique({ where: { id: params.id } });

    if (!existing) {
      return reply.code(404).send({
        error: structuredError(
          'MODEL_ALIAS_NOT_FOUND',
          'Model alias was not found.',
          'Refresh model aliases and retry disable alias.',
          false,
        ),
      });
    }

    const operation = await startOperation(prisma, {
      type: 'alias.disable',
      targetType: 'alias',
      targetId: existing.id,
      targetLabel: existing.alias,
    });
    const alias = await prisma.modelAlias.update({
      where: { id: params.id },
      data: { enabled: false },
      include: { provider: true },
    });

    const formatted = formatModelAlias(alias);
    const result = {
      alias: formatted,
      deleted: false,
      disabled: true,
      message: `Alias disabled: ${alias.alias}.`,
      recovery: 'Recreate or re-enable the alias and sync it to restore traffic.',
    };
    const completedOperation = await finishOperation(prisma, operation, 'success', result);
    await recordAuditEvent(prisma, {
      action: 'alias.disable',
      targetType: 'alias',
      targetId: alias.id,
      targetLabel: alias.alias,
      result: 'success',
      message: result.message,
      metadata: { providerId: alias.providerId },
    });

    return reply.send({
      ...formatted,
      deleted: false,
      disabled: true,
      operation: completedOperation,
      message: result.message,
      recovery: result.recovery,
    });
  });

  app.get('/litellm/model-config', async () => {
    const aliases = await prisma.modelAlias.findMany({
      where: { enabled: true, provider: { enabled: true } },
      include: { provider: true },
      orderBy: { alias: 'asc' },
    });

    return {
      source: 'control-plane-db',
      yaml: renderLiteLlmModelConfig(
        aliases.map((alias) => ({
          alias: alias.alias,
          providerSlug: alias.provider.slug,
          providerBaseUrl: alias.provider.baseUrl,
          providerAuthType: alias.provider.authType,
          upstreamModel: alias.upstreamModel,
          apiKey: alias.provider.apiKeyLast4 ? '<redacted>' : null,
          description: alias.description,
        })),
      ),
    };
  });

  app.get('/budgets/check/:userId', async (request) => {
    const params = z.object({ userId: z.string().min(1) }).parse(request.params);
    const { start, end } = monthWindow();
    const budget = await prisma.budgetLimit.findFirst({
      where: { userId: params.userId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    const usage = await prisma.usageRecord.aggregate({
      where: {
        userId: params.userId,
        timestamp: { gte: start, lt: end },
        status: UsageStatus.success,
      },
      _sum: { totalTokens: true, estimatedCost: true },
    });

    return {
      userId: params.userId,
      budget: budget && {
        ...budget,
        monthlyCostLimit: decimalToString(budget.monthlyCostLimit),
      },
      usage: {
        totalTokens: usage._sum.totalTokens ?? 0,
        estimatedCost: decimalToString(usage._sum.estimatedCost),
      },
    };
  });
}

function providerSelect() {
  return {
    id: true,
    slug: true,
    name: true,
    baseUrl: true,
    authType: true,
    apiKeyLast4: true,
    enabled: true,
    healthStatus: true,
    lastHealthAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

type ListQuery = z.infer<typeof listQuerySchema>;

function cursorPage(query: ListQuery) {
  return {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  };
}

function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  map: (row: T) => unknown = (row) => row,
) {
  const items = rows.slice(0, limit).map(map);
  return {
    items,
    nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
  };
}

async function listUsers(prisma: PrismaLike, query: ListQuery) {
  const rows = await prisma.user.findMany({
    include: { team: true },
    ...cursorPage(query),
  });
  return paginate(rows, query.limit);
}

async function listProviders(prisma: PrismaLike, query: ListQuery) {
  const rows = await prisma.provider.findMany({
    select: providerSelect(),
    ...cursorPage(query),
  });
  return paginate(rows, query.limit);
}

async function listAliases(prisma: PrismaLike, query: ListQuery) {
  const aliases = await prisma.modelAlias.findMany({
    include: { provider: true },
    ...cursorPage(query),
  });

  return paginate(aliases, query.limit, formatModelAlias);
}

async function listKeys(prisma: PrismaLike, query: ListQuery) {
  const keys = await prisma.apiKey.findMany({
    select: {
      id: true,
      prefix: true,
      litellmKeyAlias: true,
      litellmKeyId: true,
      name: true,
      status: true,
      userId: true,
      teamId: true,
      user: { select: { id: true, email: true, name: true, role: true } },
      team: { select: { id: true, slug: true, name: true } },
      defaultProjectId: true,
      defaultProject: { select: { id: true, name: true, slug: true, teamId: true } },
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
    ...cursorPage(query),
  });
  return paginate(keys, query.limit);
}

async function getUsageSummary(
  prisma: PrismaLike,
  litellmAdmin: LiteLlmAdminClient,
  query: { from?: string; to?: string; source?: 'litellm' | 'local' },
) {
  if ((query.source ?? 'litellm') === 'litellm') {
    const records = await getLiteLlmUsage(litellmAdmin, query);

    return {
      source: 'litellm',
      totals: aggregateLiteLlmUsage(records),
      byDay: dailyLiteLlmRollup(records),
      ...(await enrichedLiteLlmUsage(prisma, records)),
      rawDailyRollup: dailyLiteLlmRollup(records),
      byModel: groupLiteLlmUsage(records, 'model'),
      byKey: groupLiteLlmUsage(records, 'keyAlias'),
    };
  }

  const where = usageWhere(query);
  const [grouped, dailyRecords] = await Promise.all([
    prisma.usageRecord.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        estimatedCost: true,
      },
    }),
    prisma.usageRecord.findMany({
      where,
      select: {
        timestamp: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        estimatedCost: true,
      },
      orderBy: { timestamp: 'asc' },
      take: usageLogLimit + 1,
    }),
  ]);

  return {
    source: 'local',
    totals: rollup(grouped),
    byDay: dailyRollup(dailyRecords.slice(0, usageLogLimit)),
    dailyRollupTruncated: dailyRecords.length > usageLogLimit,
    byStatus: grouped.map((row) => ({
      status: row.status,
      requests: row._count._all,
      promptTokens: row._sum.promptTokens ?? 0,
      completionTokens: row._sum.completionTokens ?? 0,
      totalTokens: row._sum.totalTokens ?? 0,
      estimatedCost: decimalToString(row._sum.estimatedCost),
    })),
  };
}

function boundedUsageQuery(query: z.infer<typeof usageQuerySchema>) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.valueOf() - 30 * 24 * 60 * 60 * 1000);
  const durationDays = (to.valueOf() - from.valueOf()) / (24 * 60 * 60 * 1000);

  if (durationDays < 0 || durationDays > usageMaxDays) {
    throw new Error(`Usage range must be between 0 and ${usageMaxDays} days.`);
  }

  return { ...query, from: from.toISOString(), to: to.toISOString() };
}

function boundedActivityQuery<T extends { from?: string; to?: string }>(query: T) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.valueOf() - 30 * 24 * 60 * 60 * 1000);
  const durationDays = (to.valueOf() - from.valueOf()) / (24 * 60 * 60 * 1000);

  if (durationDays < 0 || durationDays > usageMaxDays) {
    throw new Error(`Activity range must be between 0 and ${usageMaxDays} days.`);
  }

  return { ...query, from: from.toISOString(), to: to.toISOString() };
}

function withMeta<T>(data: T, source: string, started: number) {
  return {
    data,
    meta: {
      loadedAt: new Date().toISOString(),
      source,
      stale: false,
      durationMs: Date.now() - started,
    },
  };
}

function structuredError(
  code: string,
  message: string,
  recovery: string,
  retryable: boolean,
  details?: unknown,
): StructuredError {
  return {
    code,
    message,
    recovery,
    retryable,
    ...(details ? { details: serializeError(details) } : {}),
  };
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}

function getOpenAiBaseUrl(env: Env) {
  if (env.OPENAI_BASE_URL) {
    return normalizeOpenAiBaseUrl(env.OPENAI_BASE_URL);
  }

  if (env.PUBLIC_LITELLM_URL) {
    return normalizeOpenAiBaseUrl(env.PUBLIC_LITELLM_URL);
  }

  if (env.SERVICE_FQDN_GATEWAY_4000) {
    return normalizeOpenAiBaseUrl(`https://${env.SERVICE_FQDN_GATEWAY_4000}`);
  }

  return 'http://localhost:4000/v1';
}

function normalizeOpenAiBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

async function startOperation(
  prisma: PrismaLike,
  input: { type: string; targetType: string; targetId: string; targetLabel?: string | null },
): Promise<AdminOperationRecord> {
  const delegate = optionalDelegate(prisma, 'adminOperation');
  if (!delegate?.create) {
    return {
      id: randomUUID(),
      type: input.type,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel ?? null,
      status: 'running',
      startedAt: new Date(),
    };
  }

  return delegate.create({
    data: {
      type: input.type,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel ?? null,
      status: 'running',
    },
  }) as Promise<AdminOperationRecord>;
}

async function finishOperation(
  prisma: PrismaLike,
  operation: AdminOperationRecord,
  status: OperationStatus,
  payload: unknown,
) {
  const delegate = optionalDelegate(prisma, 'adminOperation');
  const data =
    status === 'success'
      ? { status, result: payload as Prisma.InputJsonValue, finishedAt: new Date() }
      : { status, error: payload as Prisma.InputJsonValue, finishedAt: new Date() };

  if (!delegate?.update) {
    Object.assign(operation, data);
    return operation;
  }

  return delegate.update({
    where: { id: operation.id },
    data,
  }) as Promise<AdminOperationRecord>;
}

async function findOperation(prisma: PrismaLike, id: string) {
  const delegate = optionalDelegate(prisma, 'adminOperation');
  if (!delegate?.findUnique) return null;
  return delegate.findUnique({ where: { id } }) as Promise<AdminOperationRecord | null>;
}

async function recordAuditEvent(
  prisma: PrismaLike,
  input: {
    action: string;
    targetType: string;
    targetId?: string | null;
    targetLabel?: string | null;
    result: string;
    message?: string;
    metadata?: unknown;
  },
) {
  const delegate = optionalDelegate(prisma, 'auditEvent');
  if (!delegate?.create) return null;
  return delegate.create({
    data: {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      result: input.result,
      message: input.message,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
  });
}

async function listAuditEvents(prisma: PrismaLike, query: ListQuery) {
  const delegate = optionalDelegate(prisma, 'auditEvent');
  if (!delegate?.findMany) return { items: [], nextCursor: null };
  const rows = (await delegate.findMany(cursorPage(query))) as Array<{ id: string }>;
  return paginate(rows, query.limit);
}

function optionalDelegate(prisma: PrismaLike, key: 'adminOperation' | 'auditEvent') {
  return (prisma as unknown as Record<string, undefined | Record<string, unknown>>)[key] as
    | {
        create?: (args: unknown) => unknown;
        update?: (args: unknown) => unknown;
        findUnique?: (args: unknown) => unknown;
        findMany?: (args: unknown) => unknown;
      }
    | undefined;
}

function aliasToTarget(
  alias: {
    alias: string;
    upstreamModel: string;
    description: string | null;
    provider: {
      slug: string;
      baseUrl: string;
      authType: 'api_key' | 'none';
      encryptedApiKey: string | null;
    };
  },
  providerSecretKey: string,
): ProviderModelTarget {
  return {
    alias: alias.alias,
    providerSlug: alias.provider.slug,
    providerBaseUrl: alias.provider.baseUrl,
    providerAuthType: alias.provider.authType,
    upstreamModel: alias.upstreamModel,
    apiKey: alias.provider.encryptedApiKey
      ? decryptProviderSecret(alias.provider.encryptedApiKey, providerSecretKey)
      : null,
    description: alias.description,
  };
}

async function syncProviderAliases(
  prisma: PrismaLike,
  litellmAdmin: LiteLlmAdminClient,
  providerId: string,
  providerSecretKey: string,
) {
  const aliases = await prisma.modelAlias.findMany({
    where: { providerId, enabled: true, provider: { enabled: true } },
    include: { provider: true },
  });

  for (const alias of aliases) {
    await syncAliasToLiteLlm(alias, litellmAdmin, providerSecretKey);
    await prisma.modelAlias.update({
      where: { id: alias.id },
      data: { lastSyncedAt: new Date() },
    });
  }

  return aliases.length;
}

async function syncAliasToLiteLlm(
  alias: {
    alias: string;
    upstreamModel: string;
    description: string | null;
    provider: {
      slug: string;
      baseUrl: string;
      authType: 'api_key' | 'none';
      encryptedApiKey: string | null;
    };
  },
  litellmAdmin: LiteLlmAdminClient,
  providerSecretKey: string,
) {
  const target = aliasToTarget(alias, providerSecretKey);
  await litellmAdmin.upsertModel(buildLiteLlmModelPayload(target));
}

async function markAliasSynced(prisma: PrismaLike, id: string) {
  return prisma.modelAlias.update({
    where: { id },
    data: { lastSyncedAt: new Date() },
    include: { provider: true },
  });
}

function formatModelAlias(alias: {
  id: string;
  alias: string;
  upstreamModel: string;
  enabled: boolean;
  description: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  provider: {
    id: string;
    slug: string;
    name: string;
    baseUrl: string;
    authType: 'api_key' | 'none';
    apiKeyLast4: string | null;
    enabled: boolean;
  };
}) {
  return {
    id: alias.id,
    alias: alias.alias,
    upstreamModel: alias.upstreamModel,
    enabled: alias.enabled,
    description: alias.description,
    lastSyncedAt: alias.lastSyncedAt,
    createdAt: alias.createdAt,
    updatedAt: alias.updatedAt,
    provider: {
      id: alias.provider.id,
      slug: alias.provider.slug,
      name: alias.provider.name,
      baseUrl: alias.provider.baseUrl,
      authType: alias.provider.authType,
      apiKeyLast4: alias.provider.apiKeyLast4,
      enabled: alias.provider.enabled,
    },
  };
}

function usageWhere(query: { from?: string; to?: string }) {
  return {
    timestamp:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lt: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
  };
}

function aggregateSums() {
  return {
    promptTokens: true,
    completionTokens: true,
    totalTokens: true,
    estimatedCost: true,
  } as const;
}

function formatAggregateRow(groupKey: 'userId' | 'model') {
  return (row: {
    [key: string]: unknown;
    _count: { _all: number };
    _sum: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      estimatedCost: Prisma.Decimal | null;
    };
  }) => ({
    [groupKey]: row[groupKey],
    requests: row._count._all,
    promptTokens: row._sum.promptTokens ?? 0,
    completionTokens: row._sum.completionTokens ?? 0,
    totalTokens: row._sum.totalTokens ?? 0,
    estimatedCost: decimalToString(row._sum.estimatedCost),
  });
}

function rollup(
  rows: Array<{
    _count: { _all: number };
    _sum: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      estimatedCost: Prisma.Decimal | null;
    };
  }>,
) {
  return rows.reduce(
    (acc, row) => ({
      requests: acc.requests + row._count._all,
      promptTokens: acc.promptTokens + (row._sum.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (row._sum.completionTokens ?? 0),
      totalTokens: acc.totalTokens + (row._sum.totalTokens ?? 0),
      estimatedCost: new Prisma.Decimal(acc.estimatedCost)
        .plus(row._sum.estimatedCost ?? 0)
        .toFixed(8),
    }),
    {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: '0.00000000',
    },
  );
}

function dailyRollup(
  rows: Array<{
    timestamp: Date;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: Prisma.Decimal;
  }>,
) {
  const buckets = new Map<
    string,
    {
      date: string;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedCost: string;
    }
  >();

  for (const row of rows) {
    const date = row.timestamp.toISOString().slice(0, 10);
    const current = buckets.get(date) ?? {
      date,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: '0.00000000',
    };

    buckets.set(date, {
      date,
      requests: current.requests + 1,
      promptTokens: current.promptTokens + row.promptTokens,
      completionTokens: current.completionTokens + row.completionTokens,
      totalTokens: current.totalTokens + row.totalTokens,
      estimatedCost: new Prisma.Decimal(current.estimatedCost).plus(row.estimatedCost).toFixed(8),
    });
  }

  return Array.from(buckets.values());
}

async function getLiteLlmUsage(
  litellmAdmin: LiteLlmAdminClient,
  query: { from?: string; to?: string },
) {
  const logs = await litellmAdmin.getSpendLogs({ ...query, limit: usageLogLimit });
  return logs
    .slice(0, usageLogLimit)
    .map(normalizeLiteLlmSpendLog)
    .filter((record) => record !== null);
}

async function ensureLiteLlmActivityBackfill(
  prisma: PrismaLike,
  env: Env,
  litellmAdmin: LiteLlmAdminClient,
  query: ActivityLogFilters,
) {
  const existing = await prisma.activityLog.count({
    where: {
      source: 'litellm_spend_logs',
      createdAt:
        query.from || query.to
          ? {
              gte: query.from ? new Date(query.from) : undefined,
              lt: query.to ? new Date(query.to) : undefined,
            }
          : undefined,
    },
  });
  if (existing > 0) return;

  const logs = await litellmAdmin.getSpendLogs({ from: query.from, to: query.to });
  for (const log of logs.slice(0, 250)) {
    const activity = normalizeLiteLlmActivity(log);
    if (!activity) continue;
    await createActivityLog(prisma, activity, env);
  }
}

function latestLiteLlmUsageByKey(records: Awaited<ReturnType<typeof getLiteLlmUsage>>) {
  const latest = new Map<string, Date>();

  for (const record of records) {
    for (const key of [record.keyAlias, record.keyId]) {
      if (!key) continue;

      const current = latest.get(key);
      if (!current || record.timestamp > current) {
        latest.set(key, record.timestamp);
      }
    }
  }

  return latest;
}

function latestKeyUsage(
  key: { litellmKeyAlias?: string | null; litellmKeyId?: string | null },
  latestUsageByKey: Map<string, Date>,
) {
  const candidates = [key.litellmKeyAlias, key.litellmKeyId]
    .map((id) => (id ? latestUsageByKey.get(id) : null))
    .filter((date): date is Date => date instanceof Date);

  return candidates.reduce<Date | null>(
    (latest, date) => (!latest || date > latest ? date : latest),
    null,
  );
}

function isAfter(candidate: Date, current: Date | string | null | undefined) {
  if (!current) {
    return true;
  }

  const currentDate = current instanceof Date ? current : new Date(current);
  return Number.isNaN(currentDate.valueOf()) || candidate > currentDate;
}

function dailyLiteLlmRollup(records: Awaited<ReturnType<typeof getLiteLlmUsage>>) {
  const buckets = new Map<string, typeof records>();

  for (const record of records) {
    const date = record.timestamp.toISOString().slice(0, 10);
    buckets.set(date, [...(buckets.get(date) ?? []), record]);
  }

  return [...buckets.entries()].map(([date, bucketRecords]) => ({
    date,
    ...aggregateLiteLlmUsage(bucketRecords),
  }));
}

async function enrichedLiteLlmUsage(
  prisma: PrismaLike,
  records: Awaited<ReturnType<typeof getLiteLlmUsage>>,
) {
  const context = await usageAttributionContext(prisma);
  const attributed = records.map((record) => {
    const key =
      (record.keyAlias && context.keysByAlias.get(record.keyAlias)) ||
      (record.keyId && context.keysById.get(record.keyId)) ||
      null;
    const userId = record.userId ?? key?.userId ?? null;
    const teamId = record.teamId ?? key?.teamId ?? null;
    const user = userId ? context.users.get(userId) : null;
    const team = teamId
      ? context.teams.get(teamId)
      : user?.teamId
        ? context.teams.get(user.teamId)
        : null;

    return { ...record, userId, teamId: team?.id ?? teamId, user, team, key };
  });

  const byUser = groupAttributedUsage(
    attributed,
    (record) => record.user?.id ?? record.userId ?? 'unknown',
  )
    .map((row) => ({
      userId: row.id === 'unknown' ? null : row.id,
      user: row.records[0]?.user ?? null,
      team: row.records[0]?.team ?? null,
      keyCount: new Set(
        row.records
          .map((record) => record.key?.id ?? record.keyAlias ?? record.keyId)
          .filter(Boolean),
      ).size,
      modelBreakdown: aggregateBreakdown(row.records, (record) => record.model),
      keyBreakdown: aggregateBreakdown(
        row.records,
        (record) => record.key?.name ?? record.keyAlias ?? record.keyId ?? 'Unknown key',
      ),
      daily: dailyLiteLlmRollup(row.records),
      anomalies: usageAnomalies(row.records),
      budget: row.id === 'unknown' ? null : (context.budgetsByUser.get(row.id) ?? null),
      ...aggregateLiteLlmUsage(row.records),
    }))
    .sort((a, b) => Number(b.estimatedCost) - Number(a.estimatedCost));

  const byTeam = groupAttributedUsage(
    attributed,
    (record) => record.team?.id ?? record.teamId ?? 'unknown',
  )
    .map((row) => ({
      teamId: row.id === 'unknown' ? null : row.id,
      team: row.records[0]?.team ?? null,
      userCount: new Set(
        row.records.map((record) => record.user?.id ?? record.userId).filter(Boolean),
      ).size,
      modelBreakdown: aggregateBreakdown(row.records, (record) => record.model),
      budget: row.id === 'unknown' ? null : (context.budgetsByTeam.get(row.id) ?? null),
      ...aggregateLiteLlmUsage(row.records),
    }))
    .sort((a, b) => Number(b.estimatedCost) - Number(a.estimatedCost));

  const byKey = groupAttributedUsage(
    attributed,
    (record) => record.key?.id ?? record.keyAlias ?? record.keyId ?? 'unknown',
  )
    .map((row) => ({
      keyId: row.id === 'unknown' ? null : row.id,
      key: row.records[0]?.key ?? null,
      user: row.records[0]?.user ?? null,
      team: row.records[0]?.team ?? null,
      modelBreakdown: aggregateBreakdown(row.records, (record) => record.model),
      ...aggregateLiteLlmUsage(row.records),
    }))
    .sort((a, b) => Number(b.estimatedCost) - Number(a.estimatedCost));

  return {
    byUser,
    byTeam,
    byKey,
    topUsersByCost: byUser.slice(0, 10),
    topUsersByTokens: [...byUser].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
    unknownAttribution: byUser.find((row) => row.userId === null) ?? null,
    inactive: inactiveUsage(context, attributed),
  };
}

async function usageAttributionContext(prisma: PrismaLike) {
  const userDelegate = usageDelegate(prisma, 'user');
  const teamDelegate = usageDelegate(prisma, 'team');
  const keyDelegate = usageDelegate(prisma, 'apiKey');
  const budgetDelegate = usageDelegate(prisma, 'budgetLimit');
  const [users, teams, keys, budgets] = await Promise.all([
    (userDelegate?.findMany?.({
      select: { id: true, email: true, name: true, role: true, teamId: true, createdAt: true },
    }) ?? []) as Promise<UsageContextUser[]> | UsageContextUser[],
    (teamDelegate?.findMany?.({
      select: { id: true, slug: true, name: true },
    }) ?? []) as Promise<UsageContextTeam[]> | UsageContextTeam[],
    (keyDelegate?.findMany?.({
      select: {
        id: true,
        prefix: true,
        litellmKeyAlias: true,
        litellmKeyId: true,
        name: true,
        status: true,
        userId: true,
        teamId: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    }) ?? []) as Promise<UsageContextKey[]> | UsageContextKey[],
    (budgetDelegate?.findMany?.({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    }) ?? []) as Promise<UsageContextBudget[]> | UsageContextBudget[],
  ]);

  return {
    users: new Map(users.map((user) => [user.id, user])),
    teams: new Map(teams.map((team) => [team.id, team])),
    keysById: new Map(keys.map((key) => [key.id, key])),
    keysByAlias: new Map(
      keys
        .flatMap((key) => [
          key.litellmKeyAlias ? ([key.litellmKeyAlias, key] as const) : null,
          key.litellmKeyId ? ([key.litellmKeyId, key] as const) : null,
          [key.id, key] as const,
        ])
        .filter((entry): entry is readonly [string, UsageContextKey] => Boolean(entry)),
    ),
    budgetsByUser: new Map(
      budgets
        .filter((budget) => budget.userId)
        .map((budget) => [budget.userId as string, formatBudget(budget)]),
    ),
    budgetsByTeam: new Map(
      budgets
        .filter((budget) => budget.teamId)
        .map((budget) => [budget.teamId as string, formatBudget(budget)]),
    ),
  };
}

function usageDelegate(prisma: PrismaLike, name: string) {
  return (
    prisma as unknown as Record<string, { findMany?: (args?: unknown) => Promise<unknown[]> }>
  )[name];
}

function groupAttributedUsage<T>(records: T[], getKey: (record: T) => string) {
  const buckets = new Map<string, T[]>();
  for (const record of records) {
    const key = getKey(record);
    buckets.set(key, [...(buckets.get(key) ?? []), record]);
  }

  return [...buckets.entries()].map(([id, bucketRecords]) => ({ id, records: bucketRecords }));
}

function aggregateBreakdown<T extends LiteLlmUsageRecord>(
  records: T[],
  getKey: (record: T) => string,
) {
  return groupAttributedUsage(records, getKey)
    .map((row) => ({
      name: row.id,
      ...aggregateLiteLlmUsage(row.records),
    }))
    .sort((a, b) => Number(b.estimatedCost) - Number(a.estimatedCost));
}

function usageAnomalies(
  records: Array<{ timestamp: Date; estimatedCost: string; status: string }>,
) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const currentWeek = records.filter((record) => now - record.timestamp.valueOf() <= 7 * day);
  const previousWeek = records.filter((record) => {
    const age = now - record.timestamp.valueOf();
    return age > 7 * day && age <= 14 * day;
  });
  const currentCost = sumCost(currentWeek);
  const previousCost = sumCost(previousWeek);
  const errors = records.filter((record) => record.status === 'error').length;
  const anomalies: string[] = [];

  if (previousCost > 0 && currentCost >= previousCost * 3) {
    anomalies.push(`Cost is ${Math.round((currentCost / previousCost) * 100)}% of previous week.`);
  }
  if (errors > 0) {
    anomalies.push(`${errors} failed requests in selected range.`);
  }

  return anomalies;
}

function inactiveUsage(
  context: Awaited<ReturnType<typeof usageAttributionContext>>,
  records: Array<{ user?: UsageContextUser | null; key?: UsageContextKey | null }>,
) {
  const activeUserIds = new Set(records.map((record) => record.user?.id).filter(Boolean));
  const activeKeyIds = new Set(records.map((record) => record.key?.id).filter(Boolean));
  const usersWithNoUsage = [...context.users.values()]
    .filter((user: { id: string }) => !activeUserIds.has(user.id))
    .slice(0, 20);
  const keysNeverUsed = [...context.keysById.values()]
    .filter(
      (key: { id: string; lastUsedAt?: Date | string | null }) =>
        !key.lastUsedAt && !activeKeyIds.has(key.id),
    )
    .slice(0, 20);

  return { usersWithNoUsage, keysNeverUsed };
}

function sumCost(records: Array<{ estimatedCost: string }>) {
  return records.reduce((total, record) => total + Number(record.estimatedCost || 0), 0);
}

function formatBudget(budget: Record<string, unknown>) {
  return {
    ...budget,
    monthlyCostLimit:
      budget.monthlyCostLimit instanceof Prisma.Decimal
        ? decimalToString(budget.monthlyCostLimit)
        : String(budget.monthlyCostLimit ?? '0.00000000'),
  };
}

function decimalToString(value: Prisma.Decimal | null | undefined): string {
  return value == null ? '0.00000000' : value.toFixed(8);
}

function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
