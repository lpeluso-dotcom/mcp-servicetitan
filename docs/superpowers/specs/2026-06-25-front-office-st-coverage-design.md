# Front-Office ServiceTitan Coverage — Design

- **Date:** 2026-06-25
- **Owner:** Luke Peluso (Business Systems Manager, QSC)
- **Repo:** `mcp-servicetitan` (`lpeluso-dotcom/mcp-servicetitan`, `/home/taylor/work/mcp-servicetitan/`)
- **Tenant:** ServiceTitan `431848990`
- **Status:** Design — approved scope: **both phases committed** (2026-06-25). Pending spec review → writing-plans.

## ANCHOR-PROBLEM

QSC office staff — **front-office CSRs, dispatch/scheduling, and sales/install coordinators** — use Claude in the office through the **TAI-ST connector**, which is the `mcp-servicetitan` worker (v1.6.0, ~85 read tools). They are **"very disappointed."** Verified failure (all four modes confirmed by the owner 2026-06-25): (1) coverage — the data they want isn't queryable in a usable shape; (2) quality/staleness; (3) discoverability — they don't know what to ask; (4) speed/errors.

Root cause is **tool shape, not missing data**. The current catalog is almost entirely **single-record** (`get_job`, `get_invoice`, `find_customer`) or **narrow lists** (`list_jobs_today`, `list_invoices_job`). There is no general list/filter, no job-level full-context composite, no notes search, and no flexible ad-hoc query. Meanwhile the data is **already synced into taylor-ai D1** every 2h (`ST_SYNC` cron).

The owner's framing: *"only ~17 entities and ~400 endpoints; expand utilization of our data in D1 to improve the semantic layer."* The disappointed users are **all on ServiceTitan**; only Luke + Jessica use the Woz/QBO (finance) connectors — **so this work is scoped to ST, not Woz.**

## GOAL / SUCCESS-CRITERIA

A front-office CSR / dispatcher / coordinator can, through the connector they already use, reliably get:

1. **List / cross-record answers** — "all jobs for tech X this week," "open estimates in 295xx not followed up," "jobs on hold by reason."
2. **Full context in one shot** — "everything on this job": job + appointments + invoice + line items / **materials used** + **job times** + notes + assigned tech + status.
3. **General lookups** — jobs, job times, pricebook, materials used, invoice info, notes, location, job history (owner's own list).
4. **The long tail** — arbitrary operational questions ("just general things") without a bespoke tool per question.

Measurable definition of done:
- Phase 1 ships the flexible tools below; each returns in < ~2s p50 against D1.
- Phase 2 ships a guarded ad-hoc query tool that answers a held-out set of real office questions.
- The **read-only office connector is deployed** (no write tool reachable by office users).
- Adoption is **measured** (`audit_log` actor tagging) and reviewed with the actual staff before declaring success.

## NON-GOALS (YAGNI)

- NOT exposing all 217 ST entities. We expose the operational set the office actually asks about.
- NOT a second connector or new login for office users.
- NOT any change to Woz / QBO / the finance semantic layer (different users).
- NOT any **write** capability for office users (read-only role only).
- NOT a new sync pipeline — we read the existing taylor-ai D1 mirror.

## ARCHITECTURE

### Surface
- All new capability is built into **`mcp-servicetitan`**, additive: new files under `src/tools/<category>/`. **No protected file is modified** (`read-router.ts`, `write-gate.ts`, `write-tool-factory.ts`, `composite-helpers.ts`, `st.ts`, `st-path-builder.ts`, `durable/*`, baseline migrations).
- New tools are **D1-first** (taylor-ai prod `ba02a8c6-…` via the existing `queryD1` RPC / `/api/st/read` service binding) with **live-ST fallback** only where a record may be newer than the 2h sync. D1-first keeps the office off the live ST rate limit and is fast/cheap.
- Office access = the **`readonly` role** + the **`POST /c/<token>/mcp`** Claude-Desktop route already implemented on branch `lab-fields-v170` (added 2026-06-16): 71 read tools, **zero write tools registered**, URL-path token is the credential, invalid token → plain 401 (no `www-authenticate`, so Claude doesn't attempt OAuth). This route is **coded but not deployed** — deploying it is part of this work.

### Data sources (verified present in taylor-ai D1, 2026-06-25)
`jobs`, `appointments`, `appointment_assignments`, `invoices`, `invoice_items`, `estimates`, `estimate_templates`, `customers`, `customer_contacts`, `customer_notes`, `locations`, `memberships`, `technicians`, `technician_skills`, `job_timesheets`, `non_job_appointments`, `calls`, `pb_services`, `pb_materials`, `pb_equipment`, `pb_categories`, `job_types`, `installed_equipment`, `recurring_service_events`, `forms`, `form_submissions`.

### Tool-coverage invariant
The repo enforces `/admin/endpoints/coverage`: every non-exempt tool must declare an `stEndpoint`. List/D1 tools that mirror a single ST endpoint declare it; the Phase 2 ad-hoc query tool is **declared exempt** (same mechanism as `st_call` + the 3 Siro tools) since it maps to no single endpoint.

## PHASE 1 — Flexible coverage tools *(committed)*

Principle: **few flexible tools with rich optional filters** beat dozens of narrow tools (smaller catalog = better discoverability for non-technical staff and Claude). Each tool: D1-first, parameterized SQL (`.prepare().bind().all()`, never string interpolation, never `.exec()`), bounded result set (default 50 / max configurable cap), CSR-readable field names in the response, plain-English description written for a CSR.

| Tool | Purpose / covers | Key filters | Primary D1 source(s) |
|---|---|---|---|
| `list_jobs` | "All jobs for tech X this week," "jobs on hold by reason," "today/this week's board by BU" | technicianId, dateFrom/dateTo (via Appointments `start`), status, businessUnit, jobType, holdReason, customerId, locationId, limit | `jobs` ⋈ `appointments` ⋈ `appointment_assignments` |
| `job_360` | "Everything on this job" — the missing job-level composite | jobId | `jobs` + `appointments` + `invoices` + `invoice_items` (materials used) + `job_timesheets` (job times) + `customer_notes` + `technicians` |
| `list_estimates` | "Open estimates not followed up," by BU/age/status | status, followUpState, businessUnit, ageDays, technicianId, limit | `estimates` (+ `jobs` for context) |
| `search_notes` | "Find the note about X," location/install notes | query (keyword), customerId, jobId, dateFrom/dateTo, limit | `customer_notes` (+ job-note source if present) |
| `job_history` | "This customer's history" — timeline of jobs + outcomes | customerId, locationId, dateFrom/dateTo, limit | `jobs` + `invoices` + `appointments` |
| `list_memberships` | "Memberships expiring next month," active/by-type | status (active/expiring/expired), type, dateFrom/dateTo, limit | `memberships` |

Scheduling/capacity questions reuse existing `get_capacity` / `list_technicians_available` / `st_get_capacity_slots` / `get_technician_shifts`; Phase 1 adds only thin convenience wrappers if the existing tools don't already answer "is tech X free Thursday" / "what's on the board tomorrow" cleanly (decided during planning, not assumed here).

**Note**: `customer_snapshot` already provides customer-360 (customer + jobs + invoices + memberships); `job_360` is the deliberate counterpart at job grain. We do not duplicate `customer_snapshot`.

## PHASE 2 — `query_operations` ask-anything *(committed)*

A single guarded read-only SQL tool over a **curated allow-list** of operational taylor-ai D1 tables/views, so the long tail ("just general things") is answerable without a tool per question.

**Security model (carries the Wave-0 / QUA-348 ship-blocker lessons verbatim):**
- **AST allow-list gate, NOT regex.** Parse the SQL; permit only a single `SELECT`; reject anything else. (Reviewers reproduced `SELECT 1; SELECT 2` returning two result sets through a regex gate — do not repeat that.)
- **Fail-closed default-deny** on table/column: only allow-listed tables and non-denylisted columns.
- **Single statement only** — reject multi-statement input; run via `.prepare().bind().all()`, never `.exec()`.
- **Hard row cap** (1000) injected/enforced server-side (D1 has no statement-timeout API; cap rows_read defensively).
- **No writes** — gate rejects any non-SELECT; tool is registered only for read roles.
- **PII policy:** office staff are *authorized* to see customer contact + job data (it is their job), so customer name / phone / email / service address are **allowed** for the internal office role. The denylist covers genuinely sensitive fields only — payment-card / banking / SSN / employee-comp columns — which are excluded from the allow-listed projection. (This differs from Woz, where external-analytics use required salted-hash; here the consumers are internal CSRs.)
- **Audit** every call via `obs.audit()` with the office actor tag.

**Discoverability:** a `describe_operations` helper (or rich tool description) lists the allow-listed tables + columns in plain English so Claude can construct correct SELECTs and staff know what exists.

**Reuse:** port/adapt the proven `mcp-hopper` AST allow-list gate (`whiteListCheck`) rather than writing a new gate; point it at taylor-ai D1 via `queryD1` with its own table allow-list + column denylist.

## CROSS-CUTTING

### Indexes (prerequisite, ships before/with Phase 1)
taylor-ai prod shows a full-table-scan / read-amplification signature (~148B rows_read/mo, ~445k rows/query). Opening list + ad-hoc query surfaces **without** indexes would worsen the "slow/errored" complaint and the D1 read bill. Add a taylor-ai migration (`NNNN_front_office_indexes.sql`) with candidate indexes validated against `EXPLAIN QUERY PLAN` + measured elapsed time (planner row-estimates are unreliable on D1):
- `appointments(technician_id?, start)` / `appointment_assignments(technician_id, job_id)` — list_jobs by tech + date.
- `jobs(business_unit_id)`, `jobs(job_type_id)`, `jobs(customer_id)`, `jobs(job_status)` — list_jobs / job_history filters.
- `invoices(job_id)`, `invoice_items(invoice_id)` — job_360 / job_history.
- `customer_notes(customer_id)`, `customer_notes(job_id)` — search_notes.
- `estimates(status)`, `estimates(job_id)` — list_estimates.
- `memberships(status)` / expiry column — list_memberships.

Exact column names + index set finalized during planning by reading live schema; this list is the candidate set, validated by EXPLAIN before commit. Indexes are additive and reversible (paired `DROP INDEX` rollback per migration etiquette).

### Discoverability for non-technical staff
- Every new tool description is written **for a CSR**, not an engineer (concrete example questions in the description).
- A short "What you can ask Claude" one-pager for the office (the named question archetypes above).

### Adoption gate / measurement
- `audit_log` already tags MCP traffic by actor; office connector tokens get a distinct actor tag so we can see real usage by tool.
- After Phase 1 + the readonly-connector deploy, review actual usage with the disappointed staff before declaring success. (Owner pattern: builds stall at ~80% without an adoption check — this is the check.)

## TESTING

- Per-tool unit tests (vitest) — the repo invariant is "every new handler gets a test"; current suite is ~517 green.
- **Filter-preservation tests** for every list tool (reuse `src/tools/__tests__/filter_preservation_helper.ts`) — guards the ST "silently-ignored filter" class.
- Phase 2: gate tests asserting (a) multi-statement rejected, (b) non-SELECT rejected, (c) non-allow-listed table rejected, (d) denylisted column never returned, (e) row cap enforced, (f) no write tool reachable by `readonly` role.
- Index migration validated on `taylor-ai-dev` (`28848a36-…`) before prod, with row-count + elapsed-time before/after.

## SECURITY

- Office surface = `readonly` role only (zero write tools registered) + `/c/<token>/mcp` token-as-credential, fail-closed 401.
- Phase 2 gate is the highest-risk component — AST allow-list, fail-closed, single-statement, parameterized, row-capped, audited (above).
- Pre-prod security review of the Phase 2 gate before it goes live (owner's belt-and-suspenders QA preset for risk surfaces).

## DEPLOY / SEQUENCING NOTES

- Work branches off a clean base; **do not** entangle the in-flight `lab-fields-v170` WIP. The `readonly`/`/c/<token>` connector code lives on `lab-fields-v170` and must be reconciled (merge/rebase decision is a planning task).
- `mcp-servicetitan` CI auto-deploys from `main`; taylor-ai deploy needs `scripts/preflight.sh`. Apply the index migration via `mcp__claude_ai_Cloudflare_Developer_Platform__d1_database_query` (local CF token lacks D1 scope) — dev first, then prod.
- New worker/route/connector surfaces and the index migration get catalogued in `qsc-infra/.claude/rules/protected-modules.md` before deploy.

## OPEN QUESTIONS (resolve during planning, not blocking design)

1. Exact `readonly`/`/c/<token>` reconciliation: merge `lab-fields-v170` first, or cherry-pick the connector commits onto a fresh feature branch?
2. Which office surface do staff actually connect through — claude.ai TAI-ST connector vs Claude Desktop `/c/<token>` route — and do we need per-user tokens vs one shared office token?
3. Do job-level notes live in `customer_notes` only, or is there a separate job-note source to union in `search_notes`/`job_360`?
4. Whether existing dispatch/capacity tools already answer "is tech X free Thursday" well enough to skip new scheduling wrappers.
