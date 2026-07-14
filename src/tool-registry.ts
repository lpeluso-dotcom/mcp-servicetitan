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
import { traceTool } from './observability/tracing';
import { offloadIfLarge } from './resources/results';

export interface RequestContext {
  actor: string;
  role: 'default' | 'admin' | 'lockdown' | 'readonly';
}

// Field-name patterns that indicate values likely to contain PII or free-text
// customer data. We redact at audit-log time (defense-in-depth), so a future
// reader endpoint or D1 export can't surface raw customer phone/email/address
// even though access to mcp-servicetitan is already gated behind MCP_SYNC_KEY.
// Keep this list in sync with src/__tests__/security_redact.test.ts.
const REDACT_FIELD_PATTERNS: readonly RegExp[] = [
  /^phone/i, /Phone$/i,
  /^email/i, /Email$/i,
  /^name$/i, /Name$/i,
  /^street/i, /^address/i, /^city$/i, /^zip$/i, /^postal/i, /^state$/i,
  /^note$/i, /^notes$/i, /^description$/i, /^summary$/i,
  /^body$/i,        // raw st_call body — may contain anything
];

function shouldRedactKey(key: string): boolean {
  for (const re of REDACT_FIELD_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(k)) {
      if (typeof v === 'string') {
        out[k] = `[redacted:str:${v.length}]`;
      } else if (typeof v === 'number') {
        out[k] = '[redacted:num]';
      } else if (v === null) {
        out[k] = null;
      } else {
        out[k] = '[redacted]';
      }
    } else {
      out[k] = redactPayload(v, depth + 1);
    }
  }
  return out;
}

/**
 * Derive spec-correct MCP tool annotations from a ToolDef.
 *
 * All fields are HINTS per the MCP spec — clients must not rely on them for
 * security decisions — but they should still be accurate:
 *   - readOnlyHint:      true iff the tool never modifies ServiceTitan state.
 *   - destructiveHint:   the spec DEFAULTS this to true when omitted, so every
 *                        write must set it explicitly. Additive creates (POST)
 *                        are NOT destructive; PATCH/PUT/DELETE modify existing
 *                        data and are.
 *   - idempotentHint:    only PUT/DELETE are canonically idempotent HTTP
 *                        methods — POST (create) and PATCH (partial update)
 *                        are not guaranteed idempotent, so both are false.
 *   - openWorldHint:     always false — a ServiceTitan tenant is a closed,
 *                        fixed entity set, not an open-ended web/search tool.
 */
function deriveAnnotations(tool: ToolDef): {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const method = tool.stEndpoint?.method ?? 'GET';
  return {
    title: tool.title ?? tool.name.replace(/_/g, ' '),
    readOnlyHint: !tool.isWrite,
    destructiveHint: tool.isWrite ? method !== 'POST' : false,
    idempotentHint: tool.isWrite ? ['PUT', 'DELETE'].includes(method) : true,
    openWorldHint: false,
  };
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
  // Compute the merged annotations ONCE: method-derived defaults, then the
  // per-tool overrides (tool.annotations) layered on top. The wire `title`
  // reuses annotations.title so it can't drift from the annotation copy.
  const annotations = { ...deriveAnnotations(tool), ...(tool.annotations ?? {}) };

  server.registerTool(
    tool.name,
    {
      title: annotations.title,
      description: tool.description,
      inputSchema: tool.zodSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations,
    },
    async (args: Record<string, unknown>) => {
      const correlation = newCorrelationId();
      const started = Date.now();

      try {
        const rawResult = await tool.handler(env, args, {
          actor: reqCtx.actor,
          correlation,
        });
        const result = tool.transformResult ? tool.transformResult(rawResult) : rawResult;
        const latency = Date.now() - started;

        // Composite handlers signal partial-failure via _partial=true on the
        // result envelope. We surface that as audit_log status='partial' so
        // SELECT status, COUNT(*) FROM audit_log GROUP BY status is queryable,
        // and emit a parallel error_log row at 'warn' carrying the per-call
        // failure detail so the response truncation in audit can't lose it.
        const isPartial =
          result !== null &&
          typeof result === 'object' &&
          (result as { _partial?: unknown })._partial === true;
        const failures = isPartial
          ? (result as { _failures?: unknown })._failures
          : undefined;

        execCtx.waitUntil(
          obs.audit(env, {
            actor: reqCtx.actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: isPartial ? 'partial' : 'ok',
            latency_ms: latency,
            correlation,
            payload: redactPayload(args),
          })
        );
        if (isPartial) {
          execCtx.waitUntil(
            obs.error(env, {
              source: `worker:mcp-servicetitan:${tool.name}`,
              severity: 'warn',
              message: `composite ${tool.name} returned partial result`,
              context: { actor: reqCtx.actor, correlation, failures },
              correlation,
            })
          );
        }
        execCtx.waitUntil(
          obs.heartbeat(env, `mcp-servicetitan:${tool.name}`, { ok: true })
        );
        emitMetric(env, execCtx, tool.name, 'ok', latency, reqCtx);

        // Phoenix tracing: one root span per call, ids/flags only — never raw
        // args/results (this worker's whole reason to exist is serving ST PII).
        execCtx.waitUntil(
          traceTool(
            env,
            tool.name,
            { correlation, role: reqCtx.role, actor: reqCtx.actor, partial: isPartial },
            async () => ({ status: isPartial ? 'error' : 'ok', latencyMs: latency })
          )
        );

        // Gated offload: below RESULT_THRESHOLD chars this is byte-identical
        // to the prior inline behavior (same text content block + same
        // structuredContent wrapping rule, now factored into
        // wrapStructuredContent so there is exactly one implementation of
        // that rule). Above threshold, the full payload is stashed in KV and
        // a resource_link is returned instead of inlining it. The
        // hasOutputSchema flag keeps structuredContent schema-valid for
        // outputSchema'd tools (the SDK validates it at runtime). See
        // src/resources/results.ts.
        const shaped = await offloadIfLarge(env, correlation, result, Boolean(tool.outputSchema));
        return { content: shaped.content, structuredContent: shaped.structuredContent };
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
            context: obs.safeContext({ actor: reqCtx.actor, correlation, code: mcpErr.code }),
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
            payload: redactPayload(args),
            result: { code: mcpErr.code, message: mcpErr.message },
          })
        );
        execCtx.waitUntil(
          obs.heartbeat(env, `mcp-servicetitan:${tool.name}`, { ok: false })
        );
        emitMetric(env, execCtx, tool.name, 'error', latency, reqCtx);

        // Phoenix tracing: one root span per call, ids/flags only — never raw
        // args/results (this worker's whole reason to exist is serving ST PII).
        execCtx.waitUntil(
          traceTool(
            env,
            tool.name,
            { correlation, role: reqCtx.role, actor: reqCtx.actor, code: mcpErr.code },
            async () => ({ status: 'error', latencyMs: latency })
          )
        );

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
