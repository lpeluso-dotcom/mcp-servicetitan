# mcp-servicetitan — remaining work after Wave 2

A self-contained handoff. Everything below is verified state as of **2026-08-24**, not
aspiration. Paste any single section as a prompt; the "Orientation" block is the shared
preamble every one of them needs.

---

## Orientation (read first — prepend to any task below)

You are working on `mcp-servicetitan`, a production Cloudflare Worker exposing 110 MCP tools
over Streamable HTTP for ServiceTitan tenant `431848990`. Repo: `~/work/mcp-servicetitan`,
GitHub `lpeluso-dotcom/mcp-servicetitan` (**PUBLIC** — never commit tenant secrets or
security-sensitive detail).

**Current state, verified 2026-08-24:**
- `main` @ `4408097`, deployed to prod. `/health` reports the deployed commit sha.
- 124 test files / 1581 tests, green, fully offline in ~6s.
- The `version` label still says `1.7.0` and has been meaningless for months. Use the
  commit sha from `/health`, not the label.
- Waves 1 and 2 (workstreams A–D) are merged and live. Wave 2 workstream E is **not**.

**Process rules — non-negotiable:**
1. **TDD.** Write the failing test first and actually run it to watch it fail. A test you
   never saw fail proves nothing.
2. **Verify before claiming done.** `npm run check` (typecheck + suite) must be green, with
   real pasted output. Never "should pass".
3. **The local test runner is intermittently flaky** — `node_modules/@babel` is damaged on
   disk, which occasionally kills a vitest worker fork and reports e.g. `123 passed (124)`.
   Re-run before believing a failure. **CI is authoritative** because it installs clean.
   Do NOT try to repair `node_modules`.
4. **`wrangler` cannot run locally at all** — `node_modules/wrangler/wrangler-dist/cli.js`
   has a `SyntaxError`. No local `deploy --dry-run` is possible. Verify config by parsing
   it (`tomllib`) and against current Cloudflare docs; label anything unproven as unproven.
5. **Deploys are CI-only:** `gh workflow run deploy.yml --ref main -f env=prod|dev`. A local
   `wrangler deploy` cannot work — committed `wrangler.toml` ships placeholder resource ids
   by design, swapped in by `scripts/inject-deploy-config.py` inside the workflow.
   `main` is branch-protected: PR + green `validate`, and the branch must be **up to date**
   with base or the merge is refused.
6. **Protected modules** (registered in `qsc-infra/.claude/rules/protected-modules.md`):
   `src/write-gate.ts`, `src/write-tool-factory.ts`, `src/composite-helpers.ts`,
   `src/routes/admin-guard.ts`, `src/tools/st_call.ts`, `src/st-path-builder.ts`,
   `src/durable/*.ts`, `migrations/0001_baseline.sql`. Changing one is allowed but must be
   called out prominently in the PR body. (`src/read-router.ts` was deleted in Wave 2.)
7. **Hard business rule:** ServiceTitan pricebook items use **dynamic pricing**. A `price`
   or `cost` of `0`/`null`/absent does **NOT** mean free or unpriced — it is computed at
   invoice time. Never report an item as unpriced based on a static field read.

**Reference documents:**
- `docs/superpowers/plans/2026-08-24-wave2-correctness-and-platform.md` — the Wave 2 plan
- `docs/superpowers/plans/2026-08-24-wave2-agent-prompts.md` — the Wave 2 agent prompts
- `~/qsc-infra/docs/audit/ST-MCP-AUDIT-2026-08-01.md` — the source audit. **Now partly
  stale**; Wave 2 corrected MB-1, C-1, C-4 and the node_modules claim. Trust code over it.

---

## BLOCKED ON LUKE — cannot proceed without these

**L1. Verify the OAuth consent screen.** Wave 1 added a consent page to the `/authorize`
flow (audit S-1). No human has logged in through it since. It only fires on
authorize — an already-connected connector skips it — so it needs a **disconnect and
reconnect** of a claude.ai connector (or a throwaway second one) against
`https://mcp-servicetitan.lpeluso.workers.dev/mcp-oauth`. Confirm the page appears, names
the application, and shows a `claude.ai` address under "will send your token to".
**This blocks L2 and task F2.** Four real people authenticate through this path
(`lpeluso@`, `office@`, `awilliams@`, `ssusor@`).

**L2. KV namespaces + secrets** — blocks merging PR #109 (see E1). Create the two
`MCP_CACHE` KV namespaces; set `KV_CACHE_NAMESPACE_ID_PROD` and `_DEV` as GitHub secrets;
confirm all 9 prod secrets are set (the new `secrets.required` gate will fail the deploy
otherwise); confirm `namespace_id` `1001`/`1002` are not already claimed by `taylor-ai` or
`qsc-hopper` in the same Cloudflare account.

**L3. Publish decisions** for the public cut (`lpeluso-dotcom/servicetitan-mcp`): npm, and
the MCP registry. An exact-name query for `io.github.lpeluso-dotcom/servicetitan-mcp`
against `registry.modelcontextprotocol.io` returns **0** — a manifest exists but was never
published. Both are outward-facing and irreversible-ish; do not do either without a yes.

**L4. Git history** still carries 8 employee emails in a public repo. Accept, or rewrite?

---

## E1 — merge Wave 2 workstream E (PR #109)

**Blocked on L2 only.** The PR is complete, CI-green, and was deliberately held back:
merging it puts `secrets.required` on `main`, which makes the **next deploy fail** unless
the secrets exist. Deploys are manual, so someone could trip it unaware.

Contents: `secrets.required` deploy gate, `[observability.traces]` (0.1 prod / 1.0 dev —
free until 2026-09-30, billed after), `mcp_cache` D1→KV behind a `CACHE_BACKEND` flag
(ships `d1` in prod, `dual` in dev), persisted `CustomerSnapshotSingleflight` locks,
AI Gateway on `embedQuery` only, and a native `[[ratelimits]]` edge binding.

It also fixed a **latent deploy bug**: `scripts/inject-deploy-config.py` mapped KV
placeholders by TOML section header, so adding a third `[[kv_namespaces]]` block made
`MCP_CACHE` inherit `PROXY_STATE`'s namespace id. It now resolves by `binding =` line.

**After L2:** update the branch, confirm `validate` is green, merge, deploy to **dev first**
(`-f env=dev`), verify, then prod. Then flip `CACHE_BACKEND` to `dual` in prod, watch, and
only then to `kv`. Do not jump straight to `kv` — nothing has proven KV beats D1 here.

---

## A2 — close the last two ungoverned ServiceTitan call paths

Wave 2 workstream A put ~60 tool files and 8 write sites under the rate limiter, but flagged
two paths it would not touch because both are protected modules outside its brief:

- **`src/composite-helpers.ts:45`** (`stRead`) — used by the three highest-fanout
  composites. **The biggest remaining hole.**
- **`src/write-tool-factory.ts:140`** — the generic write path behind ~14 tools.

Each is a one-line wrap in the existing `guardedStFetch`. Both are protected modules — flag
them.

**Important:** `composite-helpers.ts` fan-outs are **parallel**, so they will be the heaviest
users of the new pacing path. Re-check `MAX_PACE_ATTEMPTS` (3) and `MAX_PACE_WAIT_MS` (1200)
against a realistic fan-out before assuming the defaults hold. The cautionary case is
`get_configurable_equipment_children`, which fans out 25 parallel calls and would have
hard-failed 13 of them under the new caps before pacing was added.

**Context — the caps are now derived, not invented** (`src/durable/st-rate-limiter.ts`):
`ST_DOCUMENTED_CALLS_PER_SECOND = 60` (ServiceTitan's published limit),
`WORKER_QUOTA_FRACTION = 1/3` (we share the tenant quota with taylor-ai and Make),
`AGGREGATE_CAP = 20`/s, `DEFAULT_FAMILY_CAP = 12`/s, 1-second windows.
ST's real reporting rule is **1 of the same report per minute per tenant** — not a volume
cap — and is enforced as same-report-identity rejection.

---

## R1 — `st_run_report`: finish the async migration (PR #62, open since 2026-07-11)

**This has a deadline that is not ours to set.** PR #62 (QUA-785) migrates `st_run_report`
from ServiceTitan's **deprecated synchronous** reporting endpoint to the async token/poll
pattern per ST API release #78 — *"before the old sync endpoint sunsets"*.

Wave 2 added a result cache and same-report rejection on the **sync** path. That is a
stopgap on an endpoint with a shelf life. Rebase PR #62 onto current `main`, reconcile it
with the Wave 2 caching and `reportRunIdentity()` work (the canonical cache key sorts report
parameters by name — the async path must use the same identity function or the two will
disagree), and land it.

Check whether ST has announced a sunset date. If it has, this stops being routine
maintenance and becomes time-boxed.

---

## F1 — MCP SDK 1.29.0 → 1.30.0

Low risk: no API break, no protocol-constant change (`LATEST_PROTOCOL_VERSION` is
`2025-11-25` in both). Only two behaviour changes — a 10 MB stdio read-buffer cap
(irrelevant to an HTTP Worker) and `Content-Type` validated by parsed media type instead of
a substring match.

**Check first whether it is even possible:** `agents@0.17.3` pins
`@modelcontextprotocol/sdk` at **exactly `1.29.0`**, not a caret. If the pin blocks it, this
folds into F3 and should not be attempted alone.

---

## F2 — `@cloudflare/workers-oauth-provider` 0.8.1 → 0.10.3, and CIMD

**Blocked on L1.** Eight releases behind. 0.9.0 is a security-tightening release that
**enforces PKCE (S256 required, `plain` rejected)**, applies strict RFC 8707 resource
matching, adds RFC 9207 `iss`, and tightens DCR validation. 0.10.0 changes the `/authorize`
handler shape by exporting `AuthorizationError` from `parseAuthRequest()`.

These touch the exact login path Wave 1 rewrote and that no human has exercised. Bumping
first would confound two changes — if login breaks you would not know which caused it.

**While there, evaluate CIMD (Client ID Metadata Documents).** MCP revision 2026-07-28
**deprecates Dynamic Client Registration in favour of CIMD**. The provider supports it, but
it is disabled here: `global_fetch_strictly_public` is absent from `wrangler.toml`'s
compatibility flags, and `clientRegistrationCallback` / `disallowPublicClientRegistration`
are unset — so `/register` is fully open to anyone. The consent screen (Wave 1) is what
currently makes that safe. **CIMD is the principled fix.**

Before bumping, check whether any client we support omits PKCE or sends a `resource` that
does not exactly match the configured `resourceMetadata.resource` — those are the two most
likely breakages.

---

## F3 — `agents` 0.17.3 → 0.21.0 + MCP SDK v2

The substantial upgrade. Four minors and a whole SDK generation.

- MCP packages move from `dependencies` to **`peerDependencies`** — `@modelcontextprotocol/server@2.0.0`
  must be added to our own `package.json` (exact-pinned, no caret).
- `createMcpHandler` takes a **factory**, not an instance; the import moves to
  `agents/mcp/server`.
- The v1-server overload still compiles on 0.21.0, so a two-step (bump, then refactor) is
  viable and is the recommended shape.

**The highest-risk regression is not the SDK swap — it is 0.20.0's new Origin/Host
allowlist**, which rejects malformed and non-allowlisted browser Origins. Requests with no
Origin header (normal non-browser MCP clients) still pass. If this worker is ever reached
from a browser client or a custom domain, set `allowedHostnames` / `allowedOriginHostnames`
before deploying. Deploy to `env.dev` first.

**Our architecture is vindicated, not threatened:** `McpAgent` is now deprecated and
feature-frozen, and Cloudflare's docs say plainly not to use it for new servers. We are
already on the recommended stateless `createMcpHandler` path.

**Do not adopt elicitation.** It is structurally impossible on the stateless path —
`createMcpHandler` builds a fresh transport per request with no storage, and `elicitInput`
exists only on the DO-backed `McpAgent`. Under MCP 2026-07-28 server-initiated requests are
replaced by MRTR, a client-retry `input_required` pattern that needs the v2 stack. The
existing dryRun→HMAC write gate stays and is **not** obsolete.

---

## G — refresh the public cut (`lpeluso-dotcom/servicetitan-mcp`)

Frozen at v1.0.0 / 76 tools since 2026-06-19; live is at 110. It is correctly de-tenanted
(no tenant id, no QSC emails, no `taylor-ai` or Supabase references) — **keep that true**.

**Security first, as its own PR. This is not cosmetic:**
1. `src/jwt.ts:17` calls `jwtVerify(token, secret)` with **no `audience` and no `issuer`** —
   the exact S-2 finding Wave 1 fixed privately, still shipping publicly.
2. `hono ^4.12.23` — the 4 advisories Wave 1 patched by moving to 4.13.3.

Then dependencies (`agents ^0.13.2`, `@modelcontextprotocol/sdk ^1.29.0`), then
`server.json` — it is on registry schema `2025-09-29`; current is `2025-12-11`.

Then tools. **Portable** = hits the ST API directly with no QSC infrastructure. **Excluded
by construction:** everything Supabase-backed (`gold_*`, `semantic_search_gold`,
`titan_advisor_score`, `trade_coverage`, `search_pricebook_semantic`,
`search_pricebook_templates`, `get_proposal_tiers`, `get_service_breakout`,
`find_packages_with_item`), all `siro_*`, and QSC business logic
(`membership_jackpot_leaderboard`, `membership_outreach_list`,
`commercial_plumbing_opportunities`, `save_tech_debrief`,
`open_opportunities_pulitzer_feed`). Anything reading the taylor-ai D1 mirror must be
reimplemented against live ST or skipped — decide per tool and say which.

**Do not publish to npm or the registry without L3.**

---

## Loose ends — each small, none urgent

| # | Item | Evidence |
|---|---|---|
| X1 | `call_quality_review` accepts a `csr` argument the handler never sends to ST or applies client-side. Third instance of the silently-dropped-filter class. Wire it up or reject it via `rejectUnsupportedSTFilters`. | Found by Wave 2 workstream B |
| X2 | **taylor-ai D1 CPU-limit resets** — `D1 DB exceeded its CPU time limit and was reset`, across 5 tools on Aug 6 / 18 / 22 / 23 / 24. Pre-existing, cross-repo, and it fails the post-deploy smoke gate intermittently. Needs its own investigation in `taylor-ai`. | `error_log`, and the 2026-08-24 deploy run |
| X3 | `business_units.synced_at` is **unconfirmed** — the Wave 2 BU catalog resource deliberately omits it and rides on the soft-failing `fetchTableMax` probe. One-line upgrade once someone confirms the column exists. | `src/resources/catalogs.ts` |
| X4 | `payroll_job_timesheets_list` still uses its own older freshness guard rather than `stampMirrorFreshness` — inconsistent shape vs the other 20 stamped tools. Low-value consolidation. | `src/tools/payroll/payroll_job_timesheets_list.ts:261,:277,:290` |
| X5 | Catalog resources still missing: **campaigns** and **membership types** (need a cached live-ST read; the `reports` catalog is the precedent) and **job types** (no mirror table and no endpoint in this repo at all — check the `st-job-types` skill for an authoritative source first). | `src/resources/catalogs.ts` |
| X6 | A **sliding window** for the rate limiter is the obvious next step if 20/s ever binds. Not taken in Wave 2 because it replaces the persisted counter shape with timestamp rings, rewriting a protected module's storage format for a second-order gain. | `src/durable/st-rate-limiter.ts` |
| X7 | Confirm whether the `servicetitan-proxy` Worker forwards ST's `RateLimit-*` headers. If it does, feeding real remaining-quota into the DO beats any hardcoded fraction. There is a `TODO(rate-limit)` marking this. | Cross-repo |
| X8 | The `version` label (`1.7.0`) has been meaningless for months. Either bump it in the release flow or delete it and rely on the commit sha in `/health`. | `package.json` |
| X9 | Stale open PRs need triage: **#94** (docs — CLAUDE.md + 2 plan files, still unmerged, which is why local `main` had 3 unpushed commits), **#100/#101/#93/#76** (dependabot). | `gh pr list` |
| X10 | Stale local checkouts of this same repo, confusing to cross-repo greps: `~/work/mcp-st-jessica` (v1.6.0, June) and `~/work/mcp-st-front-office`. Also a leftover `qua-1234` worktree. Delete when convenient. | `git worktree list` |
| X11 | Give the audit doc a Wave 2 status pass — mark MB-1, C-1, C-4, P-2, D-1, MB-4 as resolved and correct the stale claims, so the next reader is not misled the way Wave 2 planning initially was. | `~/qsc-infra/docs/audit/ST-MCP-AUDIT-2026-08-01.md` |

---

## Suggested order

```
L1 (Luke, 2 min) ──► F2 ──► F3
L2 (Luke)        ──► E1
A2  ─┐
R1  ─┼─ independent, any order, highest value first: A2 > R1 > F1
F1  ─┘
G   ── after A2/R1 land, security PR first, publish gated on L3
X*  ── opportunistic
```

**Definition of done for each:** failing test watched fail first; `npm run check` green with
pasted output; PR with a body stating what changed, why, the real test output, and any
protected-module touches; deploy from `main` after merge; `/health` confirms the new sha.
