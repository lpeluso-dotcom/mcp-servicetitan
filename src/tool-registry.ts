// ============================================================
// tool-registry.ts — Bridge between ToolDef pattern and McpServer.tool()
//
// Wraps every tool handler with:
//   - Correlation ID generation
//   - Timing
//   - obs.audit() + obs.heartbeat() + obs.error() (fire-and-forget)
//   - Analytics Engine metric emission
//   - MCP response envelope (content + isError)
//   - McpError → structured response
//
// Called once per request from buildServer() so each request gets a
// fresh McpServer instance (required post-SDK-1.26.0; shared instances
// are a known security vuln).
// ============================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import type { ToolDef } from './tools/index';
import { newCorrelationId } from './auth';
import { McpError } from './errors';
import * as obs from './obs';

export interface RequestContext {
  actor: string;
  role: 'default' | 'admin';
}

/**
 * Register a tool on the McpServer, wrapping its handler with the full
 * observability + error-handling envelope.
 */
export function registerTool(
  server: McpServer,
  tool: ToolDef,
  env: Env,
  execCtx: ExecutionContext,
  reqCtx: RequestContext
): void {
  server.tool(
    tool.name,
    tool.description,
    tool.zodSchema,
    async (args: Record<string, unknown>) => {
      const correlation = newCorrelationId();
      const started = Date.now();

      try {
        const result = await tool.handler(env, args, {
          actor: reqCtx.actor,
          correlation,
        });
        const latency = Date.now() - started;

        execCtx.waitUntil(
          obs.audit(env, {
            actor: reqCtx.actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: 'ok',
            latency_ms: latency,
            correlation,
            payload: args,
          })
        );
        execCtx.waitUntil(
          obs.heartbeat(env, `mcp-servicetitan:${tool.name}`, { ok: true })
        );
        emitMetric(env, execCtx, tool.name, 'ok', latency, reqCtx);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const latency = Date.now() - started;
        const mcpErr =
          err instanceof McpError
            ? err
            : new McpError('internal_error', (err as Error).message || 'tool threw', {
                correlation,
              });

        execCtx.waitUntil(
          obs.error(env, {
            source: `worker:mcp-servicetitan:${tool.name}`,
            severity: mcpErr.code === 'upstream_error' ? 'error' : 'warn',
            message: mcpErr.message,
            stack: (err as Error).stack,
            context: { actor: reqCtx.actor, args, correlation, code: mcpErr.code },
            correlation,
          })
        );
        execCtx.waitUntil(
          obs.audit(env, {
            actor: reqCtx.actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: 'error',
            latency_ms: latency,
            correlation,
            payload: args,
            result: { code: mcpErr.code, message: mcpErr.message },
          })
        );
        execCtx.waitUntil(
          obs.heartbeat(env, `mcp-servicetitan:${tool.name}`, { ok: false })
        );
        emitMetric(env, execCtx, tool.name, 'error', latency, reqCtx);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(mcpErr.toResponse()) }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Write a point to the Analytics Engine for p50/p95/p99 + error-rate queries.
 * Blobs carry categorical labels, doubles carry numeric fields.
 * Guarded — if the binding is missing (older dev), silently skip.
 */
function emitMetric(
  env: Env,
  execCtx: ExecutionContext,
  tool: string,
  status: 'ok' | 'error',
  latencyMs: number,
  reqCtx: RequestContext
): void {
  if (!env.MCP_METRICS) return;
  try {
    env.MCP_METRICS.writeDataPoint({
      blobs: [tool, status, reqCtx.role, reqCtx.actor],
      doubles: [latencyMs],
      indexes: [tool], // primary filter dimension
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[metrics] writeDataPoint failed: ${(e as Error).message}`);
  }
}
