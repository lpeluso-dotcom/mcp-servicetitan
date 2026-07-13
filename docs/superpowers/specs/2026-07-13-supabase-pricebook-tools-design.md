# Supabase-backed pricebook search toolset + embedding-refresh Workflow — design

**Date:** 2026-07-13 · **Linear:** DEV ticket drafted (files under Development — MCP Servers; related QUA-782, QUA-627) · **Status:** design approved by Luke 2026-07-13 (Sections 1–4; architecture updated to add the Workflow refresh plane per Luke's "reads + Workflow-owned embeddings" choice)

## 1. Goal & scope

Give the mcp-servicetitan connector the same natural-language pricebook search the qsc-pricebook-search Vercel app ships, by reading the **shared Supabase vector store** (project `nlaaliehqpgskjmiuzze`) instead of the dormant Cloudflare Vectorize path that never gets re-embedded (Data Foundry review 2026-06-27, Group D). Add a durable **embedding-refresh Workflow** so the connector keeps the vector column fresh on its own rather than silently depending on the Vercel cron staying alive.

- **Read plane:** 1 repointed tool + 4 new tools as ToolDefs on the existing `agents/mcp` handler — stateless, idempotent, `default` role.
- **Refresh plane:** a Cloudflare **Workflow** (durable, per-step retry, resumable), kicked by a cron on this worker, that embeds pricebook rows where `embedding IS NULL`. Runs as a **backstop** — same predicate as the app's embed step (`lib/refresh.ts` `embedMissing`: `is_active=1 AND embedding IS NULL`, keyed on **`(code, item_type)`** since code isn't unique), so it's idempotent with it, no race, no coordinated cross-repo cutover. Difference that matters: the app caps at **up to 300 rows/run (6×50), best-effort, never throws**, so a cold ~14k backlog takes ~47 daily runs; the durable Workflow **drains the full NULL backlog in one resumable run** across Workers-AI rate limits. Embed input MUST match the app exactly — `[name, description, category_name].filter(Boolean).join(' — ').slice(0,1500)` — or the shared vector space degrades. Supabase data sync (D1→Supabase upsert, items 09:00 / templates 09:30 UTC) stays owned by qsc-pricebook-search.
- In scope: 5 read tools; `AI` + `[[workflows]]` bindings + a cron trigger + `scheduled()` handler; two secrets; the embed Workflow class; taylor-ai Vectorize decommission.
- Out of scope: replicating the app's markup-estimate heuristics (`lib/pricing.ts` bands, Halo rule); the D1→Supabase data sync (app-owned); per-user auth changes; refactoring the connector into an `Agent`/`McpAgent` (it already sits on the Agents SDK MCP surface via `createMcpHandler`).
- **One-home note:** embedding *logic* now exists in two places (app cron + this Workflow) by design — the redundancy IS the resilience Luke asked for. Optional fast-follow: retire the app's embed step once the Workflow is proven, making this the sole embedder.

## 2. Tools & data flow

Query flow: `query → env.AI.run('@cf/baai/bge-base-en-v1.5', {text:[q]}) → 768-d vector → POST {SUPABASE_URL}/rest/v1/rpc/<fn> → shape → defaultShaper`.

All five are `ToolDef`s under `src/tools/pricebook/`, registered in `src/tools/index.ts`, `default` role.

| Tool | Backing call | Notes |
|---|---|---|
| `search_pricebook_semantic` (repoint) | `rpc/search_pricebook_hybrid(query_text, item_types[], limit_rows, expansions[], query_embedding, match_count)` (migration 0014) | Same tool name/args as today (`query`, `topK`) so existing callers keep working; result rows gain `match_kind`, richer fields. Embed failure → retry RPC with `query_embedding=null` (lexical-only — RPC handles it). |
| `search_pricebook_templates` (new) | `rpc/search_templates(query_text, limit_rows)` (0015) | Returns template/proposal hits with item_count, total_price_ref, tier/proposal context. |
| `get_proposal_tiers` (new) | `rpc/get_proposal_tiers(pid)` (0007/0008) | Tier ladder (Good/Better/Best) for a proposal id. |
| `find_packages_with_item` (new) | `rpc/templates_with_item(item_code)` + `rpc/services_with_item(item_st_id)` (0009) | Reverse links: which templates/proposals and which services contain an item. Codes are NOT unique across item_type — tool takes `code` + optional `item_type` and resolves `st_id` first when needed. |
| `get_service_breakout` (new) | PostgREST selects on `pricebook_items` (no RPC exists) | Read the service row's jsonb link columns (`service_materials`, `service_equipment`, `recommendations`, `upgrades`, migration 0009), then one batch `st_id=in.(…)` select to resolve component items. Mirrors the app's `lib/serviceQueries.ts` pattern. |

Once the repoint ships, taylor-ai's `/api/pricebook/semantic-search` has zero callers (verified estate-wide grep 2026-07-13) and is decommissioned (§4.1).

## 3. Bindings, secrets, pricing honesty, security

### 3.1 Bindings
- Add `[ai] binding = "AI"` to `wrangler.toml` (prod **and** `env.dev`). Native binding — no token, no account ID, no CI placeholder-inject change. Model pinned in code: `@cf/baai/bge-base-en-v1.5` (768-d), matching the corpus (14,009/14,009 embedded with that exact model). Same binding serves both the read tools (query embed) and the refresh Workflow (row embed).
- Add `[[workflows]]` binding `EMBED_WORKFLOW`, class `PricebookEmbedWorkflow` (prod + `env.dev`), and `[triggers] crons = ["0 10 * * *"]` (one hour after the app's 09:00 UTC data sync) with a `scheduled()` handler in `src/index.ts` that calls `env.EMBED_WORKFLOW.create(...)`. Workflows need no DO/D1 migration. No new D1/KV/DO.

### 3.2 Secrets (decision: dedicated second key)
- `SUPABASE_URL` — wrangler secret (secret rather than var only to keep the project ref out of the public-fork toml).
- `SUPABASE_PB_KEY` — a **newly minted second Supabase secret key**, named for the connector (e.g. `mcp-servicetitan-pb`). Independent rotation/revocation from the Vercel app's key. service_role-privileged; the connector's write surface is **exactly one column** — `pricebook_items.embedding`, written only by the refresh Workflow. Read tools only call the read RPCs/selects. (Honest framing: not "read-only by construction" anymore — it's read + a single embedding-column write.) A narrower Postgres role scoped to `SELECT + UPDATE(embedding)` is a possible fast-follow, not v1.
- Set in both environments: `wrangler secret put SUPABASE_URL` / `SUPABASE_PB_KEY` (+ `--env dev`).

### 3.3 Pricing honesty (hard rule)
- QSC runs dynamic pricing: `st_price`/`member_price` of `0`/null does **not** mean free. The shared shaper for these tools maps `0`/null → `price: null` + `price_basis: "dynamic — computed at invoice"`. **Never emit $0** for a dynamic item.
- Stored non-zero prices are surfaced as *reference* prices. The worker does not replicate `lib/pricing.ts` markup bands or the Halo rule — app-owned heuristics that would drift.
- Every tool description carries the standing dynamic-pricing warning (existing pattern in the current tool).

### 3.4 Security & failure modes
- Read-only tools → `default` role, existing `X-Sync-Key` inbound auth; no dryRun ceremony.
- Outbound: `fetch` to `SUPABASE_URL/rest/v1/…` with `apikey` + `Authorization: Bearer` headers, `AbortSignal.timeout(10_000)`, `topK ≤ 20` / `limit_rows ≤ 25` caps.
- Embed failure → lexical-only fallback (§2). Supabase failure → clean tool error; **no** fallback to the old Vectorize path.
- RLS on all pb_ tables stays default-deny; key lives server-side only — same trust model as the Vercel app.
- Cost: bge-base embeddings are negligible against the $100/mo Cloudflare ceiling; `cpu_ms = 50` unaffected (fetch is wall-clock, not CPU).

## 4. Decommission, provisioning, testing

### 4.1 taylor-ai Vectorize decommission (same shipping window — no soak; Luke 2026-07-13)
The estate-wide grep found exactly one live caller (this connector's own tool), so once the repoint deploys:
1. Separate small PR on taylor-ai: delete the `/api/pricebook/semantic-search` route block (`src/index.ts` ~1344) and the `PRICEBOOK_INDEX` `[[vectorize]]` binding (~line 160). **Leave `VOICE_VECTORIZE` and the RAG routes untouched** (separate, dev-gated feature). taylor-ai has many concurrent worktrees — check `git branch --show-current` / worktree state before any write.
2. After the binding-drop deploy: `wrangler vectorize delete` the pricebook index.
3. Evidence the path was already dead: the route embeds queries with bge-**small** (384-d), incompatible with a 768-d index.

### 4.2 Provisioning (config only)
- Luke: mint the second Supabase secret key (dashboard → API keys).
- Secrets per §3.2; `[ai]` + `[[workflows]]` bindings + cron per §3.1. No Supabase migrations — all five read-side backing calls already applied to prod (0007–0015), and the `embedding` column already exists (0012). Re-verify exact RPC signatures at plan time (done 2026-07-13 for all five).

### 4.3 Testing
- **Unit (vitest):** per read tool with mocked `env.AI` + mocked `fetch` — happy path; embed-failure → lexical fallback; `$0`/null → `price_basis` shaping; topK/limit caps; Supabase 5xx → tool error. Workflow unit tests: model-id assertion (`@cf/baai/bge-base-en-v1.5`); backlog=0 → no-op; batch drain marks rows non-null; step-failure retry path; per-run ceiling honored. Register tools so `coverage_gate.test.ts` passes.
- **Live dev:** `scripts/preflight.sh` → deploy `--env dev` → `/mcp` probe (skill probe script). Read parity set: "shower caulk", "3 ton AC condenser" (known hybrid wins), `cap240` → CAP-240 (code tier), plus one template search, one service breakout, one proposal-tiers, one reverse-link call against known entities; assert no `$0` on any dynamic item. Workflow: force one dev row's `embedding` to NULL, trigger the Workflow (manual `create` or cron), confirm the row is re-embedded within one run and metrics/audit rows land.
- **Prod:** CI deploy from main; `/health` tool-inventory shows **+4 net-new** tools at `default` (the repoint keeps the existing tool's slot); one prod `/mcp` probe; confirm first cron Workflow run drains any prod NULL backlog and logs a count.
- **Docs:** update the mcp-servicetitan skill tool catalog (qsc-infra canonical copy), `references/knowledge-base.md`, CHANGELOG, and add the Workflow + cron to `protected-modules.md` if the class warrants protection.

## 5. Embedding-refresh Workflow

### 5.1 Shape
- **Plain Cloudflare Workflow** (`WorkflowEntrypoint`), class `PricebookEmbedWorkflow` in `src/workflows/pricebook-embed.ts`. NOT the Agents-SDK `AgentWorkflow` — the connector is a stateless Worker, not an `Agent` DO, so there's no DO to host an `AgentWorkflow`. A standalone Workflow bound via `[[workflows]]` and started from the worker's `scheduled()` handler is the correct primitive.
- **Trigger:** cron `0 10 * * *` → `scheduled()` → `env.EMBED_WORKFLOW.create({ params: {} })`. Guard against overlap: before creating, skip if an instance is already running (the worker tracks the last instance id in KV `PROXY_STATE`, or queries instance status).

### 5.2 Steps (each a `step.do`, individually retried)
1. **count backlog** — `GET pricebook_items?select=count&is_active=eq.1&embedding=is.null` (PostgREST `Prefer: count=exact`, head request). If 0 → finish (no-op day).
2. **drain loop** — repeat until backlog empty or a per-run ceiling (e.g. 5,000 rows / instance to stay well inside limits):
   - `step.do("fetch-batch")`: select up to **100** rows `code, item_type, name, description, category_name` where `is_active=1 AND embedding IS NULL`.
   - `step.do("embed-batch")`: `env.AI.run('@cf/baai/bge-base-en-v1.5', { text: rows.map(r => [r.name, r.description, r.category_name].filter(Boolean).join(' — ').slice(0,1500)) })` → 768-d vectors. On rate-limit the step retries with backoff (Workflow-native).
   - `step.do("write-batch")`: `PATCH pricebook_items?code=eq.<code>&item_type=eq.<item_type>` with `{ embedding: "[v1,v2,…]" }` (bracketed-string pgvector literal, per the app). Keyed on `(code, item_type)`. Only writes the embedding column.
   - `step.sleep` a short beat between batches to respect Workers-AI QPS.
3. **finalize** — log embedded count to `MCP_METRICS` (Analytics Engine) + `audit_log` D1 row.

### 5.3 Consistency & safety
- **Idempotent with the app:** both target `embedding IS NULL`; whichever writes a row first wins, the other's next `fetch-batch` no longer sees it. No double-spend on Workers AI.
- **Model lock:** must be exactly `@cf/baai/bge-base-en-v1.5` (768-d) — a different model corrupts the shared vector space. Pinned as a const, asserted in a unit test.
- **Never blackout:** the Workflow only ever *fills* embeddings; it never deletes/deactivates rows, so it cannot blank the catalog (unlike the data-sync path, which has its own blackout guard in the app).
- **Failure isolation:** an embed/write step failure retries that step; a poisoned row (repeated failure) is skipped after N attempts and logged, never blocking the batch.

### 5.4 Known gap → fast-follow (out of v1)
Neither the app nor this Workflow re-embeds a row whose **text changed** (the schema has no `content_hash`/`embedded_at`; the D1→Supabase upsert overwrites text but leaves the old vector). Closing it needs a `content_hash` column + nulling `embedding` on change in the **app's** data-sync. Tracked as a follow-up ticket; v1 backstop is NULL-fill only.

## Done when
Read tools return live Supabase hybrid results via `/mcp` in prod with dynamic pricing surfaced honestly; the `PricebookEmbedWorkflow` runs on cron in prod and drains the `embedding IS NULL` backlog durably (verified by a forced-null test row getting re-embedded within one run); the taylor-ai Vectorize route, binding, and index are removed; spec + plan committed under `docs/superpowers/`.
