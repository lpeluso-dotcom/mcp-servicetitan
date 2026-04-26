// ============================================================
// admin-health-audit.ts — /admin/health/audit probe handler
//
// Surfaces the last activity timestamps from audit_log and error_log
// so a future telemetry-silence window is detectable in a single curl.
//
// The 2026-04-23 v1.0 cutover left prod silent for three days because
// the user-level Claude Code config still pointed at the dev URL — a
// configuration trap, not a code bug. This probe makes that class of
// problem one query away.
// ============================================================

import type { Context } from 'hono';
import type { Env } from '../env';
import { requireAdminKey } from './admin-guard';

const SILENCE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

interface MaxRow { last_ts: number | null }

export async function auditHealthHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const denied = requireAdminKey(c);
  if (denied) return denied;
  try {
    const [auditRow, errorRow] = await Promise.all([
      c.env.DB.prepare('SELECT MAX(ts) AS last_ts FROM audit_log').first<MaxRow>(),
      c.env.DB.prepare('SELECT MAX(ts) AS last_ts FROM error_log').first<MaxRow>(),
    ]);
    const now = Date.now();
    const lastAudit = auditRow?.last_ts ?? null;
    const lastError = errorRow?.last_ts ?? null;
    const isSilent = lastAudit === null || now - lastAudit > SILENCE_THRESHOLD_MS;
    return c.json({
      ok: true,
      service: 'mcp-servicetitan',
      version: c.env.MCP_SERVICE_VERSION,
      last_audit_ts: lastAudit,
      last_audit_iso: lastAudit ? new Date(lastAudit).toISOString() : null,
      last_audit_age_ms: lastAudit ? now - lastAudit : null,
      last_error_ts: lastError,
      last_error_iso: lastError ? new Date(lastError).toISOString() : null,
      is_silent: isSilent,
      silence_threshold_ms: SILENCE_THRESHOLD_MS,
      _hint: isSilent
        ? 'No audit activity in the last hour. Check ~/.claude.json mcp-servicetitan.url and any other HTTP callers — the v1.0 cutover trap was a stale dev URL in user-level config.'
        : null,
    });
  } catch (e) {
    return c.json({ error: 'probe failed', detail: (e as Error).message }, 500);
  }
}
