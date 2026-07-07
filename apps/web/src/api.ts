export type User = {
  id: string;
  email: string;
  name: string;
  role?: string;
  teamId?: string | null;
  createdAt?: string;
  team?: { id: string; slug: string; name: string } | null;
};

export type ApiKey = {
  id: string;
  prefix: string;
  litellmKeyAlias?: string | null;
  litellmKeyId?: string | null;
  name: string;
  status: 'active' | 'revoked' | string;
  userId: string;
  teamId?: string | null;
  defaultProjectId?: string | null;
  defaultProject?: Project | null;
  user?: Pick<User, 'id' | 'email' | 'name' | 'role'>;
  team?: { id: string; slug: string; name: string } | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  teamId?: string | null;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
  team?: { id: string; slug: string; name: string } | null;
};

export type ActivityLogStatus = {
  enabled: boolean;
  level: 'off' | 'metadata' | 'preview' | 'full';
  retentionDays: number;
  previewChars: number;
  redactionEnabled: boolean;
  storeCompletions: boolean;
  auditDetailView: boolean;
  cleanupEnabled: boolean;
  cleanupCron: string;
  requireProjectTag: boolean;
};

export type ActivityLog = {
  id: string;
  createdAt: string;
  userId?: string | null;
  user?: Pick<User, 'id' | 'email' | 'name' | 'role'> | null;
  teamId?: string | null;
  team?: { id: string; slug: string; name: string } | null;
  keyAlias?: string | null;
  model: string;
  provider: string;
  requestId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  project?: Project | null;
  clientName?: string | null;
  clientVersion?: string | null;
  source: string;
  status: string;
  latencyMs?: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: string | number;
  category?: string | null;
  promptPreview?: string | null;
  completionPreview?: string | null;
  promptContent?: string | null;
  completionContent?: string | null;
  redactionApplied: boolean;
  expiresAt: string;
  raw?: unknown;
  contentAvailable?: {
    preview: boolean;
    fullPrompt: boolean;
    completion: boolean;
  };
};

export type ActivityLogList = {
  items: ActivityLog[];
  nextCursor?: string | null;
};

export type ActivitySummary = {
  requests: number;
  activeUsers: number;
  activeProjects: number;
  tokens: number;
  estimatedCost: string | number;
  suspiciousOrErrorRequests: number;
};

export type Provider = {
  id: string;
  slug: string;
  name: string;
  baseUrl: string;
  authType: 'api_key' | 'none';
  apiKeyLast4?: string | null;
  enabled: boolean;
  healthStatus?: 'healthy' | 'unhealthy' | string | null;
  lastHealthAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ModelAlias = {
  id: string;
  alias: string;
  upstreamModel: string;
  enabled: boolean;
  description?: string | null;
  lastSyncedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  provider?: Provider;
};

export type UsageGroup = {
  [key: string]: unknown;
  requests: number;
  errors?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  estimatedCost: string | number;
  lastUsage?: string | null;
  user?: Pick<User, 'id' | 'email' | 'name' | 'role' | 'teamId'> | null;
  team?: { id: string; slug: string; name: string } | null;
  key?: Pick<ApiKey, 'id' | 'name' | 'status' | 'prefix' | 'litellmKeyAlias' | 'lastUsedAt'> | null;
  modelBreakdown?: UsageGroup[];
  keyBreakdown?: UsageGroup[];
  daily?: UsageGroup[];
  budget?: {
    monthlyCostLimit?: string | number | null;
    monthlyTokenLimit?: number | null;
  } | null;
  anomalies?: string[];
  keyCount?: number;
  userCount?: number;
};

export type Usage = {
  source: string;
  totals: {
    requests?: number;
    totalTokens?: number;
    estimatedCost?: string | number;
  };
  byUser?: UsageGroup[];
  byModel?: UsageGroup[];
  byTeam?: UsageGroup[];
  byKey?: UsageGroup[];
  byDay?: UsageGroup[];
  rawDailyRollup?: UsageGroup[];
  topUsersByCost?: UsageGroup[];
  topUsersByTokens?: UsageGroup[];
  unknownAttribution?: UsageGroup | null;
  inactive?: {
    usersWithNoUsage?: User[];
    keysNeverUsed?: ApiKey[];
  };
};

export type SectionKey = 'users' | 'providers' | 'aliases' | 'keys' | 'usage';

export type DashboardData = {
  users: User[];
  providers: Provider[];
  aliases: ModelAlias[];
  keys: ApiKey[];
  usage: Usage | null;
};

export type DashboardResult = {
  data: DashboardData;
  errors: Partial<Record<SectionKey, string>>;
};

export type ClientConfig = {
  openaiBaseUrl: string;
  defaultModel: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`/admin${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text || 'Request failed.' };
  }

  if (!response.ok) {
    throw new ApiError(formatApiError(body), response.status);
  }

  return body as T;
}

function formatApiError(body: unknown) {
  const payload = body as {
    error?: string | { message?: string; recovery?: string; details?: unknown };
    details?: unknown;
  };
  if (typeof payload?.error === 'object' && payload.error) {
    const details = payload.error.details ? `: ${JSON.stringify(payload.error.details)}` : '';
    const recovery = payload.error.recovery ? ` ${payload.error.recovery}` : '';
    return `${payload.error.message || 'Request failed.'}${recovery}${details}`;
  }

  const details = payload?.details ? `: ${JSON.stringify(payload.details)}` : '';
  return `${payload?.error || 'Request failed.'}${details}`;
}

export const api = {
  getClientConfig: (token: string) => request<ClientConfig>(token, '/client-config'),
  getDashboard: async (token: string): Promise<DashboardResult> => {
    const entries = await Promise.allSettled([
      request<User[]>(token, '/users'),
      request<Provider[]>(token, '/providers'),
      request<ModelAlias[]>(token, '/model-aliases'),
      request<ApiKey[]>(token, '/keys'),
      request<Usage>(token, '/usage'),
    ]);
    const keys: SectionKey[] = ['users', 'providers', 'aliases', 'keys', 'usage'];
    const data: DashboardData = { users: [], providers: [], aliases: [], keys: [], usage: null };
    const errors: Partial<Record<SectionKey, string>> = {};

    entries.forEach((entry, index) => {
      const key = keys[index];
      if (entry.status === 'rejected') {
        errors[key] = entry.reason instanceof Error ? entry.reason.message : 'Request failed.';
        return;
      }

      if (key === 'users') data.users = entry.value as User[];
      if (key === 'providers') data.providers = entry.value as Provider[];
      if (key === 'aliases') data.aliases = entry.value as ModelAlias[];
      if (key === 'keys') data.keys = entry.value as ApiKey[];
      if (key === 'usage') data.usage = entry.value as Usage;
    });

    return { data, errors };
  },
  getUsage: (
    token: string,
    query: { from?: string; to?: string; source?: 'litellm' | 'local' },
  ) => {
    const params = new URLSearchParams();
    if (query.from) params.set('from', new Date(query.from).toISOString());
    if (query.to) params.set('to', new Date(query.to).toISOString());
    if (query.source) params.set('source', query.source);
    return request<Usage>(token, `/usage${params.toString() ? `?${params.toString()}` : ''}`);
  },
  getActivityStatus: (token: string) => request<ActivityLogStatus>(token, '/activity-logs/status'),
  getProjects: (token: string) => request<Project[]>(token, '/projects'),
  createProject: (
    token: string,
    payload: { name: string; slug?: string; teamId?: string | null; description?: string | null },
  ) => request<Project>(token, '/projects', { method: 'POST', body: JSON.stringify(payload) }),
  getActivityLogs: (token: string, query: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return request<ActivityLogList>(
      token,
      `/activity-logs${params.toString() ? `?${params.toString()}` : ''}`,
    );
  },
  getActivitySummary: (token: string, query: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return request<ActivitySummary>(
      token,
      `/activity-logs/summary${params.toString() ? `?${params.toString()}` : ''}`,
    );
  },
  getActivityLog: (token: string, id: string) =>
    request<ActivityLog>(token, `/activity-logs/${id}`),
  cleanupActivityLogs: (token: string) =>
    request<{ deleted: number; cleanedAt: string }>(token, '/activity-logs/cleanup-expired', {
      method: 'POST',
    }),
  createUser: (
    token: string,
    payload: { email: string; name: string; team?: { slug: string; name: string } },
  ) => request<User>(token, '/users', { method: 'POST', body: JSON.stringify(payload) }),
  createKey: (token: string, payload: { userId: string; name: string }) =>
    request<ApiKey & { apiKey: string }>(token, '/keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createProvider: (
    token: string,
    payload: { slug: string; name: string; baseUrl: string; apiKey?: string },
  ) => request<Provider>(token, '/providers', { method: 'POST', body: JSON.stringify(payload) }),
  checkProvider: (token: string, id: string) => request<Provider>(token, `/providers/${id}/health`),
  rotateProvider: (token: string, id: string, apiKey: string) =>
    request<Provider>(token, `/providers/${id}/rotate-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, syncAliases: true }),
    }),
  disableProvider: (token: string, id: string) =>
    request<Provider>(token, `/providers/${id}`, { method: 'DELETE' }),
  createAlias: (
    token: string,
    payload: { alias: string; providerId: string; upstreamModel: string },
  ) =>
    request<ModelAlias>(token, '/model-aliases', { method: 'POST', body: JSON.stringify(payload) }),
  syncAlias: (token: string, id: string) =>
    request<ModelAlias>(token, `/model-aliases/${id}/sync`, { method: 'POST' }),
  syncAllAliases: (token: string) =>
    request<{ syncedAliases: number; aliases: Array<{ alias: string; synced: boolean }> }>(
      token,
      '/model-aliases/sync-all',
      { method: 'POST' },
    ),
  disableAlias: (token: string, id: string) =>
    request<ModelAlias>(token, `/model-aliases/${id}`, { method: 'DELETE' }),
  revokeKey: (token: string, id: string) =>
    request<ApiKey>(token, `/keys/${id}/revoke`, { method: 'POST' }),
};
