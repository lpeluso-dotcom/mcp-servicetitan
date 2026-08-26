# F-11 — customer_snapshot: disclose truncation + rate-limit the fanout

**Date:** 2026-08-26
**Source:** tai-connectors-review-2026-08-25.md finding **F-11** (High, Performance/correctness).
**Repo:** `mcp-servicetitan` (TAI-ST). **Decision (Luke, 2026-08-26):** disclose-not-paginate.

## Problem

`customer_snapshot` fires six parallel ST list reads (`locations`, `jobs`, `memberships`, `estimates`, `invoices`, + `customer`) via `stRead`, then caches the assembled snapshot in `mv_customer_snapshot` for 5 minutes. Two defects:

1. **Silent truncation.** `gatherFetches` runs each response through `extractStData`, which returns only `.data` — ST's top-level `hasMore` is discarded. A customer with more than one page of jobs/invoices/etc. gets **page one only**, with no signal, and the incomplete result is cached as if complete.
2. **Rate-limiter bypass.** `stRead` is a raw `env.ST_PROXY.fetch` — it does not go through `guardedStFetch`, so the six concurrent calls never consult the reporting/CRM family limiter.

## Decision: disclose, do not paginate

Keep the single-fire composite fast. Do **not** loop pages. Instead:

- Surface a `_truncated` map naming every list arm where ST returned `hasMore: true`, so a partial snapshot is **disclosed** to the caller, not served silently as complete.
- Route the fanout through `guardedStFetch` so the calls respect the family limiter.
- **Do not cache a truncated snapshot** — if any arm is truncated, skip `mvWrite` (a fast, complete re-read next call is better than a cached lie). A complete snapshot caches as before.

## Components

- `src/composite-helpers.ts` — `gatherFetches` must preserve `hasMore` per call alongside `.data`. Add a sibling that returns `{ results, partial, failures, truncated }` where `truncated: string[]` lists call names whose response had `hasMore === true`. Keep the existing `gatherFetches` signature intact (other composites use it); add the richer behavior without breaking them.
- `src/composite-helpers.ts` — the fanout in `customer_snapshot` must use a rate-limited read. Add `stReadGuarded(env, headers, endpoint, signal)` that wraps `stRead` in `guardedStFetch(env, endpoint, () => stRead(...), {})` (family parsed from the endpoint). `customer_snapshot` switches its six calls to it.
- `src/tools/composites/customer_snapshot.ts` — thread `truncated` into the result as `_truncated`, and gate `mvWrite` on `truncated.length === 0`.

## Testing (unit, mocked ST_PROXY.fetch; no live ST)

1. A `jobs` response with `hasMore: true` → result carries `_truncated: ['jobs']` and the snapshot is **NOT** written to `mv_customer_snapshot`.
2. All arms `hasMore: false` (or absent) → `_truncated: []` and the snapshot **IS** cached (existing behavior preserved).
3. The six fanout calls go through `guardedStFetch` → the limiter `/check` fires (assert the DO received the calls).
4. Existing `customer_snapshot` and `composite-helpers` tests stay green (no regression to `gatherFetches` consumers).

**Gate:** full suite + typecheck + wrangler dry-run. Adversarial review before PR.

## Out of scope

Deploy, merge, live ST calls, and any change to the other composites' pagination (each is its own finding if needed). No change to `paged-st-read.ts`.
