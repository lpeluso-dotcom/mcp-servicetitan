# TAI-STV2 Guided-Surface Rebuild + Per-Role Scoping — Design

**Date:** 2026-07-19
**Repo:** `mcp-servicetitan` (the worker behind the **TAI-STV2** Claude connector)
**Author:** Luke Peluso (with Claude)
**Status:** Design — pending Luke's review before an implementation plan.

---

## 1. Problem

The TAI-STV2 connector's "guided surface" — the 5 MCP prompts and 3 MCP resources shown in
Claude's connector picker — was built speculatively ("Phase 2 Task 2.3"), not from how QSC's
back-office staff actually use ServiceTitan. Luke's assessment: the prompts are the **wrong
workflows**, their **output is weak**, they're **too rigid/one-shot**, and the **resources are the
wrong reference data**. Separately, all ~86 tools are exposed to every connected user, which is too
large a surface to route reliably for a non-technical CSR or clerk and offers no guardrail.

**Goal:** rebuild the guided surface around Luke's real recurring workflows, back the genuinely
tool-starved ones with purpose-built tools, source analytical data from the Supabase gold warehouse
where it exists, and scope the exposed surface per role using the same Entra-group pattern already
proven on the TAI-QBO connector.

## 2. Surface decision (why the connector, not a separate chatbot)

Decision research (deep-research run `wf_5b27e922-37a`, 2026-07-19; 8 claims adversarially verified,
2 decision-critical unknowns verified live afterward) concluded the **Claude connector is the right
surface** for QSC back-office staff, and a bespoke chatbot is not worth building:

- **Zero-touch managed auth does not help QSC.** Anthropic's enterprise-managed connector auth is
  (a) **Okta-only at launch** — Entra ID unsupported — and (b) currently covers only a **fixed
  first-party connector roster** (Asana, Atlassian, Canva, Figma, Granola, Linear, Supabase, Slack),
  **not custom connectors**. So on any surface, rollout means "admin enables + each staffer
  authorizes once." That one-time per-user click is tolerable at 5–15 seats.
  (src: claude.com/blog/enterprise-managed-auth; support.claude.com/en/articles/15537633)
- **The Microsoft path (Copilot Studio / Teams) is messier**, not cleaner: MCP auth is a shared
  API key the user provides or per-user OAuth, governed by Power Platform DLP — and the per-user
  identity story is more tangled than TAI-STV2's existing Cloudflare-Access→Entra OAuth. M365
  Copilot rollouts also stall hard (Gartner: 60% pilot → 6% scale → 1% full).
- **The connector keeps our per-user Entra identity + per-role gating intact**, which the Microsoft
  path would compromise.

The tool layer (`mcp-servicetitan`) is surface-agnostic and the durable asset regardless; only the
MCP **prompts** are a Claude-connector-specific UX. Staying on the connector means the prompts are
worth building.

## 3. Data-source rule (gold where it exists, D1/live where it can't)

The canonical analytical store is now the **Supabase gold warehouse** (project
`nlaaliehqpgskjmiuzze`, `gold` schema), not the legacy taylor-ai D1 mirror. Per Luke: source from
gold. But gold's grain is incomplete, so a blanket rule can't hold:

- **Gold has:** `fct_job` (revenue via `job_total_cents`), `fct_invoice_line` (`cost_cents`,
  `total_cost_cents`), `fct_estimate`, `fct_estimate_line`, `fct_membership`; dims for business_unit,
  job_type, lead_source, location, pb_category, sku, truck.
- **Gold LACKS (no grain today):** any timesheet / labor-burden / drive-time / dispatch-pro fact
  (there is **no `fct_timesheet`**), and it lags the Woz sync cadence so it is **too stale for a
  "today" operational view.**

**Ruling (Luke, 2026-07-19):** *gold where it exists, D1/live-ST where gold can't.* Each unit below
is labeled with its source. When Woz later materializes a timesheet/labor fact in gold, the
D1-sourced units (`tech_scorecard`, `drive-time`) can be repointed — tracked as a follow-up, not a
blocker.

Access to gold reuses the existing `src/supabase.ts` helpers (`sbSelect`, `sbRpc`, header auth via
`SUPABASE_PB_KEY` / `SUPABASE_URL`). Reads against `gold`-schema tables need the `Accept-Profile:
gold` header (the read-side analogue of the `Content-Profile` header `sbRpc` already sets for `vec`);
a small extension to `sbSelect` (an optional schema arg) covers this.

## 4. The guided surface (rebuilt)

### 4.1 Prompts (5 — replacing all current)

| Prompt | Args | Backing tool(s) | Source |
|---|---|---|---|
| `job-cost-margin` | `jobId` **or** `businessUnitId`+`from`/`to` | job mode → `job_cost_actuals` (incl. labor burden); BU/window mode → **`gold_margin_by_bu`** (new) | job = D1; BU = **gold** |
| `daily-review` | `date?` | `list_jobs_today` → `get_capacity` → `dispatch_pro_alerts_list` → `jobs_hold_reasons_list` → `list_unpaid_invoices` (brief) | live ST / D1 (freshness) |
| `pricebook-health` | `businessUnitId?` | `pricebook_health_check_services` → `pricebook_markup_drift` → `pricebook_cost_drift` → `pricebook_vendor_part_gaps` | D1 pb_ (catalog config) |
| `weekly-tech-review` | `technicianId?`, `weekOf?` | **`tech_scorecard`** (new) | D1 (labor grain) |
| `drive-time` | `technicianId`, `startDate`/`endDate` | `tech_drive_time_summary` | D1 |

Prompt authoring follows the existing `src/prompts/index.ts` conventions: a `PromptDef` with
`argsSchema` (ZodRawShape, `z.coerce.number()` for numeric wire-string args), a pure `build()`
returning a single user-role text message that names the **exact** tool names, arg mapping, and the
expected output shape. Argument completions (the `completableOptional` pattern) are reused for
enumerable args (`weekOf`, `businessUnitId`, `daysBack`-style windows).

**Dynamic-pricing honesty** carries into `pricebook-health`: never report a `0`/`null` reference
price as "unpriced" (reuse `shapePriceRow`'s `price_basis` convention).

**QBO layering (decision: option a).** `job-cost-margin` is ST/D1/gold-sourced and self-contained.
The prompt *notes* that QBO cost lines can be layered in when the TAI-QBO connector is also connected
in the same session, but never depends on it — no silent degradation.

### 4.2 New tools (2)

**`gold_margin_by_bu`** — Supabase gold aggregation.
- **Returns:** margin by business unit (and optionally job_type) over a date window:
  revenue (`Σ fct_job.job_total_cents`), cost (`Σ fct_invoice_line.cost_cents`), GP$, GP%.
- **Source:** Supabase `gold` schema only.
- **Implementation (decided — Luke, 2026-07-19):** add a `gold.margin_by_bu(p_from, p_to, p_bu_id)`
  Postgres function in **qsc-vector** (a new migration) and call it via `sbRpc(..., 'gold')`,
  matching the `vec.match_entities` pattern (aggregation in-DB, one round trip). The qsc-vector
  migration is a sequenced dependency (authored/reviewed in that repo — see §7).
- Honest labeling: this is **item/material margin** (revenue − invoice-line cost); it does **not**
  include labor burden (no gold labor grain). The tool description must say so.

**`tech_scorecard`** — D1 weekly per-tech rollup (pure SQL, mirrors `tech_drive_time_summary`).
- **Returns:** for one tech or all, over a week: jobs completed, revenue, drive% / windshield cost,
  dispatch-pro utilization + ratio, timesheet hours, assigned-vs-sold estimate gap.
- **Source:** D1 (`job_timesheets`, `technicians`, + the dispatch-pro/estimate D1 sources the
  existing composites already read). No gold grain exists for this.
- This is the single tool that makes "week review / tech questions" answerable in one call instead
  of chaining five brittle ones.

Both register through the existing `ToolDef` registry (`src/tools/index.ts`) and inherit the
`defaultShaper` response shaping and role-gating already applied to every tool call.

### 4.3 Resources (3 — reworked, gold-sourced where a gold dim exists)

| Resource | URI | Change | Source |
|---|---|---|---|
| Technician roster (PII-stripped) | `mcp-st://catalog/technicians` | **keep** (no gold tech dim; feeds tech workflows) | D1 |
| Pricebook category tree | `mcp-st://catalog/pricebook-categories` | **repoint** to `gold.dim_pb_category` | **gold** |
| Business units | `mcp-st://catalog/business-units` | **new** (id, name, active) — **replaces** the dropped report catalog | **gold** (`gold.dim_business_unit`) |

The `technicians` resource keeps its explicit allow-list mapper (never spreads the raw row; only
`tech_id, name, business_unit, role, active`). The dropped `reports` resource is removed because
none of the five workflows run native ST reports.

## 5. Per-role connector scoping (Entra-group pattern, mirrors TAI-QBO)

**Motivation:** guardrails + adoption matter more than power-user flexibility. Exposing all ~86
tools to a CSR is both a routing problem (the model mis-selects) and a guardrail gap. QSC already
solved this shape on the **TAI-QBO connector**: an **Entra security group governs a Cloudflare
Access application/policy** (who may complete the connector login), and the worker serves a
**scoped surface** for that identity.

**Mechanism to replicate (no new SaaS):**
1. **Entra groups** (ops, existing pattern): one security group per persona — `QSC-Dispatch-CSR`,
   `QSC-Sales`, `QSC-Accounting`, `QSC-All`.
2. **Cloudflare Access** (ops): Access policy(ies) gate the connector on group membership. The
   worker's OAuth already federates Access→Entra and resolves a per-user identity (`src/oauth.ts`,
   `ALLOWED_EMAILS` defense-in-depth re-check).
3. **Worker role → surface filter** (code, this repo): extend the existing `Role` model
   (`src/auth.ts`, today `admin|default|lockdown|readonly`) with a **persona/surface-profile**
   resolved from the OAuth'd identity. Each persona declares an **allow-list of tool names + prompt
   names + resource URIs**; `buildServer()` registers **only** that persona's surface. Persona is
   resolved from the identity the same way QBO keys its scoped surfaces — an `email → persona`
   mapping (extendable to an Entra `groups`/`roles` claim if Access is configured to forward one).

**Persona → surface (4 personas — Luke, 2026-07-19; initial surface cut, adjustable):**

| Persona (Entra group) | Prompts | Representative tools |
|---|---|---|
| **Dispatch-CSR** (`QSC-Dispatch-CSR`) | `daily-review`, `drive-time` | capacity, jobs-today/appointments, dispatch-pro, tech lookup, customer find/snapshot, memberships expiring + outreach (front-office) |
| **Sales** (`QSC-Sales`) | quote/estimate follow-up | estimates, open opportunities (pulitzer feed), assigned-vs-sold audit, proposal tiers, customer snapshot |
| **Accounting** (`QSC-Accounting`) | (AR-focused) | unpaid invoices, invoice + balance, customer lookup |
| **All** (`QSC-All`) | **all 5 prompts** | full tool surface incl. `job-cost-margin` (`gold_margin_by_bu`), `tech_scorecard`, `pricebook-health` — subject to existing role gating |

Membership outreach folds into **Dispatch-CSR** (front office) rather than its own persona; the
analytical prompts (`job-cost-margin`, `pricebook-health`, `weekly-tech-review`) are **All**-only.

**Scope guard:** the persona filter is **additive to**, not a replacement for, the existing
per-call role gating (write tools stay behind `default`/`admin`; `readonly`/`lockdown` still apply).
A persona can only ever **narrow** what a role already permits.

## 6. Testing (TDD)

Follow the repo's existing test conventions (`src/**/__tests__`, `src/__tests__`):
- **Prompts:** extend `src/__tests__/prompts.test.ts` — each new prompt asserts `build()` names the
  correct tool(s), maps args, and (for completions) exposes the expected option list. Watch each
  test fail first.
- **Resources:** extend `src/__tests__/catalog-resources.test.ts` — the new `business-units`
  resource, the repointed `pricebook-categories` (gold), and the retained PII-stripped
  `technicians` allow-list (assert phone/email can never leak even if the row carries them).
- **New tools:** unit tests for `gold_margin_by_bu` (GP math; gold-only source; labor-exclusion
  labeling) and `tech_scorecard` (per-tech rollup; one-tech vs all; empty-window degrades cleanly),
  mirroring `margin_audit` / `tech_drive_time_summary` test patterns.
- **Per-role scoping:** tests that a given persona's `tools/list` and `prompts/list` expose only its
  allow-listed surface, and that the persona can never widen a role's write permission.
- **Coverage gate:** update `src/tools/__tests__/coverage_gate.test.ts` and `schemas.test.ts` for
  the two new tools.

## 7. Scope

**In scope:** the 5 prompts, 2 new tools, 3 resources, `sbSelect` `Accept-Profile` extension, and
per-role surface filtering in the worker (+ the persona allow-lists).

**Out of scope / follow-ups:**
- The `gold.margin_by_bu` RPC migration lives in **qsc-vector** — sequenced as a dependency of
  `gold_margin_by_bu`, but authored/reviewed in that repo (or replaced by in-worker aggregation).
- Cloudflare Access applications + Entra security groups are an **ops task** (mirroring QBO), not
  worker code — done alongside deploy, not in this repo's plan.
- Materializing `fct_timesheet` in gold (would let `tech_scorecard` / `drive-time` move to gold) is
  a separate Woz/qsc-vector data-engineering effort.

## 8. Decisions resolved

1. **`gold_margin_by_bu`** → new `gold.margin_by_bu` RPC in **qsc-vector** (in-DB aggregation).
   *(Luke, 2026-07-19)*
2. **Persona set** → 4 personas: Dispatch-CSR / Sales / Accounting / All (membership folds into
   Dispatch-CSR; analytical prompts are All-only). *(Luke, 2026-07-19)*
3. **Surface stays the Claude connector** (not a chatbot), per the §2 research verdict + Luke's
   stated preference.

_No open questions remain; pending Luke's final review of this spec before the implementation plan._
