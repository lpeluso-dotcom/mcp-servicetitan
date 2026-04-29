# mcp-servicetitan

QSC ServiceTitan MCP server — a Cloudflare Worker that exposes 65 ST tools (reads + write-gated mutations + L5 composites + 1 admin gateway) to Claude Code via the Model Context Protocol.

**Status:** v1.2 (cumulative: F1 telemetry probe, F1.5 Inspector smoke, F3 partial-failure helper, H1 write-tool factory, H3 DO hibernation tests, D4 marketing_roas removed, v1.2 ST API expansion — `stEndpoint` descriptor + `/admin/endpoints` route + 3 new tools `st_get_capacity_slots`, `st_run_report`, `st_post_marketing_attribution`). v1.0.0 was the super-MCP build that shipped 2026-04-23.

## Architecture

```
Claude Code  ──Streamable HTTP/MCP──▶  mcp-servicetitan (Cloudflare Worker)
                                              │
                          ┌───────────────────┼─────────────────────┐
                          ▼                   ▼                     ▼
                    own D1 qsc-mcp-st   service binding         Durable Objects:
                    audit_log, error_log,    TAYLOR_AI       StRateLimiter (per ST family)
                    confirmation_tokens,        │            CustomerSnapshotSingleflight
                    mcp_roles, mcp_cache,       ▼            (per customerId fanout guard)
                    endpoint_registry,    /api/st/read
                    materialized views    /api/st/write
                                                │
                                                ▼
                                        ServiceTitan API
                                        (OAuth from taylor-ai)
```

- **Transport:** Cloudflare Agents SDK `createMcpHandler` (Streamable HTTP) — replaces the v0.1 custom JSON-RPC handler.
- **Per-request McpServer:** required post-SDK-1.26.0 — shared instances are a known cross-request state-bleed vuln.
- **Auth at the boundary:** every tool call writes to `audit_log` (surface=`servicetitan`), errors to `error_log`. `/admin/*` routes guarded by `X-Sync-Key`.
- **Read path:** `ReadRouter` is implemented as future infrastructure but not yet wired into individual tools — every read currently goes live via `/api/st/read` proxy on taylor-ai. D1-first migration is a v1.2 question.
- **Write path:** two-phase `WriteGate` — `dryRun: true` returns a 15-min HMAC `confirmation_token`; `dryRun: false` + valid token executes via `/api/st/write` proxy. `confirmation_token` reuse, expiry, HMAC tampering, and tool-name forging are all enforced.
- **Composites:** L5 fanout tools (`customer_snapshot`, `job_closeout_report`) use `gatherFetches` for explicit per-call partial-failure attribution. No silent empty arrays.

## Tool catalog (v1.2)

64 default-role + 1 admin-role (`st_call`) = 65 total. Full breakdown:

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
| T8 Tasks | 2 | `create_task`, `list_open_tasks` |
| T9 Admin gateway | 1 | `st_call` *(role=admin only)* |
| T11 Reporting (v1.2) | 1 | `st_run_report` *(mode discriminator: list_categories \| list_reports \| describe_report \| run)* |
| T12 Marketing-attribution (v1.2) | 1 | `st_post_marketing_attribution` *(kind discriminator: job \| web_booking \| web_lead_form \| external_call)* |
| C10–C12 Composites | 9 | `customer_snapshot`, `pricebook_health_check_services`, `job_closeout_report`, `margin_audit`, `membership_outreach_list`, `dispatch_override_audit`, `call_quality_review`, `commercial_plumbing_opportunities`, `membership_jackpot_leaderboard` |
| Siro | 3 | `siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement` |

Removed in v1.1 D4: `marketing_roas` (stub blocked on three external MCPs that don't exist; cleaner-stub > stub-that-lies).

Deferred:
- `pricebook_health_check_materials_equipment` — needs taylor-ai nightly sync of `pb_materials` + `pb_equipment` (cross-repo).
- `/webhooks/st` HMAC ingest — no producer yet.
- D1-first read routing for the 25 single-fetch tools — v1.3 mechanical pass.
- 3 D1-first ST endpoints from the 2026-04-28 gap audit — deferred to Phase 2 until corresponding D1 tables land.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | none | MCP Streamable HTTP — Inspector + Claude Code |
| `GET /health` | none | Liveness + tool count + version |
| `GET /admin/roles` | `X-Sync-Key` | List role assignments from `mcp_roles` |
| `GET /admin/metrics` | `X-Sync-Key` | 1h call summary + 24h top tools + 1h error tops |
| `GET /admin/health/audit` | `X-Sync-Key` | Last-activity probe — returns `last_audit_ts`, `is_silent`, `_hint` for diagnosis |
| `GET /admin/endpoints` | `X-Sync-Key` | ST endpoint inventory — per-tool `stEndpoint` descriptors + undeclared list (v1.2) |
| `POST /webhooks/st` | (501) | Reserved for v1.3 |

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
- `MCP_SYNC_KEY` — bearer for taylor-ai write proxy + `/admin/*` routes
- `SIRO_API_TOKEN` — Siro org API token

## Verifying telemetry

After every cut, the operator should run:

```bash
curl -H "X-Sync-Key: $MCP_SYNC_KEY" \
     https://mcp-servicetitan.lpeluso.workers.dev/admin/health/audit | jq .
```

Expected on a healthy worker: `is_silent: false`, `last_audit_age_ms` near zero. If `is_silent: true`, the `_hint` field points at the most likely cause — a stale URL in `~/.claude.json` is the v1.0 cutover trap. See [docs/mcp/v1.1/RUNBOOK.md](docs/mcp/v1.1/RUNBOOK.md) for the diagnostic procedure.

## Registering with Claude Code

User-level (`~/.claude.json`):

```json
{
  "mcpServers": {
    "mcp-servicetitan": {
      "type": "http",
      "url": "https://mcp-servicetitan.lpeluso.workers.dev/mcp",
      "headers": { "X-Sync-Key": "<MCP_SYNC_KEY>" }
    }
  }
}
```

Workspace (`qsc-infra/.mcp.json`) takes precedence inside that workspace.

## Environment

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | own database `qsc-mcp-st` (prod `5380b37c-…`) / `qsc-mcp-st-dev` (`74007593-…`) |
| `TAYLOR_AI` | service | taylor-ai worker, used for `/api/st/read`, `/api/st/write`, `queryD1` RPC |
| `TAI_STATE` | KV | shared with taylor-ai for heartbeat keys |
| `MCP_METRICS` | Analytics Engine | p50/p95/p99 + error-rate timeseries |
| `ST_RATE_LIMITER` | Durable Object | per-ST-family adaptive rate limiter (Retry-After-aware) |
| `CUSTOMER_SNAPSHOT_FLIGHT` | Durable Object | per-customerId fanout guard for `customer_snapshot` |

## Source-of-truth design

- Architecture: `qsc-infra/docs/mcp/ST-MCP-DESIGN.md`
- v1.1 plan: `~/.claude/plans/bubbly-napping-muffin.md`
- Runbook: [docs/mcp/v1.1/RUNBOOK.md](docs/mcp/v1.1/RUNBOOK.md)
- Protected modules: `qsc-infra/.claude/rules/protected-modules.md`
- Latest drift log: `qsc-infra/docs/audit/DRIFT-2026-04-23.md`

## See also

- `qsc-infra/docs/mcp/TEMPLATE.md`
- `qsc-infra/docs/ST-API.md`
- taylor-ai `src/gate-st.js` (OAuth, write proxy)
