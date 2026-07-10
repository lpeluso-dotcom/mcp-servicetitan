# mcp-servicetitan

ServiceTitan MCP server - a Cloudflare Worker that exposes 87 ST tools (86 default-role + 1 admin-only gateway) to Claude Code via the Model Context Protocol. Tools span reads, write-gated mutations, L5 composites, and raw API access.

**Status:** v1.5.1 - see [CHANGELOG.md](CHANGELOG.md) for full history. 87 tools (86 default + 1 admin), CI validation for PRs/pushes, manual Cloudflare deploy workflow. Integration guide at [docs/INTEGRATION.md](docs/INTEGRATION.md).

**Publication note:** this is a single-tenant ServiceTitan integration. Share the code for review, not a live production MCP endpoint or credentials. `POST /mcp` requires either `Authorization: Bearer <JWT>` or `X-Sync-Key`; `/health` is the only intentionally public runtime endpoint.

## Architecture

```
Claude Code  ──Streamable HTTP/MCP──▶  mcp-servicetitan (Cloudflare Worker)
                                              │
                          ┌───────────────────┼─────────────────────┐
                          ▼                   ▼                     ▼
                    own D1 mcp-servicetitan   service binding         Durable Objects:
                    audit_log, error_log,    ST_PROXY       StRateLimiter (per ST family)
                    confirmation_tokens,        │            CustomerSnapshotSingleflight
                    mcp_roles, mcp_cache,       ▼            (per customerId fanout guard)
                    endpoint_registry,    /api/st/read
                    materialized views    /api/st/write
                                                │
                                                ▼
                                        ServiceTitan API
                                        (OAuth from servicetitan-proxy)
```

- **Transport:** Cloudflare Agents SDK `createMcpHandler` (Streamable HTTP) — replaces the v0.1 custom JSON-RPC handler.
- **Per-request McpServer:** required post-SDK-1.26.0 — shared instances are a known cross-request state-bleed vuln.
- **Auth at the boundary:** `POST /mcp` requires a valid JWT or `X-Sync-Key`; every tool call writes to `audit_log` (surface=`servicetitan`), errors to `error_log`. `/admin/*` routes are guarded by `X-Sync-Key`.
- **Read path:** `ReadRouter` is implemented as future infrastructure but not yet wired into individual tools — every read currently goes live via `/api/st/read` proxy on servicetitan-proxy. D1-first migration is a v1.2 question.
- **Write path:** two-phase `WriteGate` — `dryRun: true` returns a 15-min HMAC `confirmation_token`; `dryRun: false` + valid token executes via `/api/st/write` proxy. `confirmation_token` reuse, expiry, HMAC tampering, and tool-name forging are all enforced.
- **Composites:** L5 fanout tools (`customer_snapshot`, `job_closeout_report`) use `gatherFetches` for explicit per-call partial-failure attribution. No silent empty arrays.
- **Response shaping (v1.4.1):** `ToolDef.transformResult` lets a tool strip ST envelope noise (`paginationToken`, `_meta`, etc.) and cap big arrays before MCP serialize. Adopted on `customer_snapshot`, `job_closeout_report`, `st_list_customers`, plus every v1.5 reader/composite; mechanical rollout to remaining hand-rolled tools deferred to v1.6.
- **Shared ST helper (v1.5.1 / completed v1.6.0):** `src/st.ts` exports `readST(env, ctx, endpoint, query?)`, `readSTPaged(...)`, and `readSTPost(env, ctx, endpoint, body)` (POST-as-read for ST endpoints that require a body). All read tools are migrated to `readST` / `readSTPaged` (as of v1.6.0). Write tools (`st_patch_*`, `st_create_*`, `assign_technicians`, etc.) use the write proxy by design and stay direct.
- **stEndpoint coverage gate (v1.5.1):** every non-exempt tool declares an `stEndpoint` descriptor; `GET /admin/endpoints/coverage` plus a vitest invariant enforce 100% coverage (only `st_call` + 3 Siro tools are exempt).
- **Filter-preservation test harness (v1.5.1):** `src/tools/__tests__/filter_preservation_helper.ts` exposes `assertFilterPreservation(tool, matrix, baseArgs?)` so each tool can declare which filters must be forwarded as query, path, D1 WHERE, or rejected. Generalizes the payroll auto-fallback regression caught in v1.5.

## Tool catalog (v1.5.1)

86 default-role + 1 admin-role (`st_call`) = 87 total. Full breakdown:

| Tranche | Count | Tools |
|---|---|---|
| Legacy F1 | 9 | `st_list_customers`, `st_get_customer`, `st_list_jobs`, `st_list_appointments`, `st_get_pricebook`, `st_patch_service`, `st_create_service`, `st_patch_material`, `st_create_material` |
| T5 CRM | 6 | `find_customer`, `get_customer`, `get_customer_locations`, `list_customer_jobs`, `get_customer_membership`, `add_customer_note` *(H1 factory)* |
| T5 Jobs | 8 | `get_job`, `list_jobs_today`, `get_job_appointments`, `add_job_note`, `book_job`, `reschedule_appointment`, `hold_appointment`, `assign_technicians` |
| T6 Pricebook | 5 | `search_pricebook_services`, `get_service_details`, `search_materials`, `get_configurable_equipment_children`, `list_service_categories` |
| T6 Invoicing | 4 | `get_invoice`, `list_invoices_job`, `get_invoice_balance`, `list_unpaid_invoices` |
| T7 Estimates | 3 | `list_estimates_job`, `get_estimate`, `update_estimate_status` |
| T7 Dispatch | 5 | `get_capacity`, `list_technicians_available`, `get_technician_shifts`, `list_non_job_events`, `st_get_capacity_slots` *(v1.2 — `/capacity` slot-finder)* |
| T7 Marketing | 3 | `list_campaigns`, `get_campaign_performance`, `create_call_with_campaign` |
| T8 Memberships | 3 | `list_memberships_active`, `list_memberships_expiring`, `create_recurring_service` |
| T8 Calls & Forms | 2 | `get_call`, `get_form_submission` |
| T8 Tasks | 2 | `create_task` *(v1.5 — expanded to 8 ST-required fields)*, `list_open_tasks` |
| T9 Admin gateway | 1 | `st_call` *(role=admin only)* |
| T11 Reporting (v1.2) | 1 | `st_run_report` *(mode discriminator: list_categories \| list_reports \| describe_report \| run)* |
| T12 Marketing-attribution (v1.2) | 1 | `st_post_marketing_attribution` *(kind discriminator: job \| web_booking \| web_lead_form \| external_call)* |
| T12 Inventory (v1.4.1) | 4 | `inventory_vendors_list`, `inventory_warehouses_list`, `inventory_receipts_list`, `inventory_transfers_list` |
| T13 Payroll (v1.4.1) | 4 | `payroll_payrolls_list`, `payroll_non_job_timesheets_list`, `payroll_location_rates_list`, `payroll_settings_get` |
| T13 Payroll (v1.5) | 1 | `payroll_job_timesheets_list` *(D1-first, auto/d1/live modes)* |
| T14 Sales/Opportunities (v1.5) | 2 | `opportunities_list`, `opportunity_get` *(D1-first via mig 0018)* |
| T15 Dispatch Pro (v1.5) | 3 | `dispatch_pro_utilization_list`, `dispatch_pro_ratio_list`, `dispatch_pro_alerts_list` *(D1-first via mig 0022)* |
| T16 Jobs ST-77 (v1.5.1) | 1 | `jobs_hold_reasons_list` *(wraps `/jpm/v2/.../job-hold-reasons`)* |
| C10–C12 Composites | 9 | `customer_snapshot`, `pricebook_health_check_services`, `job_closeout_report`, `margin_audit`, `membership_outreach_list`, `dispatch_override_audit`, `call_quality_review`, `commercial_plumbing_opportunities`, `membership_jackpot_leaderboard` |
| C13 Costing composites (v1.5) | 4 | `job_cost_actuals`, `tech_drive_time_summary`, `assigned_vs_sold_estimate_audit`, `open_opportunities_pulitzer_feed` |
| Siro | 3 | `siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement` |

Removed in v1.1 D4: `marketing_roas` (stub blocked on three external MCPs that don't exist; cleaner-stub > stub-that-lies).

Deferred (v1.6 candidates / post-v1.6.0):
- `pricebook_health_check_materials_equipment` — needs upstream proxy nightly sync of `pb_materials` + `pb_equipment`.
- Mechanical response-shaper rollout to the remaining hand-rolled tools.
- Full filter-preservation coverage of all ~80 tools via the v1.5.1 harness (each tool adopts via one test).
- ST-77.2/77.3 product probes (Equipment auto-attach, Dispatch Pro multi-appointment, FTK dispatch links, Contact Center Pro, Inventory landed costs).
- Tool-pack splitting (default / payroll / dispatch / accounting / pricebook / admin views) for context-pressure mitigation.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | JWT or `X-Sync-Key` | MCP Streamable HTTP — Inspector + Claude Code |
| `GET /health` | none | Liveness + tool count + version |
| `GET /admin/roles` | `X-Sync-Key` | List role assignments from `mcp_roles` |
| `GET /admin/metrics` | `X-Sync-Key` | Multi-period call stats: `period_1h`, `period_24h`, `period_7d` with `error_rate_pct`; `by_actor_24h`; `write_gate_24h` dryRun/confirm/expired counts; top 10 tools + errors |
| `GET /admin/health/audit` | `X-Sync-Key` | Last-activity probe — returns `last_audit_ts`, `is_silent`, `_hint` for diagnosis |
| `GET /admin/endpoints` | `X-Sync-Key` | ST endpoint inventory — per-tool `stEndpoint` descriptors + undeclared list (v1.2) |
| `GET /admin/endpoints/coverage` | `X-Sync-Key` | stEndpoint coverage gate (v1.5.1) — every non-exempt tool must declare `stEndpoint`; reports `total`, `declared`, `exempt`, `undeclared[]` |
| `POST /webhooks/st` | HMAC | HMAC-verified ST webhook ingest (v1.4.1) — event-type allowlist: `appointmentScheduled`, `jobCompleted`, `paymentReceived`, `customerCreated`. Unknown types return 400. Per-event metric to `MCP_METRICS`. |
- [JMT x402 Agent Tools](https://jmt-x402-proxy.jmthomasofficial.workers.dev) — 25 paid x402 endpoints on Base mainnet: web search, AI analysis, crypto/stock data, SEC filings, company intel, news, sentiment, macro dashboard. $0.001-$0.15/call USDC. Local LLM-powered.

## Deploy

```bash
# Install deps + run preflight (28 checks)
npm install
bash scripts/preflight.sh --env dev

# Optional: live smoke against the deployed dev (29th check)
REMOTE=1 bash scripts/preflight.sh --env dev

# Deploy
npx wrangler deploy --env dev    # dev
npx wrangler deploy              # prod (top-level env)

# Verify via Inspector smoke
bash scripts/inspector-smoke.sh dev   # or prod
```

Required wrangler secrets (set once via `wrangler secret put`):
- `MCP_SYNC_KEY` — bearer for servicetitan-proxy write proxy + `/admin/*` routes
- `SIRO_API_TOKEN` — Siro org API token
- `ST_WEBHOOK_SECRET` — ServiceTitan webhook HMAC secret
- `JWT_SECRET` — HS256 signing secret for JWT client auth; use at least 32 random bytes

## Verifying telemetry

After every cut, the operator should run:

```bash
curl -H "X-Sync-Key: $MCP_SYNC_KEY" \
     https://mcp-servicetitan.example.workers.dev/admin/health/audit | jq .
```

Expected on a healthy worker: `is_silent: false`, `last_audit_age_ms` near zero. If `is_silent: true`, the `_hint` field points at the most likely cause, usually a stale client URL or an idle deployment.

## Observability

Every tool call writes a row to D1 `audit_log` via `ctx.waitUntil` (non-blocking — never adds to tool latency). Every error writes to `error_log`. Analytics Engine (`MCP_METRICS` binding) receives a data point per call with tool name, actor, status, and latency.

**Admin metrics endpoint:**
```bash
curl -s -H "X-Sync-Key: $MCP_SYNC_KEY" \
  https://mcp-servicetitan.example.workers.dev/admin/metrics | jq '{
    "1h": .period_1h,
    "24h": .period_24h,
    "error_rate_pct": .period_24h.error_rate_pct,
    "top_tools": .top_tools_24h[0:3],
    "write_gate": .write_gate_24h
  }'
```

**Analytics Engine SQL queries** (8 pre-built panels — p50/p95/p99 latency, error rate by tool, calls by actor, composite fanout, write-gate activity):
```bash
# See scripts/query-metrics.sql for full query set
# AE schema: blob1=tool, blob2=actor, blob3=status, double1=latency_ms
```

**Grafana Cloud dashboard**: wire a Cloudflare Analytics Engine datasource to `mcp_servicetitan_metrics` dataset. See `docs/observability.md` for setup, panel queries, and alert configuration. Dashboard JSON at `docs/observability/dashboards/mcp-servicetitan.json`.

## Registering with Claude Code

User-level (`~/.claude.json`):

```json
{
  "mcpServers": {
    "mcp-servicetitan": {
      "type": "http",
      "url": "https://mcp-servicetitan.example.workers.dev/mcp",
      "headers": { "X-Sync-Key": "<MCP_SYNC_KEY>" }
    }
  }
}
```

Workspace-level MCP config takes precedence inside that workspace.

JWT clients can send `Authorization: Bearer <JWT>` instead. The JWT must be signed with `JWT_SECRET`, include a non-empty `sub`, and may include `actor` plus `role: "default"` or `role: "admin"`.

## Environment

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | own database for audit logs, errors, confirmation tokens, roles, cache data, and endpoint registry |
| `ST_PROXY` | service | upstream ServiceTitan proxy worker, used for `/api/st/read`, `/api/st/write`, and `queryD1` RPC |
| `PROXY_STATE` | KV | optional shared heartbeat namespace |
| `MCP_METRICS` | Analytics Engine | p50/p95/p99 + error-rate timeseries |
| `ST_RATE_LIMITER` | Durable Object | per-ST-family adaptive rate limiter (Retry-After-aware) |
| `CUSTOMER_SNAPSHOT_FLIGHT` | Durable Object | per-customerId fanout guard for `customer_snapshot` |

## Public Deployment Notes

- Replace placeholder Cloudflare resource IDs in `wrangler.toml`.
- Set `ST_TENANT_ID` to your own ServiceTitan tenant ID before deploying.
- Point the `ST_PROXY` service binding at your own upstream ServiceTitan proxy.
- Keep production URLs and credentials out of public issues and pull requests.
