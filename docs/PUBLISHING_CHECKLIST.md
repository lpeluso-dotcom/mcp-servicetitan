# GitHub Publication Checklist

Use this before making the repository public or inviting broad community feedback.

## Access Boundaries

- Do not publish or share `MCP_SYNC_KEY`, `JWT_SECRET`, `SIRO_API_TOKEN`, `ST_WEBHOOK_SECRET`, Cloudflare API tokens, or `.dev.vars`.
- Do not invite public users to connect to the production worker.
- Keep `POST /mcp` credentialed with either `Authorization: Bearer <JWT>` or `X-Sync-Key`.
- Keep `/health` public and free of secrets, tenant customer data, account IDs, or operational payloads.
- Keep the public tenant placeholder (`000000000`) in source. Configure the real tenant only through deployment config (`ST_TENANT_ID`) or private infrastructure.

## Repository Hygiene

- Confirm `git status` only contains intentional release-prep changes.
- Confirm `.env.example` contains placeholders only.
- Confirm `.gitignore` excludes `.env`, `.env.*`, `.dev.vars`, logs, Wrangler state, build output, and `node_modules`.
- Confirm `wrangler.toml` contains placeholder Cloudflare resource IDs, not production account resources.
- Confirm the MIT license is acceptable before accepting external code contributions.
- Review old audit artifacts under `docs/audit/` for internal-only paths or data before publishing.

## Required Checks

```bash
npm ci
npm run typecheck
npm test
npm run security:audit
gitleaks detect --no-git --source . --redact --verbose
```

## GitHub Settings

- Enable Dependabot security updates.
- Require the `CI` workflow before merge.
- Protect `main`; require pull requests and at least one review.
- Keep deployment secrets scoped to GitHub Actions environments.
- Consider disabling GitHub Actions from forks until you are comfortable with the review process.

## Community Feedback Guidance

- Ask reviewers to focus on auth/RBAC, write-gate safety, logging/redaction, webhook validation, dependency posture, Cloudflare deployment assumptions, and documentation clarity.
- Direct sensitive findings to GitHub private vulnerability reporting or another private owner contact channel.
- Use issue templates so public reports stay sanitized and actionable.
