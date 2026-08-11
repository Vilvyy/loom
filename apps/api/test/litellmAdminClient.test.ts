import { describe, expect, it } from 'vitest';
import {
  buildLiteLlmKeyPayload,
  buildLiteLlmTeamPayload,
  buildLiteLlmUserPayload,
  HttpLiteLlmAdminClient,
  type LiteLlmCreateVirtualKeyInput,
} from '../src/services/litellmAdminClient.js';

const input: LiteLlmCreateVirtualKeyInput = {
  alias: 'tlg_test',
  userId: 'user-1',
  teamId: 'team-1',
  ownerName: 'Dev Example',
  ownerEmail: 'dev@example.com',
  role: 'developer',
  budget: {
    maxBudget: 25,
    budgetDuration: '30d',
    tpmLimit: 10_000,
    rpmLimit: 120,
  },
};

describe('LiteLLM admin payloads', () => {
  it('builds virtual key payload with metadata and budgets but no model restrictions', () => {
    expect(buildLiteLlmKeyPayload(input)).toEqual({
      key_alias: 'tlg_test',
      user_id: 'user-1',
      team_id: 'team-1',
      metadata: {
        user_id: 'user-1',
        team_id: 'team-1',
        owner_name: 'Dev Example',
        owner_email: 'dev@example.com',
        role: 'developer',
        source: 'team-llm-gateway',
      },
      max_budget: 25,
      budget_duration: '30d',
      tpm_limit: 10_000,
      rpm_limit: 120,
    });
  });

  it('builds user and team mapping payloads without secrets', () => {
    expect(buildLiteLlmUserPayload(input)).toMatchObject({
      user_id: 'user-1',
      user_email: 'dev@example.com',
      user_alias: 'Dev Example',
      teams: ['team-1'],
    });
    expect(buildLiteLlmTeamPayload(input)).toMatchObject({
      team_id: 'team-1',
      models: [],
    });
  });

  it('recreates an existing dynamic model before syncing alias changes', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (String(url).endsWith('/model/info')) {
        return jsonResponse(200, {
          data: [
            {
              model_name: 'code-premium',
              model_info: { id: 'existing-model-id' },
            },
          ],
        });
      }

      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    try {
      const client = new HttpLiteLlmAdminClient({
        LITELLM_PROXY_URL: 'https://llm.example',
        LITELLM_MASTER_KEY: 'sk-master',
      } as never);

      await client.upsertModel({
        model_name: 'code-premium',
        litellm_params: {
          model: 'openai/cx/gpt-5.3-codex-spark',
          api_base: 'https://router.example/v1',
          api_key: 'provider-key',
        },
      });

      expect(requests.map((request) => request.url)).toEqual([
        'https://llm.example/model/info',
        'https://llm.example/model/delete',
        'https://llm.example/model/new',
      ]);
      expect(requests[1].body).toEqual({ id: 'existing-model-id' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries create after LiteLLM reports a duplicate during sync', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const originalFetch = globalThis.fetch;
    let infoCalls = 0;
    let createCalls = 0;

    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (String(url).endsWith('/model/info')) {
        infoCalls += 1;
        return jsonResponse(200, {
          data:
            infoCalls === 1
              ? []
              : [
                  {
                    model_name: 'code-premium',
                    model_info: { id: 'race-model-id' },
                  },
                ],
        });
      }

      if (String(url).endsWith('/model/new')) {
        createCalls += 1;
        if (createCalls === 1) {
          return jsonResponse(409, { error: 'model already exists' });
        }
      }

      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    try {
      const client = new HttpLiteLlmAdminClient({
        LITELLM_PROXY_URL: 'https://llm.example',
        LITELLM_MASTER_KEY: 'sk-master',
      } as never);

      await client.upsertModel({
        model_name: 'code-premium',
        litellm_params: {
          model: 'openai/cx/gpt-5.3-codex-spark',
          api_base: 'https://router.example/v1',
          api_key: 'provider-key',
        },
      });

      expect(requests.map((request) => request.url)).toEqual([
        'https://llm.example/model/info',
        'https://llm.example/model/new',
        'https://llm.example/model/info',
        'https://llm.example/model/delete',
        'https://llm.example/model/new',
      ]);
      expect(requests[3].body).toEqual({ id: 'race-model-id' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses valid v2 pagination and an exclusive end date without sending summarize', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      requests.push(String(url));
      return jsonResponse(200, {
        data: [{ model: 'gpt-5.6-terra' }],
        total: 1,
        page: 1,
        page_size: 100,
        total_pages: 1,
      });
    }) as typeof fetch;

    try {
      const client = new HttpLiteLlmAdminClient({
        LITELLM_PROXY_URL: 'https://llm.example',
        LITELLM_MASTER_KEY: 'sk-master',
      } as never);

      const logs = await client.getSpendLogs({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-03T00:00:00.000Z',
        limit: 100,
      });

      expect(logs).toEqual([{ model: 'gpt-5.6-terra' }]);
      expect(requests).toEqual([
        'https://llm.example/spend/logs/v2?page=1&page_size=100&start_date=2026-08-01&end_date=2026-08-04',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('splits limits above the v2 page-size maximum into valid pages', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      const requestUrl = String(url);
      requests.push(requestUrl);
      const page = Number(new URL(requestUrl).searchParams.get('page'));
      return jsonResponse(200, {
        data: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({ page, index })),
        total: 101,
        page,
        page_size: 100,
        total_pages: 2,
      });
    }) as typeof fetch;

    try {
      const client = new HttpLiteLlmAdminClient({
        LITELLM_PROXY_URL: 'https://llm.example',
        LITELLM_MASTER_KEY: 'sk-master',
      } as never);

      const logs = await client.getSpendLogs({ limit: 101 });

      expect(logs).toHaveLength(101);
      expect(requests).toEqual([
        'https://llm.example/spend/logs/v2?page=1&page_size=100',
        'https://llm.example/spend/logs/v2?page=2&page_size=1',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
