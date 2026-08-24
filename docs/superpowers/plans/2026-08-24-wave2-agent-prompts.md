# Wave 2 — subagent dispatch prompts

Verbatim prompts for the five parallel implementation agents (A–E), plus the sequenced
F and G prompts. Each A–E agent runs in its own git worktree off `origin/main` @ `2ff9d39`.

Companion to `2026-08-24-wave2-correctness-and-platform.md`.

---

## Shared preamble (prepended to every prompt)

> You are implementing one workstream of Wave 2 on the `mcp-servicetitan` Cloudflare Worker.
> You are in your own git worktree — branch off `origin/main` and work only there.
>
> **Non-negotiable process:**
> 1. **TDD.** For every behaviour change, write the failing test FIRST and actually run it to
>    watch it fail. A test you never saw fail proves nothing. Then implement, then watch it pass.
> 2. **Verify before claiming done.** `npm run check` (typecheck + full suite) must be green.
>    Paste the real output. Never write "should pass" or "tests should be green" — run it.
>    Baseline is 113 files / 1367 tests passing offline in ~5s.
> 3. **Stay in your lane.** Other agents are editing this repo in parallel worktrees. Touch only
>    the files listed in your workstream. If a fix seems to require a file outside your scope,
>    STOP and report it rather than editing it.
> 4. **Protected modules.** `src/read-router.ts`, `src/write-gate.ts`, `src/write-tool-factory.ts`,
>    `src/composite-helpers.ts`, `src/routes/admin-guard.ts`, `src/tools/st_call.ts`,
>    `src/st-path-builder.ts`, `src/durable/*.ts`, `migrations/0001_baseline.sql` are registered
>    protected files. If your workstream requires changing one, do it — but call it out
>    explicitly and prominently in your PR body and your final report.
> 5. **Commit and open a PR** against `main` with a body that states what changed, why, the test
>    output, and any protected-module touches. Do not merge it.
> 6. **Report honestly.** If you cannot finish an item, say so plainly and say why. A partial
>    workstream reported accurately is worth more than a complete-sounding one that isn't.
>
> **Repo facts you do not need to rediscover:** the suite runs fully offline (no D1, no network,
> no wrangler); `vitest.config.ts` aliases `cloudflare:workers` → `vitest.setup.ts`.
> `npm test` = `vitest run`; `npm run check` = typecheck + test. Do NOT pass `--reporter=basic`
> (vitest 4 rejects it). Do NOT attempt to reinstall or repair `node_modules` — a `@babel`
> package is damaged on disk but the suite runs fine regardless.

---

## Agent A — ST call gating and rate limiting

> **Workstream A: wire the rate limiter into every ServiceTitan call path.**
>
> **The problem, verified at `origin/main`:** `checkRateLimit` is invoked from exactly one live
> code path — `src/paged-st-read.ts:122` — and `pagedStRead` has exactly one caller,
> `src/tools/composites/margin_audit.ts:57`. Every other ST call is completely ungoverned:
> `readST` (`src/st.ts:95`, imported by 60 non-test files), `readSTPost` (`:133`),
> `readSTPaged` (`:182`), and 8 direct `env.ST_PROXY.fetch` write sites
> (`tools/st_call.ts:64,:92`; `tools/dispatch/assign_technicians.ts:44,:58`;
> `tools/invoicing/st_add_invoice_line_item.ts:275`;
> `tools/invoicing/st_create_adjustment_invoice.ts:344`;
> `tools/pricebook/st_patch_service.ts:112,:131`).
> None of them handles a 429 — `st.ts:118` turns any non-2xx into an `McpError` with no
> `Retry-After` parsing and no backoff.
>
> This is why `st_run_report` eats 429s: `FAMILY_CAP` in `src/durable/st-rate-limiter.ts`
> declares `reporting: 20/min`, and that cap is never consulted because
> `tools/reporting/st_run_report.ts:134` calls a bare `readSTPost`.
>
> **Two design bugs to fix at the same time:**
> - `src/rate-limit-guard.ts:9` does `idFromName(family)`, so `AGGREGATE_CAP = 80`
>   (`st-rate-limiter.ts:23`) is counted *per family*. The documented "global 80/min" does not
>   exist. Route the aggregate through a single fixed DO id while keeping per-family counters
>   on their own ids.
> - `st-rate-limiter.ts:117` reads `FAMILY_CAP[family]`, and `familyFromEndpoint` returns the raw
>   path segment. Undeclared families (`sales`, `inventory`, `payroll`, `marketing`) yield
>   `undefined`, and `fs.count >= undefined` is `false` — so they are **unlimited**. Add an
>   explicit `DEFAULT_FAMILY_CAP` instead of an implicit infinity.
>
> **Tasks:**
> 1. Gate `readST`, `readSTPost`, `readSTPaged` through `checkRateLimit`, and call
>    `reportBackoff(env, family, retryAfter)` when ST returns 429 with a `Retry-After`.
> 2. Gate the 8 direct `ST_PROXY.fetch` write sites listed above.
> 3. Fix the aggregate-DO-id bug.
> 4. Add `DEFAULT_FAMILY_CAP`.
> 5. Replace the plain `throw new Error(...)` at `rate-limit-guard.ts:18` with
>    `McpError('rate_limited')` carrying `retry_after_ms`. Both already exist —
>    `src/errors.ts:50` and `:80`. This is wiring, not new plumbing.
> 6. `st_run_report`: add a post-429 cooldown and a short result cache.
>
> **Tests to write first:** the limiter is consulted exactly once per `readST` call; a 429
> response produces `McpError('rate_limited')` with a populated `retry_after_ms`; an undeclared
> family is capped rather than unlimited; the aggregate cap trips across two *different*
> families (this test fails today and is the proof the id bug is fixed).
>
> **You will touch `src/durable/st-rate-limiter.ts`, which is a protected module.** Flag it.
>
> **Risk note:** this puts a DO round-trip in the hot path of all 110 tools. Think about whether
> the aggregate check can be batched or short-circuited for cheap reads, and say what you chose
> and why. If you believe gating a specific path is wrong, argue it in the PR rather than
> silently skipping it.

---

## Agent B — composite honesty and pagination

> **Workstream B: stop five composites from presenting one page as a total, and fix three
> that measure the wrong thing.**
>
> **Verified at `origin/main` — five single-page composites, none checks `hasMore`, none emits
> `truncated`:**
>
> | Tool | file:line | current |
> |---|---|---|
> | `dispatch_override_audit` | `src/tools/composites/dispatch_override_audit.ts:70` | `pageSize: 200` → `readST` `:74` |
> | `call_quality_review` | `src/tools/composites/call_quality_review.ts:25` | `pageSize: 100` |
> | `membership_jackpot_leaderboard` | `src/tools/composites/membership_jackpot_leaderboard.ts:27` | `pageSize: 200` over a YTD contest — silently drops entrants past 200 |
> | `membership_outreach_list` | `src/tools/composites/membership_outreach_list.ts:23` | `pageSize: 200` |
> | `pricebook_health_check_services` | `src/tools/composites/pricebook_health_check_services.ts:18` | `pageSize: 200` |
>
> **Task 1 — paginate all five** via `pagedStRead` (`src/paged-st-read.ts:83`), surfacing
> `truncated` and `pageCount` in the response. Its signature is
> `pagedStRead<T>(env, headers, endpointPath, query, opts)` — note the second arg is raw
> `headers`, whereas these five currently use `readST`'s `{actor, correlation}` ctx. **The swap
> is not mechanical.** Work out the correct adaptation and say what you did.
>
> **Task 2 — `dispatch_override_audit` measures the wrong thing and breaks at scale:**
> - `:135` `const overrides = appointments.map(…)` → `:151` `overrideCount: overrides.length`
>   counts **every appointment**. There is no reassignment detection anywhere. Either implement
>   real override detection or rename the field and description to say exactly what it counts.
>   Do not leave a name that lies.
> - `:129` joins `ids` unchunked — ST 400s above roughly 50 ids. A chunker already exists at
>   `src/tools/jobs/list_jobs_today.ts:21` and is unused here.
> - `:97` builds an `IN (…)` with up to 200 bind params against D1's ~100 limit — this is the
>   source of the `too many SQL variables` errors. Chunk it.
>
> **Task 3 — `commercial_plumbing_opportunities` is wrong on three axes**
> (`src/tools/composites/commercial_plumbing_opportunities.ts:21-27`):
> - **Inverted cohort.** `:36-45` dedupes customers by jobs completed *before* the cutoff and
>   never excludes customers with a *recent* job. A customer served last week is still listed as
>   an "opportunity". Fix the logic.
> - **`jobTypeName` is an unverified JPM filter.** Wire it into `rejectUnsupportedSTFilters`
>   (`src/st.ts:50`, shipped `a66a616` for exactly this defect class — its docstring says
>   "if a filter cannot be applied server-side, FAIL LOUDLY").
> - No "commercial" filter at all, and no `hasMore` — it returns one page of the oldest jobs
>   in the tenant. Fix or label honestly.
>
> **Task 4 — `pricebook_health_check_services` contradicts a hard business rule.** `:29`
> treats `cost === 0` as unhealthy. **QSC runs ServiceTitan dynamic pricing: a 0/blank price or
> cost does NOT mean unpriced.** `src/supabase.ts:146` `shapePriceRow` already encodes the
> correct rule (`'dynamic — computed at invoice'`) — the repo currently contradicts itself.
> Fix the health criterion, and report over the full population rather than one 200-row page
> (`:35` presents `services.length` as the population).
>
> **Tests first for each**: a paginated composite reports `truncated: true` when ST has more
> pages; the chunker splits a 200-id request; a zero-cost dynamic-priced service is NOT flagged
> unhealthy; a customer with a recent job is excluded from the opportunity cohort.

---

## Agent C — Supabase hardening and the gold watermark

> **Workstream C: make `src/supabase.ts` survive a bad day, and tell callers how old gold data is.**
>
> **Verified at `origin/main`:** `src/supabase.ts` has a good timeout
> (`:19` `SUPABASE_FETCH_TIMEOUT_MS = 25_000` via `AbortSignal.timeout`, well-reasoned against
> the authenticator role's 30s `statement_timeout`) — and nothing else. All four helpers
> (`sbRpc:66`, `sbSelect:80`, `sbCount:113`, `sbWriteEmbedding:132`) are single-shot bare
> `fetch` with **no retry**, and every error path interpolates the **full** `res.text()`
> (`:72`, `:85`, `:118`, `:139`) — so a 522 HTML error page lands whole in `error_log` and in
> the MCP response. There is no cache on any RPC.
>
> **Tasks 1–3:**
> 1. Add a retry wrapper for 429/408/5xx. `src/d1-proxy.ts:157` already implements a 3-attempt
>    backoff — mirror its shape rather than inventing a second idiom.
> 2. `.slice(0, 600)` every error body before it reaches an exception message.
> 3. Add `cacheGet` to `get_proposal_tiers`.
>
> **Task 4 — the `_gold_as_of` watermark. This is the substantial one.**
> All **9** Supabase-backed tools publish no data-age disclosure whatsoever. Grep for
> `as_of|_gold_as_of|measured_at|synced_at|updated_at` across them returns 0 hits:
> `gold/gold_margin_by_bu.ts`, `gold/semantic_search_gold.ts`, `gold/titan_advisor_score.ts`,
> `gold/trade_coverage.ts`, `pricebook/get_proposal_tiers.ts`, `pricebook/get_service_breakout.ts`,
> `pricebook/find_packages_with_item.ts`, `pricebook/search_pricebook_templates.ts`,
> `pricebook/search_pricebook_semantic.ts`.
>
> **Do not copy `trade_coverage.ts:158 measured_at`.** That records when *we measured*, not when
> gold was built. Copying it as a watermark would actively mislead. There is no existing
> Supabase analogue of `stampMirrorFreshness` — you must write one. Model it on the
> `fetchTableMax` shape in `src/mirror-freshness.ts`, but source the watermark from Supabase.
> Cache the probe so you are not adding a round-trip per tool call.
>
> `titan_advisor_score` already has a free watermark it fails to publish — it orders by
> `snapshot_date.desc` at `:101`, so the newest `snapshot_date` is already in hand.
>
> **Why this matters:** a QSC analytical answer was shipped to Luke's inbox with a wrong
> headline because data age was invisible at write-up time. A stale-gold answer that looks
> fresh is worse than no answer. The watermark is the fix.
>
> **Tests first:** retry fires on 429 and gives up after N; a 40 KB error body is truncated to
> 600 chars; every one of the 9 tools emits `_gold_as_of`; the watermark probe is cached.

---

## Agent D — hygiene, redaction, resolver TTL, catalogs

> **Workstream D: five small, independent, high-value fixes.**
>
> **1. Delete the dead read-router and the comment that lies about it.**
> `src/read-router.ts` has exactly one importer —
> `src/tools/__tests__/read_router_sql_guard.test.ts:10` — and no live call path. The
> staleness-aware architecture it was meant to provide was replaced by
> `src/mirror-freshness.ts` (QUA-1141/QUA-1234). Delete the module and its test.
> Then fix `src/tools/index.ts:159`, which documents `source: 'd1'` as
> *"D1-first read via read-router (live ST only on miss)"* — false for all 15 `'d1'` tools;
> they read the mirror directly. Write what the code actually does.
> **`src/read-router.ts` is a protected module — flag the deletion prominently.**
>
> **2. Stamp the 3 unstamped shared mirror readers** with `stampMirrorFreshness`:
> `src/name-resolver.ts:64`, `src/name-cache.ts:97`, and `src/resources/catalogs.ts:212,:231`
> (the latter already *mentions* `fetchTableMax` in a comment at `:32` but never calls it).
> 20 of 22 mirror-reading tool files are already stamped; these three shared components are the
> residue, and `name-resolver` is the highest-traffic one — every `*Name` argument on every tool
> resolves through it.
> Leave `src/tools/invoicing/sku-resolve.ts` alone: its `:1` comment documents a deliberate,
> well-argued opt-out, and its `unavailable` path already discloses a broken mirror.
>
> **3. Credential-harden `REDACT_FIELD_PATTERNS`** (`src/tool-registry.ts:36-44`). The current
> list is PII-only (`phone`, `email`, `name`, `street`, `address`, `city`, `zip`, `postal`,
> `state`, `note`, `notes`, `description`, `summary`, `body`) and strips **zero**
> credential-shaped keys. Add: `secret`, `token`, `api_?key`, `authorization`, `password`,
> `passwd`, `credential`, `bearer`, `cookie`, `session_?id`, `sync_?key`, `client_?secret`,
> `refresh_?token`, `access_?token`, `jwt`, `signature`, `private_?key`, `salt`.
> **Do not add a bare `/key/i`** — it over-matches `keyName`, `foreignKey`, `keys`.
> `redactPayload` (`:54`) recurses to depth 6 and preserves type shape, so additions are
> zero-risk. Keep `src/__tests__/security_redact.test.ts` in sync — the file header says to.
>
> **4. Add a TTL to the name-resolver memo.** `src/name-resolver.ts:51`
> `const indexCache = new Map<Kind, Promise<IndexRow[]>>()` has no timestamp, no TTL, no size
> bound; `loadIndex:58` returns the cached promise unconditionally. The in-code rationale at
> `:49-50` ("Workers isolates are short-lived enough that staleness is bounded by isolate
> replacement") is an assumption, not a guarantee — a hot isolate lives far longer. This
> compounds with `KIND_CONFIG` (`:40`, `:44`) filtering `WHERE active = 1`: a deactivated tech
> stays resolvable, and a newly *activated* one stays invisible, for the isolate's whole life.
> Add a fetched-at stamp and a 5–10 minute TTL. Keep `_clearResolverCache()` working for tests.
>
> **5. Add a business-units catalog resource.** `src/resources/catalogs.ts` registers three
> (`mcp-st://catalog/pricebook-categories`, `/technicians`, `/reports`). Business units are the
> trivial fourth — the table is already queried at `name-resolver.ts:40`
> (`SELECT bu_id AS id, name FROM business_units WHERE active = 1`). Copy the technicians block,
> and stamp it with freshness at birth (per item 2). Resources cost callers zero tool calls for
> id→name lookups, which is the whole point.
>
> **Tests first for each.** Item 3 in particular: assert that a payload containing
> `client_secret`, `access_token`, and `X-Sync-Key`-shaped keys is redacted, and that
> `foreignKey` and `keyName` are NOT.

---

## Agent E — Cloudflare platform adoption

> **Workstream E: adopt the Cloudflare capabilities that actually fit this worker.**
>
> **First, two things already true** — do not "fix" them: `wrangler.toml` already sets
> `placement = { mode = "smart" }` and `[observability] enabled = true`, for both prod and
> `env.dev`.
>
> **1. `secrets.required` in `wrangler.toml` (highest value per minute).** Eight secrets are
> currently documented only as TOML comments. The new `secrets.required` property makes
> `wrangler deploy` **fail** when any is unset, and makes `wrangler types` generate from it
> instead of sniffing `.dev.vars`. This turns a comment block into an enforced deploy gate and
> directly strengthens `scripts/preflight.sh`.
>
> **2. `[observability.traces]`.** Open beta; **free through 2026-09-30, billed from
> 2026-10-01** — so set an explicit `head_sampling_rate` now rather than discovering it on a
> bill. Automatic tracing spans the `ST_PROXY` service binding, D1 queries, DO fetches, and
> Workers AI, which is exactly the per-request breakdown this worker lacks.
> **Keep `audit_log`** — it is a compliance record for a two-phase-confirm write system, not
> telemetry. Tracing makes `error_log` redundant, not `audit_log`. Do not remove either in this
> PR; just land tracing and note what could later retire.
>
> **3. Move `mcp_cache` from D1 to KV.** `src/cache.ts` (~75 lines, 13 call sites, all funnelled
> through `cacheGet`) is a pure opaque-blob read-through keyed by `(ns, k)` with a millisecond
> `expires_at`. That is exactly KV's shape, and KV buys three things:
> **(a) automatic expiry** — today `idx_mcp_cache_expires` exists but **nothing ever deletes
> expired rows**; only `cachePurgeNamespace` deletes, by namespace, so expired rows accumulate
> in D1 forever; **(b) edge-local reads** instead of a round trip to the single-region D1
> primary; **(c) cheaper reads** at scale. KV's eventual consistency is already the semantics a
> TTL'd cache has. Precedent exists in-repo: `src/resources/catalogs.ts:246` notes report
> categories are already KV-cached at 1h. Dual-write behind a flag, then cut over.
>
> **4. Persist `CustomerSnapshotSingleflight` locks.**
> `src/durable/customer-snapshot-flight.ts` keeps locks in a plain in-memory `Map` and never
> touches `state.storage`. Cloudflare evicts idle DOs, and every eviction silently drops all
> locks — the singleflight degrades to a no-op with no signal. Its sibling DO already guards
> against this with `blockConcurrencyWhile`; follow that pattern.
> **This is a protected module (`src/durable/*.ts`) — flag it.**
>
> **5. AI Gateway on `embedQuery` only** (`src/supabase.ts:30`) — add
> `{ gateway: { id: "...", cacheTtl: 86400 } }` to the Workers AI call so repeated query
> embeddings are cached and you get token/latency/error analytics.
> **Do NOT enable it for `PricebookEmbedWorkflow`** — that only embeds rows where
> `embedding IS NULL`, so every input is unique by construction and a cache is pure overhead.
> Cloudflare's own docs warn against caching embeddings for indexing workloads.
> Note honestly in the PR that AI Gateway does nothing for this worker's role as an MCP
> *provider* — it only fronts outbound model calls.
>
> **6. Native `[[ratelimits]]` binding at the `/mcp` edge** — per-caller abuse protection so one
> runaway agent client cannot fan out into 100 DO round trips.
> **This does not and cannot replace `StRateLimiter`**: the native binding is per-Cloudflare-
> location and eventually consistent (Cloudflare's docs explicitly say it is "intentionally
> designed to not be used as an accurate accounting system"), and cannot enforce a *global*
> ServiceTitan quota. Different problem, different tool. Agent A owns `StRateLimiter`; do not
> touch it.
>
> **Do NOT do in this workstream:** the DO SQLite backend cutover (a deployed KV-backed class
> cannot be converted; it needs a new class and a binding swap — deferred behind Agent A's
> work), Queues, Hyperdrive, Vectorize, or Containers. All four were assessed and rejected with
> reasons; do not relitigate them.
>
> **Coordination:** you and Agent A both care about rate limiting but own different code. You
> own `wrangler.toml` and `src/cache.ts`; A owns `src/rate-limit-guard.ts` and
> `src/durable/st-rate-limiter.ts`. If you need a change in A's files, report it, don't make it.

---

## Agent F — dependency and protocol upgrades (SEQUENCED)

> **F1 (do first, low risk):** `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0. No API break, no
> protocol-constant change (`LATEST_PROTOCOL_VERSION` stays `2025-11-25` in both). Only two
> behaviour changes: a new 10 MB stdio read-buffer cap (irrelevant — this is an HTTP Worker) and
> `Content-Type` now validated by parsed media type instead of a substring match (verify no
> client or proxy sends a sloppy header). Note `agents@0.17.3` pins the SDK at **exactly**
> `1.29.0`, not a caret — so check whether the bump is even possible without also moving
> `agents`. Report what you find.
>
> **F2 (BLOCKED — do not start until Luke confirms the OAuth consent screen works):**
> `@cloudflare/workers-oauth-provider` 0.8.1 → 0.10.3 — eight releases. 0.9.0 is a
> security-tightening release that **enforces PKCE (S256 required by default, `plain` rejected)**,
> applies strict RFC 8707 resource matching, adds RFC 9207 `iss`, and tightens DCR validation.
> 0.10.0 changes the `/authorize` handler shape by exporting `AuthorizationError` from
> `parseAuthRequest()`. These touch the exact login path Wave 1 just rewrote and that no human
> has yet exercised — bumping before verification would confound two changes.
> While there: evaluate **CIMD (Client ID Metadata Documents)**. MCP 2026-07-28 **deprecates
> Dynamic Client Registration in favour of CIMD**, and the provider already supports it, but it
> is disabled here — `global_fetch_strictly_public` is absent from `wrangler.toml`'s
> compatibility flags, and `clientRegistrationCallback` / `disallowPublicClientRegistration` are
> unset, so registration is fully open. CIMD is the principled fix for the open `/register`.
>
> **F3 (after F1, `env.dev` first):** `agents` 0.17.3 → 0.21.0 + MCP SDK v2. Substantial:
> MCP packages move from `dependencies` to **`peerDependencies`** (so
> `@modelcontextprotocol/server@2.0.0` must be added to our own `package.json`),
> `createMcpHandler` now takes a **factory** rather than an instance, and the import moves to
> `agents/mcp/server`. The v1-server overload still compiles on 0.21.0, so a two-step
> (bump, then refactor) is viable.
> **The highest-risk regression is not the SDK swap — it is 0.20.0's new Origin/Host allowlist**,
> which rejects malformed and non-allowlisted browser Origins. Requests with no Origin header
> (normal non-browser MCP clients) still pass. If this worker is ever reached from a browser
> client or a custom domain, set `allowedHostnames` / `allowedOriginHostnames` before deploying.
> Our stateless `createMcpHandler` choice is vindicated: `McpAgent` is now deprecated and
> feature-frozen, and Cloudflare's docs say plainly not to use it for new servers.
>
> **Do not adopt elicitation.** It is structurally impossible on the stateless path —
> `createMcpHandler` builds a fresh transport per request with no storage, and `elicitInput`
> exists only on the DO-backed `McpAgent`. Under MCP 2026-07-28 server-initiated requests are
> replaced by MRTR (a client-retry `input_required` pattern) which needs the v2 stack. The
> existing dryRun→HMAC write gate stays and is not obsolete.

---

## Agent G — public cut refresh (`lpeluso-dotcom/servicetitan-mcp`)

> **Workstream G: bring the public cut up to date. Security first — it is not cosmetic.**
>
> The public repo is frozen at v1.0.0 / 76 tools since 2026-06-19 while the live server is at
> 110 tools. It is de-tenanted correctly (no tenant id, no QSC emails, no `taylor-ai`
> references, no Supabase tools) — that part is good and must stay true.
>
> **It ships two real problems:**
> 1. `src/jwt.ts:17` calls `jwtVerify(token, secret)` with **no `audience` and no `issuer`
>    option** — the exact S-2 finding Wave 1 fixed in the private repo, still public.
> 2. `hono ^4.12.23` — the 4 advisories Wave 1 patched by bumping to 4.13.3.
>
> Also stale: `agents ^0.13.2` (live is 0.17.3, current 0.21.0),
> `@modelcontextprotocol/sdk ^1.29.0`, and `server.json` on schema `2025-09-29` when the
> current registry schema is `2025-12-11`.
>
> **Order: port the two security fixes first, as their own PR.** Then the dependency refresh.
> Then tools.
>
> **Portable tools** are those that hit the ServiceTitan API directly with no QSC
> infrastructure. **Excluded by construction:** anything Supabase-backed (`gold_margin_by_bu`,
> `semantic_search_gold`, `titan_advisor_score`, `trade_coverage`, `search_pricebook_semantic`,
> `search_pricebook_templates`, `get_proposal_tiers`, `get_service_breakout`,
> `find_packages_with_item`), all `siro_*` (QSC vendor), and QSC business logic
> (`membership_jackpot_leaderboard`, `membership_outreach_list`,
> `commercial_plumbing_opportunities`, `save_tech_debrief`, `open_opportunities_pulitzer_feed`).
> Anything reading the taylor-ai D1 mirror must either be reimplemented against live ST or
> skipped — decide per tool and say which you chose.
>
> **Do NOT publish to npm and do NOT publish to the MCP registry.** Both need Luke's explicit
> approval. Prepare the manifest and say it is ready; do not push it.
> For context: an exact-name query for `io.github.lpeluso-dotcom/servicetitan-mcp` against
> `registry.modelcontextprotocol.io` returns 0 results — the manifest was written but never
> published.
