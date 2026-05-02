# Integration Guide

How to wire `mcp-servicetitan` into MCP-compatible clients.

**Base URL:** `https://mcp-servicetitan.lpeluso.workers.dev`  
**Protocol:** MCP Streamable HTTP (JSON-RPC 2.0 over `POST /mcp`)  
**Auth:** `X-Sync-Key` bearer for `/admin/*` routes; `POST /mcp` tool calls are open (scoped to public tool set)

---

## Claude Code (recommended)

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "mcp-servicetitan": {
      "type": "http",
      "url": "https://mcp-servicetitan.lpeluso.workers.dev/mcp",
      "headers": {
        "X-Sync-Key": "<your-sync-key>"
      }
    }
  }
}
```

The `X-Sync-Key` header is required for write-confirmation tools and admin access. Without it, all 65 default-role tools are accessible but write-confirm envelopes will fail.

After adding, restart Claude Code and verify with:
```
> tools
```
You should see 65 `mcp-servicetitan__*` tools listed.

---

## MCP Inspector

```bash
# Install Inspector
npx @modelcontextprotocol/inspector

# Connect to worker
# URL: https://mcp-servicetitan.lpeluso.workers.dev/mcp
# Headers: {"X-Sync-Key": "<your-key>"}
```

Or use the smoke script (requires `MCP_SYNC_KEY` in environment):
```bash
cd /home/taylor/work/mcp-servicetitan
source ~/.env
bash scripts/inspector-smoke.sh prod
```

---

## VS Code (Copilot)

Add to your VS Code settings (`settings.json`):

```json
{
  "github.copilot.mcp.servers": {
    "mcp-servicetitan": {
      "url": "https://mcp-servicetitan.lpeluso.workers.dev/mcp",
      "headers": {
        "X-Sync-Key": "<your-sync-key>"
      }
    }
  }
}
```

---

## Custom HTTP client (curl)

```bash
# List all tools
curl -s -X POST https://mcp-servicetitan.lpeluso.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Sync-Key: $MCP_SYNC_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep '^data:' | cut -c6- | jq '[.result.tools[].name]'

# Call a read tool
curl -s -X POST https://mcp-servicetitan.lpeluso.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Sync-Key: $MCP_SYNC_KEY" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"find_customer","arguments":{"query":"Smith"}}
  }' | grep '^data:' | cut -c6- | jq '.result.content[0].text | fromjson'

# Write tool — dryRun first
curl -s -X POST https://mcp-servicetitan.lpeluso.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Sync-Key: $MCP_SYNC_KEY" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"add_customer_note","arguments":{
      "customerId": 261837,
      "note": "Test note",
      "dryRun": true
    }}
  }' | grep '^data:' | cut -c6- | jq '.result.content[0].text | fromjson'
# → {preview, confirmToken, expiresAt}

# Confirm the write
curl -s -X POST https://mcp-servicetitan.lpeluso.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Sync-Key: $MCP_SYNC_KEY" \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params":{"name":"add_customer_note","arguments":{
      "customerId": 261837,
      "note": "Test note",
      "confirmToken": "<token-from-dryRun-response>"
    }}
  }' | grep '^data:' | cut -c6- | jq '.result'
```

---

## Response format

All tool responses follow the MCP `CallToolResult` shape:

```json
{
  "content": [
    { "type": "text", "text": "<JSON string or plain text>" }
  ],
  "isError": false
}
```

For structured tools, `text` is a JSON string — parse it:
```bash
jq '.result.content[0].text | fromjson'
```

Error responses set `isError: true` and include a descriptive message in `content[0].text`.

---

## Session management

The worker is stateless; session management is handled at the MCP protocol layer. If your client requires `mcp-session-id` for session resumption, the worker echoes it back in response headers.

---

## Auth model (today vs roadmap)

| | Today (v1.2) | Roadmap (v1.3) |
|---|---|---|
| Client auth | Shared `X-Sync-Key` bearer | Per-client JWT with `actor` claim |
| Role assignment | D1 `mcp_roles` table keyed by SHA-256(key) | D1 `mcp_roles` keyed by `sub` claim in JWT |
| Admin access | `X-Sync-Key` + `X-MCP-Role: admin` header | JWT with `role: admin` claim |
| Rotation | Replace `MCP_SYNC_KEY` wrangler secret | Per-client key revocation via `mcp_roles` |
