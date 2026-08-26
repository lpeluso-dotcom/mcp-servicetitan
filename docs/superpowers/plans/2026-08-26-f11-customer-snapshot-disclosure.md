# F-11 customer_snapshot Disclosure + Rate-Limit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Stop `customer_snapshot` from silently serving/caching a truncated first page, and route its fanout through the rate limiter — without paginating (disclose-not-paginate, Luke 2026-08-26).

**Architecture:** `gatherFetches` gains a variant that preserves ST's per-arm `hasMore` alongside `.data`; `customer_snapshot` surfaces a `_truncated: string[]` of arm names with more pages, routes its six reads through `guardedStFetch`, and skips the `mv_customer_snapshot` write when anything is truncated.

**Tech Stack:** TypeScript, Cloudflare Workers, vitest.

## Global Constraints

- No deploy, no merge, no live ST calls. Do NOT edit protected modules; import only.
- Do NOT change `gatherFetches`'s existing signature/behavior for its other consumers — add new behavior alongside.
- `_truncated` is an array of arm names (customer_snapshot has 6 arms; a boolean would lose which). Additive field; no existing test asserts it on this tool.
- A truncated snapshot must NOT be cached.

**Key interfaces:**
- `guardedStFetch(env, endpoint, run: () => Promise<Response>, opts?): Promise<Response>` from `./rate-limit-guard` (parses family from endpoint, does limiter `/check`).
- `stRead(env, headers, endpoint, signal?): Promise<Response>` from `./composite-helpers` (raw proxy fetch).
- `extractStData<T>(json): T` returns `.data` (drops `hasMore`).
- `gatherFetches(calls: NamedCall[]): Promise<{results, partial, failures}>`.

**Files:** `src/composite-helpers.ts` (modify), `src/tools/composites/customer_snapshot.ts` (modify), `src/tools/__tests__/c10_composites.test.ts` (add tests).

---

### Task 1: `gatherFetchesWithTruncation` + `stReadGuarded` in composite-helpers

**Files:** Modify `src/composite-helpers.ts`; Test `src/tools/__tests__/f3_composite_helpers.test.ts` (add).

**Interfaces produced:**
- `stReadGuarded(env, headers, endpoint, signal?): Promise<Response>` — `guardedStFetch(env, endpoint, () => stRead(env, headers, endpoint, signal))`.
- `gatherFetchesWithTruncation(calls: NamedCall[]): Promise<FanoutResult & { truncated: string[] }>` — like `gatherFetches`, but reads each response as `{data, hasMore}` (via a new internal parse that keeps `hasMore`), returns `results` = the `.data` (identical shape to today), plus `truncated` = names where `hasMore === true`.

- [ ] **Step 1: Write failing test** in `f3_composite_helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gatherFetchesWithTruncation } from '../../composite-helpers';

function resp(body: unknown) { return Promise.resolve(new Response(JSON.stringify(body), { status: 200 })); }

describe('gatherFetchesWithTruncation', () => {
  it('flags arms whose ST response has hasMore:true, and returns .data as results', async () => {
    const out = await gatherFetchesWithTruncation([
      { name: 'jobs', promise: resp({ data: [{ id: 1 }], hasMore: true }) },
      { name: 'invoices', promise: resp({ data: [{ id: 2 }], hasMore: false }) },
      { name: 'locations', promise: resp({ data: [{ id: 3 }] }) }, // hasMore absent
    ]);
    expect(out.results.jobs).toEqual([{ id: 1 }]);
    expect(out.truncated).toEqual(['jobs']);
    expect(out.partial).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`gatherFetchesWithTruncation` not exported).
Run: `npx vitest run src/tools/__tests__/f3_composite_helpers.test.ts -t truncation --pool=threads --maxWorkers=1`

- [ ] **Step 3: Implement.** Add to `src/composite-helpers.ts` (do NOT touch existing `gatherFetches`/`extractStData`):

```ts
/** Like extractStData but also reports ST's top-level hasMore flag. */
function extractStPage<T = unknown>(json: unknown): { data: T; hasMore: boolean } {
  if (json !== null && typeof json === 'object') {
    const obj = json as { data?: T; hasMore?: boolean };
    if ('data' in obj) return { data: obj.data as T, hasMore: obj.hasMore === true };
  }
  return { data: json as T, hasMore: false };
}

/** guardedStFetch-wrapped stRead, so composite fanouts respect the family limiter. */
export function stReadGuarded(
  env: Env,
  headers: Record<string, string>,
  endpoint: string,
  signal?: AbortSignal,
): Promise<Response> {
  return guardedStFetch(env, rewriteTenantPlaceholders(env, endpoint), () =>
    stRead(env, headers, endpoint, signal),
  );
}

/**
 * gatherFetches + per-arm truncation disclosure. `results` is byte-identical to
 * gatherFetches (the .data arrays); `truncated` names every arm whose ST
 * response carried hasMore:true, so a caller can disclose an incomplete answer
 * instead of caching it as complete (F-11).
 */
export async function gatherFetchesWithTruncation(
  calls: NamedCall[],
): Promise<FanoutResult & { truncated: string[] }> {
  const settled = await Promise.allSettled(
    calls.map(async (c) => {
      const resp = await c.promise;
      if (!resp.ok) throw tagged('HTTPError', `${resp.status} ${resp.statusText || ''}`.trim());
      try {
        return extractStPage(await resp.json<unknown>());
      } catch (e) {
        throw tagged('JSONParseError', e instanceof Error ? e.message : String(e));
      }
    }),
  );
  const results: Record<string, unknown> = {};
  const failures: FanoutFailure[] = [];
  const truncated: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const name = calls[i].name;
    const res = settled[i];
    if (res.status === 'fulfilled') {
      results[name] = res.value.data;
      if (res.value.hasMore) truncated.push(name);
    } else {
      results[name] = null;
      const err = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
      failures.push({ call: name, error_class: err.name || 'Error', message: err.message || String(res.reason) });
    }
  }
  return { results, partial: failures.length > 0, failures, truncated };
}
```

Add imports at top of `composite-helpers.ts` if missing: `import { guardedStFetch } from './rate-limit-guard';` (rewriteTenantPlaceholders is already imported).

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(composites): gatherFetchesWithTruncation + stReadGuarded (F-11)`.

---

### Task 2: customer_snapshot uses the guarded, truncation-aware fanout

**Files:** Modify `src/tools/composites/customer_snapshot.ts`; Test `src/tools/__tests__/c10_composites.test.ts` (add).

- [ ] **Step 1: Write failing tests** (append to the `describe('customer_snapshot', …)` block):

```ts
  it('discloses _truncated arms and does NOT cache when a sub-call has more pages', async () => {
    const writes: string[] = [];
    const env = makeEnv(async (url: string) => {
      if (!url.includes('/api/st/read')) return new Response('{}', { status: 200 });
      // jobs arm truncated; everything else complete
      if (decodeURIComponent(url).includes('/jpm/v2/'))
        return new Response(JSON.stringify({ data: [{ id: 1 }], hasMore: true }), { status: 200 });
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    // capture mv writes
    const origPrepare = env.DB.prepare;
    env.DB.prepare = (sql: string) => {
      if (/INSERT OR REPLACE INTO mv_customer_snapshot/i.test(sql)) writes.push(sql);
      return origPrepare(sql);
    };
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._truncated).toEqual(['jobs']);
    expect(writes).toHaveLength(0); // truncated snapshot not cached
  });

  it('_truncated is empty and the snapshot IS cached when all arms are complete', async () => {
    const writes: string[] = [];
    const env = makeEnv(liveOk([]));
    const origPrepare = env.DB.prepare;
    env.DB.prepare = (sql: string) => {
      if (/INSERT OR REPLACE INTO mv_customer_snapshot/i.test(sql)) writes.push(sql);
      return origPrepare(sql);
    };
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._truncated).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run — expect FAIL** (`_truncated` undefined; cache written regardless).
Run: `npx vitest run src/tools/__tests__/c10_composites.test.ts -t "customer_snapshot" --pool=threads --maxWorkers=1`

- [ ] **Step 3: Implement** in `customer_snapshot.ts`:
  - Change import: `import { gatherFetchesWithTruncation, stReadGuarded } from '../../composite-helpers';` (drop `gatherFetches, stRead`).
  - Replace the six `stRead(...)` with `stReadGuarded(...)` (same args).
  - Replace `const fanout = await gatherFetches([...])` with `gatherFetchesWithTruncation`.
  - Add `_truncated: fanout.truncated` to the `result` object.
  - Gate the cache write: `if (acquired && fanout.truncated.length === 0) { await mvWrite(...) ... }`.

- [ ] **Step 4: Run — expect PASS.** Also run the full `customer_snapshot` describe to confirm `_partial`/`_failures`/single-flight tests still pass.
- [ ] **Step 5: Commit** `fix(composites): customer_snapshot discloses truncation, rate-limits fanout, skips caching partials (F-11)`.

---

### Task 3: Full-suite gate + adversarial + PR

- [ ] Typecheck (foreground). Full suite in serial batches (host is memory-starved; `--pool=threads --maxWorkers=1`, retry segfaulting batches). Wrangler dry-run (retry until clean).
- [ ] Dispatch `qsc-agents:adversary` on `origin/main..HEAD`: attack (a) does `results` stay byte-identical for non-truncated arms, (b) can a truncated-but-also-failed arm double-count or mis-disclose, (c) does routing through `guardedStFetch` change error surfacing vs raw `stRead`, (d) is the cache-skip correct when `acquired` is false. Fix CONFIRMED defects red→green.
- [ ] Push `codex/ralph-f11-snapshot-disclosure`, open a PR (no merge, no deploy) citing F-11 + the disclose-not-paginate decision. Comment outcome on the relevant Linear ticket.
