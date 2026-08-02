# Design: fix invoice-write tools — probe-confirmed payload shapes + post-write verify-read

Date: 2026-07-31
Status: draft v2 (post adversarial-panel review, 30 findings incorporated), pending Luke review
Supersedes-in-part: `2026-07-31-invoice-write-tools-design.md` — note that spec's
tools shipped in modified form (write path `/api/st/write`, not the spec'd
`durableWrite()` helper; the jobId-link feature was dropped as API-impossible).
Do not use the superseded spec for mechanics; the Confirmed Ground Truth
section below is the baseline.

## Problem

The two invoice-write tools shipped this morning (PR #85) were executed live for
the first time on the Basso non-job-revenue fix (project 76790146) and **both
silently failed on the money-bearing field while returning HTTP success**:

1. `st_create_adjustment_invoice` POSTed
   `{adjustmentToId, lineItems, businessUnitId}` to
   `/accounting/v2/tenant/{tid}/invoices`. ST created adjustment invoice
   **84402274** (ref `83058736-1`, `adjustmentToId` correctly set) but the
   `lineItems` array was **silently ignored** — the invoice came back with
   `items: null`, total $0.00. The field name was a documented best-guess that
   was never live-confirmed.
2. `st_add_invoice_line_item` PATCHed an HI1 line onto job invoice **83052705**.
   The item **was** appended (item id **84402146**) but landed at **price $0.00**
   — dynamic pricing does NOT compute on API-appended items, and `price` is
   confirmed absent from `InvoiceItemUpdateRequest` (silently ignored). The job
   invoice still totals $0.00.
3. Systemic: both tools treat HTTP 200 as success. Neither re-reads the invoice
   to confirm the monetary effect landed. Silent no-op is the worst failure
   mode this codebase has hit (twice today) and nothing currently guards it.

Net prod state right now: the original defect on project invoice **83058736**
($9,771, `job: null`, Exported, batch 7729) is untouched; job invoice 83052705
carries one inert $0 HI1 line (item 84402146); stray empty adjustment invoice
84402274 sits against 83058736.

## Scope (agreed with Luke 2026-07-31)

- **End-to-end**: make the full two-invoice move work via API. Basso is the
  acceptance test. The other 7 known defect cases are out of scope for this
  effort but must be unblocked by it.
- **Prod only**: no ST integration/sandbox tenant exists (confirmed: no
  `api-integration.servicetitan.io` creds anywhere in mcp-servicetitan or
  taylor-ai; everything is hardwired to `api.servicetitan.io`).
- **Probe subject**: stray invoice **84402274** is the designated live test
  subject. Populating it correctly completes the **adjustment-invoice half** of
  Basso's fix (the job-invoice half is Phase C step 2); a failed test leaves
  nothing worse than what's already there.
- Approach 1 chosen (probe → fix → verify-read → live acceptance), degrading
  to a hybrid (ST internal UI API for the operations the public API can't do)
  **only** if probing proves the public API cannot set a price anywhere.

## Confirmed ground truth (do not re-derive; live-probed 2026-07-31 on prod tenant 431848990)

- `PATCH /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items` takes ONE
  flat item per call (`InvoiceItemUpdateRequest`): `id` (nullable), `skuId`
  (nullable), `skuName`, `description` (required), `quantity` (required),
  `cost`, `technicianId`. **No `price`** — silently ignored, like every
  unknown field (ASP.NET model binding). Omitting `id` = append
  (`CreateInvoiceItemAsync`), which resolves the item BY SKU and 500s
  ("Sku (Name:) is not found.") without `skuId`/`skuName`.
- An invoice's **job link cannot be changed** via the public API. The invoice
  update model is only `summary`/`dueDate`/`reviewStatus`. Not revisited here.
- `POST /accounting/v2/tenant/{tid}/invoices` **requires** top-level
  `adjustmentToId` — verified via an empty-body probe that 400'd naming
  `adjustmentToId` as a required property (so presence-validation runs at the
  binding/validation layer, before any create). The endpoint is catalogued as
  "create adjustment invoice". Live-verified to create an invoice when a valid
  parent id is supplied. **Items field name on this create model: UNKNOWN**
  (that's Phase A's job).
- ST accepts and silently drops unknown body fields → a wrong field-name guess
  looks like success. Wrong-TYPE values on real fields, by contrast, produce
  400 binding errors that echo the field name — that's the probe primitive.
  **Corollary (panel finding): a wrong-type probe on a field that does NOT
  exist binds cleanly and the request proceeds** — so every probe must also
  carry a guaranteed binding failure ("anchor", below) or it risks becoming a
  live write.

## Phase A — probing (prod; guaranteed-400 by construction)

**The anchor rule (mandatory on every write-path probe):** every A1/A2 probe
body includes `"adjustmentToId": "not-a-number"` — a wrong-TYPE value on the
one field confirmed to exist and be required on the create model. This
guarantees a 400 binding error on every request regardless of whether the
candidate field exists, so no probe can degenerate into a well-formed create.
Place the candidate field before the anchor in document order (harmless if
ASP.NET aggregates binding errors; fail-fast-safe if it doesn't). Read the
400 body's field-name echoes: candidate named → field exists on the model;
only `adjustmentToId` named → candidate unknown.

**Safety rails (mandatory):**
- **A0 — preconditions**: via the read path, confirm invoice id 999999999 does
  not exist (`GET /invoices?ids=999999999` → empty) and record it. Re-read
  84402274, 83052705, 83058736 as the pre-probe baseline.
- **2xx hard stop**: any 2xx from any probe is an immediate abort. Record the
  returned id, verify state via the read path, log to the memory graph, and
  surface to Luke for UI cleanup before any further probe is sent.
- **Send-once discipline**: each probe is sent exactly once; on timeout, check
  via the read path before any re-send (st-write-safety ambiguous-failure
  rule applies to probes, not just tool writes).
- **Worker invocation**: probes go through the direct worker path
  (`POST /api/st/write` with `{endpoint, method, payload}`). The worker adds
  no retries (single fetch — verified). A4's DELETE must be expressed as
  `method: "DELETE"` in the POST body — a literal HTTP DELETE to
  `/api/st/write` hits the worker router's own 404 (Hono plain body, no ST
  ProblemDetails/traceId), which must never be read as an ST result.

**Probes:**

- **A1 — items field name on the create model**: anchored probes
  `{"<candidate>": 123, "adjustmentToId": "x"}` for candidates `items`,
  `lineItems`; if neither echoes, widen (`invoiceItems`, `itemModels`,
  `item`) before concluding the create model takes no items.
- **A2 — nested item model** (only after A1 confirms a field name): anchored
  probes with a one-element array under the confirmed field, wrong-typing one
  nested candidate at a time: `price`, `quantity`, `skuId`, `skuName`,
  `description`, `generalLedgerAccountId`, `businessUnitId`, `type`, `cost`.
  Interpretation: nested candidate echoed → exists; only the anchor echoed →
  ambiguous (nested binding may not run while the top-level anchor fails). Use
  `quantity` as the positive control: if wrong-typed `quantity` does NOT echo
  under the anchor, nested echoes are being masked — switch to per-request
  single-field probing with the anchor moved after the array in document
  order, and only then interpret absence as nonexistence.
- **A3 — `POST /invoices/{id}/items`** (distinct verb from the confirmed
  PATCH): (1) fingerprint the gateway's route-not-found response first with a
  control probe to a known-garbage path under the same prefix
  (`POST .../invoices/999999999/definitely-not-a-route`), comparing status AND
  body shape (ST ProblemDetails with traceId vs gateway generic). (2) If
  fingerprints differ, probe with wrong-typed `price` in the body against the
  999999999 URL — a 400 echoing `price` proves route + field in one shot,
  before any existence ambiguity. (3) An ST-shaped 404 with no echo = route
  exists, `price` not on its model. Also wrong-type-probe `id` on this model
  (update-with-price capability is a distinct question from append-with-price).
- **A4 — `DELETE /invoices/{id}/items/{itemId}`**: existence probe against
  999999999/999999999, classified against the A3 gateway fingerprint by body
  shape, not status alone: fingerprint-matching 404 = no route; ST-shaped
  404 = route exists; 2xx/204 = exists and idempotent (record; no cleanup
  needed — the target ids don't exist).
- **A5 — decision point** (present findings to Luke before Phase B):
  - A bind-echo on `price` is a **provisional** price-capable verdict — it
    proves the field exists on the model, not that the value is honored at
    persist time (bind-success-is-not-effect is this spec's founding lesson;
    ST could still recompute/zero it). True confirmation only comes from
    Phase C's verify-read. The hybrid fallback stays armed until then.
  - If a provisional price-capable path exists (A2 or A3): pure public-API
    plan, hybrid armed as fallback.
  - If no public path accepts price anywhere: hybrid — the
    `st-internal-api` replay (Luke's session curl) covers the price-set on
    **both** sides: job invoice 83052705's line AND the adjustment invoice's
    line (84402274 or replacement). If the internal API can't either, the
    adjustment side falls back to full UI completion by Luke, and the tools
    ship with honest descriptions of the limitation. The decision tree is
    total: every branch ends with both invoices priced by a named mechanism.

Every finding gets written to the memory graph entity
`mcp-servicetitan invoice-write tool gap (spec 2026-07-31)` and to this
spec's addendum.

## Phase B — tool fixes (TDD, per confirmed shapes only)

**Shared: extend `src/errors.ts`.** Add `'silent_noop'` and
`'verify_unavailable'` (and `'amount_mismatch'`, below) to the closed
`McpErrorCode` union — they are not legal values today and `new
McpError('silent_noop', …)` would not compile. `mapUpstreamStatus` and
existing code-switching consumers are unaffected (verify while implementing).

**Shared: verify-read contract** (both tools, after any `dryRun=false` write):

1. Re-read the target invoice via the same `ids`-filter read path, **with the
   same ids-honored guard** (`Number(data[0].id) !== expectedId` → treat as
   verify failure, never compare against an arbitrary invoice).
2. Outcome taxonomy:
   - Write returned HTTP error → `upstream_error` (unchanged) — except in
     two-step mode, see below.
   - Invoice **absent** from the read (HTTP 200, empty data — the normal
     read-after-write-lag signature) or read itself timing out → retry with
     backoff (2s, 10s), then `verify_unavailable`. The write may have landed;
     do NOT auto-retry the write.
   - Invoice returned, intended effect present → success with
     `verified: true` + actual totals + affected ids.
   - Invoice returned, money-bearing effect **missing** (expected items
     absent, or total unchanged when a change was intended) → `silent_noop`,
     naming every created/modified id so nothing is stranded invisibly.
   - Invoice returned, items present but total ≠ intent → `amount_mismatch`
     (distinct from silent_noop), with expected vs actual.
3. "Intended total" is defined as `sum(price × quantity)` over submitted
   lines, compared against the invoice's `subTotal` (pre-tax; QSC adjustment
   lines here are untaxed — state actuals in the response either way). When
   the confirmed path is **not** price-capable, verify-read asserts item
   presence/count only and the success response carries `verified: true,
   unpriced: true` — behaving-as-documented is never `silent_noop`.

### `st_create_adjustment_invoice`

- Payload rebuilt to the A1/A2-confirmed field names. No speculative fields.
- **Guard dispositions** (complete current list, per panel finding — "keep
  unchanged" was underspecified):
  - non-empty lineItems, parent `not_found`, ids-honored, Posted/Exported
    parent, no adjustment-of-adjustment, TOCTOU token binding → survive
    unchanged.
  - Equipment-requires-price+cost guard and the `offsetAmount` netting warning
    both depend on a `price` input field: they survive only in the
    price-capable branch. In a no-price branch they are removed along with
    the `price` schema field (see below) and `offsetAmount` is dropped from
    the schema (its arithmetic is meaningless without caller-set prices).
- **Two-step mode**: used when the create model takes no items at all, OR
  when A2 shows create-time items are not price-capable but A3's items path
  is (panel finding: this combination previously had no defined behavior).
  POST creates the bare adjustment invoice; the confirmed items path then
  populates it — one dryRun/confirm cycle, preview showing both steps.
  **Any failure after the create step (HTTP error, silent_noop,
  verify_unavailable, amount_mismatch) must name the just-created invoice id
  and carry the stray-invoice warning** — never recreate the invisible-
  stranding failure mode.

### `st_add_invoice_line_item`

- If A3 found a price-capable items path: rebuild on it (keep the per-item
  sequential-call model only if the confirmed shape requires it).
- If price is settable on no public path: `price` is **removed from the Zod
  schema and a non-null `price` input is rejected with `validation_error`**
  (not accepted-and-warned — accepting an input ST will silently drop is the
  exact pattern under repair). Tool description states plainly that appended
  items land unpriced under QSC dynamic pricing and points at the hybrid path.
- **Append verification** must be lag-proof and duplicate-proof (panel
  finding: 83052705 already carries an inert HI1 line, so "exists by SKU"
  false-positives): baseline-read the invoice's item ids immediately before
  the write (inside the confirmed execute, not at dryRun time), then verify
  by item-count delta / new item id not in the baseline.
- **Update verification** (id present — a path the prior spec forgot): re-read,
  locate the item by id, compare the fields that were sent
  (description/quantity/cost) against the returned item; mismatch →
  `silent_noop`.

### Optional (scope-gated): `st_delete_invoice_item`

Only if A4 confirms DELETE exists AND the Basso fix needs it (i.e., the only
way to price 83052705's line is delete-and-re-add). Full dryRun/token/audit
pattern; verify-read asserts the item id is gone from the re-read. Not built
otherwise.

## Phase C — live acceptance (Basso, with Luke's go-ahead at each write)

1. **Adjustment side.** Populate **84402274** in place with the single offset
   line: HI1, qty 1, price −9,771.00, GL 4000 (27035271), BU 257 — via
   whichever path Phase A/B confirmed. dryRun preview → Luke approves →
   execute → verify-read. Fallbacks in order:
   - Only create-time items work → create a NEW fully-populated adjustment
     invoice; 84402274 is then deleted by **Luke via the ST UI before the
     step-4 close-out** (it is Pending/unbatched — UI-deletable). Acceptance
     is not blocked on the deletion, but it must be tracked (memory-graph
     observation + surfaced in the close-out report) so the stray isn't
     dropped.
   - No public price path anywhere → hybrid: internal-API price-set on
     84402274's line (per A5), manually verified (below).
2. **Job-invoice side.** Get the $9,771 HI1 line onto **83052705**. The two
   capabilities are distinct (panel finding) — map by probe result:
   - A3 confirmed **update-with-price** (`id` + `price` on its model) → price
     the existing item 84402146 in place. Preferred: no duplicate line ever
     exists.
   - A3 confirmed **append-with-price** only → append a new priced HI1 line,
     then remove the inert $0 item 84402146 via `st_delete_invoice_item` (if
     A4 confirmed) or flag it for Luke's UI deletion (same tracking rule as
     the stray invoice). The $0 duplicate is NOT silently tolerated.
   - No public price path → hybrid internal-API price-set on item 84402146.
   Same dryRun → approve → execute → verify-read cycle for tool writes.
3. **Hybrid-write verification rule**: any internal-API write is un-audited by
   design (no qsc-mcp-st audit_log row — noted limitation, motivation for
   keeping this branch last-resort). It must be followed by the same manual
   verify-read (`get_invoice`) with results recorded in this spec's addendum
   and the memory graph.
4. **Acceptance re-read** of all three invoices (83052705, 83058736, 84402274
   or its replacement), asserting:
   - job invoice 83052705: total **$9,771.00**, job link intact (83052702),
     **exactly one** HI1 line (no inert $0 duplicate remaining, unless
     explicitly flagged-and-tracked for UI deletion).
   - project invoice 83058736: **unchanged** ($9,771.00, Exported, batch 7729).
   - adjustment invoice: total **−$9,771.00** against 83058736.
   - Net project revenue change: **$0.00** — the fix re-attributes, it does
     not change what was billed. Basso paid in full; nothing customer-facing
     moves (adjustment sentStatus stays NotSent).
5. Close out: update the memory graph (probe findings; Basso → fixed; other
   7 → unblocked; any pending UI deletions), and append actuals to this spec.

## Testing

- Unit (existing `st_write_tools.test.ts` pattern — mock `DB.prepare` +
  `ST_PROXY.fetch`):
  - payload-shape assertions against the A1/A2-confirmed field names (written
    AFTER Phase A; they encode its findings).
  - verify-read paths: mock post-write read returning the invoice with
    matching effect → `verified: true`; returned-but-effect-missing →
    `silent_noop` naming ids; returned-but-wrong-total → `amount_mismatch`;
    **empty data → backoff retries then `verify_unavailable`** (distinct
    from silent_noop), asserting the write was NOT re-sent; ids-filter
    dishonored on the verify-read → `verify_unavailable`.
  - two-step mode: create-succeeds-items-fail must surface the created id.
  - Existing validation-guard tests keep passing **modulo fixture updates to
    the confirmed line-item shape** — the current fixtures hardcode `price`
    inside `lineItems`, the netting test does price arithmetic, and the
    confirm-path test asserts `payload.lineItems` verbatim; all of those are
    rewritten to the confirmed shape, with the guard *semantics* unchanged
    in the branches where the guards survive (see dispositions above).
- Live: Phase C itself is the acceptance test; every write dryRun-previewed
  and Luke-approved first.

## Out of scope

- The other 7 defect cases (separate pass once the tools are proven on Basso).
  Several involve deposit lines — the offset must exclude the deposit; that's
  payload content, not tool capability, but the runbook for that pass must
  call it out.
- Job-link reassignment (confirmed impossible via public API).
- Any change to QSC's upstream invoicing convention that creates these
  project-invoice defects in the first place (tracked separately; see memory
  entity `QSC install-invoicing reconciliation pattern (2026-06-26)`).
- Hard-blocking writes to Exported invoices (unchanged warn-only stance — no
  accounting stakeholder has ratified a block).

## Risks

- **Prod probing**: mitigated by construction — the anchor rule makes every
  write-path probe 400 unconditionally; A0 verifies the sentinel id is
  nonexistent; the 2xx hard-stop is the safety net if both fail.
- **84402274 as test subject**: already stray; worst case it gains a wrong
  line. Pending/unbatched → ST UI cleanup is trivial and QSC-internal; it
  never reaches the customer (sentStatus NotSent).
- **Accounting visibility**: the adjustment nets to zero and the parent is
  already Exported/batched; the new adjustment invoice will itself need to be
  posted/exported by accounting in their normal flow. Luke owns telling
  accounting the adjustment exists (same as the manual Dembowski case).
- **ST removes/changes the undocumented behaviors**: verify-read converts any
  future silent regression into a loud error at the moment it happens.

## Decision log

- 2026-07-31 Approach 1 (probe→fix→verify) chosen over internal-API-first and
  hybrid-first; hybrid only as a proven-necessity fallback — now with a total
  decision tree (every branch prices both invoices by a named mechanism).
- 2026-07-31 No sandbox: confirmed absent; prod probing with the anchored
  400-technique + 84402274 as live subject, per Luke.
- 2026-07-31 Verify-read added to both tools as a permanent requirement — an
  invoice-write tool may never again report success without confirming the
  monetary effect. New error codes `silent_noop` / `verify_unavailable` /
  `amount_mismatch` added to the McpErrorCode union to carry the distinction.
- 2026-07-31 Adversarial panel (3 cold-context lenses, 30 findings: 3
  blockers, 14 majors) drove v2: probe anchoring, total fallback tree,
  lag-aware verify taxonomy, guard dispositions, duplicate-line handling,
  stray-invoice tracking, schema-level rejection of droppable inputs.
