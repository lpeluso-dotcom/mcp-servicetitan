# F-09 — search_materials returns non-matches (unsupported ST filters)

**Date:** 2026-08-26
**Source:** tai-connectors-review-2026-08-25.md finding **F-09** (High, Semantic/correctness).
**Repo:** `mcp-servicetitan`. **Branch:** `codex/ralph-f09-search-materials-filter` (off main).

## Problem

`search_materials` promises fuzzy `name`/`categoryId` filtering. ST's `/pricebook/v2/tenant/{tid}/materials` endpoint **silently ignores** `name`/`categoryId` (honours only `active`/`ids`, per QUA-951 tenant evidence, verified live 2026-08-04). So:
- `code=NO-SUCH-CODE` → D1 miss → falls through to live ST with `name=<code>` → ST ignores it → returns an **arbitrary unfiltered first page** presented as matches.
- A `name`/`categoryId` query does the same: unfiltered page that looks like a real match.

## Scope note

The report flagged three files at snapshot `@a54fdc0`. Two — `st_get_pricebook.ts` and `search_pricebook_services.ts` — were **already fixed by QUA-951** on current main (both call `rejectUnsupportedSTFilters` and return a true empty on a code miss). **Only `search_materials.ts` still has the bug.** This fix brings it to parity with its sibling.

## Fix — mirror the QUA-951 pattern used in search_pricebook_services

1. Call `rejectUnsupportedSTFilters(args, { name, categoryId }, correlation)` at the top of the handler — reject `name`/`categoryId` with a `validation_error` pointing to `search_pricebook_all({query})` for fuzzy name/description matching (and client-side category filtering).
2. On a D1 exact-code **miss**, return a **true empty result** with a `_note` (never fall through to an unfiltered ST page). Mirror the sibling's shape: `{ materials: [], _source: 'd1-exact', _matched_code: null, _note, ...freshness }`.
3. The live path forwards only `active`/`page`/`pageSize` to ST (drop `name`/`categoryId` from the query object).
4. Update the schema descriptions for `name`/`categoryId` to "NOT SUPPORTED by ServiceTitan on this endpoint" and the tool description to route fuzzy search to `search_pricebook_all`.

No new dependency — `rejectUnsupportedSTFilters` is exported from `src/st.ts` (already used by the two siblings).

## Testing (unit, mocked ST_PROXY.fetch)

1. `name` provided → throws `validation_error` (NOT forwarded to ST). *(replaces the existing `'passes name filter'` test, which asserted the bug.)*
2. `categoryId` provided → throws `validation_error`.
3. `code` with no D1 row and no live match → returns `materials: []`, `_matched_code: null`, a `_note` — and makes **no** unfiltered ST call, OR if it does list, the empty is honest. (Mirror sibling: on code miss, return empty, do not call ST.)
4. **Negative test (report-required):** upstream ST deliberately returns unrelated rows; assert the tool does NOT present them as matches for a filtered query (because the filter now rejects before the call).
5. Plain listing (`active`/`page`/`pageSize` only, no name/category) → still lists live. `empty args` and `_source` tests stay green.

**Gate:** full suite + typecheck + wrangler dry-run. Adversarial review before PR.

## Out of scope

Deploy, merge, live ST calls, the two already-fixed siblings, and any change to the exact-code D1 path or freshness stamping.
