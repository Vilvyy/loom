import { ActivityLogSource, Prisma, UsageStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import type { Env } from '../config/env.js';
import type { PrismaLike } from '../db/prisma.js';
import { normalizeLiteLlmSpendLog } from './litellmUsageService.js';

export type PromptLogLevel = Env['PROMPT_LOG_LEVEL'];

export type ActivityLogInput = {
  createdAt?: Date;
  userId?: string | null;
  teamId?: string | null;
  keyId?: string | null;
  keyAlias?: string | null;
  model: string;
  provider?: string | null;
  requestId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  source?: ActivityLogSource;
  status?: UsageStatus | 'success' | 'error' | 'rate_limited' | 'budget_exceeded';
  latencyMs?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCost?: string | number | Decimal;
  category?: string | null;
  promptContent?: string | null;
  completionContent?: string | null;
  raw?: unknown;
};

export type ActivityLogFilters = {
  userId?: string;
  teamId?: string;
  keyAlias?: string;
  projectId?: string;
  model?: string;
  provider?: string;
  status?: UsageStatus;
  clientName?: string;
  category?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
};

export function activityLogStatus(env: Env) {
  return {
    enabled: env.PROMPT_LOGS_ENABLED,
    level: env.PROMPT_LOG_LEVEL,
    retentionDays: env.PROMPT_LOG_RETENTION_DAYS,
    previewChars: env.PROMPT_LOG_PREVIEW_CHARS,
    redactionEnabled: env.PROMPT_LOG_REDACTION_ENABLED,
    storeCompletions: env.PROMPT_LOG_STORE_COMPLETIONS,
    auditDetailView: env.PROMPT_LOG_AUDIT_DETAIL_VIEW,
    cleanupEnabled: env.PROMPT_LOG_CLEANUP_ENABLED,
    cleanupCron: env.PROMPT_LOG_CLEANUP_CRON,
    requireProjectTag: env.PROMPT_LOG_REQUIRE_PROJECT_TAG,
  };
}

export function expiresAtFor(createdAt: Date, retentionDays: number) {
  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

export function redactSensitiveText(value: string) {
  let redacted = value;
  const patterns: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]+["']?/gi,
    /\b(password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,;]+["']?/gi,
    /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
  ];

  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return { value: redacted, redactionApplied: redacted !== value };
}

export function applyPromptLoggingPolicy(
  input: ActivityLogInput,
  env: Env,
): ActivityLogInput & {
  promptPreview: string | null;
  completionPreview: string | null;
  promptContent: string | null;
  completionContent: string | null;
  redactionApplied: boolean;
} {
  const level = env.PROMPT_LOGS_ENABLED ? env.PROMPT_LOG_LEVEL : 'metadata';
  const allowPreview = level === 'preview' || level === 'full';
  const allowFull = level === 'full';
  const prompt = textOrNull(input.promptContent);
  const completion = textOrNull(input.completionContent);
  let redactionApplied = false;

  const redact = (value: string | null) => {
    if (!value || !env.PROMPT_LOG_REDACTION_ENABLED) return value;
    const result = redactSensitiveText(value);
    redactionApplied ||= result.redactionApplied;
    return result.value;
  };

  const safePrompt = redact(prompt);
  const safeCompletion = redact(completion);

  return {
    ...input,
    promptPreview:
      allowPreview && safePrompt ? safePrompt.slice(0, env.PROMPT_LOG_PREVIEW_CHARS) : null,
    completionPreview:
      allowPreview && env.PROMPT_LOG_STORE_COMPLETIONS && safeCompletion
        ? safeCompletion.slice(0, env.PROMPT_LOG_PREVIEW_CHARS)
        : null,
    promptContent: allowFull ? safePrompt : null,
    completionContent: allowFull && env.PROMPT_LOG_STORE_COMPLETIONS ? safeCompletion : null,
    redactionApplied,
  };
}

export async function normalizeActivityInput(
  prisma: PrismaLike,
  input: ActivityLogInput,
  env: Env,
) {
  const createdAt = input.createdAt ?? new Date();
  const key = input.keyId
    ? await findKeyById(prisma, input.keyId)
    : input.keyAlias
      ? await findKeyByAlias(prisma, input.keyAlias)
      : null;
  const project = await resolveProject(prisma, {
    teamId: input.teamId ?? key?.teamId ?? null,
    projectId: input.projectId,
    projectName: input.projectName,
    defaultProjectId: key?.defaultProjectId,
  });
  const policy = applyPromptLoggingPolicy(input, env);
  const promptTokens = Math.max(0, input.promptTokens ?? 0);
  const completionTokens = Math.max(0, input.completionTokens ?? 0);
  const totalTokens = Math.max(0, input.totalTokens ?? promptTokens + completionTokens);

  return {
    createdAt,
    userId: input.userId ?? key?.userId ?? null,
    teamId: input.teamId ?? key?.teamId ?? null,
    keyId: key?.id ?? input.keyId ?? null,
    keyAlias: input.keyAlias ?? key?.litellmKeyAlias ?? null,
    model: input.model,
    provider: input.provider ?? providerFromModel(input.model),
    requestId: input.requestId ?? null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? input.projectName ?? 'Unassigned',
    clientName: input.clientName ?? null,
    clientVersion: input.clientVersion ?? null,
    source: input.source ?? ActivityLogSource.loom_ingest,
    status: normalizeStatus(input.status),
    latencyMs: input.latencyMs ?? null,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost: new Prisma.Decimal(input.estimatedCost ?? 0),
    category: input.category ?? null,
    promptPreview: policy.promptPreview,
    completionPreview: policy.completionPreview,
    promptContent: policy.promptContent,
    completionContent: policy.completionContent,
    redactionApplied: policy.redactionApplied,
    raw: scrubRaw(input.raw),
    expiresAt: expiresAtFor(createdAt, env.PROMPT_LOG_RETENTION_DAYS),
  };
}

export function normalizeLiteLlmActivity(value: unknown): ActivityLogInput | null {
  const usage = normalizeLiteLlmSpendLog(value);
  if (!usage || !isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const projectName = firstString([
    value['x-loom-project'],
    metadata['x-loom-project'],
    metadata.project,
    metadata.repo,
    metadata['x-loom-repo'],
  ]);
  const client = parseClient(
    firstString([value['x-loom-client'], metadata['x-loom-client'], metadata.client]),
  );

  return {
    createdAt: usage.timestamp,
    userId: usage.userId,
    teamId: usage.teamId,
    keyId: usage.keyId,
    keyAlias: usage.keyAlias,
    model: usage.model,
    provider: firstString([value.provider, metadata.provider]) ?? providerFromModel(usage.model),
    requestId: firstString([value.request_id, value.requestId, value.id, metadata.request_id]),
    projectName,
    clientName: client.name,
    clientVersion: client.version,
    source: ActivityLogSource.litellm_spend_logs,
    status: usage.status === 'error' ? UsageStatus.error : UsageStatus.success,
    latencyMs: usage.latencyMs,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    estimatedCost: usage.estimatedCost,
    category: firstString([metadata.category, value.category]),
    promptContent: firstString([
      value.prompt,
      value.prompt_content,
      value.messages,
      metadata.prompt,
      metadata.messages,
    ]),
    completionContent: firstString([
      value.completion,
      value.response,
      value.completion_content,
      metadata.completion,
    ]),
    raw: value,
  };
}

export async function createActivityLog(prisma: PrismaLike, input: ActivityLogInput, env: Env) {
  const normalized = await normalizeActivityInput(prisma, input, env);
  return prisma.activityLog.create({
    data: normalized,
    include: activityLogInclude(),
  });
}

export async function listActivityLogs(prisma: PrismaLike, filters: ActivityLogFilters) {
  const rows = await prisma.activityLog.findMany({
    where: activityWhere(filters),
    include: activityLogInclude(),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: filters.limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit).map(formatActivityLogListItem);
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]?.id : null,
  };
}

export async function getActivityLogDetail(prisma: PrismaLike, id: string, env: Env) {
  const row = await prisma.activityLog.findUnique({
    where: { id },
    include: activityLogInclude(),
  });
  if (!row) return null;
  return formatActivityLogDetail(row, env);
}

export async function summarizeActivityLogs(
  prisma: PrismaLike,
  filters: Omit<ActivityLogFilters, 'limit' | 'cursor'>,
) {
  const where = activityWhere({ ...filters, limit: 1 });
  const [count, userRows, projectRows, totals, errorCount] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.groupBy({ by: ['userId'], where }),
    prisma.activityLog.groupBy({ by: ['projectId'], where }),
    prisma.activityLog.aggregate({
      where,
      _sum: { totalTokens: true, estimatedCost: true },
    }),
    prisma.activityLog.count({
      where: { ...where, status: { in: [UsageStatus.error, UsageStatus.rate_limited] } },
    }),
  ]);

  return {
    requests: count,
    activeUsers: userRows.filter((row) => row.userId).length,
    activeProjects: projectRows.filter((row) => row.projectId).length,
    tokens: totals._sum.totalTokens ?? 0,
    estimatedCost: decimalToString(totals._sum.estimatedCost),
    suspiciousOrErrorRequests: errorCount,
  };
}

export async function cleanupExpiredActivityLogs(prisma: PrismaLike, now = new Date()) {
  const result = await prisma.activityLog.deleteMany({ where: { expiresAt: { lt: now } } });
  return { deleted: result.count, cleanedAt: now.toISOString() };
}

export function activityWhere(filters: ActivityLogFilters) {
  return {
    userId: filters.userId,
    teamId: filters.teamId,
    keyAlias: filters.keyAlias,
    projectId: filters.projectId,
    model: filters.model,
    provider: filters.provider,
    status: filters.status,
    clientName: filters.clientName,
    category: filters.category,
    createdAt:
      filters.from || filters.to
        ? {
            gte: filters.from ? new Date(filters.from) : undefined,
            lt: filters.to ? new Date(filters.to) : undefined,
          }
        : undefined,
  };
}

function activityLogInclude() {
  return {
    user: { select: { id: true, email: true, name: true, role: true } },
    team: { select: { id: true, slug: true, name: true } },
    project: { select: { id: true, name: true, slug: true, teamId: true } },
  } as const;
}

function formatActivityLogListItem(row: ActivityLogRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    userId: row.userId,
    user: row.user,
    teamId: row.teamId,
    team: row.team,
    keyAlias: row.keyAlias,
    model: row.model,
    provider: row.provider,
    requestId: row.requestId,
    projectId: row.projectId,
    projectName: row.project?.name ?? row.projectName ?? 'Unassigned',
    project: row.project,
    clientName: row.clientName,
    clientVersion: row.clientVersion,
    source: row.source,
    status: row.status,
    latencyMs: row.latencyMs,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    estimatedCost: decimalToString(row.estimatedCost),
    category: row.category,
    promptPreview: row.promptPreview,
    completionPreview: row.completionPreview,
    redactionApplied: row.redactionApplied,
    expiresAt: row.expiresAt,
  };
}

function formatActivityLogDetail(row: ActivityLogRow, env: Env) {
  const item = formatActivityLogListItem(row);
  const canShowFull = env.PROMPT_LOGS_ENABLED && env.PROMPT_LOG_LEVEL === 'full';
  return {
    ...item,
    promptContent: canShowFull ? row.promptContent : null,
    completionContent:
      canShowFull && env.PROMPT_LOG_STORE_COMPLETIONS ? row.completionContent : null,
    raw: row.raw,
    contentAvailable: {
      preview: env.PROMPT_LOGS_ENABLED && ['preview', 'full'].includes(env.PROMPT_LOG_LEVEL),
      fullPrompt: canShowFull && Boolean(row.promptContent),
      completion: env.PROMPT_LOG_STORE_COMPLETIONS,
    },
  };
}

async function resolveProject(
  prisma: PrismaLike,
  input: {
    teamId?: string | null;
    projectId?: string | null;
    projectName?: string | null;
    defaultProjectId?: string | null;
  },
) {
  if (input.projectId) {
    return prisma.project.findUnique({ where: { id: input.projectId } });
  }
  if (input.projectName) {
    const slug = slugify(input.projectName);
    return prisma.project.findFirst({
      where: { slug, teamId: input.teamId ?? null },
    });
  }
  if (input.defaultProjectId) {
    return prisma.project.findUnique({ where: { id: input.defaultProjectId } });
  }
  return null;
}

async function findKeyById(prisma: PrismaLike, id: string) {
  return prisma.apiKey.findUnique({
    where: { id },
    select: { id: true, userId: true, teamId: true, litellmKeyAlias: true, defaultProjectId: true },
  });
}

async function findKeyByAlias(prisma: PrismaLike, alias: string) {
  return prisma.apiKey.findFirst({
    where: { OR: [{ litellmKeyAlias: alias }, { litellmKeyId: alias }] },
    select: { id: true, userId: true, teamId: true, litellmKeyAlias: true, defaultProjectId: true },
  });
}

function scrubRaw(value: unknown): Prisma.InputJsonValue | undefined {
  if (!isRecord(value)) return undefined;
  const clone = { ...value };
  for (const key of [
    'prompt',
    'prompt_content',
    'messages',
    'completion',
    'completion_content',
    'response',
  ]) {
    delete clone[key];
  }
  if (isRecord(clone.metadata)) {
    const metadata = { ...clone.metadata };
    delete metadata.prompt;
    delete metadata.messages;
    delete metadata.completion;
    clone.metadata = metadata;
  }
  return clone as Prisma.InputJsonValue;
}

function normalizeStatus(value: ActivityLogInput['status']) {
  const status = String(value ?? 'success');
  if (status === 'error') return UsageStatus.error;
  if (status === 'rate_limited') return UsageStatus.rate_limited;
  if (status === 'budget_exceeded') {
    return UsageStatus.budget_exceeded;
  }
  return UsageStatus.success;
}

function providerFromModel(model: string) {
  const [provider] = model.split('/');
  return provider && provider !== model ? provider : 'unknown';
}

function parseClient(value: string | null) {
  if (!value) return { name: null, version: null };
  const [name, version] = value.split('@');
  return { name: name || null, version: version || null };
}

function firstString(values: unknown[]) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text) return text;
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value);
  return null;
}

function decimalToString(value: Prisma.Decimal | Decimal | null | undefined): string {
  return value == null ? '0.00000000' : new Decimal(value.toString()).toFixed(8);
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type ActivityLogRow = Prisma.ActivityLogGetPayload<{
  include: ReturnType<typeof activityLogInclude>;
}>;
