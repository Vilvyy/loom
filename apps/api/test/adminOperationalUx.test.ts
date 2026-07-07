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
  PROMPT_LOGS_ENABLED: false,
  PROMPT_LOG_LEVEL: 'metadata',
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

describe('admin operational UX endpoints', () => {
  it('returns section metadata, action operation status, and audit events', async () => {
    const prisma = createMockPrisma();
    const app = await buildApp(env, prisma, new MockLiteLlmAdminClient());
    const headers = { authorization: `Bearer ${env.ADMIN_TOKEN}` };

    const section = await app.inject({ method: 'GET', url: '/admin/dashboard/providers', headers });
    expect(section.statusCode).toBe(200);
    expect(section.json()).toMatchObject({
      data: [{ id: 'provider-1', slug: 'company-ai' }],
      meta: { source: 'provider-registry', stale: false },
    });

    const disabled = await app.inject({
      method: 'DELETE',
      url: '/admin/providers/provider-1',
      headers,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      disabled: true,
      affectedAliases: 2,
      operation: { id: 'operation-1', status: 'success' },
      message: 'Provider disabled: company-ai. 2 aliases were disabled.',
    });

    const operation = await app.inject({
      method: 'GET',
      url: '/admin/operations/operation-1',
      headers,
    });
    expect(operation.statusCode).toBe(200);
    expect(operation.json()).toMatchObject({ id: 'operation-1', status: 'success' });

    const audit = await app.inject({ method: 'GET', url: '/admin/audit-events', headers });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()[0]).toMatchObject({
      action: 'provider.disable',
      targetLabel: 'company-ai',
      result: 'success',
    });

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
  const provider = {
    id: 'provider-1',
    slug: 'company-ai',
    name: 'Company AI',
    baseUrl: 'https://ai.company.com/v1',
    authType: 'api_key' as const,
    apiKeyLast4: '-key',
    enabled: true,
    healthStatus: null,
    lastHealthAt: null,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-06-30T00:00:00.000Z'),
  };
  const operations: Record<string, Record<string, unknown>> = {};
  const auditEvents: Array<Record<string, unknown>> = [];

  const prisma = {
    provider: {
      findMany: async () => [provider],
      findUnique: async () => provider,
      update: async (payload: { data: Partial<typeof provider> }) => {
        Object.assign(provider, payload.data);
        return provider;
      },
    },
    modelAlias: {
      updateMany: async () => ({ count: 2 }),
    },
    adminOperation: {
      create: async (payload: { data: Record<string, unknown> }) => {
        const operation = {
          id: 'operation-1',
          ...payload.data,
          startedAt: new Date('2026-06-30T00:00:00.000Z'),
        };
        operations['operation-1'] = operation;
        return operation;
      },
      update: async (payload: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(operations[payload.where.id], payload.data);
        return operations[payload.where.id];
      },
      findUnique: async (payload: { where: { id: string } }) =>
        operations[payload.where.id] ?? null,
    },
    auditEvent: {
      create: async (payload: { data: Record<string, unknown> }) => {
        const event = {
          id: `audit-${auditEvents.length + 1}`,
          ...payload.data,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
        };
        auditEvents.unshift(event);
        return event;
      },
      findMany: async () => auditEvents,
    },
  };

  return prisma as unknown as PrismaLike;
}
