// ============================================================
// chunk.ts — shared batch splitter for the two hard external limits that
// keep breaking L5 composites at scale.
//
// Both limits produce the same failure mode: the code works on a small
// fixture, then 400s / 500s the first time a real date range returns more
// than a page of rows. They get one tested helper instead of another
// hand-rolled `for (i += N)` loop per call site.
// ============================================================

/**
 * Cap on a ServiceTitan simple-IDs lookup (`?ids=a,b,c`). Over the cap ST
 * returns HTTP 400 `{"errors":{"Ids":["Simple IDs lookup should n…"]}}`
 * (ST truncates its own message there).
 *
 * Verified live 2026-07-27/28 against tenant 431848990: a 200-id chunk 400s,
 * a 50-id chunk succeeds. The exact ceiling is somewhere in (50, 200); this
 * stays at the documented-safe 50 rather than probing for the true edge.
 * Mirrors the constant list_jobs_today.ts already applies to its own ids call.
 */
export const ST_IDS_BATCH_MAX = 50;

/**
 * Cap on bound parameters in a single D1 statement. SQLite's default
 * SQLITE_MAX_VARIABLE_NUMBER is 100 on the D1 build; an `IN (?,?,…)` built
 * from a 200-row ST page blows straight through it with
 * `too many SQL variables`. 90 leaves headroom for the handful of non-IN
 * binds a caller may add to the same statement.
 */
export const D1_BIND_PARAM_MAX = 90;

/**
 * Split `items` into consecutive batches of at most `size`, preserving order.
 * An empty input yields no batches (never `[[]]`, which would issue a query
 * with an empty `IN ()` / `ids=`).
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk: size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
