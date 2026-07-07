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

describe('admin provider routes', () => {
  it('stores provider secrets encrypted and syncs aliases to LiteLLM', async () => {
    const prisma = createMockPrisma();
    const litellm = new MockLiteLlmAdminClient();
    const app = await buildApp(env, prisma, litellm);

    const providerResponse = await app.inject({
      method: 'POST',
      url: '/admin/providers',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      payload: {
        slug: 'company-ai',
        name: 'Company AI',
        baseUrl: 'https://ai.company.com/v1/',
        apiKey: 'provider-secret-key',
      },
    });

    expect(providerResponse.statusCode).toBe(201);
    expect(providerResponse.json()).toMatchObject({
      id: 'provider-1',
      slug: 'company-ai',
      baseUrl: 'https://ai.company.com/v1',
      apiKeyLast4: '-key',
    });
    expect(providerResponse.body).not.toContain('provider-secret-key');
    expect(prisma.provider.created?.encryptedApiKey).not.toContain('provider-secret-key');

    const aliasResponse = await app.inject({
      method: 'POST',
      url: '/admin/model-aliases',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      payload: {
        alias: 'code-premium',
        providerId: 'provider-1',
        upstreamModel: 'openai/gemini-2.5-pro',
      },
    });

    expect(aliasResponse.statusCode).toBe(201);
    expect(litellm.models[0]).toMatchObject({
      model_name: 'code-premium',
      litellm_params: {
        api_base: 'https://ai.company.com/v1',
        api_key: 'provider-secret-key',
        model: 'openai/gemini-2.5-pro',
      },
    });

    const rotateResponse = await app.inject({
      method: 'POST',
      url: '/admin/providers/provider-1/rotate-key',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      payload: {
        apiKey: 'rotated-provider-key',
        syncAliases: true,
      },
    });

    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json()).toMatchObject({ rotated: true, syncedAliases: 1 });
    expect(litellm.models[1]).toMatchObject({
      model_name: 'code-premium',
      litellm_params: {
        api_key: 'rotated-provider-key',
      },
    });

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/admin/providers/provider-1',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ disabled: true, enabled: false });

    await app.close();
  });
});

class MockLiteLlmAdminClient implements LiteLlmAdminClient {
  models: unknown[] = [];

  async ensureUser(_input: LiteLlmCreateVirtualKeyInput): Promise<void> {}
  async ensureTeam(_input: LiteLlmCreateVirtualKeyInput): Promise<void> {}
  async createVirtualKey(_input: LiteLlmCreateVirtualKeyInput): Promise<LiteLlmVirtualKey> {
    throw new Error('not used');
  }
  async revokeVirtualKey(_alias: string): Promise<void> {}
  async getSpendLogs(_query: LiteLlmSpendLogQuery): Promise<unknown[]> {
    return [];
  }
  async upsertModel(payload: unknown): Promise<void> {
    this.models.push(payload);
  }
}

function createMockPrisma() {
  const providerRecord = {
    id: 'provider-1',
    slug: 'company-ai',
    name: 'Company AI',
    baseUrl: 'https://ai.company.com/v1',
    authType: 'api_key' as const,
    encryptedApiKey: '',
    apiKeyLast4: '-key',
    enabled: true,
    healthStatus: null,
    lastHealthAt: null,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-06-30T00:00:00.000Z'),
  };

  const prisma = {
    provider: {
      created: null as typeof providerRecord | null,
      create: async (payload: { data: Partial<typeof providerRecord> }) => {
        Object.assign(providerRecord, payload.data);
        prisma.provider.created = { ...providerRecord };
        return selectProvider(providerRecord);
      },
      findUnique: async () => providerRecord,
      update: async (payload: { data: Partial<typeof providerRecord> }) => {
        Object.assign(providerRecord, payload.data);
        return selectProvider(providerRecord);
      },
    },
    modelAlias: {
      create: async (payload: {
        data: {
          alias: string;
          upstreamModel: string;
          description?: string;
          enabled: boolean;
        };
      }) => ({
        id: 'alias-1',
        alias: payload.data.alias,
        providerId: 'provider-1',
        upstreamModel: payload.data.upstreamModel,
        enabled: payload.data.enabled,
        description: payload.data.description ?? null,
        lastSyncedAt: null,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        updatedAt: new Date('2026-06-30T00:00:00.000Z'),
        provider: providerRecord,
      }),
      findMany: async () => [
        {
          id: 'alias-1',
          alias: 'code-premium',
          providerId: 'provider-1',
          upstreamModel: 'openai/gemini-2.5-pro',
          enabled: true,
          description: null,
          lastSyncedAt: null,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
          updatedAt: new Date('2026-06-30T00:00:00.000Z'),
          provider: providerRecord,
        },
      ],
      update: async () => ({
        id: 'alias-1',
        alias: 'code-premium',
        providerId: 'provider-1',
        upstreamModel: 'openai/gemini-2.5-pro',
        enabled: true,
        description: null,
        lastSyncedAt: new Date('2026-06-30T00:00:01.000Z'),
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        updatedAt: new Date('2026-06-30T00:00:00.000Z'),
        provider: providerRecord,
      }),
      updateMany: async () => ({ count: 1 }),
    },
  };

  return prisma as unknown as PrismaLike & typeof prisma;
}

function selectProvider(provider: {
  id: string;
  slug: string;
  name: string;
  baseUrl: string;
  authType: 'api_key';
  apiKeyLast4: string | null;
  enabled: boolean;
  healthStatus: string | null;
  lastHealthAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    baseUrl: provider.baseUrl,
    authType: provider.authType,
    apiKeyLast4: provider.apiKeyLast4,
    enabled: provider.enabled,
    healthStatus: provider.healthStatus,
    lastHealthAt: provider.lastHealthAt,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}
