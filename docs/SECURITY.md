# Security Policy

## Supported Versions

Loom is pre-1.0 software. Security fixes are made on the default branch unless the maintainers publish a release branch policy later.

## Reporting a Vulnerability

Please do not open a public GitHub issue for vulnerabilities, leaked credentials, authentication bypasses, or provider-account abuse paths.

Report privately through GitHub Security Advisories if enabled for the repository. If advisories are not enabled, contact the maintainers through the private channel listed in the repository owner profile.

Include:

- Affected commit or version.
- Steps to reproduce.
- Impact and required privileges.
- Whether secrets, provider keys, LiteLLM keys, or user data may be exposed.
- Any logs or screenshots with secrets redacted.

## Security Boundaries

Loom must not implement credential scraping, quota bypassing, password sharing automation, browser cookie reuse, or storage of user passwords. Upstream provider credentials must be operator-provided through environment variables or the encrypted provider registry and used only with authorized provider accounts.

## Operational Guidance

- Keep `ADMIN_TOKEN`, `API_KEY_PEPPER`, `PROVIDER_SECRET_KEY`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, and provider API keys outside git.
- Expose LiteLLM to developer tools; keep the admin API and dashboard behind VPN, IP allowlist, or upstream authentication.
- Rotate LiteLLM keys and provider credentials after suspected compromise.
- Keep prompt content logging disabled unless reviewed and approved for your environment. The default is metadata-only activity visibility with no prompt or completion content.
- Use `PROMPT_LOG_LEVEL=preview` or `full` only for explicit operational need, with redaction enabled and a short retention window.
- Treat Activity Log detail views as sensitive. Loom audits detail access and full-prompt access without storing raw prompts in audit metadata.
- Decide usage, activity, prompt, LiteLLM spend-log, and audit retention before broad rollout.
