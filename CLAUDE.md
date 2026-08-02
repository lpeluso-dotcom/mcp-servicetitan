# mcp-servicetitan

Cloudflare Worker exposing QSC's ServiceTitan tenant (`431848990`) as a Streamable HTTP
MCP server. Tools span reads, write-gated mutations, L5 composites, and raw API access.

Live: `https://mcp-servicetitan.lpeluso.workers.dev`

## Commands

```bash
npm run check          # typecheck && test — run this before every deploy
npm test               # vitest run — 91 test files
npm run typecheck      # tsc --noEmit
npm run dev            # wrangler dev
npm run preflight:dev  # pre-deploy integrity gate (build + test + binding presence)
npm run preflight      # same, prod
npm run deploy:dev     # wrangler deploy --env dev
npm run deploy         # wrangler deploy (PROD)
npm run types          # wrangler types — regenerate binding types
npm run security:audit # npm audit --omit=dev
```

**Preflight is the deploy gate.** It needs `CLOUDFLARE_API_TOKEN` in the environment and
returns non-zero on any failure. Do not deploy around a failing preflight.

## Architecture

- `src/index.ts` — MCP request entry, tool dispatch
- `src/auth.ts`, `src/jwt.ts`, `src/oauth.ts` — `X-Sync-Key` and Bearer JWT auth, role gating
- `src/d1.ts`, `src/d1-proxy.ts` — D1 reads (binding `DB` → `mcp-servicetitan`)
- `src/composite-helpers.ts` — L5 composite tools
- `src/name-resolver.ts`, `src/name-cache.ts` — ID → name resolution
- `src/durable/` — Durable Objects; `EMBED_WORKFLOW` powers pricebook embeddings
- `src/obs.ts` — observability into `MCP_METRICS` Analytics Engine

## Auth and exposure

- `POST /mcp` requires `Authorization: Bearer <JWT>` **or** `X-Sync-Key`. 401 otherwise.
- `/health` is the only intentionally public endpoint, and it **redacts tool names**
  (QUA-519 hardening). Do not add tool names back to its response.
- Single-tenant integration. Share code for review, never a live endpoint or credentials.

## Stale-doc warning

The README and CHANGELOG version labels have drifted. The label reads "1.7.0" but has not
been bumped across roughly ten prod deploys since 2026-07-13, so it does not identify the
deployed code. Live `/health` reported **toolCount 109** as of 2026-08-01 while older docs
claim 85–87. **Trust `/health` and the source over any tool count written in a doc.**

Current audits: `docs/audit/ST-MCP-AUDIT-2026-08-01.md` (code/security/D1 debt) and
`docs/audit/ST-MCP-RESEARCH-2026-08-01.md` (ST API + MCP spec state), both in `qsc-infra`.
**They are not on qsc-infra's main branch yet** — as of 2026-08-02 they live only on
`origin/docs/st-mcp-audit-2026-08-01`. Read them with
`git -C ~/qsc-infra show origin/docs/st-mcp-audit-2026-08-01:docs/audit/ST-MCP-AUDIT-2026-08-01.md`
until that branch merges.

## ServiceTitan rules

- **Pricebook items use dynamic pricing.** A `price` of `0`/`null`/absent does NOT mean the
  item is free or unpriced — price is computed at invoice time from rules, BU, membership
  tier, and labor. Never report an item as unpriced from a static field read.
- Before any ST write, invoke the `st-write-safety` skill.
