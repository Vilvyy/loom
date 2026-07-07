# Activity Logs

Activity Logs give admins an operational view of AI usage by user, key, project, model, provider, client, status, tokens, latency, and cost.

This feature is admin-only. It is intended for operations, attribution, abnormal usage review, and incident response. It is not hidden surveillance: prompt content is off by default, retention is explicit, detail access is audited, and stored content is redacted when enabled.

## Sources

Loom prefers LiteLLM spend logs as the usage source of truth. When the Activity Logs page is opened, Loom can backfill activity metadata from LiteLLM spend logs for the selected date range. Local `/ingest/usage` requests also write matching activity rows.

Activity log rows use one of these sources:

- `litellm_spend_logs`
- `loom_ingest`
- `manual`

## Prompt Logging Modes

`PROMPT_LOG_LEVEL` supports:

- `off`: no prompt or completion content.
- `metadata`: request metadata, usage, cost, and attribution only.
- `preview`: redacted prompt preview up to `PROMPT_LOG_PREVIEW_CHARS`.
- `full`: redacted full prompt content.

`PROMPT_LOGS_ENABLED=false` prevents prompt and completion content from being stored even if the level is set to `preview` or `full`. Metadata can still be shown from LiteLLM spend logs.

Completion content is stored only when both `PROMPT_LOG_LEVEL=full` and `PROMPT_LOG_STORE_COMPLETIONS=true`.

## Project Attribution

Projects are managed through:

- `POST /admin/projects`
- `GET /admin/projects`
- `PATCH /admin/projects/:id`
- `DELETE /admin/projects/:id`

Developer keys can have a default project. Request metadata can override the default project when LiteLLM forwards metadata.

Supported metadata keys:

- `x-loom-project`
- `x-loom-client`
- `x-loom-repo`
- `metadata.project`
- `metadata.client`
- `metadata.repo`

Rows without project attribution are shown as `Unassigned`.

## Admin API

- `GET /admin/activity-logs/status`
- `GET /admin/activity-logs`
- `GET /admin/activity-logs/:id`
- `GET /admin/activity-logs/summary`
- `POST /admin/activity-logs/cleanup-expired`

List and summary filters:

- `userId`
- `teamId`
- `keyAlias`
- `projectId`
- `model`
- `provider`
- `status`
- `clientName`
- `category`
- `from`
- `to`
- `limit`
- `cursor`

## Audit Events

Loom writes audit events for:

- `activity_log.list`
- `activity_log.view_detail`
- `activity_log.view_full_prompt`
- `activity_log.retention_cleanup`
- `activity_log.disabled_access_attempt`

Audit metadata intentionally excludes raw prompt and completion content.

## Retention

Each row has `expiresAt`, calculated from `PROMPT_LOG_RETENTION_DAYS`. `POST /admin/activity-logs/cleanup-expired` deletes expired rows. When `PROMPT_LOG_CLEANUP_ENABLED=true`, the API process also runs a daily cleanup timer.

LiteLLM spend-log cleanup is operator-managed. If your LiteLLM database retains spend logs longer than Loom activity logs, configure LiteLLM-side retention or database maintenance separately.
