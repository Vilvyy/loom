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

describe('admin key routes', () => {
  it('stores local metadata after LiteLLM virtual key creation and revokes LiteLLM alias', async () => {
    const litellm = new MockLiteLlmAdminClient();
    const prisma = createMockPrisma();
    const app = await buildApp(env, prisma, litellm);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      payload: {
        userId: 'user-1',
        name: 'codex',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(litellm.created).not.toHaveProperty('models');
    expect(prisma.apiKey.createPayload?.data).toMatchObject({
      prefix: 'sk',
      litellmKeyAlias: 'tlg_mock_alias',
      litellmKeyId: 'token-1',
      userId: 'user-1',
      teamId: 'team-1',
    });
    expect(prisma.apiKey.createPayload?.data.keyHash).not.toContain('sk-litellm-user-key');

    const revokeResponse = await app.inject({
      method: 'POST',
      url: '/admin/keys/key-1/revoke',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });

    expect(revokeResponse.statusCode).toBe(200);
    expect(litellm.revokedAliases).toEqual(['tlg_mock_alias']);
    expect(prisma.apiKey.updatePayload?.data).toMatchObject({ status: 'revoked' });

    await app.close();
  });

  it('returns LiteLLM usage attribution dimensions', async () => {
    const litellm = new MockLiteLlmAdminClient();
    litellm.spendLogs = [
      {
        timestamp: '2026-06-30T00:00:00.000Z',
        user_id: 'user-1',
        team_id: 'team-1',
        key_alias: 'tlg_mock_alias',
        model_group: 'code-premium',
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        spend: 0.01,
        status: 'success',
      },
    ];
    const app = await buildApp(env, createMockPrisma(), litellm);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.byUser[0]).toMatchObject({ userId: 'user-1', requests: 1 });
    expect(body.byTeam[0]).toMatchObject({ teamId: 'team-1', requests: 1 });
    expect(body.byModel[0]).toMatchObject({ model: 'code-premium', requests: 1 });
    expect(body.byKey[0]).toMatchObject({ keyAlias: 'tlg_mock_alias', requests: 1 });

    await app.close();
  });

  it('lists key metadata without loading LiteLLM spend logs', async () => {
    const litellm = new MockLiteLlmAdminClient();
    litellm.spendLogs = [
      {
        timestamp: '2026-06-30T02:00:00.000Z',
        key_alias: 'tlg_mock_alias',
        token_id: 'token-1',
        model_group: 'code-premium',
        prompt_tokens: 10,
        completion_tokens: 2,
        spend: 0.01,
        status: 'success',
      },
    ];
    const prisma = createMockPrisma();
    const app = await buildApp(env, prisma, litellm);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      id: 'key-1',
      lastUsedAt: null,
    });
    expect(prisma.apiKey.updatePayloads).toEqual([]);

    await app.close();
  });

  it('keeps key listing independent of LiteLLM availability', async () => {
    const litellm = new MockLiteLlmAdminClient();
    litellm.failSpendLogs = true;
    const app = await buildApp(env, createMockPrisma(), litellm);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ id: 'key-1', lastUsedAt: null });

    await app.close();
  });

  it('uses a bounded cursor query for key listings', async () => {
    const prisma = createMockPrisma();
    const app = await buildApp(env, prisma, new MockLiteLlmAdminClient());

    const response = await app.inject({
      method: 'GET',
      url: '/admin/keys?limit=1&cursor=key-previous',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.apiKey.findManyPayload).toMatchObject({
      take: 2,
      cursor: { id: 'key-previous' },
      skip: 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(response.json()).toMatchObject({ items: [{ id: 'key-1' }], nextCursor: null });

    await app.close();
  });

  it('cleans up the LiteLLM key if local metadata storage fails', async () => {
    const litellm = new MockLiteLlmAdminClient();
    const prisma = createMockPrisma({ failCreate: true });
    const app = await buildApp(env, prisma, litellm);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      payload: {
        userId: 'user-1',
        name: 'codex',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(litellm.revokedAliases).toEqual(['tlg_mock_alias']);

    await app.close();
  });
});

class MockLiteLlmAdminClient implements LiteLlmAdminClient {
  created: LiteLlmCreateVirtualKeyInput | null = null;
  revokedAliases: string[] = [];
  spendLogs: unknown[] = [];
  failSpendLogs = false;

  async ensureUser(): Promise<void> {}
  async ensureTeam(): Promise<void> {}

  async createVirtualKey(input: LiteLlmCreateVirtualKeyInput): Promise<LiteLlmVirtualKey> {
    this.created = input;
    return {
      key: 'sk-litellm-user-key',
      keyAlias: 'tlg_mock_alias',
      tokenId: 'token-1',
      raw: {},
    };
  }

  async revokeVirtualKey(alias: string): Promise<void> {
    this.revokedAliases.push(alias);
  }

  async getSpendLogs(_query: LiteLlmSpendLogQuery): Promise<unknown[]> {
    if (this.failSpendLogs) {
      throw new Error('spend logs unavailable');
    }

    return this.spendLogs;
  }

  async upsertModel(_payload: unknown): Promise<void> {}
}

function createMockPrisma(options: { failCreate?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        email: 'dev@example.com',
        name: 'Dev Example',
        role: 'developer',
        teamId: 'team-1',
        team: { id: 'team-1', slug: 'engineering', name: 'Engineering' },
      }),
    },
    apiKey: {
      createPayload: null as { data: Record<string, unknown> } | null,
      updatePayload: null as { data: Record<string, unknown> } | null,
      updatePayloads: [] as Array<{ data: Record<string, unknown> }>,
      findManyPayload: null as Record<string, unknown> | null,
      create: async (payload: { data: Record<string, unknown> }) => {
        if (options.failCreate) {
          throw new Error('local insert failed');
        }

        prisma.apiKey.createPayload = payload;
        return {
          id: 'key-1',
          prefix: payload.data.prefix,
          litellmKeyAlias: payload.data.litellmKeyAlias,
          litellmKeyId: payload.data.litellmKeyId,
          name: payload.data.name,
          status: 'active',
          userId: payload.data.userId,
          teamId: payload.data.teamId,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
        };
      },
      findUnique: async () => ({
        id: 'key-1',
        litellmKeyAlias: 'tlg_mock_alias',
        status: 'active',
      }),
      findMany: async (payload: Record<string, unknown>) => {
        prisma.apiKey.findManyPayload = payload;
        return [
        {
          id: 'key-1',
          prefix: 'sk',
          litellmKeyAlias: 'tlg_mock_alias',
          litellmKeyId: 'token-1',
          name: 'codex',
          status: 'active',
          userId: 'user-1',
          teamId: 'team-1',
          user: { id: 'user-1', email: 'dev@example.com', name: 'Dev Example', role: 'developer' },
          team: { id: 'team-1', slug: 'engineering', name: 'Engineering' },
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-06-30T00:00:00.000Z'),
        },
        ];
      },
      update: async (payload: { data: Record<string, unknown> }) => {
        prisma.apiKey.updatePayload = payload;
        prisma.apiKey.updatePayloads.push(payload);
        return {
          id: 'key-1',
          status: 'revoked',
          revokedAt: new Date('2026-06-30T00:00:00.000Z'),
        };
      },
    },
  };

  return prisma as unknown as PrismaLike & typeof prisma;
}
