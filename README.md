# mcp-servicetitan

QSC ServiceTitan MCP server. Exposes read-only ST tools to Claude Code via the Model Context Protocol, backed by `taylor-ai`'s `/api/st/read` endpoint (no direct ST credentials held here).

**Status:** 0.1.0 POC — 5 read-only tools, dev-only deploy. See `qsc-infra/docs/mcp/ST-MCP-DESIGN.md` for the full design and phase-2 follow-ups.

## Architecture

```
Claude Code  ──MCP/JSON-RPC──▶  mcp-servicetitan (Cloudflare Worker)
                                        │
                                        ▼
                                   /api/st/read  (taylor-ai Worker)
                                        │
                                        ▼
                                 ServiceTitan API (OAuth from taylor-ai)
```

- `mcp-servicetitan` authenticates outgoing calls to taylor-ai with `MCP_SYNC_KEY` in the `X-Sync-Key` header (must match `SYNC_KEY` on taylor-ai, or taylor-ai needs an accept-either middleware update)
- Every tool call is logged to the `audit_log` D1 table on taylor-ai (shared DB)
- Errors go to `error_log` on the same DB
- Heartbeats to `TAI_STATE` KV under `heartbeat:mcp-servicetitan:*`
- Read-through cache via `mcp_cache` D1 table (TTLs per `ST-MCP-DESIGN.md § 2`)

## Tools (v0.1.0)

| Tool | Cache TTL | ST endpoint |
|---|---|---|
| `st_list_customers` | 5 min | `/crm/v2/tenant/{id}/customers` |
| `st_get_customer` | 5 min | `/crm/v2/tenant/{id}/customers/{customerId}` |
| `st_list_jobs` | none | `/jpm/v2/tenant/{id}/jobs` |
| `st_list_appointments` | none | `/jpm/v2/tenant/{id}/appointments` |
| `st_get_pricebook` | 10 min | `/pricebook/v2/tenant/{id}/{assetType}` |

Phase-2 follow-ups (not in this POC): `st_list_locations`, `st_list_tasks`, `st_get_equipment`, `st_create_task`, `st_patch_equipment`, `st_link_equipment_to_service`, `st_durable_write`.

## Endpoints

- `POST /mcp` — JSON-RPC 2.0 MCP endpoint (`tools/list`, `tools/call`)
- `GET /health` — unauthenticated liveness check

## Deploy

```bash
# Install deps
npm install

# Dev deploy
wrangler secret put MCP_SYNC_KEY --env dev
wrangler deploy --env dev

# Smoke test
curl https://mcp-servicetitan-dev.lpeluso.workers.dev/health

# MCP tools/list
curl -X POST https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Registering with Claude Code

Add to `qsc-infra/.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-servicetitan": {
      "type": "http",
      "url": "https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp"
    }
  }
}
```

## Environment

- `TAYLOR_AI_URL` — taylor-ai worker URL (prod or dev)
- `MCP_SYNC_KEY` — shared bearer secret for calling `/api/st/read`
- `DB` — shared taylor-ai D1
- `TAI_STATE` — shared TAI-STATE KV

## Not in this POC

- Write tools
- Durable workflow wrapper
- Rate limiting (relies on taylor-ai's upstream)
- Prod deploy (dev only until soak)
- Auth for MCP clients (currently open — anyone who knows the URL can call)

## See also

- `qsc-infra/docs/mcp/ST-MCP-DESIGN.md`
- `qsc-infra/docs/mcp/TEMPLATE.md`
- `qsc-infra/docs/agents/ATOMIC-AGENTS.md`
- taylor-ai `src/st-read.js`, `src/obs.js`
