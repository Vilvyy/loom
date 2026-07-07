import { Prisma, UsageStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import type { PrismaLike } from '../src/db/prisma.js';
import type {
  LiteLlmAdminClient,
  LiteLlmCreateVirtualKeyInput,
  LiteLlmSpendLogQuery,
  LiteLlmVirtualKey,
} from '../src/services/litellmAdminClient.js';

const env: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ADMIN_TOKEN: '1234567890123456',
  API_KEY_PEPPER: '1234567890123456',
  PROVIDER_SECRET_KEY: '12345678901234567890123456789012',
  LOG_LEVEL: 'silent',
  LITELLM_PROXY_URL: 'http://localhost:4000',
  LITELLM_MASTER_KEY: 'sk-1234567890123456',
  DEFAULT_KEY_BUDGET_DURATION: '30d',
  PROMPT_LOGS_ENABLED: true,
  PROMPT_LOG_LEVEL: 'full',
  PROMPT_LOG_RETENTION_DAYS: 7,
  PROMPT_LOG_PREVIEW_CHARS: 300,
  PROMPT_LOG_REDACTION_ENABLED: true,
  PROMPT_LOG_STORE_COMPLETIONS: false,
  PROMPT_LOG_AUDIT_DETAIL_VIEW: true,
  PROMPT_LOG_CLEANUP_ENABLED: true,
  PROMPT_LOG_CLEANUP_CRON: '0 2 * * *',
  PROMPT_LOG_REQUIRE_PROJECT_TAG: false,
  ROUTER_BASE_URL: 'http://router:20128/v1',
  ROUTER_API_KEY: 'router-key',
  ROUTER_PREMIUM_MODEL: 'openai/premium',
  ROUTER_BALANCED_MODEL: 'openai/balanced',
  ROUTER_FAST_MODEL: 'openai/fast',
  ROUTER_FALLBACK_MODEL: 'openai/fallback',
  ROUTER_AGENT_PREMIUM_MODEL: 'openai/agent-premium',
  ROUTER_AGENT_CHEAP_MODEL: 'openai/agent-cheap',
};

describe('admin activity log routes', () => {
  it('requires admin auth, lists activity, audits detail, and cleans expired rows', async () => {
    const prisma = createMockPrisma();
    const app = await buildApp(env, prisma, new MockLiteLlmAdminClient());
    const headers = { authorization: `Bearer ${env.ADMIN_TOKEN}` };

    const unauthorized = await app.inject({ method: 'GET', url: '/admin/activity-logs' });
    expect(unauthorized.statusCode).toBe(401);

    const status = await app.inject({ method: 'GET', url: '/admin/activity-logs/status', headers });
    expect(status.json()).toMatchObject({ enabled: true, level: 'full', retentionDays: 7 });

    const list = await app.inject({
      method: 'GET',
      url: '/admin/activity-logs?projectId=project-1',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({
      id: 'activity-1',
      projectName: 'Platform',
      promptPreview: 'Build feature',
    });

    const detail = await app.inject({
      method: 'GET',
      url: '/admin/activity-logs/activity-1',
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      promptContent: 'Build feature',
      completionContent: null,
      contentAvailable: { fullPrompt: true },
    });

    const cleanup = await app.inject({
      method: 'POST',
      url: '/admin/activity-logs/cleanup-expired',
      headers,
    });
    expect(cleanup.json()).toMatchObject({ deleted: 1 });
    expect(prisma.auditEvents.map((event) => event.action)).toContain('activity_log.view_detail');
    expect(prisma.auditEvents.map((event) => event.action)).toContain(
      'activity_log.view_full_prompt',
    );
    expect(prisma.auditEvents.map((event) => event.action)).toContain(
      'activity_log.retention_cleanup',
    );

    await app.close();
  });
});

class MockLiteLlmAdminClient implements LiteLlmAdminClient {
  async ensureUser(_input: LiteLlmCreateVirtualKeyInput): Promise<void> {}
  async ensureTeam(_input: LiteLlmCreateVirtualKeyInput): Promise<void> {}
  async createVirtualKey(_input: LiteLlmCreateVirtualKeyInput): Promise<LiteLlmVirtualKey> {
    throw new Error('not used');
  }
  async revokeVirtualKey(_alias: string): Promise<void> {}
  async getSpendLogs(_query: LiteLlmSpendLogQuery): Promise<unknown[]> {
    return [];
  }
  async upsertModel(_payload: unknown): Promise<void> {}
}

function createMockPrisma() {
  const row = {
    id: 'activity-1',
    createdAt: new Date('2026-07-07T00:00:00.000Z'),
    userId: 'user-1',
    user: { id: 'user-1', email: 'dev@example.com', name: 'Dev', role: 'developer' },
    teamId: 'team-1',
    team: { id: 'team-1', slug: 'platform', name: 'Platform' },
    keyId: 'key-1',
    keyAlias: 'tlg_key',
    model: 'code-premium',
    provider: 'openai',
    requestId: 'req-1',
    projectId: 'project-1',
    projectName: 'Platform',
    project: { id: 'project-1', name: 'Platform', slug: 'platform', teamId: 'team-1' },
    clientName: 'codex',
    clientVersion: '1.0.0',
    source: 'loom_ingest',
    status: UsageStatus.success,
    latencyMs: 42,
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
    estimatedCost: new Prisma.Decimal('0.001'),
    category: null,
    promptPreview: 'Build feature',
    completionPreview: null,
    promptContent: 'Build feature',
    completionContent: null,
    redactionApplied: false,
    raw: { request_id: 'req-1' },
    expiresAt: new Date('2026-07-14T00:00:00.000Z'),
  };
  const auditEvents: Array<Record<string, unknown>> = [];
  const prisma = {
    auditEvents,
    activityLog: {
      count: async () => 1,
      findMany: async () => [row],
      findUnique: async () => row,
      groupBy: async () => [{ userId: 'user-1', projectId: 'project-1' }],
      aggregate: async () => ({
        _sum: { totalTokens: 12, estimatedCost: new Prisma.Decimal('0.001') },
      }),
      deleteMany: async () => ({ count: 1 }),
    },
    auditEvent: {
      create: async (payload: { data: Record<string, unknown> }) => {
        auditEvents.push(payload.data);
        return payload.data;
      },
    },
  };

  return prisma as unknown as PrismaLike & { auditEvents: Array<Record<string, unknown>> };
}
