import { z } from 'zod';

const optionalPositiveNumber = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().positive().optional(),
);

const optionalPositiveInt = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const booleanFromEnv = z.preprocess((value) => {
  if (value === '' || value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  ADMIN_TOKEN: z.string().min(16),
  API_KEY_PEPPER: z.string().min(16),
  PROVIDER_SECRET_KEY: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().url().optional(),
  LITELLM_PROXY_URL: z.string().url(),
  OPENAI_BASE_URL: z.string().url().optional(),
  PUBLIC_LITELLM_URL: z.string().url().optional(),
  SERVICE_FQDN_GATEWAY_4000: z.string().min(1).optional(),
  LITELLM_MASTER_KEY: z
    .string()
    .min(8)
    .refine((value) => value.startsWith('sk-'), {
      message: 'must start with sk-',
    }),
  DEFAULT_KEY_MAX_BUDGET: optionalPositiveNumber,
  DEFAULT_KEY_BUDGET_DURATION: z.string().min(1).default('30d'),
  DEFAULT_KEY_TPM_LIMIT: optionalPositiveInt,
  DEFAULT_KEY_RPM_LIMIT: optionalPositiveInt,
  PROMPT_LOGS_ENABLED: booleanFromEnv.default(false),
  PROMPT_LOG_LEVEL: z.enum(['off', 'metadata', 'preview', 'full']).default('metadata'),
  PROMPT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  PROMPT_LOG_PREVIEW_CHARS: z.coerce.number().int().positive().default(300),
  PROMPT_LOG_REDACTION_ENABLED: booleanFromEnv.default(true),
  PROMPT_LOG_STORE_COMPLETIONS: booleanFromEnv.default(false),
  PROMPT_LOG_AUDIT_DETAIL_VIEW: booleanFromEnv.default(true),
  PROMPT_LOG_CLEANUP_ENABLED: booleanFromEnv.default(true),
  PROMPT_LOG_CLEANUP_CRON: z.string().min(1).default('0 2 * * *'),
  PROMPT_LOG_REQUIRE_PROJECT_TAG: booleanFromEnv.default(false),
  ROUTER_BASE_URL: z.string().url().optional(),
  ROUTER_API_KEY: z.string().min(1).optional(),
  NINE_ROUTER_BASE_URL: z.string().url().optional(),
  NINE_ROUTER_API_KEY: z.string().min(1).optional(),
  ROUTER_PREMIUM_MODEL: z.string().min(1),
  ROUTER_BALANCED_MODEL: z.string().min(1),
  ROUTER_FAST_MODEL: z.string().min(1),
  ROUTER_FALLBACK_MODEL: z.string().min(1),
  ROUTER_AGENT_PREMIUM_MODEL: z.string().min(1),
  ROUTER_AGENT_CHEAP_MODEL: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }

  if (!parsed.data.ROUTER_BASE_URL && !parsed.data.NINE_ROUTER_BASE_URL) {
    throw new Error('Invalid environment: ROUTER_BASE_URL or NINE_ROUTER_BASE_URL is required');
  }

  if (!parsed.data.ROUTER_API_KEY && !parsed.data.NINE_ROUTER_API_KEY) {
    throw new Error('Invalid environment: ROUTER_API_KEY or NINE_ROUTER_API_KEY is required');
  }

  return parsed.data;
}
