# Wave 2 — correctness, platform, and the public cut

**Date:** 2026-08-24
**Baseline:** `origin/main` @ `2ff9d39` (Wave 1 merged + deployed 2026-08-23 19:09)
**Prod at start:** version label `1.7.0`, 110 tools, 113 test files / 1367 tests green offline in 5.4s

Wave 1 closed the security findings (S-1 consent screen, S-2 JWT claims, S-4 smoke denylist,
S-8 PII scrub, hono advisories). Wave 2 is correctness, platform modernisation, and refreshing
the public cut.

---

## Ground truth corrections

Three claims that shaped earlier planning are wrong and must not be carried forward:

1. **MB-1's headline is stale.** QUA-1141 + QUA-1234 landed `src/mirror-freshness.ts`.
   20 of 22 mirror-reading tool files are stamped. The residue is **3 shared components**
   (`name-resolver.ts`, `name-cache.ts`, `resources/catalogs.ts`), not ~17 tools.
2. **C-1 (`get_configurable_equipment_children`) is fixed** (`4518f99` → `e1f29b6` → `bb717a8`).
   Dropped from scope.
3. **`node_modules` corruption does not block testing.** `npm test` runs fully offline.
   The earlier "fsck blocks the SDK bump" assessment was wrong.

Also corrected: the server does **not** pin protocol `2024-11-05` — `Server._oninitialize`
negotiates against `SUPPORTED_PROTOCOL_VERSIONS` and echoes the client's request.
`wrangler.toml` already sets `placement = { mode = "smart" }` and `[observability] enabled = true`.

---

## Workstreams

Each is an independent branch off `origin/main`, built in its own worktree, each landing as its
own PR. A–E have no file overlap and run in parallel. F is sequenced behind a human check. G is last.

### A — ST call gating and rate limiting (P-1, C-5)

**Problem.** `checkRateLimit` is invoked from exactly one live path (`paged-st-read.ts:122`),
and `pagedStRead` has exactly one caller (`margin_audit.ts:57`). Every other ST call —
`readST` (60 importing files), `readSTPost`, `readSTPaged`, and 8 direct `ST_PROXY.fetch`
write sites — is ungoverned, with no 429 handling. The `reporting` family's 20/min cap exists
in `FAMILY_CAP` and is never consulted, which is why `st_run_report` eats 429s.

Two design bugs compound it:
- `rate-limit-guard.ts:9` uses `idFromName(family)`, so `AGGREGATE_CAP = 80` is enforced
  *per family*, not globally. The "global 80/min" is fiction.
- `familyFromEndpoint` returns the raw path segment, so undeclared families
  (`sales`, `inventory`, `payroll`, `marketing`) hit `FAMILY_CAP[x] === undefined`,
  making `count >= undefined` false — **unlimited**.

**Tasks.**
1. Gate `readST` / `readSTPost` / `readSTPaged` through `checkRateLimit`, and call
   `reportBackoff` on a 429 response with `Retry-After`.
2. Gate the 8 direct `ST_PROXY.fetch` write sites.
3. Route the aggregate counter through a single DO id so `AGGREGATE_CAP` is genuinely global,
   keeping per-family counters on their own ids.
4. Give undeclared families an explicit `DEFAULT_FAMILY_CAP` rather than an implicit infinity.
5. Throw `McpError('rate_limited')` with `retry_after_ms` instead of a plain `Error`
   (`errors.ts:50,:80` already carry the plumbing).
6. `st_run_report`: add a cooldown after a 429 plus a short result cache.

**Risk.** Touches the hot path of every read. Gate behind tests that assert the limiter is
consulted exactly once per call and that a 429 produces `McpError('rate_limited')`.

### B — composite honesty and pagination (P-2, C-2, C-3, C-4)

**Problem.** Five composites read a single page and present it as a total. None checks
`hasMore`; none emits `truncated`.

| Tool | file:line |
|---|---|
| `dispatch_override_audit` | `composites/dispatch_override_audit.ts:70` |
| `call_quality_review` | `composites/call_quality_review.ts:25` |
| `membership_jackpot_leaderboard` | `composites/membership_jackpot_leaderboard.ts:27` |
| `membership_outreach_list` | `composites/membership_outreach_list.ts:23` |
| `pricebook_health_check_services` | `composites/pricebook_health_check_services.ts:18` |

**Tasks.**
1. Swap all five to `pagedStRead`, surfacing `truncated` and `pageCount`. Note the signature
   takes raw `headers`, not `readST`'s `{actor, correlation}` ctx — the swap is not mechanical.
2. `dispatch_override_audit`: chunk the `ids` join (>~50 ids 400s; the chunker in
   `list_jobs_today.ts:21` is unused here), chunk the D1 `IN (…)` bind (200 params vs D1's ~100
   limit), and rename `overrideCount` — it counts *all* appointments and detects no reassignment.
3. `commercial_plumbing_opportunities`: wire `jobTypeName` into `rejectUnsupportedSTFilters`
   (`st.ts:50`, shipped `a66a616` for exactly this defect class) so an unsupported filter fails
   loudly, and fix the inverted cohort — it currently dedupes customers with jobs completed
   *before* the cutoff and never excludes those with a *recent* job.
4. `pricebook_health_check_services`: stop treating `cost === 0` as unhealthy. QSC runs dynamic
   pricing; `supabase.ts:146` `shapePriceRow` already encodes the correct rule and the repo
   contradicts itself. Report over the full population, not one page.

### C — Supabase hardening and gold watermark (MB-4, D-1)

**Problem.** `src/supabase.ts` has a timeout but no retry (all four helpers are single-shot
`fetch`), no error slicing (a 522 HTML page lands whole in `error_log` and in the MCP
response), and no cache. Separately, **all 9 Supabase-backed tools publish no data-age
watermark.** The surface grew since the audit — `titan_advisor_score` shipped as a 9th.

Note: the audit cited `trade_coverage.ts:158 measured_at` as a precedent. It is **not** one —
that records when *we measured*, not when gold was built. Copying it would be misleading.
A real watermark helper must be written.

**Tasks.**
1. Retry wrapper on 429/408/5xx, mirroring `d1-proxy.ts:157`'s 3-attempt backoff.
2. `.slice(0, 600)` on all four error paths (`:72`, `:85`, `:118`, `:139`).
3. `cacheGet` on `get_proposal_tiers`.
4. Write a `_gold_as_of` watermark helper (the `fetchTableMax` shape, but for Supabase) and
   apply it to all 9 tools. `titan_advisor_score` already holds a free watermark it doesn't
   publish — it orders by `snapshot_date.desc` at `:101`.

### D — hygiene and cheap wins (MB-1 residue, redaction, resolver TTL, catalogs)

1. Delete `src/read-router.ts` (only importer is its own test) and fix the false taxonomy
   comment at `tools/index.ts:159`, which claims `'d1'` means "D1-first via read-router
   (live ST only on miss)" for all 15 `source: 'd1'` tools. It never did.
2. Stamp the 3 unstamped shared mirror readers with `stampMirrorFreshness`:
   `name-resolver.ts:64`, `name-cache.ts:97`, `resources/catalogs.ts:212,:231`.
3. **Credential hardening of `REDACT_FIELD_PATTERNS`** (`tool-registry.ts:36-44`). The list is
   PII-only and strips zero credential-shaped keys. Add the enumerated set: `secret`, `token`,
   `api_?key`, `authorization`, `password`, `passwd`, `credential`, `bearer`, `cookie`,
   `session_?id`, `sync_?key`, `client_?secret`, `refresh_?token`, `access_?token`, `jwt`,
   `signature`, `private_?key`, `salt`. Avoid a bare `/key/i` — it over-matches `keyName`,
   `foreignKey`.
4. **TTL on the name-resolver memo** (`name-resolver.ts:51`). `indexCache` has no timestamp,
   no TTL, no bound; the in-code rationale ("isolates are short-lived") is an assumption, not a
   guarantee. Because `KIND_CONFIG` filters `active = 1`, a deactivated tech stays resolvable
   and a newly activated one stays invisible for the isolate's life. Add a fetched-at stamp and
   a 5–10 min TTL.
5. Add the **business units** catalog resource — trivial, the table is already queried at
   `name-resolver.ts:40`. Stamp it with freshness at birth.

### E — Cloudflare platform

| # | Item | Verdict | Effort |
|---|---|---|---|
| 1 | `secrets.required` in `wrangler.toml` — turns 8 TOML comments into an enforced deploy gate | ADOPT | S |
| 2 | `[observability.traces]` with `head_sampling_rate` — free until 2026-09-30, billed from 10-01 | ADOPT | S |
| 3 | `mcp_cache` D1 table → KV with `expirationTtl`. **Nothing currently deletes expired rows**; only `cachePurgeNamespace` deletes, by namespace | ADOPT | S |
| 4 | Persist `CustomerSnapshotSingleflight` locks to DO storage — it holds them in a plain in-memory `Map`, so every eviction silently degrades it to a no-op | ADOPT | S |
| 5 | AI Gateway on `embedQuery` only (`supabase.ts:30`), `cacheTtl: 86400`. **Not** on `PricebookEmbedWorkflow` — every input there is unique by construction | CONSIDER | S |
| 6 | Native `[[ratelimits]]` binding at the `/mcp` edge for per-caller abuse protection. Does **not** replace `StRateLimiter` — it is per-colo and eventually consistent, and cannot enforce a global ST quota | CONSIDER | S |
| 7 | `placement.region` hint instead of `mode = "smart"` — docs advise against smart mode for a known single backend. Requires confirming the Supabase region first | CONSIDER | S |
| 8 | `StRateLimiterV2` on the SQLite DO backend — a deployed KV-backed class **cannot** be converted; this is a cutover, safe only because rate-limit state is ephemeral. Defer behind A | DEFER | M |
| 9 | Queues, Hyperdrive, Vectorize, Containers | SKIP | — |

`audit_log` stays regardless — it is a compliance record for a two-phase-confirm write system,
not telemetry. Tracing would make `error_log` redundant, not `audit_log`.

### F — dependency and protocol upgrades (SEQUENCED, not parallel)

**Blocked on the human OAuth check.** `@cloudflare/workers-oauth-provider` 0.8.1 → 0.10.3 is
8 releases, and 0.9.0 enforces PKCE-S256, strict RFC 8707 resource matching, and RFC 9207
`iss`. Those touch the exact login path Wave 1 just rewrote and no human has yet exercised.
**Do not bump until the consent screen is confirmed working.**

1. `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 — no API break, no protocol change. The only
   behavioural changes are a 10 MB stdio read cap (irrelevant to an HTTP Worker) and stricter
   `Content-Type` parsing. Low risk, do first.
2. `@cloudflare/workers-oauth-provider` → 0.10.3, and evaluate **CIMD** (Client ID Metadata
   Documents). MCP 2026-07-28 **deprecates DCR** in favour of CIMD; the provider already
   supports it but it is disabled — `global_fetch_strictly_public` is absent from
   `wrangler.toml` and `clientRegistrationCallback` / `disallowPublicClientRegistration` are
   unset, so registration is fully open. This is the principled fix for `/register`.
3. `agents` 0.17.3 → 0.21.0 + MCP SDK v2. Larger: MCP packages move to `peerDependencies`
   (must be added to our own `package.json`), `createMcpHandler` takes a **factory**, and the
   import moves to `agents/mcp/server`. Highest-risk runtime regression is **not** the SDK swap
   but 0.20.0's new Origin/Host allowlist. Our `createMcpHandler` choice is vindicated —
   `McpAgent` is now the deprecated path. Own PR, `env.dev` first.

**Not adopting elicitation.** It is structurally impossible on the stateless path
(`createMcpHandler` builds a fresh transport per request with no storage; `elicitInput` is
DO-only). Under 2026-07-28 it is replaced by MRTR — a client-retry `input_required` pattern —
which requires the v2 stack. Our dryRun→HMAC gate stays; it is not obsolete.

### G — public cut refresh (`lpeluso-dotcom/servicetitan-mcp`)

Frozen at v1.0.0 / 76 tools since 2026-06-19 while live is at 110. It ships **two real
problems**, so this is not cosmetic:

1. `src/jwt.ts:17` calls `jwtVerify(token, secret)` with **no audience or issuer** — the exact
   S-2 finding Wave 1 fixed privately, still public.
2. `hono ^4.12.23` — the 4 advisories Wave 1 patched.

Plus: `agents ^0.13.2` (live 0.17.3, current 0.21.0), and `server.json` on schema `2025-09-29`
(current `2025-12-11`).

**Tasks.** Port the S-2 JWT fix and the hono bump first. Then port the genuinely portable
tools — those that hit the ST API directly with no QSC infrastructure. Excluded by
construction: everything Supabase-backed (`gold_*`, `semantic_search_gold`,
`search_pricebook_semantic`, `search_pricebook_templates`, `get_proposal_tiers`,
`get_service_breakout`, `find_packages_with_item`), Siro, and QSC business logic
(`membership_jackpot_leaderboard`, `commercial_plumbing_opportunities`, `save_tech_debrief`,
`open_opportunities_pulitzer_feed`). Refresh `server.json` to the current schema.

**Registry.** The server is **not** listed in the MCP registry — an exact-name query for
`io.github.lpeluso-dotcom/servicetitan-mcp` returns 0. A manifest exists but was never
published. Publishing is free and is the discoverability play. **Requires Luke's explicit
approval** — as does any npm publish.

---

## Sequencing

```
A B C D E   (parallel, worktree-isolated, each its own PR)
        │
        ├── F1 (SDK 1.30.0)            — any time, low risk
        ├── F2 (oauth-provider, CIMD)  — BLOCKED on human OAuth verification
        ├── F3 (agents 0.21 + SDK v2)  — after F1, env.dev first
        │
        └── G (public cut)             — after A–D land, security ports first
```

## Definition of done

- `npm run check` green (typecheck + 1367+ tests) on every branch before its PR.
- No branch merged without a fresh test run pasted into the PR — no "should be fine".
- Deploy from `main` after each merge; confirm `/health` reports the new commit sha.
- The audit doc gets a Wave 2 status pass at the end, marking what is now actually fixed.

## Open decisions for Luke

1. **OAuth consent verification** — gates F2. The only genuinely human-only item.
2. **npm publish** and **MCP registry publish** for the public cut — outward-facing, needs a yes.
3. **`placement.region`** — needs the Supabase project region confirmed.
4. Git history still carries 8 employee emails. Accept, or rewrite a public repo's history?
