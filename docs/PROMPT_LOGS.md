# Prompt Logs

Prompt logging is configurable and conservative by default.

Default environment:

```env
PROMPT_LOGS_ENABLED=false
PROMPT_LOG_LEVEL=metadata
PROMPT_LOG_RETENTION_DAYS=7
PROMPT_LOG_PREVIEW_CHARS=300
PROMPT_LOG_REDACTION_ENABLED=true
PROMPT_LOG_STORE_COMPLETIONS=false
PROMPT_LOG_AUDIT_DETAIL_VIEW=true
PROMPT_LOG_CLEANUP_ENABLED=true
PROMPT_LOG_CLEANUP_CRON="0 2 * * *"
PROMPT_LOG_REQUIRE_PROJECT_TAG=false
```

## Storage Rules

- Metadata is the default logging level.
- Prompt content is not stored unless `PROMPT_LOGS_ENABLED=true` and `PROMPT_LOG_LEVEL` is `preview` or `full`.
- Full prompt content is not stored unless `PROMPT_LOG_LEVEL=full`.
- Completion content is not stored unless `PROMPT_LOG_LEVEL=full` and `PROMPT_LOG_STORE_COMPLETIONS=true`.
- Redaction runs before preview or full content is stored.
- Raw JSON returned in details excludes common prompt and completion fields.

## Redaction

Loom redacts common high-risk secrets before storage and detail responses:

- API keys and OpenAI-style `sk-...` keys
- Bearer tokens
- JWT-like strings
- GitHub tokens
- Private keys
- Environment variable secrets
- Password assignments
- Long base64-like blobs

Redaction is a defense-in-depth control. Do not treat prompt logging as a safe place to intentionally store secrets.

## Recommended Modes

- Daily operations: `PROMPT_LOGS_ENABLED=false`, `PROMPT_LOG_LEVEL=metadata`.
- Short diagnostic window: `PROMPT_LOGS_ENABLED=true`, `PROMPT_LOG_LEVEL=preview`.
- Incident-only prompt inspection: `PROMPT_LOGS_ENABLED=true`, `PROMPT_LOG_LEVEL=full`, keep `PROMPT_LOG_STORE_COMPLETIONS=false` unless completion inspection is required.

After any diagnostic window, return to metadata mode and run cleanup.
