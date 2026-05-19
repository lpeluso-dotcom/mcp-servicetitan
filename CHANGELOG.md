# Changelog

## v1.5.1 — 2026-05-19 (UNRELEASED — ST-77 hardening, depends on v1.5)

Branch `feat/v1.5.1-st77-hardening` stacks on top of `feat/v1.5-payroll-opportunities-dispatch-pro` (PR #17). Scope follows the external QA reviewer's pick: **sharp**, not a sweep. Tool count **86 → 87** (+1); test count **437 → 451** (+14).

### Infra
- New `src/st.ts` — `readST(env, ctx, endpoint, query?)` and `readSTPaged(env, ctx, endpoint, query?, options?)`. Centralizes the `env.ST_PROXY.fetch` + `URLSearchParams` + envelope-parse pattern that 30+ tools were hand-rolling. Built-in `hasMore` drain with a `maxPages` cap (default 50) so a runaway loop can't trigger.
- New `src/tools/__tests__/filter_preservation_helper.ts` — reusable test harness: `assertFilterPreservation(tool, matrix, baseArgs?, overrides?)`. For each declared filter, asserts one of: `forwarded_query` (live ST URL), `forwarded_path` (path segment), `forwarded_d1` (SQL WHERE clause), or `rejected_or_skipped` (validation_error or `_fallback_skipped` flag). Designed to be applied incrementally; first adopters are the v1.5.1 tools + 2 v1.5 regression checks.

### ST-77 alignment
- **`st_list_appointments`** — added `active` filter (forwarded as `active=True|False`). The returned `active` boolean on each row passes through unchanged.
- **`st_list_jobs`** + **`get_job`** — docstrings document the ST-77 `isAutoDispatched` field; both tools already return raw JSON so the field flows through naturally. Migrated both to `readST`.
- **New: `jobs_hold_reasons_list`** — wraps `/jpm/v2/tenant/{tid}/job-hold-reasons` (mirrors the `job-cancel-reasons` shape taylor-ai already syncs). Returns `{id, name, active}` rows. Pass to `hold_appointment` callers that need to resolve a reason name → ID before holding.

### Tests
- 14 new tests under `src/tools/__tests__/v151_st77.test.ts`:
  - 4 for `st_list_appointments` active filter + harness sweep of all 5 declared filters
  - 2 for `st_list_jobs` (`isAutoDispatched` pass-through + harness sweep)
  - 1 for `get_job` (`isAutoDispatched` pass-through)
  - 2 for `jobs_hold_reasons_list` (endpoint shape + active filter)
  - 5 regression-via-harness for `payroll_job_timesheets_list` (jobId, technicianId, appointmentId honored in D1 SQL) and `opportunities_list` (6 filters honored in D1 SQL)
- All 451 tests pass; `npm run check` clean.

### Migrated to readST helper
- `st_list_appointments`, `st_list_jobs`, `jobs/get_job` — 3 tools. The bulk migration of the remaining ~25 hand-rolled fetch tools is left as a v1.6 follow-up so this PR stays sharp.

### Out of scope (deferred per reviewer's note)
- Full filter-preservation coverage of all ~80 tools — harness is in place; each tool adopts via a one-test-per-tool addition.
- ST-77.2/77.3 product probes (Equipment auto-attach, Dispatch Pro multi-appointment, FTK dispatch links, Contact Center Pro, Inventory landed costs) — separate v1.6 candidates.
- `settings_intacct_business_unit_mappings_get` — only useful for shops on Sage Intacct.
- Tool-pack splitting (default / payroll / dispatch / accounting / pricebook / admin views) — context-pressure mitigation; separate design discussion.

## v1.5.0 — 2026-05-19 (UNRELEASED — awaiting Luke review)

PR (`feat/v1.5-payroll-opportunities-dispatch-pro`): payroll + opportunities + dispatch-pro D1-first reads and four costing composites driven by today's ST Payroll API findings. Tool count **75 → 86** (+9 readers added; +2 composites in opportunities/dispatch_pro count is actually 9 new tools); test count **416 → 430** (+14).

Plan: `~/.claude/plans/inlite-of-what-we-elegant-mitten.md`. Today's payroll probe + Q1 job-costing findings are the motivation; per-job drive/working-time data now flows through the typed MCP surface instead of the taylor-ai proxy escape-hatch.

### New: D1-first reader tools (5)
| Tool | D1 table | ST endpoint mirror |
|---|---|---|
| `opportunities_list` | `opportunities` (mig 0018) | `/sales/v2/tenant/{tid}/opportunities` |
| `opportunity_get` | `opportunities` + `estimates` | `/sales/v2/tenant/{tid}/opportunities/{id}` |
| `dispatch_pro_utilization_list` | `dispatch_pro_utilization` (mig 0022) | reporting/operations/80766576 |
| `dispatch_pro_ratio_list` | `dispatch_pro_ratio` | reporting/operations/80770546 |
| `dispatch_pro_alerts_list` | `dispatch_pro_alerts` | reporting/operations/80769010 |

All five use `transformResult: defaultShaper` and read via the shared `src/d1.ts` helper (`POST /api/sql/read`, SELECT/WITH only).

### Refactored: `payroll_job_timesheets_list` to D1-first
- Previously: live-only (PR #16). Now: reads from the new `job_timesheets` D1 table (migration 0021, denormalized `drive_minutes` + `working_minutes`), with three modes — `auto` (D1, falls back to live on empty/stale with a jobId/appointmentId filter), `d1` (force D1), `live` (force live ST).
- Added filters: `technicianId`, `appointmentId`, `arrivedOnOrAfter`, `arrivedOnOrBefore`, `active`. The probe-reconciliation case (job 77423990 / Brooks / drive=24m + work=152m) is covered by both modes.

### New: composites (4)
| Composite | Purpose | Source |
|---|---|---|
| `job_cost_actuals` | Per-job rollup: timesheets + appointments + assignments + estimates + live invoice + computed `labor_burden_$ = (drive + work) × burdenRate / 60`. Reconciles to today's probe ($132 at $45/hr on the Brooks job). | mixed |
| `tech_drive_time_summary` | Per-tech rollup over a date window: drive %, working minutes, jobs/day, first-call drive, windshield cost ($110/hr default per YTD plan), labor burden. | D1 |
| `assigned_vs_sold_estimate_audit` | Credit-attribution diagnostic: estimates where `sold_by` is empty (status=Sold), no job link, or doesn't match any tech on `appointment_assignments`. | D1 |
| `open_opportunities_pulitzer_feed` | Open cohort (status NOT IN Won/Dismissed, active=1) joined to latest estimate + customer. Same shape as Pulitzer's `open-opportunities` report. | D1 |

### Fix: `create_task` schema expanded to 8 ST-required fields
- Previous shape sent only `{name, jobId, dueDate?, assignedToId?}` — ST returned 200 but created an incomplete task missing reporter / BU / classification.
- v1.5 schema: `body`, `reportedById`, `businessUnitId`, `employeeTaskTypeId`, `employeeTaskSourceId` are now required; `reportedDate` defaults to now; `isClosed` defaults to false; `priority` defaults to 'Normal' (enum: Normal/High/Urgent).

### Infra
- New `src/d1.ts` shared helper (`readD1(env, sql, params)`) — SELECT/WITH gate + typed result.
- `D1_TABLES` set in `src/read-router.ts` extended with: `job_timesheets`, `opportunities`, `opportunity_statuses`, `dispatch_pro_utilization`, `dispatch_pro_ratio`, `dispatch_pro_alerts`.
- Pre-deploy follow-up: migration `0003_webhook_event_index.sql` still needs to be applied to prod (`wrangler d1 execute <your-d1-database> --remote --file migrations/0003_webhook_event_index.sql`).

### QA round 1 — auto-fallback filter-honoring (PR #17 review)
- `payroll_job_timesheets_list` auto-fallback to live ST now requires `jobId` AND no filter the live endpoint can't honor. Previously the condition included `appointmentId`, but `liveRead`'s batch path only forwards page/pageSize/active=Any/modifiedOnOrAfter — so `{ appointmentId, source: 'auto' }` on empty/stale D1 silently returned a wide-net superset labeled `_source: 'live'`. Same class of bug for `technicianId`, `arrivedOnOrAfter`, `arrivedOnOrBefore`, `active`.
- `source: 'live'` with any of `technicianId`, `appointmentId`, `arrivedOnOrAfter`, `arrivedOnOrBefore`, `active` now throws `validation_error` instead of silently dropping them.
- `source: 'auto'` with an unsupported filter still returns the D1 result (no fallback) and includes `_fallback_skipped: 'unsupported_live_filter:<names>'` for transparency.
- 7 new regression tests cover: appointmentId/technicianId/arrived-window-don't-fallback, mixed-filter jobId+technicianId stays D1, live-rejects on each unsupported filter, jobId+modifiedOnOrAfter passes through cleanly. Test count 430 → 437.

## v1.4.1 — 2026-05-06

PR #8 (`feat/shape-inventory-webhooks`): three independently-shippable tracks — response shaper, inventory + payroll pack, webhook hardening. Tool count **66 → 74**; test count **316 → 398** (+82).

### Track 1 — Response shaper
- New `src/response-shape.ts` exporting `excludeFields`, `limitArrays`, `abbreviateKeys`, `defaultShaper`, `DEFAULT_EXCLUDED_FIELDS`, `RESERVED_KEYS`. Strips ST envelope noise (`paginationToken`, `requestId`, `eTag`, `_links`, `_meta`) and caps top-level arrays before MCP serialize.
- New optional `transformResult?: (result: unknown) => unknown` field on `ToolDef`; applied in `registerTool` between handler return and audit/serialize.
- Adopted on 3 high-payload smoke-test tools: `customer_snapshot` (with `limitArrays {jobs:25, invoices:25, estimates:25, locations:10}`), `job_closeout_report`, `st_list_customers`. Mechanical rollout to the remaining ~63 tools deferred to a follow-up PR.

### Track 2 — Inventory + payroll pack (8 new tools)
| Tool | Endpoint |
|---|---|
| `inventory_vendors_list` | `/inventory/v2/tenant/{tid}/vendors` |
| `inventory_warehouses_list` | `/inventory/v2/tenant/{tid}/warehouses` |
| `inventory_receipts_list` | `/inventory/v2/tenant/{tid}/receipts` |
| `inventory_transfers_list` | `/inventory/v2/tenant/{tid}/transfers` |
| `payroll_payrolls_list` | `/payroll/v2/tenant/{tid}/payrolls` |
| `payroll_non_job_timesheets_list` | `/payroll/v2/tenant/{tid}/non-job-timesheets` |
| `payroll_location_rates_list` | `/payroll/v2/tenant/{tid}/locations/rates` |
| `payroll_settings_get` | `/payroll/v2/tenant/{tid}/payroll-settings` |

All use `transformResult: defaultShaper`. Slim transforms default `active`/`*_id` fields to `null` (not `true`). Endpoint paths verified against `MeltanoLabs/tap-service-titan` (Singer tap) — several plan paths corrected (e.g. `/timesheets` → `/payrolls`, `/settings` → `/payroll-settings`, `/purchase-orders` deferred as export-only).

### Track 3 — Webhook hardening
- `ACCEPTED_EVENT_TYPES` allowlist on `webhook-ingest.ts` limited to 4 events from the Velocity n8n trigger node (verified 2026-05-06): `appointmentScheduled`, `jobCompleted`, `paymentReceived`, `customerCreated`. Unknown types now return 400 with `{error: 'unknown_event_type', received: <type>}`.
- Reads canonical `x-servicetitan-event` header before falling back to body fields.
- Per-event metric emission via `env.MCP_METRICS.writeDataPoint({indexes: [eventType], blobs: ['webhook'], doubles: [1]})` — cardinality bounded at 4.
- New migration `0003_webhook_event_index.sql` adds composite index `(event_type, received_at)` for type-filtered queries.

### Tests
- 316 → 398 tests (+82). `npm run check` clean.

### Deferred to v1.5
- Mechanical shaper rollout to the remaining ~63 tools.
- Inventory PO list (export-pattern API, deferred until `from`-token argument shape is added).
- Numeric slim fields default `0` → `null` for clearer "missing" semantics.
- Webhook `x-servicetitan-event-id` header read (currently `eventId` still comes from body).


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
