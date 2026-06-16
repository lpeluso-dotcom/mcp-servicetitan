// ============================================================
// admin-errors.ts — /admin/errors/unacked probe handler
//
// Closes the detection gap that let the tenant-404s and schema-drift bugs run
// silently: obs.error() writes error_log rows but nothing READ them. This returns
// the error-severity rows in a recent window plus an `alert` boolean, so a Grafana
// alert / scheduled agent can fire when error_count > 0.
//
//   GET /admin/errors/unacked?windowMs=3600000   (X-Sync-Key admin-gated)
// ============================================================

import type { Context } from 'hono';
import type { Env } from '../env';
import { requireAdminKey } from './admin-guard';

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1h
const MIN_WINDOW_MS = 60 * 1000; // 1m
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ROWS = 50;

interface ErrRow {
  ts: number;
  source: string | null;
  message: string | null;
  correlation: string | null;
}

export async function unackedErrorsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const denied = await requireAdminKey(c);
  if (denied) return denied;

  const raw = Number(new URL(c.req.url).searchParams.get('windowMs'));
  const windowMs = Math.max(MIN_WINDOW_MS, Math.min(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MS, MAX_WINDOW_MS));
  const since = Date.now() - windowMs;

  try {
    const [countRow, rows] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM error_log WHERE severity = 'error' AND ts >= ?`)
        .bind(since)
        .first<{ n: number }>(),
      c.env.DB.prepare(
        `SELECT ts, source, message, correlation FROM error_log
         WHERE severity = 'error' AND ts >= ? ORDER BY ts DESC LIMIT ?`
      )
        .bind(since, MAX_ROWS)
        .all<ErrRow>(),
    ]);
    const count = countRow?.n ?? 0;
    return c.json({
      ok: true,
      service: 'mcp-servicetitan',
      window_ms: windowMs,
      since_iso: new Date(since).toISOString(),
      error_count: count,
      alert: count > 0, // monitor: alert when true
      errors: (rows.results ?? []).map((r) => ({
        ts: r.ts,
        iso: new Date(r.ts).toISOString(),
        source: r.source,
        message: r.message,
        correlation: r.correlation,
      })),
      _truncated: count > MAX_ROWS,
    });
  } catch (e) {
    return c.json({ error: 'errors probe failed', detail: (e as Error).message }, 500);
  }
}
