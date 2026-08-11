import type { Env } from '../config/env.js';

export type LiteLlmKeyBudget = {
  maxBudget?: number;
  budgetDuration?: string;
  tpmLimit?: number;
  rpmLimit?: number;
};

export type LiteLlmCreateVirtualKeyInput = {
  alias: string;
  userId: string;
  teamId?: string | null;
  ownerName: string;
  ownerEmail: string;
  role: string;
  budget: LiteLlmKeyBudget;
};

export type LiteLlmVirtualKey = {
  key: string;
  keyAlias?: string;
  tokenId?: string;
  raw: unknown;
};

export interface LiteLlmAdminClient {
  ensureUser(input: LiteLlmCreateVirtualKeyInput): Promise<void>;
  ensureTeam(input: LiteLlmCreateVirtualKeyInput): Promise<void>;
  createVirtualKey(input: LiteLlmCreateVirtualKeyInput): Promise<LiteLlmVirtualKey>;
  revokeVirtualKey(alias: string): Promise<void>;
  getSpendLogs(query: LiteLlmSpendLogQuery): Promise<unknown[]>;
  upsertModel(payload: unknown): Promise<void>;
}

export type LiteLlmSpendLogQuery = {
  from?: string;
  to?: string;
  limit?: number;
};

const maxSpendLogPageSize = 100;
const defaultSpendLogLimit = 250;

export function buildLiteLlmKeyPayload(input: LiteLlmCreateVirtualKeyInput) {
  return {
    key_alias: input.alias,
    user_id: input.userId,
    team_id: input.teamId ?? undefined,
    metadata: {
      user_id: input.userId,
      team_id: input.teamId ?? null,
      owner_name: input.ownerName,
      owner_email: input.ownerEmail,
      role: input.role,
      source: 'team-llm-gateway',
    },
    max_budget: input.budget.maxBudget,
    budget_duration: input.budget.budgetDuration,
    tpm_limit: input.budget.tpmLimit,
    rpm_limit: input.budget.rpmLimit,
  };
}

export function buildLiteLlmUserPayload(input: LiteLlmCreateVirtualKeyInput) {
  return {
    user_id: input.userId,
    user_email: input.ownerEmail,
    user_alias: input.ownerName,
    user_role: input.role,
    teams: input.teamId ? [input.teamId] : undefined,
    metadata: {
      source: 'team-llm-gateway',
    },
  };
}

export function buildLiteLlmTeamPayload(input: LiteLlmCreateVirtualKeyInput) {
  if (!input.teamId) {
    return null;
  }

  return {
    team_id: input.teamId,
    team_alias: input.teamId,
    models: [],
    metadata: {
      source: 'team-llm-gateway',
    },
  };
}

export class HttpLiteLlmAdminClient implements LiteLlmAdminClient {
  private readonly baseUrl: string;
  private readonly masterKey: string;

  constructor(env: Env) {
    this.baseUrl = env.LITELLM_PROXY_URL.replace(/\/$/, '');
    this.masterKey = env.LITELLM_MASTER_KEY;
  }

  async ensureUser(input: LiteLlmCreateVirtualKeyInput): Promise<void> {
    void input;
    // LiteLLM /user/new returns a new key as a side effect. The gateway must
    // return exactly one user key, so user attribution is attached on /key/generate.
  }

  async ensureTeam(input: LiteLlmCreateVirtualKeyInput): Promise<void> {
    const payload = buildLiteLlmTeamPayload(input);
    if (!payload) {
      return;
    }

    await this.requestIgnoringConflict('/team/new', payload);
    await this.requestIgnoringConflict('/team/update', payload);
  }

  async createVirtualKey(input: LiteLlmCreateVirtualKeyInput): Promise<LiteLlmVirtualKey> {
    const body = await this.requestJson('/key/generate', buildLiteLlmKeyPayload(input));
    const response = body as {
      key?: string;
      token?: string;
      key_alias?: string;
      keyAlias?: string;
      token_id?: string;
      tokenId?: string;
    };
    const key = response.key ?? response.token;

    if (!key) {
      throw new Error('LiteLLM did not return a virtual key');
    }

    return {
      key,
      keyAlias: response.key_alias ?? response.keyAlias ?? input.alias,
      tokenId: response.token_id ?? response.tokenId,
      raw: body,
    };
  }

  async revokeVirtualKey(alias: string): Promise<void> {
    try {
      await this.requestJson('/key/delete', { key_aliases: [alias] });
    } catch (error) {
      if (error instanceof LiteLlmAdminError && error.statusCode === 404) {
        return;
      }

      throw error;
    }
  }

  async getSpendLogs(query: LiteLlmSpendLogQuery): Promise<unknown[]> {
    const limit = toSpendLogLimit(query.limit);
    const pageSize = Math.min(limit, maxSpendLogPageSize);
    const logs: unknown[] = [];

    try {
      for (let page = 1; logs.length < limit; page += 1) {
        const params = buildV2SpendLogParams(query, page, Math.min(pageSize, limit - logs.length));
        const body = await this.request('GET', `/spend/logs/v2?${params}`);
        const data = getSpendLogData(body);
        logs.push(...data);

        const totalPages = getTotalPages(body);
        if (
          data.length === 0 ||
          data.length < pageSize ||
          totalPages === null ||
          page >= totalPages
        ) {
          return logs.slice(0, limit);
        }
      }

      return logs;
    } catch (error) {
      if (!(error instanceof LiteLlmAdminError) || error.statusCode !== 404) {
        throw error;
      }
    }

    // v1 accepts summarize; do not send it to the stricter v2 endpoint.
    const legacyParams = buildLegacySpendLogParams(query, pageSize);
    return getSpendLogData(await this.request('GET', `/spend/logs?${legacyParams}`)).slice(
      0,
      limit,
    );
  }

  async upsertModel(payload: unknown): Promise<void> {
    const modelName = getModelName(payload);
    await this.deleteModelsByName(modelName);

    try {
      await this.requestJson('/model/new', payload);
    } catch (error) {
      if (error instanceof LiteLlmAdminError && [400, 409].includes(error.statusCode)) {
        await this.deleteModelsByName(modelName);
        await this.requestJson('/model/new', payload);
        return;
      }

      throw error;
    }
  }

  private async deleteModelsByName(modelName: string): Promise<void> {
    const modelIds = await this.getModelIdsByName(modelName);
    for (const modelId of modelIds) {
      await this.requestJson('/model/delete', { id: modelId });
    }
  }

  private async getModelIdsByName(modelName: string): Promise<string[]> {
    const body = await this.request('GET', '/model/info');
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return [];
    }

    return body.data
      .filter((entry) => isRecord(entry) && entry.model_name === modelName)
      .map((entry) => {
        if (!isRecord(entry)) {
          return null;
        }

        if (typeof entry.model_id === 'string') {
          return entry.model_id;
        }

        if (isRecord(entry.model_info) && typeof entry.model_info.id === 'string') {
          return entry.model_info.id;
        }

        return null;
      })
      .filter((modelId): modelId is string => Boolean(modelId));
  }

  private async requestIgnoringConflict(path: string, payload: unknown): Promise<void> {
    try {
      await this.requestJson(path, payload);
    } catch (error) {
      if (error instanceof LiteLlmAdminError && [400, 409].includes(error.statusCode)) {
        return;
      }

      throw error;
    }
  }

  private async requestJson(path: string, payload: unknown): Promise<unknown> {
    return this.request('POST', path, payload);
  }

  private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.masterKey}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await response.text();
    const body = text ? safeJsonParse(text) : {};

    if (!response.ok) {
      throw new LiteLlmAdminError(response.status, path, body);
    }

    return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toSpendLogLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return defaultSpendLogLimit;
  }

  return Math.max(1, Math.floor(limit));
}

function buildV2SpendLogParams(query: LiteLlmSpendLogQuery, page: number, pageSize: number) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (query.from) params.set('start_date', query.from.slice(0, 10));
  if (query.to) params.set('end_date', toExclusiveEndDate(query.to));
  return params.toString();
}

function buildLegacySpendLogParams(query: LiteLlmSpendLogQuery, pageSize: number) {
  const params = new URLSearchParams({ summarize: 'false', page_size: String(pageSize) });
  if (query.from) params.set('start_date', query.from.slice(0, 10));
  if (query.to) params.set('end_date', toExclusiveEndDate(query.to));
  return params.toString();
}

function toExclusiveEndDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value.slice(0, 10);

  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function getSpendLogData(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.logs)) return body.logs;
  if (isRecord(body) && Array.isArray(body.data)) return body.data;
  return [];
}

function getTotalPages(body: unknown): number | null {
  if (
    !isRecord(body) ||
    typeof body.total_pages !== 'number' ||
    !Number.isInteger(body.total_pages)
  ) {
    return null;
  }

  return body.total_pages;
}

function getModelName(payload: unknown) {
  if (isRecord(payload) && typeof payload.model_name === 'string') {
    return payload.model_name;
  }

  throw new Error('LiteLLM model payload is missing model_name');
}

export class LiteLlmAdminError extends Error {
  constructor(
    readonly statusCode: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`LiteLLM admin request failed: ${path} returned ${statusCode}`);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}
