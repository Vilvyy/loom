# Operations

## Start Locally

```bash
cp .env.example .env
npm install
npm run prisma:generate
docker compose up --build
```

Postgres initializes separate schemas: `app` for the control plane and `litellm` for LiteLLM. Do not point both services at the same schema; LiteLLM manages its own Prisma schema and can otherwise modify unrelated tables.

## Rotate Admin Token

1. Generate a new long random token.
2. Update `ADMIN_TOKEN` in the deployment secret store or `.env`.
3. Restart the control-plane API.

## Rotate Upstream Provider Key

For static env providers:

1. Replace `ROUTER_API_KEY` in the operator-managed environment.
2. Restart LiteLLM.
3. Run a small `/v1/models` or chat completion smoke test.

For registry-managed providers, rotate with `POST /admin/providers/:id/rotate-key` or update metadata with `PATCH /admin/providers/:id`, then resync affected aliases. Loom intentionally avoids returning stored provider API keys.

## Add Provider and Alias

Use the provider registry for OpenAI-compatible targets such as local 9Router, `https://ai.example.com/v1`, OpenAI, or an internal vLLM/Ollama proxy:

```bash
curl -s http://localhost:3000/admin/providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"9router","name":"9Router Local","baseUrl":"http://9router:20128/v1","apiKey":"LOCAL_TOKEN"}'
```

Check provider health:

```bash
curl -s http://localhost:3000/admin/providers/PROVIDER_ID/health \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Create a public alias and sync it to LiteLLM:

```bash
curl -s http://localhost:3000/admin/model-aliases \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"alias":"code-premium","providerId":"PROVIDER_ID","upstreamModel":"openai/gemini-2.5-pro"}'
```

Developers keep using `code-premium` regardless of whether it points to 9Router, `ai.example.com`, or another OpenAI-compatible backend.

## Dashboard

Open the minimal admin dashboard:

```text
http://localhost:3000/dashboard
```

For deployment, expose it only on the admin API origin behind VPN, IP allowlist, or upstream auth. The page is a thin API client: it asks for `ADMIN_TOKEN`, stores it in browser local storage, and calls `/admin/*` with bearer auth.

## Provider Rotation and Disable

Rotate a provider key:

```bash
curl -s http://localhost:3000/admin/providers/PROVIDER_ID/rotate-key \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"NEW_PROVIDER_API_KEY","syncAliases":true}'
```

Update provider metadata:

```bash
curl -s -X PATCH http://localhost:3000/admin/providers/PROVIDER_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://ai.example.com/v1","syncAliases":true}'
```

Disable a provider and all of its local aliases:

```bash
curl -s -X DELETE http://localhost:3000/admin/providers/PROVIDER_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Delete is intentionally a soft disable. LiteLLM model deletion is not automated yet, so disabling avoids silently breaking active traffic while keeping an audit trail.

## Real Provider Smoke

After setting a real OpenAI-compatible provider credential:

```bash
REAL_PROVIDER_BASE_URL=https://ai.example.com/v1 \
REAL_PROVIDER_API_KEY=provider-key \
REAL_PROVIDER_MODEL=openai/gemini-2.5-pro \
npm run smoke:real-provider
```

The script creates a temporary provider, alias, user, LiteLLM virtual key, and sends one chat completion through LiteLLM.

## Revoke a Team Key

```bash
curl -X POST http://localhost:3000/admin/keys/KEY_ID/revoke \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Revocation calls LiteLLM `/key/delete` using the stored LiteLLM key alias, then marks the local metadata row revoked.

## Usage Source

Default admin usage endpoints read LiteLLM spend logs:

```bash
curl http://localhost:3000/admin/usage -H "Authorization: Bearer $ADMIN_TOKEN"
```

Use `?source=local` only for manually ingested records or future log forwarder debugging.

## Activity Logs

Open the Activity Logs tab in the admin dashboard or call:

```bash
curl http://localhost:3000/admin/activity-logs \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Create a project for attribution:

```bash
curl -s http://localhost:3000/admin/projects \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Billing Console","slug":"billing-console","teamId":"TEAM_ID"}'
```

Request metadata can override a key default project with `x-loom-project`, `x-loom-client`, `x-loom-repo`, or LiteLLM metadata fields `project`, `client`, and `repo`. Missing project attribution is shown as `Unassigned`.

## Data Retention

Activity logs use `expiresAt`, calculated from `PROMPT_LOG_RETENTION_DAYS`. Manual cleanup:

```bash
curl -X POST http://localhost:3000/admin/activity-logs/cleanup-expired \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

When `PROMPT_LOG_CLEANUP_ENABLED=true`, the API process also runs a daily cleanup timer. `PROMPT_LOG_CLEANUP_CRON` is exposed for operator configuration and documentation, but the in-process scheduler currently runs daily.

LiteLLM spend-log cleanup is operator-managed. Configure LiteLLM/database retention separately if LiteLLM spend logs must expire on the same schedule.

For production, also set a retention target for `UsageRecord` rows and export daily/monthly aggregate reports before pruning.

## Fallback Test Path

Fallback behavior depends on the LiteLLM model configuration you sync or provide. After changing aliases or upstream routing, call `/v1/models` and run one small chat completion through the public alias. If all routes fail, LiteLLM returns a structured provider/proxy error.
