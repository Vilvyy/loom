import { ActivityLogSource, UsageStatus, Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { PrismaLike } from '../db/prisma.js';
import { createActivityLog } from '../services/activityLogService.js';
import { normalizeUsageRecord } from '../services/usageService.js';

const ingestUsageSchema = z.object({
  timestamp: z.string().datetime().optional(),
  userId: z.string().min(1),
  keyId: z.string().min(1).optional().nullable(),
  teamId: z.string().min(1).optional().nullable(),
  model: z.string().min(1),
  provider: z.string().min(1),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  estimatedCost: z.number().nonnegative(),
  status: z.nativeEnum(UsageStatus),
  latencyMs: z.number().int().nonnegative().optional().nullable(),
  keyAlias: z.string().min(1).optional().nullable(),
  requestId: z.string().min(1).optional().nullable(),
  projectId: z.string().min(1).optional().nullable(),
  projectName: z.string().min(1).optional().nullable(),
  clientName: z.string().min(1).optional().nullable(),
  clientVersion: z.string().min(1).optional().nullable(),
  category: z.string().min(1).optional().nullable(),
  promptContent: z.string().optional().nullable(),
  completionContent: z.string().optional().nullable(),
});

export async function ingestRoutes(app: FastifyInstance, prisma: PrismaLike, env: Env) {
  app.addHook('onRequest', app.verifyAdmin);

  app.post('/usage', async (request, reply) => {
    const input = ingestUsageSchema.parse(request.body);
    const normalized = normalizeUsageRecord({
      ...input,
      timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
    });

    const usage = await prisma.usageRecord.create({
      data: {
        timestamp: normalized.timestamp,
        userId: normalized.userId,
        keyId: normalized.keyId,
        teamId: normalized.teamId,
        model: normalized.model,
        provider: normalized.provider,
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
        totalTokens: normalized.totalTokens,
        estimatedCost: new Prisma.Decimal(normalized.estimatedCost),
        status: normalized.status as UsageStatus,
        latencyMs: normalized.latencyMs,
      },
    });

    if (normalized.keyId) {
      await prisma.apiKey.update({
        where: { id: normalized.keyId },
        data: { lastUsedAt: normalized.timestamp },
      });
    }

    await createActivityLog(
      prisma,
      {
        createdAt: normalized.timestamp,
        userId: normalized.userId,
        keyId: normalized.keyId,
        keyAlias: input.keyAlias,
        teamId: normalized.teamId,
        model: normalized.model,
        provider: normalized.provider,
        requestId: input.requestId,
        projectId: input.projectId,
        projectName: input.projectName,
        clientName: input.clientName,
        clientVersion: input.clientVersion,
        source: ActivityLogSource.loom_ingest,
        status: normalized.status as UsageStatus,
        latencyMs: normalized.latencyMs,
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
        totalTokens: normalized.totalTokens,
        estimatedCost: normalized.estimatedCost,
        category: input.category,
        promptContent: input.promptContent,
        completionContent: input.completionContent,
      },
      env,
    );

    return reply.code(201).send({ ...usage, estimatedCost: usage.estimatedCost.toFixed(8) });
  });
}
