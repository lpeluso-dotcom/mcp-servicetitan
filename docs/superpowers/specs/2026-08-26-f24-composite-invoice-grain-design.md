# F-24 — closeout/cost composites: preserve invoice grain + disclose omissions

**Date:** 2026-08-26
**Source:** tai-connectors-review-2026-08-25.md finding **F-24** (Medium, Grain/tool contract).
**Repo:** `mcp-servicetitan`. **Branch:** `codex/ralph-f24-composite-invoice-grain` (stacked on F-11 for its helpers).

## Problem

`job_closeout_report` and `job_cost_actuals` collapse a 1:N invoice relation to `invoiceData[0]` — an unordered first row — and label the result as the full closeout/cost. A job with a base invoice + an adjustment silently returns whichever invoice is first and omits the rest, "calling itself full." Both also use the raw `gatherFetches`/`stRead` (rate-limiter bypass, same class as F-11).

Report's prescribed fix: *"Preserve invoice arrays and their grain, or require a deterministic invoice role/type. The response must disclose omissions and may not call itself full."*

## Decision (consistent with F-11 disclose-not-paginate)

Reuse the F-11 primitives (`stReadGuarded`, `gatherFetchesWithTruncation`). The two tools differ in how they use the invoice, so the fix differs:

### job_closeout_report
- Keep `invoice: firstInvoice` (back-compat; existing test + LLM callers expect it).
- **Add `invoices: <full array>`** — preserves grain.
- **Add `_invoice_count`** and, when the invoices list itself was paginated, **`_truncated`** from the guarded helper.
- Route the 3-arm fanout through `stReadGuarded`.
- Description no longer implies the single `invoice` is complete.

### job_cost_actuals
- Keep `invoice: firstInvoice` — its labor-burden math is designed around one invoice.
- **Add `_invoice_count`** and **`_invoices_omitted: boolean`** (`count > 1`) so it does not present the single invoice as the whole set.
- Route its 1-arm invoice fanout through `stReadGuarded`.

No pagination loop (disclose-not-paginate). No change to the burden computation or to `job` / per-tech rollups.

## Testing (unit, mocked ST_PROXY.fetch; no live ST)

1. `job_closeout_report`: a jobs-invoices response with two invoices → `invoices` has 2 rows, `invoice` is the first, `_invoice_count === 2`. Existing `invoice`/`_partial` tests stay green.
2. `job_closeout_report`: an invoices response with `hasMore:true` → `_truncated` includes `invoices`.
3. `job_cost_actuals`: two invoices → `invoice` is the first, `_invoice_count === 2`, `_invoices_omitted === true`; one invoice → `_invoices_omitted === false`.
4. Both: the fanout consulted the rate limiter (`ST_RATE_LIMITER.get` called).
5. Existing `v15_composites` / `c10` assertions stay green.

**Gate:** full suite + typecheck + wrangler dry-run. Adversarial review before PR.

## Out of scope
Deploy, merge, live ST calls, pagination, the burden formula, and the other composites (each its own finding). Stacked on F-11 — merge order: F-11 (#115) then this.
