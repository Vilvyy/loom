![Loom Cover](https://blobshot-assets.apps.anggaprytn.com/api/files/pbc_1321337024/cagcoccc6vut3te/loom_o1aziz7kmh.webp)

# Loom

Self-hosted control plane for team LLM access through LiteLLM.

Loom gives an engineering team one OpenAI-compatible endpoint for coding tools and automation while keeping user access, provider routing, key lifecycle, usage visibility, and operator controls in one place. LiteLLM remains the request-time gateway; Loom manages the admin workflow around LiteLLM virtual keys, provider registry entries, model aliases, local metadata, usage summaries, and operational dashboards.

## Why Loom Exists

Small teams often end up with unmanaged AI access: shared keys, unknown spend, direct provider credentials on developer machines, no clean revocation path, and no stable model names across providers. Loom separates those concerns:

- Developers use personal LiteLLM virtual keys against one `/v1` endpoint.
- Operators manage users, teams, keys, upstream providers, and model aliases from an admin API or dashboard.
- Provider credentials stay in environment variables or the encrypted provider registry.
- LiteLLM handles request-time authentication, model allowlists, budgets supported by LiteLLM, proxying, and spend logs.

Loom does not scrape credentials, pool browser sessions, automate password sharing, bypass provider quotas, or resell provider access. Use upstream accounts and API keys that are authorized for your team or organization.

## Current Features

- Fastify control-plane API with bearer-token admin auth.
- React admin console served from `/dashboard`.
- User and team records stored in Postgres through Prisma.
- LiteLLM virtual key creation and revocation with local hashed key metadata.
- Provider registry for OpenAI-compatible upstreams.
- Provider API key encryption at rest with `PROVIDER_SECRET_KEY`.
- Stable model aliases synced into LiteLLM dynamic model configuration.
- Provider health checks against OpenAI-compatible `/v1/models`.
- LiteLLM spend-log usage summaries by user and model.
- Admin-only Activity Logs for user, project, model, key, client, token, cost, status, and prompt-preview/full-prompt inspection when explicitly enabled.
- Manual usage ingestion endpoint for fallback or future log-forwarder workflows.
- Budget records for monthly token and cost limits, plus default LiteLLM key budget fields.
- Docker Compose stack for API, LiteLLM, Postgres, and Redis.
- Smoke scripts for gateway, key lifecycle, usage, and real-provider checks.

## Architecture

```text
Developer tools / scripts
  -> LiteLLM proxy using a personal LiteLLM virtual key
  -> OpenAI-compatible upstream selected by static config or model alias
  -> Provider

Operators
  -> Loom admin API or dashboard
  -> LiteLLM admin APIs + Loom Postgres metadata
```

The control plane and LiteLLM use separate Postgres schemas:

- `app`: Loom users, teams, key metadata, provider registry, aliases, usage records, budgets, audit events, and operations.
- `litellm`: LiteLLM-managed tables.

Keep these schemas separate because LiteLLM manages its own database schema.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for more detail.

## Quick Start

Prerequisites:

- Docker and Docker Compose
- An OpenAI-compatible upstream provider URL and API key

For the easiest install path, use the prebuilt GitHub Container Registry images:

```bash
cp .env.example .env
docker compose -f docker-compose.images.yml up -d
```

Before starting the stack, edit `.env`:

- Replace `ADMIN_TOKEN`, `API_KEY_PEPPER`, `PROVIDER_SECRET_KEY`, `LITELLM_MASTER_KEY`, and `LITELLM_SALT_KEY` with long random values.
- Set `ROUTER_BASE_URL` and `ROUTER_API_KEY` for your upstream OpenAI-compatible provider.
- Set the `ROUTER_*_MODEL` values to model strings accepted by LiteLLM for that upstream.

The image-based Compose file publishes:

- Admin API and dashboard: `http://localhost:3000`
- LiteLLM gateway: `http://localhost:4000`

To update an image-based install:

```bash
docker compose -f docker-compose.images.yml pull
docker compose -f docker-compose.images.yml up -d
```

To pin a release, set `LOOM_VERSION` in `.env`, for example:

```bash
LOOM_VERSION=v0.1.0
```

The default `docker-compose.yml` remains build-oriented and uses `expose`, not host `ports`, so it does not publish `localhost:3000` or `localhost:4000` by default. Route traffic through your reverse proxy, or use `docker-compose.images.yml` for direct local ports.

## Build From Source

Prerequisites:

- Node.js 20 or newer
- npm
- Docker and Docker Compose

```bash
cp .env.example .env
npm install
npm run prisma:generate
docker compose up --build
```

## Local Development

For API and web development outside Compose:

```bash
npm install
npm run prisma:generate
npm run dev:api
npm run dev:web
```

Open the Vite admin console at `http://localhost:5173`. The Vite dev server proxies admin API calls to `http://localhost:3000`.

Common commands:

```bash
npm run lint
npm test
npm run build
npm run format:check
npm run prisma:migrate
```

## Configuration

Configuration is environment-driven. Start from [.env.example](.env.example) and store real values in your deployment secret store.

Required groups:

- Control plane: `DATABASE_URL`, `DIRECT_URL`, `ADMIN_TOKEN`, `API_KEY_PEPPER`, `PROVIDER_SECRET_KEY`
- LiteLLM integration: `LITELLM_PROXY_URL`, `LITELLM_MASTER_KEY`
- Static upstream bootstrap: `ROUTER_BASE_URL`, `ROUTER_API_KEY`, and `ROUTER_*_MODEL`
- LiteLLM database: `LITELLM_DATABASE_URL`

Optional values include `REDIS_URL`, `DEFAULT_KEY_MAX_BUDGET`, `DEFAULT_KEY_BUDGET_DURATION`, `DEFAULT_KEY_TPM_LIMIT`, `DEFAULT_KEY_RPM_LIMIT`, and the `PROMPT_LOG_*` activity logging controls.

Prompt logging defaults to metadata visibility with prompt/completion content disabled. See [docs/ACTIVITY_LOGS.md](docs/ACTIVITY_LOGS.md) and [docs/PROMPT_LOGS.md](docs/PROMPT_LOGS.md).

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full environment reference.

## Usage

Set your admin token:

```bash
export ADMIN_TOKEN=replace-with-your-admin-token
```

Create a user:

```bash
curl -s http://localhost:3000/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","name":"Dev Example","team":{"slug":"engineering","name":"Engineering"}}'
```

Create a personal LiteLLM virtual key:

```bash
curl -s http://localhost:3000/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID_FROM_PREVIOUS_RESPONSE","name":"codex-cli"}'
```

The plaintext LiteLLM key is returned once. Loom stores only a hash, prefix, LiteLLM key alias, and LiteLLM token reference metadata.

Add an OpenAI-compatible provider:

```bash
curl -s http://localhost:3000/admin/providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"company-ai","name":"Company AI","baseUrl":"https://ai.example.com/v1","apiKey":"PROVIDER_API_KEY"}'
```

Create and sync a model alias:

```bash
curl -s http://localhost:3000/admin/model-aliases \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"alias":"code-premium","providerId":"PROVIDER_ID","upstreamModel":"openai/provider-model-id"}'
```

Call LiteLLM with the returned virtual key:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk_PERSONAL_LITELLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"code-premium","messages":[{"role":"user","content":"Say ok"}]}'
```

More examples are in [docs/USAGE.md](docs/USAGE.md).

## Project Structure

```text
apps/api/          Fastify control-plane API
apps/web/          React/Vite admin console
apps/litellm/      LiteLLM container wrapper
docs/              Architecture, operations, usage, deployment, and roadmap docs
prisma/            Loom application database schema
scripts/smoke/     End-to-end smoke scripts
litellm_config.yaml LiteLLM bootstrap configuration
docker-compose.yml Local and deployment-oriented service stack
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Usage](docs/USAGE.md)
- [Development](docs/DEVELOPMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Coolify deployment](docs/COOLIFY_DEPLOY.md)
- [Codex client usage](docs/CODEX_USAGE.md)
- [Roadmap](docs/ROADMAP.md)

## Testing

```bash
npm run lint
npm test
npm run build
```

Smoke tests require a running stack and suitable environment values:

```bash
npm run smoke:gateway
npm run smoke:real-provider
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Deployment Notes

Loom is intended to run behind a reverse proxy. Expose the LiteLLM service to developer tools and keep the admin API/dashboard behind VPN, IP allowlist, or upstream authentication.

Production basics:

- Store secrets outside git.
- Use long random values for admin and encryption secrets.
- Keep Postgres and Redis private.
- Keep provider credentials authorized for team use.
- Run smoke tests after provider or alias changes.
- Decide retention for usage and audit records before broad rollout.

See [docs/COOLIFY_DEPLOY.md](docs/COOLIFY_DEPLOY.md) for the included Coolify-oriented deployment notes.

## Roadmap

Implemented work is tracked in [docs/ROADMAP.md](docs/ROADMAP.md). Notable remaining areas include retention jobs, alerts, Redis-backed rate limits, monthly reports, deployment templates beyond the current Compose/Coolify path, and more polished dashboard workflows.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](docs/CONTRIBUTING.md), run the checks above, and keep security-sensitive changes conservative.

## Security

Please do not open public issues for vulnerabilities or leaked credentials. See [SECURITY.md](docs/SECURITY.md) for the reporting policy and project security boundaries.

## License

Loom is released under the [MIT License](LICENSE).
