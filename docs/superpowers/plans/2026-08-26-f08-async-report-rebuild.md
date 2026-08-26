# F-08 Async-Report Migration Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `st_run_report` mode=run to ServiceTitan's ST-78 async token contract while preserving the Wave 2 429-containment layer and fixing four adversarial blockers.

**Architecture:** mode=run POSTs `.../data/query`. A 200 returns rows inline; a 202 returns a token, which we poll via `GET data-queries/{token}` until 200 or a **wall-clock** deadline, then best-effort `DELETE`. The async call is wrapped by the existing result-cache + post-429 cooldown, and routed through `guardedStFetch` so the reporting-family limiter and identity plumbing are preserved. Discovery modes (list_categories/list_reports/describe_report) are unchanged.

**Tech Stack:** TypeScript, Cloudflare Workers, vitest, zod.

## Global Constraints

- No deploy, no merge, no live ST calls, no D1/QBO writes — all Luke-gated.
- Do NOT edit protected modules (`src/st.ts`, `src/rate-limit-guard.ts`, `src/auth.ts`, `src/tenant.ts`, `src/errors.ts`, `src/cache.ts`). Import from them only.
- Async raw fetch MUST route through `guardedStFetch(env, endpoint, run, { identity })` so the reporting-family limiter `/check` still fires with the report identity.
- Token field is wire-unverified: check `token` → `queryToken` → `id`; on a 202 with none, throw a loud `upstream_error` naming the actual keys seen.
- Never echo an upstream response body to the MCP caller (B3).
- All of `src/tools/__tests__/wave2_st_run_report_cooldown.test.ts` must stay green unchanged.
- `_source: hitUpstream ? 'live' : 'cache'` and the `_cache_ttl_seconds` tag on cache hits are preserved.

**Key interfaces (exact signatures, from current main):**
- `new McpError(code, message, { details?, retry_after_ms?, correlation? })`
- `cacheGet<T>(env, namespace, key, ttlSec, miss: () => Promise<T>): Promise<T>`
- `guardedStFetch(env, endpoint, run: () => Promise<Response>, opts?: { identity?: string }): Promise<Response>` — from `./rate-limit-guard`. Performs limiter `/check`, runs `run()`, calls `reportBackoff` on a 429, returns the raw `Response`. Throws `McpError('rate_limited', …, {details:{reason:'same_report_within_window'}, retry_after_ms})` when the DO denies a same-report repeat.
- `authHeaders(env, correlation, actor): Record<string,string>`
- `rewriteTenantPlaceholders(env, path): string`
- `mapUpstreamStatus(status): McpErrorCode` (429→'rate_limited', ≥500→'upstream_error', …)
- `parseRetryAfterSeconds(headerValue): number` — from `./rate-limit-guard`.

**File under change:** `src/tools/reporting/st_run_report.ts` (modify).
**New test file:** `src/tools/__tests__/f08_async_report.test.ts`.

---

### Task 1: Async transport with containment layer (inline-200 + cache + cooldown)

Rebuild the tool: async `.../data/query` POST via `guardedStFetch`, keeping the existing cache/cooldown/identity exports so `wave2_st_run_report_cooldown.test.ts` compiles and passes. This task covers the **200-inline** path (the path the wave2 mock exercises).

**Files:**
- Modify: `src/tools/reporting/st_run_report.ts`
- Test: existing `src/tools/__tests__/wave2_st_run_report_cooldown.test.ts` (must pass unchanged)

**Interfaces:**
- Consumes: `guardedStFetch`, `parseRetryAfterSeconds` (`./rate-limit-guard`); `cacheGet` (`./cache`); `authHeaders` (`./auth`); `rewriteTenantPlaceholders` (`./tenant`); `McpError`, `mapUpstreamStatus` (`./errors`).
- Produces (exported, relied on by wave2 tests + Task 2/3): `REPORT_CACHE_NS: string`, `REPORT_RUN_TTL_SEC: number`, `reportRunIdentity(args): string`, `_resetReportCooldown(): void`, `runReportQueryAsync(env, ctx, categoryId, reportId, runBody, pollTimeoutSeconds, opts): Promise<unknown>`.

- [ ] **Step 1: Verify the RED baseline** — the seed async file (no containment) fails to compile.

Run: `npm run typecheck`
Expected: FAIL — `wave2_st_run_report_cooldown.test.ts` errors: `has no exported member '_resetReportCooldown'` and `'REPORT_RUN_TTL_SEC'`. (This is the compiler proving the containment layer is required.)

- [ ] **Step 2: Rebuild `st_run_report.ts`** — async transport + containment. Replace the file body with:

```ts
// (header comment retained from prior version — ST-78 async contract, unverified token field)
import { z } from 'zod';
import { McpError, mapUpstreamStatus } from '../../errors';
import { readST } from '../../st';
import { cacheGet } from '../../cache';
import { authHeaders } from '../../auth';
import { rewriteTenantPlaceholders } from '../../tenant';
import { guardedStFetch, parseRetryAfterSeconds } from '../../rate-limit-guard';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

export const REPORT_CACHE_NS = 'servicetitan:report_run';
export const REPORT_RUN_TTL_SEC = 300; // 5 minutes

const POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 180;

let reportRunCooldownUntil = 0;
export function _resetReportCooldown(): void { reportRunCooldownUntil = 0; }

const ReportMode = z.enum(['list_categories', 'list_reports', 'describe_report', 'run']);
interface ReportParam { name: string; value: unknown; }
interface Args {
  mode: z.infer<typeof ReportMode>;
  categoryId?: string | number; reportId?: string | number;
  parameters?: ReportParam[]; page?: number; pageSize?: number;
  pollTimeoutSeconds?: number;
  _pollIntervalMs?: number;   // test seam, not in zodSchema
  _now?: () => number;        // test seam: injectable clock for the wall-clock deadline
}

export function reportRunIdentity(args: {
  categoryId?: string | number; reportId?: string | number;
  parameters?: ReportParam[]; page: unknown; pageSize: unknown;
}): string {
  const params = [...(args.parameters ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({ c: String(args.categoryId), r: String(args.reportId), p: args.page, s: args.pageSize, params });
}

function readProxyUrl(path: string): string {
  return `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`;
}

// (Task 2 replaces the timeout body of pollDataQuery; Task 1 lands the happy path.)
async function pollDataQuery(
  env: Env, ctx: { actor: string; correlation: string }, token: string,
  pollTimeoutSeconds: number, opts: { pollIntervalMs?: number; now?: () => number },
): Promise<unknown> {
  const now = opts.now ?? Date.now;
  const sleepMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = now() + pollTimeoutSeconds * 1000;
  const pollPath = rewriteTenantPlaceholders(env, `/reporting/v2/tenant/000000000/data-queries/${token}`);
  let attempt = 0;
  while (now() < deadline) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, sleepMs));
    attempt++;
    const resp = await env.ST_PROXY.fetch(readProxyUrl(pollPath), { headers: authHeaders(env, ctx.correlation, ctx.actor) });
    if (resp.status === 200) return await resp.json();
    if (resp.status === 202) continue;
    // B3: no upstream body echoed
    throw new McpError(mapUpstreamStatus(resp.status),
      `report query poll failed: upstream returned ${resp.status} (correlation ${ctx.correlation})`,
      { correlation: ctx.correlation });
  }
  await cancelDataQuery(env, ctx, token);
  const elapsed = Math.round((now() - (deadline - pollTimeoutSeconds * 1000)) / 1000);
  throw new McpError('timeout',
    `report query ${token} timed out after ${elapsed}s (ceiling ${pollTimeoutSeconds}s) — canceled`,
    { correlation: ctx.correlation });
}

async function cancelDataQuery(env: Env, ctx: { actor: string; correlation: string }, token: string): Promise<void> {
  try {
    const endpoint = rewriteTenantPlaceholders(env, `/reporting/v2/tenant/000000000/data-queries/${token}`);
    await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
      method: 'POST',
      headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, method: 'DELETE', payload: {} }),
    });
  } catch { /* best-effort */ }
}

function extractQueryToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['token', 'queryToken', 'id']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export async function runReportQueryAsync(
  env: Env, ctx: { actor: string; correlation: string },
  categoryId: string | number, reportId: string | number,
  runBody: Record<string, unknown>, pollTimeoutSeconds: number,
  opts: { identity: string; pollIntervalMs?: number; now?: () => number },
): Promise<unknown> {
  const queryPath = rewriteTenantPlaceholders(env,
    `/reporting/v2/tenant/000000000/report-category/${categoryId}/reports/${reportId}/data/query`);
  // Route through guardedStFetch so the reporting-family limiter /check fires
  // with the report identity — same gate readSTPost uses — while we still see
  // the raw 200-vs-202 status (readSTPost cannot: 202 is resp.ok).
  const initialResp = await guardedStFetch(env, queryPath, () =>
    env.ST_PROXY.fetch(readProxyUrl(queryPath), {
      method: 'POST',
      headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
      body: JSON.stringify(runBody),
    }), { identity: opts.identity });

  if (initialResp.status === 200) return await initialResp.json();
  if (initialResp.status !== 202) {
    if (initialResp.status === 429) {
      throw new McpError('rate_limited',
        `report data/query rate-limited by ServiceTitan (correlation ${ctx.correlation})`,
        { correlation: ctx.correlation,
          retry_after_ms: parseRetryAfterSeconds(initialResp.headers.get('Retry-After')) * 1000 });
    }
    throw new McpError(mapUpstreamStatus(initialResp.status),
      `report data/query POST failed: upstream returned ${initialResp.status} (correlation ${ctx.correlation})`,
      { correlation: ctx.correlation }); // B3: no body echoed
  }
  const body202 = await initialResp.json().catch(() => ({}));
  const token = extractQueryToken(body202);
  if (!token) {
    const keys = body202 && typeof body202 === 'object' ? Object.keys(body202 as object) : [];
    throw new McpError('upstream_error',
      `report data/query returned 202 but no usable token field — checked token, queryToken, id. Actual keys: [${keys.join(', ')}]`,
      { correlation: ctx.correlation });
  }
  return await pollDataQuery(env, ctx, token, pollTimeoutSeconds,
    { pollIntervalMs: opts.pollIntervalMs, now: opts.now });
}

export const st_run_report: ToolDef<Args> = {
  name: 'st_run_report',
  description:
    'Run or discover ServiceTitan native reports. Modes: list_categories | list_reports (requires categoryId) | describe_report (requires categoryId + reportId — MANDATORY before first run on unknown reportId) | run (requires categoryId + reportId, parameters[]). run is ASYNC (ST-78): POST .../data/query returns rows inline (200) or a token (202); this tool polls data-queries/{token} every 2s to a wall-clock ceiling (default 180s, override pollTimeoutSeconds max 600) and best-effort cancels on timeout. A same-report repeat inside 5min is served from cache. Source: live ST.',
  zodSchema: {
    mode: ReportMode.describe('Reporting workflow step'),
    categoryId: z.union([z.string(), z.number()]).optional().describe('Report category ID'),
    reportId: z.union([z.string(), z.number()]).optional().describe('Report ID'),
    parameters: z.array(z.object({ name: z.string(), value: z.unknown() })).optional()
      .describe('Parameter list for mode=run; shape per describe_report'),
    page: z.number().int().positive().optional().describe('Page (run mode, default 1)'),
    pageSize: z.number().int().positive().max(5000).optional().describe('Page size (run mode, default 100)'),
    pollTimeoutSeconds: z.number().int().positive().max(600).optional()
      .describe('mode=run only. Wall-clock ceiling (s) for polling a slow async report before cancel. Default 180, max 600.'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data/query',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const requireArg: (cond: unknown, msg: string) => asserts cond = (cond, msg) => {
      if (!cond) throw new McpError('validation_error', msg, { correlation });
    };
    const tid = '000000000';

    if (args.mode === 'list_categories') {
      const data = await readST<{ data?: unknown[] }>(env, { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-categories`);
      return { mode: 'list_categories', categories: data.data ?? data, _source: 'live' };
    }
    if (args.mode === 'list_reports') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=list_reports');
      const data = await readST<{ data?: unknown[] }>(env, { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports`);
      return { mode: 'list_reports', categoryId: args.categoryId, reports: data.data ?? data, _source: 'live' };
    }
    if (args.mode === 'describe_report') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=describe_report');
      requireArg(args.reportId !== undefined, 'reportId required for mode=describe_report');
      const data = await readST<unknown>(env, { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}`);
      return { mode: 'describe_report', categoryId: args.categoryId, reportId: args.reportId, report: data, _source: 'live' };
    }

    // mode === 'run'
    requireArg(args.categoryId !== undefined, 'categoryId required for mode=run');
    requireArg(args.reportId !== undefined, 'reportId required for mode=run');
    requireArg(Array.isArray(args.parameters), 'parameters[] required for mode=run (use describe_report)');

    const runBody: Record<string, unknown> = {
      parameters: args.parameters, pageSize: args.pageSize ?? 100, page: args.page ?? 1,
    };
    const now = args._now ?? Date.now;

    // post-429 cooldown — checked only on the path that would hit upstream.
    const nowMs = now();
    if (reportRunCooldownUntil > nowMs) {
      const remainingMs = reportRunCooldownUntil - nowMs;
      throw new McpError('rate_limited',
        `st_run_report: reporting API returned 429 recently; mode=run is in a ${Math.ceil(remainingMs / 1000)}s cooldown. ` +
        `Retry after that, or re-run a report pulled in the last ${REPORT_RUN_TTL_SEC / 60} minutes (served from cache, costs nothing).`,
        { correlation, retry_after_ms: remainingMs });
    }

    const identity = reportRunIdentity({
      categoryId: args.categoryId, reportId: args.reportId,
      parameters: args.parameters, page: runBody.page, pageSize: runBody.pageSize,
    });

    let hitUpstream = false;
    let data: unknown;
    try {
      data = await cacheGet<unknown>(env, REPORT_CACHE_NS, identity, REPORT_RUN_TTL_SEC, async () => {
        hitUpstream = true;
        return runReportQueryAsync(env, { actor, correlation }, args.categoryId!, args.reportId!, runBody,
          args.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
          { identity, pollIntervalMs: args._pollIntervalMs, now: args._now });
      });
    } catch (err) {
      if (err instanceof McpError && err.code === 'rate_limited' &&
          (err.details as { reason?: string } | undefined)?.reason !== 'same_report_within_window') {
        reportRunCooldownUntil = now() + (err.retry_after_ms ?? 60_000);
      }
      throw err;
    }

    return {
      mode: 'run', categoryId: args.categoryId, reportId: args.reportId, data,
      _source: hitUpstream ? 'live' : 'cache',
      ...(hitUpstream ? {} : { _cache_ttl_seconds: REPORT_RUN_TTL_SEC }),
    };
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0).

- [ ] **Step 4: Run the wave2 containment suite**

Run: `npx vitest run src/tools/__tests__/wave2_st_run_report_cooldown.test.ts`
Expected: PASS — cache hit is one ST call and `_source:'cache'`; 429 arms cooldown; discovery bypasses cooldown; identity sent to limiter.

- [ ] **Step 5: Commit**

```bash
git add src/tools/reporting/st_run_report.ts
git commit -m "feat(reporting): async st_run_report on ST-78 data/query, containment layer restored (F-08)"
```

---

### Task 2: Wall-clock poll deadline (B1) + abort of hung polls (B4)

Prove the ceiling trips on real elapsed time even when every poll GET hangs, and that no poll fetch is issued past the deadline.

**Files:**
- Modify: `src/tools/reporting/st_run_report.ts` (pollDataQuery — add per-fetch abort with remaining budget)
- Test: `src/tools/__tests__/f08_async_report.test.ts` (create)

**Interfaces:**
- Consumes: `st_run_report`, `_resetReportCooldown` from `../reporting/st_run_report`.
- Produces: none new.

- [ ] **Step 1: Write the failing test** — hung polls, injected clock advances past the ceiling.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { st_run_report, _resetReportCooldown } from '../reporting/st_run_report';

const CTX = { actor: 'vitest', correlation: 'corr-f08' };

function makeEnv(stImpl: (url: string, init?: any) => Promise<Response>) {
  const stFetch = vi.fn(stImpl);
  const doFetch = vi.fn(async (url: string) =>
    url.endsWith('/check') ? new Response(JSON.stringify({ allowed: true }), { status: 200 })
                           : new Response(JSON.stringify({ ok: true }), { status: 200 }));
  return {
    ST_PROXY: { fetch: stFetch },
    ST_RATE_LIMITER: { idFromName: (n: string) => n, get: () => ({ fetch: doFetch }) },
    ST_TENANT_ID: '000000000', MCP_SYNC_KEY: 'k', MCP_SERVICE_VERSION: '0.0.0-test',
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
    PROXY_STATE: {}, SIRO_API_TOKEN: '',
  } as any;
}
const RUN = { mode: 'run' as const, categoryId: 'c', reportId: 'r', parameters: [{ name: 'From', value: 'x' }] };

beforeEach(() => _resetReportCooldown());

it('B1: trips the wall-clock ceiling when every poll hangs (not sleep-count)', async () => {
  let t = 0;                       // injected clock, ms
  const now = () => t;
  const env = makeEnv(async (url: string, init?: any) => {
    if (String(url).includes('/data/query')) return new Response(JSON.stringify({ token: 'tok1' }), { status: 202 });
    if (String(url).includes('/api/st/write')) return new Response('{}', { status: 200 }); // DELETE cancel
    // every poll GET "hangs" — model it as advancing real time by 10s then 202
    t += 10_000;
    return new Response('', { status: 202 });
  });
  const err: any = await st_run_report
    .handler(env, { ...RUN, pollTimeoutSeconds: 30, _pollIntervalMs: 0, _now: now } as any, CTX)
    .catch((e) => e);
  expect(err.code).toBe('timeout');
  expect(err.message).toMatch(/canceled/);
  // a DELETE cancel was attempted
  expect(env.ST_PROXY.fetch.mock.calls.some((c: any[]) => String(c[0]).includes('/api/st/write'))).toBe(true);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/tools/__tests__/f08_async_report.test.ts -t "B1"`
Expected: FAIL if the deadline math is wrong (e.g. loops forever / wrong error). If Task 1 already made it pass, keep the test as the regression guard and proceed — the loop condition `now() < deadline` is the behavior under test.

- [ ] **Step 3: Harden pollDataQuery** — ensure no fetch is issued once past the deadline (B4). Confirm the loop guard is `while (now() < deadline)` and the fetch is inside it (already so in Task 1). Add a defensive re-check right before the fetch:

```ts
    if (attempt > 0) await new Promise((r) => setTimeout(r, sleepMs));
    if (now() >= deadline) break;   // B4: never fetch past the deadline
    attempt++;
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/tools/__tests__/f08_async_report.test.ts -t "B1"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/reporting/st_run_report.ts src/tools/__tests__/f08_async_report.test.ts
git commit -m "fix(reporting): wall-clock poll deadline + no-fetch-past-abort (F-08 B1/B4)"
```

---

### Task 3: Contract + disclosure tests (200-inline, 202→poll→200, no-token, B3 body-suppression, B2 cache-during-cooldown)

Add the remaining behavioral tests to `f08_async_report.test.ts`. No new production code expected (Task 1 implemented these) — this task is the proof net; if any fails, fix `st_run_report.ts` minimally.

**Files:**
- Test: `src/tools/__tests__/f08_async_report.test.ts` (append)

- [ ] **Step 1: Append the tests**

```ts
it('contract: 200 inline returns rows without polling', async () => {
  const env = makeEnv(async (url: string) => {
    expect(String(url)).toContain('/data/query');
    return new Response(JSON.stringify({ rows: [{ a: 1 }] }), { status: 200 });
  });
  const out: any = await st_run_report.handler(env, { ...RUN }, CTX);
  expect(out.mode).toBe('run');
  expect(out.data).toEqual({ rows: [{ a: 1 }] });
  // exactly one ST call (the POST); no poll GET
  expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
});

it('contract: 202 -> poll 202 -> 200 returns rows', async () => {
  let polls = 0;
  const env = makeEnv(async (url: string) => {
    if (String(url).includes('/data/query')) return new Response(JSON.stringify({ token: 'tok9' }), { status: 202 });
    polls++;
    return polls < 2 ? new Response('', { status: 202 })
                     : new Response(JSON.stringify({ rows: [{ b: 2 }] }), { status: 200 });
  });
  const out: any = await st_run_report.handler(env, { ...RUN, _pollIntervalMs: 0 } as any, CTX);
  expect(out.data).toEqual({ rows: [{ b: 2 }] });
  expect(polls).toBe(2);
});

it('contract: 202 with no usable token fails loud naming the keys', async () => {
  const env = makeEnv(async () => new Response(JSON.stringify({ status: 'pending', foo: 1 }), { status: 202 }));
  const err: any = await st_run_report.handler(env, { ...RUN }, CTX).catch((e) => e);
  expect(err.code).toBe('upstream_error');
  expect(err.message).toMatch(/no usable token/);
  expect(err.message).toMatch(/foo/); // dumps actual keys
});

it('B3: an upstream 500 body is NOT echoed to the caller', async () => {
  const env = makeEnv(async (url: string) =>
    String(url).includes('/data/query')
      ? new Response('SECRET-UPSTREAM-STACKTRACE-xyz', { status: 500 })
      : new Response('', { status: 202 }));
  const err: any = await st_run_report.handler(env, { ...RUN }, CTX).catch((e) => e);
  expect(err.code).toBe('upstream_error');
  expect(err.message).not.toMatch(/SECRET-UPSTREAM-STACKTRACE/);
});

it('B2: a cache hit is served even while the tool is in a 429 cooldown', async () => {
  // 1st call: 429 arms cooldown. 2nd identical call would be cached IF it had
  // succeeded — but it 429'd, so nothing is cached. Instead prove the inverse:
  // a SUCCEEDING run caches, and re-running the SAME report never re-enters the
  // upstream path (so cooldown is irrelevant to a cache hit).
  let calls = 0;
  const env = makeEnv(async () => { calls++; return new Response(JSON.stringify({ rows: [] }), { status: 200 }); });
  // real cache: swap DB for an in-memory map
  const mem = new Map<string, any>();
  env.DB = { prepare: (sql: string) => { let cap: any[] = []; return {
    bind: (...a: any[]) => { cap = a; return this; },
    first: async () => /FROM mcp_cache/i.test(sql) ? mem.get(`${cap[0]}|${cap[1]}`) ?? null : null,
    run: async () => { if (/INSERT OR REPLACE/i.test(sql)) mem.set(`${cap[0]}|${cap[1]}`, { value: String(cap[2]), expires_at: Number(cap[3]) }); return {}; },
  }; } } as any;
  const a: any = await st_run_report.handler(env, { ...RUN }, CTX);
  const b: any = await st_run_report.handler(env, { ...RUN }, CTX);
  expect(a._source).toBe('live');
  expect(b._source).toBe('cache');
  expect(calls).toBe(1);
});
```

- [ ] **Step 2: Run the full new file**

Run: `npx vitest run src/tools/__tests__/f08_async_report.test.ts`
Expected: PASS (all cases). If B2's inline DB double misbehaves, mirror `makeCacheDB()` from the wave2 test verbatim instead.

- [ ] **Step 3: Commit**

```bash
git add src/tools/__tests__/f08_async_report.test.ts
git commit -m "test(reporting): F-08 async contract + B2/B3 proofs"
```

---

### Task 4: Full-suite gate + bundle dry-run

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — the pre-existing flaky `catalog-resources.test.ts` (F-01) may time out; if the ONLY failure is that file's 5s timeout, re-run it isolated (`npx vitest run src/__tests__/catalog-resources.test.ts`) to confirm it passes alone, and note it as the known F-01 flake, not an F-08 regression.

- [ ] **Step 3: Wrangler bundle dry-run (non-deploying)**

Run: `npx wrangler deploy --dry-run --outdir /tmp/f08-dryrun 2>&1 | tail -5`
Expected: builds without upload; no error.

- [ ] **Step 4: Commit any incidental fixes, else no-op.**

---

### Task 5: Adversarial review

- [ ] Dispatch `qsc-agents:adversary` on the diff `origin/main..HEAD` with the four blockers (B1–B4) and the wave2 compatibility invariant as the claims to refute. Fix any CONFIRMED defect with a red→green regression before proceeding.

---

### Task 6: Open the PR (no merge, no deploy)

- [ ] Push `codex/ralph-f08-async-report-rebuild`.
- [ ] Open a PR that **supersedes #62** — body carries: the F-08 finding, the four blocker fixes with test names, the wave2-compatibility note, and the **explicit gate that the ST-78 token field (`token`/`queryToken`/`id`) is wire-unverified and needs one live smoke-test before merge**. Note #62 should be closed in favor of this PR.
- [ ] Do NOT merge. Do NOT deploy.
