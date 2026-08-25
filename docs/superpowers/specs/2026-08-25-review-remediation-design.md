# Review remediation — design

**Date:** 2026-08-25
**Branch:** `fix/review-remediation` (off `origin/main` @ `559f540`)
**Provenance:** adversarial review of PR #111 (`servicetitan-mcp-adversarial-review.md`), independently verified 2026-08-24/25.

## 1. Context

An external adversarial review of PR #111 (AP Inbox read tools) produced ~17 findings spanning the AP
feature and the server as a whole. Every claim was re-verified against source at `6d159e9` before any
work was scoped. This document records what survived verification, what was corrected, and what we
are choosing not to do.

### 1.1 What verification confirmed about the review itself

The review's evidence table reproduced exactly: `6d159e9` is a true ancestor of `559f540` with an
empty tree diff; live `/health` reports 113 tools at commit `559f540`, `lockdown:false`;
`npm run check` gives 129 test files / 1708 tests passing; production audit is 8 advisories
(5 high / 2 moderate / 1 low / 0 critical). No asserted number had drifted.

### 1.2 Corrections to the review (recorded so they are not re-litigated)

| Finding | Review said | Actually |
|---|---|---|
| AP-1 | Encoded CSRF token unconditionally survives redaction | Conditional. Leaks only when the cookie header lacks an `X-CSRF-Token=` pair. A real "Copy as cURL" includes one, which catches the encoded form incidentally. Redaction currently holds by coincidence, not design. Still worth fixing; not a live leak. |
| AUTH-1(a) | `MCP_SYNC_KEY` is "the inbound bearer credential" for `/mcp` | It is a header credential (`X-Sync-Key`). A separate Bearer/JWT path exists keyed by `JWT_SECRET`. Four-trust-domain substance holds; wording did not. |
| AUTH-2 | Server hashes the global sync key | It hashes the *presented* key. Immaterial (auth.ts:85 forces them equal) but the description was wrong. |
| OAUTH-1/2 | CSRF / DoS | Both require prior knowledge of an unguessable v4 UUID. OAUTH-2's realistic failure is a browser prefetch breaking a legitimate login, not an attack. |
| REPORT-1 (deprecation half) | Sync `/data` is deprecated | Prose-only in the ST-78 release note. The live OpenAPI spec sets `deprecated: false` on every reporting operation and **no sunset date exists**. Migration is not urgent. |
| WRITE-1 | The write factory is the ungoverned path | True but incomplete — `composite-helpers.ts:45` is also unguarded and drives up to 10 parallel ST reads per composite call. Our own A2 section already calls it "the biggest remaining hole." |

### 1.3 What verification found that the review missed

**REPORT-1's pagination half is a live production bug, and worse than described.** A tenant probe on
2026-08-25 (report `accounting/155`, `pageSize:3`) returned **188 rows** with ServiceTitan echoing
`pageSize: 1000`, `totalCount: null`, `hasMore: false`. No 400 — so `additionalProperties: false` is
not enforced and body params are silently dropped. Consequences in production today:

- `page` and `pageSize` are inert; the tool's advertised "default 100, max 5000" is false on both ends.
- **Reports over 1000 rows cannot be fully retrieved.** ST returns `hasMore`, but `page` never reaches
  it, so there is no way to fetch page 2. Large reports silently yield partial data.
- `totalCount` is always `null` because `includeTotal` is never sent.
- `reportRunIdentity()` keys the cache on `page`/`pageSize`, so page 1 and page 2 store as distinct
  entries holding identical rows.

This is the same hazard class as a truncating analytical query: the answer looks complete and is not.
It is ranked first in this remediation.

**Two of these bugs are documentation-driven.** `docs/mcp/GOTCHAS.md:68-69` instructs "paginate via
`page` + `pageSize` in the body, not query string" — that doc *caused* REPORT-1. `GOTCHAS.md:90`
already lists `ap-bills` under Accounting, contradicting the `ap-inbox.ts:4-9` comment asserting
"verified 2026-08-24 across three independent sources" that no public AP API exists. The repo
contradicted itself and the wrong side won. **Any fix touching REPORT-1 or AP-3 must correct
`GOTCHAS.md` in the same commit, or the bug regresses.**

## 2. Decisions

1. **Code-only remediation.** Design-shaped findings go to Linear, not to this branch.
2. **AP-6: spec §2.2 wins over the reviewer.** All-or-nothing enrichment failure is preserved. A
   partial AP evidence set that looks complete is more dangerous than a clean error. Only the missing
   wall-clock deadline is added. The reviewer's partial-progress recommendation is **rejected**.
3. **CORE-1 is scoped, not blanket.** The MCP SDK validates `structuredContent` at runtime, so every
   added `outputSchema` is a new live failure mode. Coverage is limited to money-path tools plus
   central list-envelope validation.

## 3. Out of scope — routed to Linear

| Finding | Why deferred |
|---|---|
| AP-3 hybrid public/internal read path | Design change. Public `ap-bills` (ST-75, 2025-10-28, scope `tn.acc.apbills:r`) should back created-bill dedup while the internal API keeps only pending/OCR evidence. Needs its own spec. The *wrong comment and doc contradiction* are fixed here; the redesign is not. |
| AUTH-1 `MCP_SYNC_KEY` split | Touches secrets held by taylor-ai, sentry-quinn, and the Retell flow. Rotation invalidates every outstanding write-confirmation token simultaneously. Needs a rotation runbook. |
| AUTH-2 per-principal roles | Changes auth semantics for every caller. Pairs with AUTH-1. |

Note for the AP-3 ticket: `sources=OCR` on the public `ap-bills` list is a supported filter for
bills that originated in the inbox — it gives the dedup path official data without the internal sweep.
No public endpoint exists for the *pending* queue (all 24 public specs swept, zero matches), so the
internal API remains necessary for that half only.

## 4. Clusters

Ordered by blast radius. Clustered by file so iterations do not collide. One exception: clusters 1 and
5 both edit `docs/mcp/GOTCHAS.md`, at lines 68-69 and 90 respectively. The edits do not overlap
textually, but cluster 5 must rebase on cluster 1 rather than branch from the same base.

### Cluster 1 — REPORT-1 + GOTCHAS correction
**Files:** `src/tools/reporting/st_run_report.ts`, `src/st.ts` (`readSTPost`), `docs/mcp/GOTCHAS.md`

Move `page`, `pageSize`, `includeTotal` to the query string. `readSTPost` currently calls
`buildUrl(resolved)` with no query argument — it needs to accept and append one. Correct the schema's
false `max 5000` to ST's real 1000 cap. Bump the `reportRunIdentity()` cache-key version so entries
written under the inert-param regime cannot serve wrong pages after the fix. Rewrite `GOTCHAS.md:68-69`,
which states the opposite of the truth.

**Acceptance:** a live probe with `pageSize:3` returns 3 rows and an echoed `pageSize:3`; two distinct
pages return distinct rows; `totalCount` is non-null when `includeTotal` is requested.

### Cluster 2 — AP correctness (AP-2, AP-4, AP-5)
**Files:** `src/tools/ap_inbox/ap_inbox_reconcile_amount.ts`, `ap_inbox_list_documents.ts`

- **AP-2:** redefine a posting outcome as the tuple `(line allocations, applied tax, applied shipping)`.
  Today the ambiguity key at `:345-352` branches only on an `extended` prefix, so any two non-`extended`
  modes can never be flagged against each other. If two modes produce different tuples, return
  `cannot_judge`/hold.
- **AP-4:** track `detail_fetched`, `invoice_number_present`, and `enrichment_error` independently.
  Define `unenriched_count` from `detail_fetched === false` only. Fix the note that currently tells a
  caller to "re-call from `enrich_cursor:0`" after a complete sweep, which loops forever.
- **AP-5:** reject `rows.length > totalCount` (the gate at `:352` is one-sided). Hoist the duplicate-identity
  `Set` out of the per-status loop at `:250` so cross-status duplicates are caught.

**Acceptance:** the 150/50/50/FREIGHT case returns hold, not `reconciles:true`; a 2-row batch against
`totalCount:1` fails; the same identity under two statuses fails; a fetched row with a genuinely blank
invoice number does not increment `unenriched_count`.

### Cluster 3 — Secret redaction and error persistence (AP-1, CORE-2)
**Files:** `src/ap-inbox.ts`, `src/st.ts`, `src/obs.ts`, `src/tool-registry.ts`

Scrub raw, percent-encoded, and safely-decoded forms of each **entire** secret before cookie splitting
(`ap-inbox.ts:71` currently `continue`s on a bare token). Separately and more importantly, stop
carrying arbitrary upstream bodies into model-visible errors and persistent logs: `obs.ts:117-131`
binds `message` and `stack` raw into `error_log`, and `tool-registry.ts:324-335` puts the message into
`audit_log.result`. Centralize safe error serialization to `{code, status, endpoint class, correlation}`.

The 600-char body slice in `st.ts` is **plan-prescribed and intentional** (Wave 2 §C) for diagnosis —
it is not removed; it is prevented from reaching persistent sinks.

**Acceptance:** regression tests for raw, percent-encoded, double-encoded, and cookie-subvalue echoes
prove no secret reaches a returned error, `error_log`, or `audit_log`.

### Cluster 4 — Rate-limiter coverage (WRITE-1, COMPOSITE-1)
**Files:** `src/write-tool-factory.ts`, `src/composite-helpers.ts`, new invariant test

Move the limiter inside `defineWriteTool` (15 tools) and guard `composite-helpers.ts:45` `stRead`.
Add an invariant test that **discovers every `ST_PROXY.fetch` call site** rather than maintaining a
hand-picked list. Watch `MAX_PACE_ATTEMPTS`/`MAX_PACE_WAIT_MS` under composite fan-out, as A2 warns.

**Acceptance:** the discovery test enumerates all call sites and asserts each is guarded or explicitly
exempted with a reason.

### Cluster 5 — AP-6 deadline + AP-3 doc correction
**Files:** `src/tools/ap_inbox/ap_inbox_list_documents.ts`, `src/ap-inbox.ts`, `docs/mcp/GOTCHAS.md`

Add a whole-operation wall-clock deadline (per-request `AbortSignal.timeout(25s)` bounds one call, not
the ~444s worst case for 200 rows). Failure stays all-or-nothing per decision 2. Correct the
`ap-inbox.ts:4-9` comment to state that public `ap-bills` exists and that the internal API is required
only for the pending/OCR queue.

### Cluster 6 — OAuth (OAUTH-1, OAUTH-2)
**File:** `src/oauth.ts`

Bind the approval state to the browser with a second `__Host-` HttpOnly/Secure/SameSite cookie required
on POST. Move the `login:<state>` KV delete (`:197`) below the CSRF comparison (`:198`).

### Cluster 7 — Type and test hardening (CORE-3, CORE-1 scoped)
**Files:** `src/tools/index.ts`, `src/__tests__/role-write-invariant.test.ts`, money-path tools

Close the invariant test's blind spot: `role-write-invariant.test.ts:81-82` skips any tool without an
`stEndpoint`, so a mutating tool declaring neither `isWrite` nor `stEndpoint` is invisible. Introduce a
required `effect: 'read' | 'write' | 'admin'` discriminant so omission is a compile error. Add
`outputSchema` to money-path tools only (~10-15) plus central list-envelope validation in `readST`.

## 5. Testing

TDD throughout — each failing test is written and **observed failing** before implementation. Two
findings ship with exact reproductions: AP-2 (`header 150, tax 50, shipping 50, FREIGHT qty 1 @ 100`)
and REPORT-1 (`pageSize:3` → 188 rows, echoed `pageSize:1000`). Full `npm run check` must pass per
cluster; the current baseline is 129 files / 1708 tests.

## 6. Landing and deploy

One commit per cluster on `fix/review-remediation`. **No deploy from this branch.** Deploys are CI-only
(`gh workflow run deploy.yml`) and `main` is branch-protected behind PR + `validate`. Human review and
CI trigger are required. `wrangler.toml` ships placeholder resource IDs by design, so a local deploy
cannot succeed even accidentally.

## 7. Risks

- Cluster 4 changes rate-limiting on 15 write tools that book jobs, reschedule appointments, and mutate
  estimates. Behavior under limit pressure changes for real dispatch operations.
- Cluster 2 touches the code path that reads real vendor bills.
- Cluster 7's `effect` discriminant is a breaking type change across 113 tool definitions.
- Cluster 1 changes report pagination semantics; any consumer that adapted to the broken behavior
  (expecting all rows regardless of `pageSize`) will see different results. This is a correction, but
  it is a behavior change.

## 8. Acceptance for the whole branch

- All 11 in-scope findings have a regression test that fails before the fix and passes after.
- `GOTCHAS.md` no longer contains the two false statements that caused REPORT-1 and AP-3.
- `npm run check` passes at or above the 1708-test baseline.
- Three Linear tickets exist for AP-3, AUTH-1, AUTH-2.
- No secret appears in any persistent error path, proven by test.
