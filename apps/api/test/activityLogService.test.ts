import { ActivityLogSource, UsageStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import {
  applyPromptLoggingPolicy,
  cleanupExpiredActivityLogs,
  expiresAtFor,
  normalizeActivityInput,
  normalizeLiteLlmActivity,
  redactSensitiveText,
} from '../src/services/activityLogService.js';

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
  PROMPT_LOG_LEVEL: 'preview',
  PROMPT_LOG_RETENTION_DAYS: 7,
  PROMPT_LOG_PREVIEW_CHARS: 12,
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

describe('activity log service', () => {
  it('redacts common secrets before preview or full storage', () => {
    const result = redactSensitiveText(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz and OPENAI_API_KEY=sk-1234567890abcdefghi',
    );

    expect(result.value).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(result.value).not.toContain('sk-1234567890abcdefghi');
    expect(result.redactionApplied).toBe(true);
  });

  it('stores metadata only when prompt logs are disabled', () => {
    const policy = applyPromptLoggingPolicy(
      { model: 'code-premium', promptContent: 'hello world' },
      { ...env, PROMPT_LOGS_ENABLED: false, PROMPT_LOG_LEVEL: 'full' },
    );

    expect(policy.promptPreview).toBeNull();
    expect(policy.promptContent).toBeNull();
  });

  it('stores preview without full prompt unless full logging is enabled', () => {
    const preview = applyPromptLoggingPolicy(
      { model: 'code-premium', promptContent: 'hello world prompt' },
      env,
    );
    const full = applyPromptLoggingPolicy(
      { model: 'code-premium', promptContent: 'hello world prompt' },
      { ...env, PROMPT_LOG_LEVEL: 'full' },
    );

    expect(preview.promptPreview).toBe('hello world ');
    expect(preview.promptContent).toBeNull();
    expect(full.promptContent).toBe('hello world prompt');
  });

  it('calculates retention expiry from createdAt', () => {
    expect(expiresAtFor(new Date('2026-07-07T00:00:00.000Z'), 7).toISOString()).toBe(
      '2026-07-14T00:00:00.000Z',
    );
  });

  it('normalizes LiteLLM activity metadata and rejects malformed rows', () => {
    expect(normalizeLiteLlmActivity(null)).toBeNull();
    const row = normalizeLiteLlmActivity({
      startTime: '2026-07-07T00:00:00.000Z',
      model_group: 'code-premium',
      prompt_tokens: 10,
      completion_tokens: 2,
      metadata: {
        project: 'Billing Console',
        client: 'codex@1.2.3',
      },
    });

    expect(row).toMatchObject({
      projectName: 'Billing Console',
      clientName: 'codex',
      clientVersion: '1.2.3',
      source: ActivityLogSource.litellm_spend_logs,
    });
  });

  it('uses key default project attribution when request metadata is absent', async () => {
    const prisma = {
      apiKey: {
        findUnique: async () => ({
          id: 'key-1',
          userId: 'user-1',
          teamId: 'team-1',
          litellmKeyAlias: 'alias-1',
          defaultProjectId: 'project-1',
        }),
      },
      project: {
        findUnique: async () => ({ id: 'project-1', name: 'Platform', slug: 'platform' }),
      },
    };

    const normalized = await normalizeActivityInput(
      prisma as never,
      { keyId: 'key-1', model: 'code-premium', status: UsageStatus.success },
      env,
    );

    expect(normalized).toMatchObject({
      userId: 'user-1',
      teamId: 'team-1',
      projectId: 'project-1',
      projectName: 'Platform',
    });
  });

  it('cleans up expired rows by expiresAt', async () => {
    const prisma = {
      activityLog: {
        deleteMany: async (args: unknown) => {
          expect(args).toMatchObject({
            where: { expiresAt: { lt: new Date('2026-07-07T00:00:00.000Z') } },
          });
          return { count: 3 };
        },
      },
    };

    await expect(
      cleanupExpiredActivityLogs(prisma as never, new Date('2026-07-07T00:00:00.000Z')),
    ).resolves.toMatchObject({ deleted: 3 });
  });
});
