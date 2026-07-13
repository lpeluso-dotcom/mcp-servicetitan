# Supabase-backed pricebook search toolset — design

**Date:** 2026-07-13 · **Linear:** DEV ticket drafted (files under Development — MCP Servers; related QUA-782, QUA-627) · **Status:** approved by Luke (Sections 1–4, 2026-07-13)

## 1. Goal & scope

Give the mcp-servicetitan connector the same natural-language pricebook search the qsc-pricebook-search Vercel app ships, by reading the **shared Supabase vector store** (project `nlaaliehqpgskjmiuzze`) instead of the dormant Cloudflare Vectorize path that never gets re-embedded (Data Foundry review 2026-06-27, Group D).

- The connector is a **read-only consumer**. Supabase remains owned and refreshed daily by qsc-pricebook-search (items cron 09:00 UTC, templates 09:30 UTC). No new worker, DO, cron, ingest, or Supabase migration.
- In scope: 1 repointed tool + 4 new tools, an `AI` binding, two secrets, taylor-ai Vectorize decommission.
- Out of scope: replicating the app's markup-estimate heuristics (`lib/pricing.ts` bands, Halo rule); write surfaces; per-user auth changes.

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
- Add `[ai] binding = "AI"` to `wrangler.toml` (prod **and** `env.dev`). Native binding — no token, no account ID, no CI placeholder-inject change. Model pinned in code: `@cf/baai/bge-base-en-v1.5` (768-d), matching the corpus (14,009/14,009 embedded with that exact model). No new D1/KV/DO.

### 3.2 Secrets (decision: dedicated second key)
- `SUPABASE_URL` — wrangler secret (secret rather than var only to keep the project ref out of the public-fork toml).
- `SUPABASE_PB_KEY` — a **newly minted second Supabase secret key**, named for the connector (e.g. `mcp-servicetitan-read`). Independent rotation/revocation from the Vercel app's key; service_role-privileged under the hood but read-only by construction (the worker only calls the read RPCs/selects above). A true SELECT-only Postgres role is a possible fast-follow, not v1.
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
- Secrets per §3.2; `[ai]` binding per §3.1. No Supabase migrations — all five backing calls already applied to prod (0007–0015). Re-verify exact RPC signatures at plan time (done 2026-07-13 for all five).

### 4.3 Testing
- **Unit (vitest):** per tool with mocked `env.AI` + mocked `fetch` — happy path; embed-failure → lexical fallback; `$0`/null → `price_basis` shaping; topK/limit caps; Supabase 5xx → tool error. Register tools so `coverage_gate.test.ts` passes.
- **Live dev:** `scripts/preflight.sh` → deploy `--env dev` → `/mcp` probe (skill probe script). Parity set: "shower caulk", "3 ton AC condenser" (known hybrid wins), `cap240` → CAP-240 (code tier), plus one template search, one service breakout, one proposal-tiers, one reverse-link call against known entities. Assert no `$0` on any dynamic item.
- **Prod:** CI deploy from main; `/health` tool-inventory bump (65 → 69 at `default`); one prod `/mcp` probe.
- **Docs:** update the mcp-servicetitan skill tool catalog (qsc-infra canonical copy), `references/knowledge-base.md`, CHANGELOG.

## Done when
New/repointed tools return live Supabase hybrid results via `/mcp` in prod; dynamic pricing surfaced honestly; the taylor-ai Vectorize route, binding, and index are removed; spec + plan committed under `docs/superpowers/`.
