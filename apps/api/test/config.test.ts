import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

describe('loadEnv', () => {
  it('validates required config', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ADMIN_TOKEN: '1234567890123456',
      API_KEY_PEPPER: '1234567890123456',
      PROVIDER_SECRET_KEY: '12345678901234567890123456789012',
      LITELLM_PROXY_URL: 'http://localhost:4000',
      LITELLM_MASTER_KEY: 'sk-1234567890123456',
      ROUTER_BASE_URL: 'http://router:20128/v1',
      ROUTER_API_KEY: 'router-key',
      ROUTER_PREMIUM_MODEL: 'openai/premium',
      ROUTER_BALANCED_MODEL: 'openai/balanced',
      ROUTER_FAST_MODEL: 'openai/fast',
      ROUTER_FALLBACK_MODEL: 'openai/fallback',
      ROUTER_AGENT_PREMIUM_MODEL: 'openai/agent-premium',
      ROUTER_AGENT_CHEAP_MODEL: 'openai/agent-cheap',
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PROMPT_LOGS_ENABLED).toBe(false);
    expect(env.PROMPT_LOG_LEVEL).toBe('metadata');
    expect(env.PROMPT_LOG_RETENTION_DAYS).toBe(7);
    expect(env.PROMPT_LOG_REDACTION_ENABLED).toBe(true);
  });

  it('validates prompt log settings', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ADMIN_TOKEN: '1234567890123456',
      API_KEY_PEPPER: '1234567890123456',
      PROVIDER_SECRET_KEY: '12345678901234567890123456789012',
      LITELLM_PROXY_URL: 'http://localhost:4000',
      LITELLM_MASTER_KEY: 'sk-1234567890123456',
      PROMPT_LOGS_ENABLED: 'true',
      PROMPT_LOG_LEVEL: 'preview',
      PROMPT_LOG_RETENTION_DAYS: '14',
      PROMPT_LOG_STORE_COMPLETIONS: 'true',
      ROUTER_BASE_URL: 'http://router:20128/v1',
      ROUTER_API_KEY: 'router-key',
      ROUTER_PREMIUM_MODEL: 'openai/premium',
      ROUTER_BALANCED_MODEL: 'openai/balanced',
      ROUTER_FAST_MODEL: 'openai/fast',
      ROUTER_FALLBACK_MODEL: 'openai/fallback',
      ROUTER_AGENT_PREMIUM_MODEL: 'openai/agent-premium',
      ROUTER_AGENT_CHEAP_MODEL: 'openai/agent-cheap',
    });

    expect(env.PROMPT_LOGS_ENABLED).toBe(true);
    expect(env.PROMPT_LOG_LEVEL).toBe('preview');
    expect(env.PROMPT_LOG_RETENTION_DAYS).toBe(14);
    expect(env.PROMPT_LOG_STORE_COMPLETIONS).toBe(true);
  });

  it('rejects short admin tokens', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        ADMIN_TOKEN: 'short',
        API_KEY_PEPPER: '1234567890123456',
        PROVIDER_SECRET_KEY: '12345678901234567890123456789012',
        LITELLM_PROXY_URL: 'http://localhost:4000',
        LITELLM_MASTER_KEY: 'sk-1234567890123456',
        ROUTER_BASE_URL: 'http://router:20128/v1',
        ROUTER_API_KEY: 'router-key',
        ROUTER_PREMIUM_MODEL: 'openai/premium',
        ROUTER_BALANCED_MODEL: 'openai/balanced',
        ROUTER_FAST_MODEL: 'openai/fast',
        ROUTER_FALLBACK_MODEL: 'openai/fallback',
        ROUTER_AGENT_PREMIUM_MODEL: 'openai/agent-premium',
        ROUTER_AGENT_CHEAP_MODEL: 'openai/agent-cheap',
      }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it('requires router base URL and API key through preferred or legacy names', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        ADMIN_TOKEN: '1234567890123456',
        API_KEY_PEPPER: '1234567890123456',
        PROVIDER_SECRET_KEY: '12345678901234567890123456789012',
        LITELLM_PROXY_URL: 'http://localhost:4000',
        LITELLM_MASTER_KEY: 'sk-1234567890123456',
        ROUTER_PREMIUM_MODEL: 'openai/premium',
        ROUTER_BALANCED_MODEL: 'openai/balanced',
        ROUTER_FAST_MODEL: 'openai/fast',
        ROUTER_FALLBACK_MODEL: 'openai/fallback',
        ROUTER_AGENT_PREMIUM_MODEL: 'openai/agent-premium',
        ROUTER_AGENT_CHEAP_MODEL: 'openai/agent-cheap',
      }),
    ).toThrow(/ROUTER_BASE_URL/);
  });

  it('treats empty optional numeric limits as unset', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ADMIN_TOKEN: '1234567890123456',
      API_KEY_PEPPER: '1234567890123456',
      PROVIDER_SECRET_KEY: '12345678901234567890123456789012',
      LITELLM_PROXY_URL: 'http://localhost:4000',
      LITELLM_MASTER_KEY: 'sk-1234567890123456',
      DEFAULT_KEY_MAX_BUDGET: '',
      DEFAULT_KEY_TPM_LIMIT: '',
      DEFAULT_KEY_RPM_LIMIT: '',
      ROUTER_BASE_URL: 'http://router:20128/v1',
      ROUTER_API_KEY: 'router-key',
      ROUTER_PREMIUM_MODEL: 'openai/premium',
      ROUTER_BALANCED_MODEL: 'openai/balanced',
      ROUTER_FAST_MODEL: 'openai/fast',
      ROUTER_FALLBACK_MODEL: 'openai/fallback',
      ROUTER_AGENT_PREMIUM_MODEL: 'openai/agent-premium',
      ROUTER_AGENT_CHEAP_MODEL: 'openai/agent-cheap',
    });

    expect(env.DEFAULT_KEY_MAX_BUDGET).toBeUndefined();
    expect(env.DEFAULT_KEY_TPM_LIMIT).toBeUndefined();
    expect(env.DEFAULT_KEY_RPM_LIMIT).toBeUndefined();
  });
});
