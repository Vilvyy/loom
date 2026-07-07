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

describe('empty JSON action requests', () => {
  it('accepts bodyless JSON POST requests for action endpoints', async () => {
    const app = await buildApp(env, createMockPrisma(), new MockLiteLlmAdminClient());

    const response = await app.inject({
      method: 'POST',
      url: '/admin/model-aliases/alias-1/sync',
      headers: {
        authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      alias: 'code-premium',
      synced: true,
    });
    expect(response.json().lastSyncedAt).toBeTruthy();

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
  const operation = {
    id: 'operation-1',
    type: 'alias.sync',
    targetType: 'alias',
    targetId: 'alias-1',
    targetLabel: 'code-premium',
    status: 'running',
    result: null,
    error: null,
    startedAt: new Date('2026-06-30T00:00:00.000Z'),
    finishedAt: null,
  };

  return {
    modelAlias: {
      findUnique: async () => ({
        id: 'alias-1',
        alias: 'code-premium',
        providerId: 'provider-1',
        upstreamModel: 'cx/gpt-5.3-codex-spark',
        enabled: true,
        description: null,
        lastSyncedAt: null,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        updatedAt: new Date('2026-06-30T00:00:00.000Z'),
        provider: {
          id: 'provider-1',
          slug: 'test',
          name: 'Test',
          baseUrl: 'https://router.example/v1',
          authType: 'none' as const,
          encryptedApiKey: null,
          apiKeyLast4: null,
          enabled: true,
          healthStatus: null,
          lastHealthAt: null,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
          updatedAt: new Date('2026-06-30T00:00:00.000Z'),
        },
      }),
      update: async () => ({
        id: 'alias-1',
        alias: 'code-premium',
        providerId: 'provider-1',
        upstreamModel: 'cx/gpt-5.3-codex-spark',
        enabled: true,
        description: null,
        lastSyncedAt: new Date('2026-06-30T00:00:01.000Z'),
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        updatedAt: new Date('2026-06-30T00:00:00.000Z'),
        provider: {
          id: 'provider-1',
          slug: 'test',
          name: 'Test',
          baseUrl: 'https://router.example/v1',
          authType: 'none' as const,
          encryptedApiKey: null,
          apiKeyLast4: null,
          enabled: true,
          healthStatus: null,
          lastHealthAt: null,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
          updatedAt: new Date('2026-06-30T00:00:00.000Z'),
        },
      }),
    },
    adminOperation: {
      create: async () => operation,
      update: async (payload: { data: Partial<typeof operation> }) => ({
        ...operation,
        ...payload.data,
      }),
    },
    auditEvent: {
      create: async (payload: { data: Record<string, unknown> }) => ({
        id: 'audit-1',
        ...payload.data,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
      }),
    },
  } as unknown as PrismaLike;
}
