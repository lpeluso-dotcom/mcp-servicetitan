// ============================================================
// obs.ts — Observability helpers for mcp-servicetitan
// Writes audit_log / error_log rows to env.DB (own-D1 qsc-mcp-st,
// migrated off taylor-ai's shared DB in v1.0 F2). Heartbeat keys
// land in TAI_STATE KV. Patterns ported from taylor-ai/src/obs.js.
//
// Safety:
//  - Never throws. Logger failures are swallowed and console.error'd
//    so they can't break the caller path.
//  - Wrap in ctx.waitUntil() where feasible (fire-and-forget).
// ============================================================

import type { Env } from './env';

export interface AuditRow {
  actor: string;
  surface: string;
  operation: string;
  target_id?: string;
  dry_run?: boolean;
  payload?: unknown;
  result?: unknown;
  status: 'ok' | 'error' | 'verified';
  latency_ms?: number;
  correlation?: string;
}

export interface ErrorRow {
  source: string;
  severity: 'fatal' | 'error' | 'warn';
  message: string;
  stack?: string;
  context?: unknown;
  correlation?: string;
}

export interface HeartbeatState {
  ok?: boolean;
  extra?: Record<string, unknown>;
}

export async function audit(env: Env, row: AuditRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log
         (ts, actor, surface, operation, target_id, dry_run, payload, result, status, latency_ms, correlation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Date.now(),
        row.actor ?? 'unknown',
        row.surface ?? 'unknown',
        row.operation ?? 'unknown',
        row.target_id ?? null,
        row.dry_run ? 1 : 0,
        row.payload ? JSON.stringify(row.payload).slice(0, 4000) : null,
        row.result ? JSON.stringify(row.result).slice(0, 4000) : null,
        row.status ?? 'ok',
        row.latency_ms ?? null,
        row.correlation ?? null
      )
      .run();
  } catch (e) {
    // Never throw from the logger.
    // eslint-disable-next-line no-console
    console.error(`[obs.audit] write failed: ${(e as Error).message}`);
  }
}

export async function error(env: Env, row: ErrorRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO error_log
         (ts, source, severity, message, stack, context, alerted, correlation)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
      .bind(
        Date.now(),
        row.source ?? 'worker:mcp-servicetitan',
        row.severity ?? 'error',
        row.message ?? 'unknown error',
        row.stack ?? null,
        row.context ? JSON.stringify(row.context).slice(0, 4000) : null,
        row.correlation ?? null
      )
      .run();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[obs.error] write failed: ${(e as Error).message}`);
  }
}

export interface MetricPoint {
  tool: string;
  latency_ms: number;
  status: 'ok' | 'error';
  source?: string;
}

export function metric(env: Env, point: MetricPoint): void {
  try {
    if (!env.MCP_METRICS) return;
    env.MCP_METRICS.writeDataPoint({
      indexes: [point.tool],
      blobs: [point.status, point.source ?? 'unknown'],
      doubles: [point.latency_ms],
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[obs.metric] write failed: ${(e as Error).message}`);
  }
}

export async function heartbeat(
  env: Env,
  source: string,
  state: HeartbeatState = {}
): Promise<void> {
  try {
    if (!env.TAI_STATE) return;
    const key = `heartbeat:${source}`;
    const existingRaw = await env.TAI_STATE.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const now = Date.now();
    const ok = state.ok !== false;
    const next = {
      last_ok_ts: ok ? now : existing.last_ok_ts ?? null,
      last_error_ts: ok ? existing.last_error_ts ?? null : now,
      consecutive_errors: ok ? 0 : (existing.consecutive_errors ?? 0) + 1,
      extra: state.extra ?? existing.extra ?? null,
    };
    await env.TAI_STATE.put(key, JSON.stringify(next));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[obs.heartbeat] ${source} failed: ${(e as Error).message}`);
  }
}
