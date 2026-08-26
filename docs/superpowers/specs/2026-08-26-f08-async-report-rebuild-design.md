# F-08 — st_run_report async-report migration (rebuild)

**Date:** 2026-08-26
**Ticket/source:** tai-connectors-review-2026-08-25.md finding **F-08** (High, Correctness/deployment); supersedes open PR #62 (QUA-785).
**Repo:** `mcp-servicetitan` (TAI-ST)
**Branch:** `codex/ralph-f08-async-report-rebuild`
**Scope guardrails:** no deploy, no merge, no live ST calls, no D1/QBO writes. All Luke-gated.

## Problem

`st_run_report` mode=run currently POSTs the deprecated **synchronous** endpoint
`.../reports/{id}/data` with `page`/`pageSize`/`parameters` in the request **body**.
ST API release #78 (ST-78) deprecated that endpoint and replaced it with an async token
contract. ST also ignores body-level paging on the old endpoint, so paged runs silently
return the default page (F-08).

Two prior changes each fix half of this and **collide**:

1. **main `acb7924`** (deployed, from `fix/review-remediation`) moves paging from body to
   query params on the *old sync* endpoint — a stopgap that keeps the sync call.
2. **PR #62** (`feat/async-report-migration`) rewrites mode=run to the async contract but
   **drops the entire 429-containment layer** main added in Wave 2 (result cache, post-429
   cooldown, `reportRunIdentity`, `REPORT_RUN_TTL_SEC`, `_resetReportCooldown`). main's own
   `wave2_st_run_report_cooldown.test.ts` imports those symbols, so PR #62 as-is fails
   typecheck against current main. Merging #62 independently is a regression, not a fix.

The correct resolution (per the review and Codex's adversarial passes): **rebuild the async
migration on current main, re-integrating the containment layer**, and fix the specific
adversarial blockers found in the transport.

## Async contract (ST-78)

Assumed from the ticket + ST-78 release notes; the exact token field is **wire-unverified**
and the code fails loud (dumping the actual response keys) on divergence rather than guessing.

```
POST .../report-category/{cat}/reports/{id}/data/query
     → 200  (rows inline, done)
     → 202  (+ token; report is slow)
GET  .../tenant/{tid}/data-queries/{token}
     → 200  (rows, done)
     → 202  (still pending)
DELETE .../tenant/{tid}/data-queries/{token}   (best-effort cancel; frees ST slot)
```

Token field checked in order: `token`, `queryToken`, `id`. None found on a 202 → loud
`upstream_error` naming the keys actually seen.

## Approach

Start from PR #62's transport functions (`runReportQueryAsync`, `pollDataQuery`,
`cancelDataQuery`, `extractQueryToken`) — they are well-built and use the correct proxy
patterns (`/api/st/read` for GET/POST, `/api/st/write` method-envelope for DELETE, since
`st.ts` is protected and DELETE isn't accepted by the read proxy). Re-seat them on current
main and wrap the async call with main's containment layer.

## Blockers to fix (each gets a failing test first)

| ID | Defect | Fix |
|----|--------|-----|
| B1 | **Poll timeout counts only sleeps, not hung network time.** `maxAttempts × interval` never trips if each GET hangs. | Wall-clock deadline: compute `deadline = now + pollTimeoutSeconds*1000`; check elapsed real time each loop AND pass an `AbortSignal` with the remaining budget to every upstream fetch so a hung poll is aborted, not awaited forever. |
| B2 | **Containment layer dropped.** Cache/cooldown/identity gone; main tests fail to compile. | Re-add `REPORT_CACHE_NS`, `REPORT_RUN_TTL_SEC`, `reportRunCooldownUntil`, `_resetReportCooldown`, `reportRunIdentity`. Wrap the async run in `cacheGet(...)` keyed by `reportRunIdentity` (now includes `page`/`pageSize`); arm the tool-wide cooldown on a real ST 429 (not on the limiter's same-report rejection). A cache hit must NOT be rejected by cooldown — cooldown is checked only on the path that would hit upstream. |
| B3 | **Raw upstream error body disclosed to MCP callers.** `text.slice(0,200)` leaks upstream response bodies. | Sanitize: report status + a fixed diagnostic string + correlation id; never echo the upstream body to the caller. Keep the real body only in server-side logging if any. |
| B4 | **Rate-limiter/admission can hang past abort; late upstream request after abort.** | Race the entire guarded poll against the deadline; ensure no upstream fetch is issued once the deadline/abort has fired (guard before each fetch and honor the AbortSignal). |

## Components

- `src/tools/reporting/st_run_report.ts` — the tool. Async transport (from #62) + main's
  containment layer + B1–B4 fixes. Discovery modes (list_categories/list_reports/
  describe_report) unchanged.
- Test seams (no new public args): `_resetReportCooldown()`, plus internal
  `_pollIntervalMs` and a time source injection so B1's wall-clock deadline is testable
  without real waits (inject `now()` / use fake timers).

## Testing

Pure unit tests; `ST_PROXY.fetch` mocked. No live ST. Each blocker + the core contract:

1. 200-inline run returns rows (no poll). *(contract)*
2. 202 → token → poll 202×N → 200 returns rows. *(contract)*
3. 202 with no recognizable token field → loud error naming actual keys. *(contract)*
4. **B1:** every poll GET hangs; fake time advances past the ceiling → timeout fires with
   real elapsed seconds; a DELETE cancel is attempted. Proves wall-clock, not sleep-count.
5. **B2a:** identical run within TTL is served from cache; upstream fetch count stays 1.
6. **B2b:** a cache hit during an active cooldown still succeeds (cooldown does not reject
   cached reads).
7. **B2c:** `wave2_st_run_report_cooldown.test.ts` (main's existing suite) compiles and
   passes unchanged — the containment exports are back.
8. **B3:** an upstream 500 with a body → caller-facing error contains NO upstream body text.
9. **B4:** deadline fires during admission → no upstream fetch is issued after abort.

**Gate:** full `npm test` + `npm run typecheck` + `wrangler deploy --dry-run` (non-deploying)
all green. Then adversarial review (qsc-agents:adversary) before opening the PR.

## Out of scope

Deploy, merge, live smoke-test of the wire contract, and any change to discovery modes or to
`st.ts`/other protected modules. The PR body will flag that the token field name needs one
live smoke-test to confirm before merge.
