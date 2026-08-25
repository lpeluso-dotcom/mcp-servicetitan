# Cluster 1 — st_run_report pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `page`/`pageSize`/`includeTotal` actually reach ServiceTitan so reports over 1000 rows can be paged, and correct the `GOTCHAS.md` entry that caused the bug.

**Architecture:** ServiceTitan's Reporting v2 `POST .../reports/{id}/data` takes `page`, `pageSize`, and `includeTotal` as **query-string** parameters; the request body carries only `parameters`. Today `st_run_report` puts all three in the body, where ST silently drops them. `readSTPost` cannot send a query string at all — it calls `buildUrl(resolved)` with no query argument — so Task 1 adds that capability and Task 2 uses it.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest, Zod, Hono.

## Global Constraints

- Money is integer cents everywhere; not relevant to this cluster but do not introduce float math.
- `buildUrl(endpoint, query?)` already exists at `src/st.ts:78` and encodes the whole path (query included) into `?endpoint=`. Use it; do not hand-build URLs.
- The limiter identity and the cache key are the SAME string by design (`reportRunIdentity`, `st_run_report.ts:81-96`). Do not let them diverge.
- No deploy from this branch. Deploys are CI-only via `gh workflow run deploy.yml`.
- Baseline to hold: `npm run check` = 129 test files / 1708 tests passing.

## Evidence this bug is real (do not re-litigate)

Live tenant probe, 2026-08-25, report `accounting/155`, requested `pageSize: 3`:
returned **188 rows**, ST echoed `pageSize: 1000`, `totalCount: null`, `hasMore: false`.

---

### Task 1: `readSTPost` can send query parameters

**Files:**
- Modify: `src/st.ts:146-160` (`readSTPost` signature and `buildUrl` call)
- Test: `src/tools/__tests__/cluster1_report_pagination.test.ts` (create)

**Interfaces:**
- Consumes: `buildUrl(endpoint: string, query?: Record<string, unknown>): string` — already exists at `src/st.ts:78`.
- Produces: `readSTPost<T>(env, ctx, endpoint, body, opts?: { identity?: string; query?: Record<string, unknown> })`. Task 2 passes `query`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/__tests__/cluster1_report_pagination.test.ts`:

```typescript
// ============================================================
// Cluster 1 — st_run_report pagination.
//
// ServiceTitan's Reporting v2 POST .../data takes page/pageSize/includeTotal
// as QUERY parameters; the body carries only `parameters`. We sent all three
// in the body, where ST silently drops them. Live probe 2026-08-25 on report
// accounting/155 with pageSize:3 returned 188 rows and echoed pageSize:1000.
//
// Consequence: reports over 1000 rows could not be paged at all, and
// reportRunIdentity keyed the cache on parameters that never left the Worker,
// so page 1 and page 2 cached as distinct entries holding identical rows.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readSTPost } from '../../st';

const CTX = { actor: 'vitest', correlation: 'corr-c1' };

function makeLimiter() {
  const doFetch = vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith('/check')) return new Response(JSON.stringify({ allowed: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { idFromName: vi.fn((n: string) => n), get: vi.fn(() => ({ fetch: doFetch })) } as any;
}

function makeEnv(stImpl: (url: string, init?: any) => Promise<Response>) {
  return {
    ST_PROXY: { fetch: vi.fn(stImpl) },
    ST_RATE_LIMITER: makeLimiter(),
    MCP_SYNC_KEY: 'k',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
    PROXY_STATE: {},
  } as any;
}

/**
 * Pull the real ST path back out of the proxy URL's ?endpoint= parameter.
 * searchParams.get() already percent-decodes once — do NOT decodeURIComponent
 * again or a legitimate '%' in a parameter value will throw.
 */
function endpointOf(url: string): string {
  return new URL(url).searchParams.get('endpoint') ?? '';
}

describe('readSTPost query support', () => {
  it('appends query params to the endpoint and leaves the body untouched', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await readSTPost(
      env,
      CTX,
      '/reporting/v2/tenant/000000000/report-category/cat1/reports/r1/data',
      { parameters: [{ name: 'From', value: '2026-01-01' }] },
      { query: { page: 2, pageSize: 3, includeTotal: true } },
    );

    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    const endpoint = endpointOf(url as string);

    expect(endpoint).toContain('page=2');
    expect(endpoint).toContain('pageSize=3');
    expect(endpoint).toContain('includeTotal=true');

    // The body must carry ONLY parameters — ST's ReportDataRequest schema is
    // additionalProperties:false, so anything else is a spec violation.
    expect(JSON.parse((init as any).body)).toEqual({
      parameters: [{ name: 'From', value: '2026-01-01' }],
    });
  });

  it('omits the query string entirely when no query is supplied', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await readSTPost(env, CTX, '/capacity/v2/tenant/000000000/capacity', { foo: 1 });

    const endpoint = endpointOf(env.ST_PROXY.fetch.mock.calls[0][0] as string);
    expect(endpoint).not.toContain('?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/cluster1_report_pagination.test.ts -t 'appends query params'`

Expected: FAIL — the endpoint contains no `page=2`, because `readSTPost` calls `buildUrl(resolved)` with no query argument.

- [ ] **Step 3: Write minimal implementation**

In `src/st.ts`, change the `readSTPost` options parameter and the `buildUrl` call:

```typescript
  opts: { identity?: string; query?: Record<string, unknown> } = {},
): Promise<T> {
  const resolved = rewriteTenantPlaceholders(env, endpoint);
  // Query goes on the ST path (buildUrl encodes the whole thing into
  // ?endpoint=). `resolved` stays query-free so guardedStFetch's family
  // classification is unaffected.
  const url = buildUrl(resolved, opts.query);
```

Leave the `guardedStFetch(env, resolved, ...)` call exactly as it is — it must keep receiving the query-free path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/cluster1_report_pagination.test.ts`

Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/st.ts src/tools/__tests__/cluster1_report_pagination.test.ts
git commit -m "fix(st): readSTPost can send query parameters

ServiceTitan's report data endpoint takes page/pageSize/includeTotal as
query parameters, but readSTPost called buildUrl with no query argument,
so there was no way to send them. guardedStFetch still receives the
query-free path so family classification is unchanged."
```

---

### Task 2: `st_run_report` sends pagination as query, not body

**Files:**
- Modify: `src/tools/reporting/st_run_report.ts:46` (cache namespace), `:117` (description), `:132-139` (schema), `:204-208` (body/query split), `:229-247` (identity + call)
- Modify: `docs/mcp/GOTCHAS.md:68-69`
- Test: `src/tools/__tests__/cluster1_report_pagination.test.ts` (append)

**Interfaces:**
- Consumes: `readSTPost(..., opts: { identity?, query? })` from Task 1.
- Produces: no new exported symbols. `REPORT_CACHE_NS` changes value from `'servicetitan:report_run'` to `'servicetitan:report_run:v2'`.

**Why the cache namespace must change:** every entry written before this fix was keyed by `reportRunIdentity` on a `page`/`pageSize` that never reached ST. Those entries hold page-1 rows under page-2 keys. Bumping the namespace abandons them rather than serving wrong pages for up to `REPORT_RUN_TTL_SEC` (300s) after deploy.

**Why the default pageSize becomes 1000, not 100:** today every run effectively returns ST's default of up to 1000 rows because our `pageSize` is discarded. Once it is honored, sending the advertised default of 100 would silently shrink every existing caller's result set by 10x. Defaulting to 1000 preserves current observed behavior. The advertised "default 100, max 5000" was false in both directions and is corrected.

- [ ] **Step 1: Write the failing test**

Append to `src/tools/__tests__/cluster1_report_pagination.test.ts`:

```typescript
import { st_run_report, _resetReportCooldown, REPORT_CACHE_NS } from '../reporting/st_run_report';

// NOTE: add `beforeEach` to the existing `from 'vitest'` import at the top of
// this file rather than adding a second import statement from the same module.

/** D1 mock backing the mcp_cache read-through with a real in-memory table. */
function makeCacheDB() {
  const rows = new Map<string, { value: string; expires_at: number }>();
  return {
    rows,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt: any = {
        bind: vi.fn((...args: unknown[]) => {
          captured.push(...args);
          return stmt;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR REPLACE INTO mcp_cache/i.test(sql)) {
            rows.set(`${captured[0]}|${captured[1]}`, {
              value: String(captured[2]),
              expires_at: Number(captured[3]),
            });
          }
          return { success: true };
        }),
        first: vi.fn(async () => {
          if (/FROM mcp_cache/i.test(sql)) return rows.get(`${captured[0]}|${captured[1]}`) ?? null;
          return null;
        }),
      };
      return stmt;
    }),
  };
}

function makeReportEnv(stImpl: (url: string, init?: any) => Promise<Response>) {
  const env = makeEnv(stImpl);
  env.DB = makeCacheDB();
  return env;
}

const RUN_ARGS = {
  mode: 'run' as const,
  categoryId: 'cat1',
  reportId: 'r1',
  parameters: [{ name: 'From', value: '2026-01-01' }],
};

beforeEach(() => {
  _resetReportCooldown();
});

describe('st_run_report pagination placement', () => {
  it('sends page/pageSize/includeTotal as query params, body carries only parameters', async () => {
    const env = makeReportEnv(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS, page: 2, pageSize: 3 }, CTX);

    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    const endpoint = endpointOf(url as string);

    expect(endpoint).toContain('page=2');
    expect(endpoint).toContain('pageSize=3');
    expect(endpoint).toContain('includeTotal=true');
    expect(JSON.parse((init as any).body)).toEqual({ parameters: RUN_ARGS.parameters });
  });

  it('defaults to pageSize 1000 so honoring pageSize does not shrink existing callers', async () => {
    const env = makeReportEnv(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX);

    const endpoint = endpointOf(env.ST_PROXY.fetch.mock.calls[0][0] as string);
    expect(endpoint).toContain('pageSize=1000');
    expect(endpoint).toContain('page=1');
  });

  it('uses a versioned cache namespace so pre-fix poisoned entries cannot serve', () => {
    expect(REPORT_CACHE_NS).toBe('servicetitan:report_run:v2');
  });

  it('still treats a different page as a different run and hits ST twice', async () => {
    const env = makeReportEnv(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX);
    await st_run_report.handler(env, { ...RUN_ARGS, page: 2 }, CTX);

    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/cluster1_report_pagination.test.ts -t 'pagination placement'`

Expected: FAIL — first test fails because `page`/`pageSize` are in the body and the endpoint has no query string; the namespace test fails because `REPORT_CACHE_NS` is still `'servicetitan:report_run'`.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/reporting/st_run_report.ts`, line 46:

```typescript
// v2: entries written before 2026-08-25 were keyed on page/pageSize that
// never reached ST, so they hold page-1 rows under page-2 keys. Abandon them.
export const REPORT_CACHE_NS = 'servicetitan:report_run:v2';
```

Replace lines 204-208 with a body/query split:

```typescript
    const runBody: Record<string, unknown> = {
      parameters: args.parameters,
    };

    // ST's Reporting v2 takes these three as QUERY parameters. The body schema
    // (Reporting.V2.ReportDataRequest) is additionalProperties:false and holds
    // only `parameters` — sending them in the body meant ST discarded them.
    // Default pageSize is 1000 (ST's own default) so honoring pageSize does not
    // shrink result sets that callers already depend on.
    const runQuery: Record<string, unknown> = {
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 1000,
      includeTotal: true,
    };
```

Update the identity call at lines 229-235 to read from `runQuery`:

```typescript
    const identity = reportRunIdentity({
      categoryId: args.categoryId,
      reportId: args.reportId,
      parameters: args.parameters,
      page: runQuery.page,
      pageSize: runQuery.pageSize,
    });
```

Pass the query through at lines 242-248:

```typescript
        return readSTPost<unknown>(
          env,
          { actor, correlation },
          `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}/data`,
          runBody,
          { identity, query: runQuery },
        );
```

Correct the schema at lines 133-139:

```typescript
    pageSize: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe('Page size (run mode only, default 1000 = ServiceTitan default)'),
```

Correct the description at line 117 — replace the trailing sentence
`mode=run: default page size 100, max 5000.` with:

```
mode=run: default page size 1000, max 1000 (ServiceTitan's cap).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/cluster1_report_pagination.test.ts`

Expected: PASS, all six tests.

Then run the pre-existing report tests, which assert cache and cooldown behavior that this change touches:

Run: `npx vitest run src/tools/__tests__/wave2_st_run_report_cooldown.test.ts`

Expected: PASS. If the "different page is a different run" test there fails, the identity wiring in Step 3 is wrong — fix it rather than editing that test.

- [ ] **Step 5: Correct the GOTCHAS entry that caused this bug**

`docs/mcp/GOTCHAS.md:68-69` currently instructs the opposite of the truth. Replace the incorrect
"paginate via `page` + `pageSize` in the body, not query string" guidance with:

```markdown
- **Reporting `POST .../reports/{id}/data` takes `page`, `pageSize`, and
  `includeTotal` as QUERY parameters, not body fields.** The body schema
  (`Reporting.V2.ReportDataRequest`) is `additionalProperties: false` and
  carries only `parameters`. ServiceTitan does NOT reject body-placed paging —
  it silently ignores it and returns its own default page of up to 1000 rows
  with `totalCount: null`. Verified by tenant probe 2026-08-25 on report
  `accounting/155`: requested `pageSize: 3`, received 188 rows, echoed
  `pageSize: 1000`. An earlier version of this file asserted the opposite and
  is what put the parameters in the body.
```

- [ ] **Step 6: Run the full suite**

Run: `npm run check`

Expected: typecheck passes; test count at or above the 1708 baseline (this plan adds 6).

- [ ] **Step 7: Commit**

```bash
git add src/tools/reporting/st_run_report.ts docs/mcp/GOTCHAS.md src/tools/__tests__/cluster1_report_pagination.test.ts
git commit -m "fix(reporting): send report paging as query params, not body

ServiceTitan takes page/pageSize/includeTotal as query parameters on
POST .../reports/{id}/data; the body schema is additionalProperties:false
and holds only parameters. We sent all three in the body, where ST
silently discarded them: reports over 1000 rows could not be paged at
all, totalCount was always null, and reportRunIdentity keyed the cache
on values that never left the Worker, so page 2 cached as a distinct
entry holding page-1 rows.

Bumps REPORT_CACHE_NS to :v2 to abandon those poisoned entries.
Defaults pageSize to 1000 (ST's own default) so honoring it does not
shrink existing callers' result sets by 10x. Corrects the schema's
false 'default 100, max 5000'.

Also corrects docs/mcp/GOTCHAS.md, which instructed body placement and
is what caused this."
```

---

### Task 3: Live verification against the tenant

**Files:** none — this task produces evidence, not code.

**Why a separate task:** unit tests prove we *send* the query string. Only a real
tenant call proves ST *honors* it. The spec's acceptance criteria require this.

**Rate-limit care:** ServiceTitan allows 1 run of the *same report* per minute per
tenant, and our own result cache holds for 300s. Vary `pageSize` between probes so
each is a distinct identity, and allow ~60s between calls. A 429 here is expected
behavior, not a failure of this cluster.

- [ ] **Step 1: Confirm pageSize is honored**

Call `st_run_report` against the deployed worker with:
`mode: run, categoryId: accounting, reportId: 155, pageSize: 3, page: 1,`
`parameters: [{DateType,0},{From,'2026-08-01'},{To,'2026-08-07'}]`

Expected: `data.data` has **3 rows** and `data.pageSize` echoes **3**.
Pre-fix baseline for comparison: 188 rows, echoed `pageSize: 1000`.

Note: this must run against a build that includes Task 2. Deploys are CI-only, so
either wait for a deploy of this branch or run the probe through a local
`wrangler dev` session with real credentials.

- [ ] **Step 2: Confirm pages differ**

Wait ~60s, then repeat with `page: 2, pageSize: 3`.

Expected: 3 rows, and the row set differs from Step 1. If the rows are identical,
the cache namespace bump did not take effect.

- [ ] **Step 3: Confirm totalCount is populated**

Check either response's `data.totalCount`.

Expected: a non-null integer (188 for the date window above). Pre-fix it was always
`null` because `includeTotal` was never sent.

- [ ] **Step 4: Determine ST's real pageSize cap**

The schema now caps at 1000 based on the observed default. That is not proof of the
maximum. Probe once with `pageSize: 2000`.

- If ST echoes `2000`, raise the schema `.max()` and the description accordingly.
- If ST echoes `1000` or errors, 1000 is the true cap — leave the schema and record
  the result in `GOTCHAS.md`.

Do not guess. Record whichever answer the probe returns.

- [ ] **Step 5: Record the evidence**

Append the probe results to the cluster's PR description or commit trailer so the
acceptance criteria in the spec can be checked off against real output rather than
an assertion.
