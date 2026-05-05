# margin_audit → ServiceTitan Reporting API: verification follow-up

**Status:** open. Logged 2026-05-04 alongside the v1.4 pagination fix in `src/tools/composites/margin_audit.ts`.

## Why this exists

`margin_audit` rolls up `revenue`, `cost`, and `margin` for a business-unit / date-range by summing `invoiceTotal` and `totalCost` over `/jpm/v2/.../jobs`. v1.4 fixed the silent single-page truncation bug by paginating up to 4,000 jobs (20 pages × 200) via `pagedStRead`, with `_truncated: true` surfaced when the cap is hit.

A native ServiceTitan saved-report would be a stronger long-term answer: dashboard-matched numbers, no JPM pagination overhead, and a single rate-limited call instead of up to 20. But we have no verified report ID for this tenant whose output matches what `margin_audit` computes today. Until that ID is verified, the paginated rollup is the source of truth.

This doc captures the verification path so a future session can promote the tool without re-discovering the steps.

## Verification path

The `st_run_report` tool already exposes the ServiceTitan Reporting API via four modes:

1. `st_run_report mode=list_categories` — discover the `category` tree. Candidate categories worth inspecting: any category named `Accounting`, `Operations`, `Performance`, `Financial`, `Margin`, or `Profitability`.
2. `st_run_report mode=list_reports categoryId=<n>` — list saved reports under each candidate category. Filter by name keywords: `margin`, `revenue`, `cost`, `gross profit`, `business unit`, `period`.
3. `st_run_report mode=describe_report categoryId=<n> reportId=<m>` — confirm the report's parameter shape and output dimensions. The candidate must accept (or be filterable to):
   - a business-unit dimension (parameter or output column), and
   - a completed-on date window (`from` / `to`, or a fixed period).
   The candidate must produce, per row or as totals:
   - revenue (gross before adjustments),
   - cost (labor + materials + equipment + subcontract),
   - margin (or revenue − cost).
4. `st_run_report mode=run categoryId=<n> reportId=<m> parameters=[…]` — pull a single window for a single business unit, save the JSON, and compare against `margin_audit` numbers for the same window.

## Acceptance criterion

A saved report is acceptable if, run with the same `businessUnitIds + completedOnOrAfter + completedBefore`, it produces revenue and cost figures within rounding (±$1) of what `margin_audit` returns today.

If the report's totals differ by more than $1, investigate the divergence before promoting — the gap usually means one side is including something the other isn't (e.g., adjustments, write-offs, voided invoices, refunds).

## Decision rule for v1.5

- **If a verified report exists**: migrate `margin_audit` to call `st_run_report` (or call the underlying `/reporting/v2/.../report-categories|reports|data` endpoints directly via `pagedStRead`). Add a thin `st_intel_revenue_summary` tool that fans the same report across multiple business units and returns a shaped `byBusinessUnit` rollup.
- **If no verified report exists**: keep `margin_audit` on `pagedStRead`. Document the absence here and revisit on the next ServiceTitan release that adds new saved reports for this tenant.

## Why we did not migrate in v1.4

The v1.4 brief was explicit: *"if there is a verified ServiceTitan Reporting API report that returns dashboard-matched margin/revenue/cost for the requested dimensions, migrate margin_audit to that report. Otherwise, implement or reuse a shared pagination helper..."* The pagination helper landed; the migration is gated on the verification above and is logged as a follow-up rather than guessed at.
