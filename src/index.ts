// ============================================================
// mcp-servicetitan — MCP server entrypoint
// Exposes a JSON-RPC 2.0 MCP endpoint at POST /mcp
// Unauthenticated GET /health for liveness
// ============================================================

import { Hono } from 'hono';
import type { Env } from './env';
import { TOOLS, findTool, toolSchemas } from './tools/index';
import { McpError } from './errors';
import * as obs from './obs';
import { newCorrelationId } from './auth';

const app = new Hono<{ Bindings: Env }>();

// ─── Health ──────────────────────────────────────────────────
app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'mcp-servicetitan',
    version: c.env.MCP_SERVICE_VERSION,
    toolCount: TOOLS.length,
    tools: TOOLS.map((t) => t.name),
    taylorAi: 'service-binding',
  });
});

// ─── MCP JSON-RPC endpoint ───────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

app.post('/mcp', async (c) => {
  const env = c.env;
  let body: JsonRpcRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error: invalid JSON'), 400);
  }

  const id = body.id ?? null;
  const actor = c.req.header('X-Actor') ?? 'claude-code';
  const correlation = c.req.header('X-Correlation-Id') ?? newCorrelationId();

  if (body.jsonrpc !== '2.0') {
    return c.json(rpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"'), 400);
  }

  switch (body.method) {
    case 'initialize': {
      return c.json(
        rpcOk(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'mcp-servicetitan', version: env.MCP_SERVICE_VERSION },
          capabilities: { tools: {} },
        })
      );
    }

    case 'tools/list': {
      return c.json(rpcOk(id, { tools: toolSchemas() }));
    }

    case 'tools/call': {
      const params = (body.params ?? {}) as { name?: string; arguments?: unknown };
      if (!params.name) {
        return c.json(rpcError(id, -32602, 'Invalid params: missing "name"'), 400);
      }
      const tool = findTool(params.name);
      if (!tool) {
        return c.json(rpcError(id, -32601, `Method not found: tool "${params.name}"`), 404);
      }

      const started = Date.now();
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        const result = await tool.handler(env, args, { actor, correlation });
        const latency = Date.now() - started;

        c.executionCtx.waitUntil(
          obs.audit(env, {
            actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: 'ok',
            latency_ms: latency,
            correlation,
            payload: args,
          })
        );
        c.executionCtx.waitUntil(
          obs.heartbeat(env, `mcp-servicetitan:${tool.name}`, { ok: true })
        );

        return c.json(
          rpcOk(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          })
        );
      } catch (err) {
        const latency = Date.now() - started;
        const mcpErr =
          err instanceof McpError
            ? err
            : new McpError('internal_error', (err as Error).message || 'tool threw', {
                correlation,
              });

        c.executionCtx.waitUntil(
          obs.error(env, {
            source: `worker:mcp-servicetitan:${tool.name}`,
            severity: mcpErr.code === 'upstream_error' ? 'error' : 'warn',
            message: mcpErr.message,
            stack: (err as Error).stack,
            context: { actor, args, correlation, code: mcpErr.code },
            correlation,
          })
        );
        c.executionCtx.waitUntil(
          obs.audit(env, {
            actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: 'error',
            latency_ms: latency,
            correlation,
            payload: args,
            result: { code: mcpErr.code, message: mcpErr.message },
          })
        );
        c.executionCtx.waitUntil(
          obs.heartbeat(env, `mcp-servicetitan:${tool.name}`, { ok: false })
        );

        return c.json(
          rpcOk(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(mcpErr.toResponse()),
              },
            ],
            isError: true,
          })
        );
      }
    }

    case 'notifications/initialized':
    case 'notifications/cancelled': {
      // Notifications have no response per JSON-RPC spec
      return new Response(null, { status: 204 });
    }

    default:
      return c.json(rpcError(id, -32601, `Method not found: ${body.method}`), 404);
  }
});

// ─── 404 ─────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'not found' }, 404));

// ─── Export ──────────────────────────────────────────────────
export default {
  fetch: app.fetch,
};
