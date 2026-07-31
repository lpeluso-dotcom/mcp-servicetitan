# Design: invoice-write tools for mcp-servicetitan

Date: 2026-07-31
Status: approved, ready for planning

## Problem

QSC has a recurring accounting defect on HVAC Install Residential (BU 257) jobs:
install revenue gets written to a **project-level invoice**
(`invoiceConfiguration: "ProjectInvoice"`, `job: null`) instead of the install
job's own invoice. This makes it "non-job revenue" — it drops out of any
job-keyed report (job costing, margin by job, tech/BU attribution). See
memory: `QSC install revenue query rule (project-invoice trap)` for the
downstream query-side symptoms of this same defect class.

The known-good fix, done once by hand via the ST UI (Dembowski / project
82539024), is a two-invoice move:

1. Populate the install job's own (pre-existing, empty) invoice with the
   install line item(s).
2. Create an **adjustment invoice** against the original project invoice,
   with a negative line item offsetting only the install amount (not any
   deposit, which stays where it was).

`mcp-servicetitan` currently has zero write coverage for invoices — only
`get_invoice` / `get_invoice_balance` (read-only). Every other domain
(pricebook, jobs, appointments, estimates, customers) has purpose-built
`st_*` write tools with the dryRun + confirmation-token + audit-log pattern.
This is the highest-risk domain to still be missing that pattern, since it
touches GL postings directly.

Scale: 8 known instances of the defect as of July 2026 (~$76K total), 7 still
unfixed. Manual UI fixes work but don't scale and leave no
`qsc-mcp-st.audit_log` trail.

## What's being built

Two new tools in `src/tools/invoicing/`, following the existing
`st_create_service` / `st_patch_service` shape exactly:

- Zod schema with `dryRun` (default `true`) + `confirmation_token` (optional).
- `dryRun=true` → `WriteGate.dryRun(...)` returns `{confirmation_token,
  payload, st_endpoint, st_method, expires_in_seconds}`.
- `dryRun=false` + valid token → `WriteGate.verifyToken(...)` then the shared
  `durableWrite()` (imported from `st_patch_service.ts`, same helper every
  existing write tool reuses — no new durable-write plumbing).
- Registered in `src/tools/index.ts` next to the other invoicing imports,
  marked `isWrite: true`.

### 1. `st_add_invoice_line_item`

Adds one or more line items to an existing invoice, and optionally sets the
invoice's `job` link.

**Inputs:**
- `invoiceId` (required)
- `jobId` (optional) — if provided, attempt to set the invoice's job link.
- `lineItems` (required, array, min 1). Field names per the *live* ST GET
  shape confirmed during research (not the untrustworthy third-party spec
  mirror), since a POST/PATCH item body hasn't been independently confirmed
  yet:
  - `skuId` or `skuName`
  - `description`
  - `quantity`
  - `price`
  - `generalLedgerAccountId` (int) — GET returns this as a nested
    `generalLedgerAccount: {id, name, number, type, detailType}` object;
    on write we accept a plain id and let the implementation phase confirm
    whether ST's PATCH body wants the bare id or the nested object.
  - `businessUnitId` (int) — same GET-vs-write shape caveat as above.
  - `type` (optional enum incl. `"Service"`, `"Material"`, `"Equipment"`) —
    live field name is `type`, not the mirror's guessed `skuType`.
- `dryRun` (default `true`), `confirmation_token`.

**Validation:**
- Reject with `validation_error` if `jobId` is given and doesn't belong to
  the same `customerId` as the invoice being modified (sanity check against
  a `get_job` / `get_invoice` read before the write).
- **Exported-invoice guard: warn, don't block.** If the target invoice's
  `syncStatus` is `Exported`, the dryRun preview includes a warning field,
  but `dryRun=false` is still allowed to proceed. (Reverses the original
  spec draft's proposed hard-block — that draft cited an accounting contact
  "Michelle" to confirm the rule with; that name traces to nothing in the
  memory graph or this conversation and appears to have been fabricated.
  There's no real person to check the rule with, so we don't invent a block
  around it. Revisit if/when a real accounting stakeholder weighs in.)
- Equipment-type line items (`type: "Equipment"`) require both `price` and
  `cost` populated — per the established QSC hard fact that equipment (unlike
  services) uses static pricing, a blank price on an equipment row is a real
  $0-billing risk, not a dynamic-pricing non-issue.
- The `jobId`-link PATCH is **best-effort, not guaranteed**: research could
  not confirm whether ST's API allows changing `invoiceConfiguration`/`job`
  on an existing invoice post-creation at all (see Implementation Risk
  below). The known-good real-world precedent (Dembowski) used a job invoice
  that **already existed empty**, pre-created by QSC's own job-invoice
  convention — so the tool's primary path is "add line items to an
  already-job-linked empty invoice," with the job-link PATCH as a secondary,
  unverified capability attempted only when `jobId` is passed and the
  invoice doesn't already have one.

### 2. `st_create_adjustment_invoice`

Creates an adjustment invoice against an existing (Posted/Exported) invoice.

**Inputs:**
- `parentInvoiceId` (required)
- `lineItems` (required, array, min 1) — same shape as tool #1's lineItems.
  Adjustment lines are typically negative to offset revenue, but the schema
  does not hardcode sign — don't silently flip it.
- `businessUnitId` (optional, defaults to parent's BU)
- `invoiceDate` (optional, defaults to today)
- `dryRun` (default `true`), `confirmation_token`.

**Validation:**
- Confirm `parentInvoiceId` exists via a `get_invoice`-style read before
  building the dryRun preview.
- Reject with `validation_error` if the parent invoice is itself an
  adjustment invoice (`adjustmentToId` is non-null) — no
  adjustment-of-adjustment chains without an explicit override flag (not
  building the override flag now; YAGNI until a real case needs it).
- Per ST's own official behavior (help.servicetitan.com/docs/create-an-
  adjustment-invoice, confirmed during research): adjustment invoices can
  only be created against invoices in **Posted or Exported** status. Reject
  with `validation_error` otherwise.
- Warn (don't block) if the adjustment line total doesn't net the parent
  invoice's relevant line to zero — informational only, not all adjustments
  are full offsets.

## Implementation risk — must resolve before merge

Two API-shape facts are **unconfirmed** from any read-only source available
during design (the only "spec" found, a third-party GitHub mirror, actively
disagrees with live GET evidence, and developer.servicetitan.io is a JS SPA
that blocked headless fetch):

1. Whether `invoiceConfiguration`/`job` are PATCH-accepted fields on an
   existing invoice at all.
2. The real endpoint + payload shape for adjustment-invoice creation (a
   `Invoices_CreateAdjustmentInvoice` operation ID surfaced in one AI-search
   summary but has zero independent corroboration — treat as an unverified
   lead only, not ground truth).

**Before either tool is considered done (not just unit-tested against
mocks), the implementation plan must include a step that sends a
deliberately-malformed test request against the ST **sandbox** tenant
(`api-integration.servicetitan.io`) for each endpoint, and reads the
resulting 400 validation-error body's field-name echoes as ground truth.**
This is read-only in effect (no real write lands) and needs no accounting
sign-off. Adjust `zodSchema`/`stEndpoint`/payload-shaping to match whatever
that confirms. Do not ship either tool's live write path on an unconfirmed
guess.

## Testing

Follow the existing `st_write_tools.test.ts` pattern exactly:
- dryRun path: mock `DB.prepare` + `ST_PROXY.fetch`, assert token issuance
  and TTL.
- Validation errors (missing lineItems, cross-customer jobId, non-Posted/
  Exported parent for adjustment, missing price/cost on Equipment lines):
  assert `McpError` with `validation_error`, assert no fetch calls made.
- durableWrite path: reuse the exported `durableWrite()` helper directly
  (already covered generically by existing tests) — new tests only need to
  confirm the `operation` string (`invoice.add_line_item`,
  `invoice.create_adjustment`) and `payload`/`target` shape are correct for
  these two tools specifically.
- Add both to `schemas.test.ts` alongside the other write tools' schema
  coverage.

## Out of scope (YAGNI)

- Adjustment-of-adjustment override flag — no real case yet.
- A "create brand-new job invoice from scratch" mode for tool #1 — the
  Dembowski precedent and QSC's job-invoice convention both point at an
  already-existing empty invoice being the norm; build that path only if
  the sandbox-confirmation step in Implementation Risk reveals it's actually
  required.
- Batch/period-close interaction beyond the Exported-status warn/block
  decisions already specified above.
