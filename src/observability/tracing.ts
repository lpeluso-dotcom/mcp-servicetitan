// src/observability/tracing.ts — fail-open span emission into mcp-servicetitan's
// OWN otel_span_queue (migrations/0005; this worker does not share taylor-ai's
// or qsc-hopper's queue). Ported from qsc-hopper-phoenix/src/observability/tracing.ts
// (service 'qsc-hopper', env binding WOZ) with the binding renamed to this repo's
// `DB` and the default service renamed to 'mcp-servicetitan'. mcp-servicetitan has
// no Cloudflare Workflows and no crons (wrangler.toml crons = []) — its only
// tracing need is one root span per MCP tool call — so WorkflowTracer/CronTracer/
// traceCron are all dropped (YAGNI, same call as qsc-fanout) in favor of a single
// traceTool() export used from tool-registry.ts's registerTool(). Every write is
// fail-open: a tracing failure can never affect the tool's own result. attrs must
// never carry raw tool args/results — callers pass only correlation id, role,
// actor, and status flags (see tool-registry.ts).
import { resolveTrace } from './correlation';

export type RunKind = 'interactive' | 'cron' | 'webhook' | 'backfill';
export interface TracerEnv { DB: D1Database; }
export type ToolSpanEnv = TracerEnv;

interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operation: string;
  actor: string;
  service: string;
  runKind: RunKind;
  status: 'ok' | 'error';
  latencyMs: number;
  attrs: Record<string, unknown>;
}

/** Fail-open INSERT into otel_span_queue. Never throws. Bind order == migrations/0005 columns. */
async function writeSpanRow(env: TracerEnv, row: SpanRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO otel_span_queue
         (ts, trace_id, span_id, parent_span_id, service_name, operation, qsc_actor, qsc_run_kind, status, latency_ms, attrs_json, shipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      Date.now(), row.traceId, row.spanId, row.parentSpanId, row.service, row.operation,
      row.actor, row.runKind, row.status, row.latencyMs, JSON.stringify(row.attrs),
    ).run();
  } catch (e: any) {
    console.error(`[observability.tracing] otel_span_queue write failed: ${e?.message ?? e}`);
  }
}

/** One root span per MCP tool call. Fail-open — a tracing failure can never affect the tool's own result. */
export async function traceTool(
  env: ToolSpanEnv,
  operation: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<{ status: 'ok' | 'error'; latencyMs: number }>,
): Promise<void> {
  const resolved = resolveTrace(undefined);
  const t0 = Date.now();
  try {
    const outcome = await fn();
    await writeSpanRow(env, {
      traceId: resolved.traceId, spanId: resolved.spanId, parentSpanId: null,
      operation, actor: 'luke', service: 'mcp-servicetitan', runKind: 'interactive',
      status: outcome.status, latencyMs: outcome.latencyMs, attrs,
    });
  } catch (e: any) {
    // fn() itself is not expected to throw (it wraps the already-caught tool
    // handler outcome) — but if it does, still emit an error span, fail-open.
    await writeSpanRow(env, {
      traceId: resolved.traceId, spanId: resolved.spanId, parentSpanId: null,
      operation, actor: 'luke', service: 'mcp-servicetitan', runKind: 'interactive',
      status: 'error', latencyMs: Date.now() - t0, attrs: { ...attrs, error: e?.message ?? String(e) },
    });
  }
}
