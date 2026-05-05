# Changelog

## v1.4.0 — 2026-05-04

### Bug fixes
- `margin_audit` no longer silently truncates at one page. Previously fetched `pageSize=200` jobs and stopped, undercounting revenue/cost/margin for any business-unit/date-range with >200 jobs. Now paginates up to 4,000 jobs (20 pages × 200) via the new `pagedStRead` helper, with `_truncated: true` and `_warnings: ['truncated_at_max_pages']` surfaced honestly when the cap is hit.

### New helpers
- `src/paged-st-read.ts` — shared pagination helper for `/api/st/read` consumers. Loops on `hasMore`, defends against missing `hasMore` via `data.length < pageSize`, caps at `maxPages` (default 20), retries 429/502/503/504 with `Retry-After` parsing and exponential backoff, cooperates with the existing `StRateLimiter` Durable Object, and surfaces `partialFailures` / `warnings` instead of throwing on mid-paging errors.
- `src/name-resolver.ts` — cached business-unit and technician name → ID resolution against the upstream proxy's nightly-synced D1 tables. Tier match (exact > prefix > contains). Asymmetric ambiguity: read mode returns the first match by ascending id with `ambiguous: true`; write mode throws `validation_error` so writes can never silently target the wrong record.

### Tool ergonomics (additive — existing ID fields still work)
- `margin_audit` accepts `businessUnitName` as an alternative to `businessUnitId`.
- `dispatch_override_audit` accepts `businessUnitName` and `technicianName`.
- `list_jobs_today` accepts `businessUnitName` and `technicianName`.
- `list_technicians_available` accepts `businessUnitName`.

### Tests
- 11 unit tests for `pagedStRead` (loop, exit conditions, retry/backoff, abort, URL shaping).
- 13 unit tests for `name-resolver` (numeric pass-through, exact/prefix/contains, read vs. write ambiguity, cache memoization).
- 4 new integration tests for `margin_audit` (multi-page sum, maxPages truncation, validation refinements).

### Docs
- `docs/audit/margin-reporting-followup-2026-05-04.md` — verification path + acceptance criterion for the deferred ServiceTitan Reporting API migration of `margin_audit`. Tracked rather than guessed (no verified saved-report ID exists yet).

### Deferred to v1.4.1
- Mechanical migration of the other eight truncating composites (`dispatch_override_audit`, `job_closeout_report`, `customer_snapshot` fan-out sub-calls, `membership_jackpot_leaderboard`, `membership_outreach_list`, `commercial_plumbing_opportunities`, `pricebook_health_check_services`, `call_quality_review`) to `pagedStRead`. Helper soaks first.

### Deferred to v1.5
- `st_intel_revenue_summary` (and any Reporting-API migration of `margin_audit`) gated on the verification path in `docs/audit/margin-reporting-followup-2026-05-04.md`.


## Unreleased (folded into v1.4.0)

### Security
- Require credentials for `POST /mcp` (`Authorization: Bearer <JWT>` or `X-Sync-Key`) before registering tools.
- Reject JWT authentication when `JWT_SECRET` is missing, too short, or placeholder-like.
- Make confirmation-token consumption conditional on `consumed_at IS NULL` to close the replay race window.

### Repository readiness
- Declare direct `jose` dependency and align `package-lock.json` root metadata.
- Add CI, Dependabot, issue templates, `.env.example`, `CONTRIBUTING.md`, and `docs/PUBLISHING_CHECKLIST.md` for public feedback.
- Change Cloudflare deployment to manual dispatch so public-feedback changes are not automatically deployed from `main`.
- Replace production tenant IDs, worker URLs, Cloudflare resource IDs, and raw audit artifacts with public-safe placeholders.
- Add runtime tenant placeholder rewriting from `ST_TENANT_ID` so the public source can remain sanitized.

## v1.2.0 — 2026-05-02

### New tools
- `st_get_capacity_slots` — Scheduler Pro slot availability lookup
- `st_run_report` — Run any ST report by category ID + report ID (mode discriminator)
- `st_post_marketing_attribution` — Post marketing attribution (kind discriminator: call / web-visit / email)

### New routes
- `GET /admin/endpoints` — ST endpoint inventory: per-tool `stEndpoint` descriptors + undeclared list

### Observability
- `stEndpoint` descriptor added to every tool definition; powers `/admin/endpoints` gap analysis
- `/admin/metrics` enriched: `period_1h`, `period_24h`, `period_7d` with `error_rate_pct`; `by_actor_24h`; `write_gate_24h` (dry_runs / confirmed / expired)
- `scripts/query-metrics.sql` — 8 documented Analytics Engine SQL queries for Grafana panels

### Security
- `admin-guard.ts` `requireAdminKey` upgraded to async timing-safe comparison via HMAC ephemeral key (prevents timing-side-channel on X-Sync-Key check)
- Gitleaks secret scan added to `scripts/preflight.sh` step [7] (mandatory, CI-enforced)
- `.gitleaksignore` created; initial scan clean
- RBAC end-to-end verified: default role (65 tools, no `st_call`); admin role (66 tools, `st_call` visible); direct call to `st_call` without admin role returns "tool not found"
- `SECURITY.md` + STRIDE-lite threat model added at repo root

### Docs
- `SECURITY.md` — threat model, write-gate flow diagram, audit posture, known limitations
- `CHANGELOG.md` — this file
- `README.md` — Observability section, `/admin/metrics` description update, `/webhooks/st` marked v1.3 (not 501)

### CI
- GitHub Actions `deploy.yml` installs gitleaks v8.30.1 before running preflight

### Deferred to v1.3
- `StRateLimiter` DO hot-path integration (scaffolded, not wired)
- `/webhooks/st` HMAC ingest (stub returns 501)
- `marketing_roas` tool (gated on mcp-scorpion/lsa/lace data)
- Heartbeat KV emission


## v1.1.0 — 2026-04-23

### New tools (H-batch — "H1 write factory")
- `book_job`, `reschedule_appointment`, `hold_appointment`, `assign_technicians` — job lifecycle writes
- `add_customer_note`, `add_job_note` — note writing
- `create_task`, `list_open_tasks` — task management (read + create; ST task API is read+create only, no PATCH)
- `get_call`, `get_form_submission` — calls + forms
- `list_memberships_active`, `list_memberships_expiring`, `create_recurring_service` — membership surface
- `list_campaigns`, `get_campaign_performance`, `create_call_with_campaign` — marketing
- `get_capacity`, `list_technicians_available`, `get_technician_shifts`, `list_non_job_events` — dispatch
- `list_estimates_job`, `get_estimate`, `update_estimate_status` — estimates
- `get_invoice`, `list_invoices_job`, `get_invoice_balance`, `list_unpaid_invoices` — invoicing

### New composites
- `pricebook_health_check_services`, `margin_audit`, `membership_outreach_list`, `dispatch_override_audit`, `call_quality_review`, `commercial_plumbing_opportunities`, `membership_jackpot_leaderboard` — L5 composites for LLM-ready reporting

### Infrastructure
- Durable Object `StRateLimiter` scaffolded (`src/durable/st-rate-limiter.ts`) — token-bucket per endpoint family, not yet wired into hot path
- HMAC write-gate pattern: dryRun → confirmation token (args_hash, 15-min TTL, single-use) → confirm
- `scripts/inspector-smoke.sh` — automated 3-check smoke (tools/list, st_list_customers, add_customer_note dryRun)
- `scripts/rollback-test.sh` — 4-stage D1 rollback test (verified 2026-05-02)
- `scripts/preflight.sh` — 29-check pre-deploy gate

### Security
- `resolveRole` + D1 `mcp_roles` table — RBAC gate for admin vs default tool visibility
- `st_call` admin gateway added (role=admin only)

### D1 schema (migration 0001_baseline)
- `audit_log`, `error_log`, `confirmation_tokens`, `mcp_cache`, `mcp_roles`, `mv_customer_snapshot`, `mv_margin_audit`


## v1.0.0 — 2026-04-14

### Initial release ("super-MCP build")
- F1 tool set: `st_list_customers`, `st_get_customer`, `st_list_jobs`, `st_list_appointments`, `st_get_pricebook`, `st_patch_service`, `st_create_service`, `st_patch_material`, `st_create_material`
- T5 CRM: `find_customer`, `get_customer`, `get_customer_locations`, `list_customer_jobs`, `get_customer_membership`
- T5 Jobs: `get_job`, `list_jobs_today`, `get_job_appointments`
- T6 Pricebook: `search_pricebook_services`, `get_service_details`, `search_materials`, `get_configurable_equipment_children`, `list_service_categories`, `search_pricebook_all`
- C10 Composite: `customer_snapshot`, `job_closeout_report`
- Siro: `siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement`
- Cloudflare Worker, Hono, Agents SDK Streamable HTTP (`/mcp` route)
- D1 bindings, Analytics Engine (`MCP_METRICS`), servicetitan-proxy service binding
- CI auto-deploy via GitHub Actions (`CLOUDFLARE_API_TOKEN` secret)
