// ============================================================
// read-router.ts — D1-first read dispatcher for mcp-servicetitan.
//
// The 25 nightly-synced tables live in servicetitan-proxy's D1. This router
// calls servicetitan-proxy's queryD1 RPC (read-only, parameterized SELECT only)
// for those tables, and falls back to live ST via /api/st/read when:
//   (a) the table is not in the nightly-synced set, OR
//   (b) the table's updated_at is stale by more than 48h.
//
// Each tool result includes _source ('d1' | 'live') and, when stale,
// _stale_days for operator transparency.
// ============================================================

import type { Env } from './env';
import { authHeaders, newCorrelationId } from './auth';
import { familyFromEndpoint, checkRateLimit, reportBackoff } from './rate-limit-guard';

// Tables nightly-synced into servicetitan-proxy D1 (verified 2026-04-22;
// re-audited 2026-06-12).
// 2026-06-12 audit: pb_materials + pb_equipment re-ADDED — the staleness that
// excluded them (23d/37d as of 2026-04-22) was fixed by the 2026-04-28
// active=True sync flip; sync_log shows both syncing daily (<24h fresh).
// call_transcripts REMOVED — legacy soak expired 2026-05-31, table dropped
// from taylor-ai D1 (R2 backup at qsc-media/backups/d1/call_transcripts/).
// v1.5 additions (2026-05-19): job_timesheets (migration 0021, 2h sync),
// opportunities (migration 0018), dispatch_pro_* (migration 0022, manual cron).
export const D1_TABLES = new Set([
  'customers', 'jobs', 'invoices', 'appointments', 'estimates', 'locations',
  'payments', 'technicians', 'campaigns', 'business_units', 'job_types',
  'tag_types', 'dispatch_zones', 'cancel_reasons', 'customer_contacts',
  'calls', 'appointment_assignments', 'invoice_items', 'estimate_items',
  'pb_services', 'pb_materials', 'pb_equipment', 'contacts', 'customer_notes',
  'tags', 'installed_equipment',
  // v1.5
  'job_timesheets', 'opportunities', 'opportunity_statuses',
  'dispatch_pro_utilization', 'dispatch_pro_ratio', 'dispatch_pro_alerts',
]);

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export interface ReadResult {
  rows: unknown[];
  _source: 'd1' | 'live';
  _stale_days?: number;
  _fallback_reason?: string;
}

export class ReadRouter {
  constructor(private env: Env) {}

  // Query servicetitan-proxy's queryD1 RPC for a nightly-synced table.
  // servicetitan-proxy exposes a read-only parameterized SELECT proxy; it rejects
  // INSERT/UPDATE/DELETE/DROP/ALTER on the provider side. We also enforce
  // SELECT-only here so a future caller can't ship a mutation across the
  // RPC boundary by accident — defense in depth.
  async queryD1(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; updatedAt: number | null }> {
    if (!/^\s*SELECT\b/i.test(sql)) {
      throw new Error('queryD1: only SELECT statements are permitted from this client');
    }
    const resp = await this.env.ST_PROXY.fetch('https://servicetitan-proxy/internal/query-d1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(this.env, newCorrelationId(), 'mcp-servicetitan-read-router'),
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!resp.ok) {
      throw new Error(`queryD1 RPC failed: ${resp.status}`);
    }

    return resp.json<{ rows: unknown[]; updatedAt: number | null }>();
  }

  // Query live ST via servicetitan-proxy's /api/st/read proxy.
  async queryLive(endpoint: string, query: Record<string, unknown> = {}): Promise<{ rows: unknown[] }> {
    const family = familyFromEndpoint(endpoint);
    await checkRateLimit(this.env, family);

    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
    ).toString();
    const url = `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(endpoint)}${qs ? '&' + qs : ''}`;

    const resp = await this.env.ST_PROXY.fetch(url, {
      headers: authHeaders(this.env, newCorrelationId(), 'mcp-servicetitan-read-router'),
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '60', 10);
        await reportBackoff(this.env, family, retryAfter);
        throw new Error(`ST rate limit: retry after ${retryAfter}s`);
      }
      throw new Error(`live ST read failed: ${resp.status}`);
    }

    const data = await resp.json<{ data?: unknown[]; items?: unknown[] }>();
    return { rows: data.data ?? data.items ?? [] };
  }

  // Route a read to D1 or live ST based on table membership and staleness.
  async read(
    table: string,
    sql: string,
    params: unknown[],
    liveEndpoint: string,
    liveQuery: Record<string, unknown> = {}
  ): Promise<ReadResult> {
    if (!D1_TABLES.has(table)) {
      const live = await this.queryLive(liveEndpoint, liveQuery);
      return { rows: live.rows, _source: 'live' };
    }

    try {
      const d1 = await this.queryD1(sql, params);

      // Check staleness. If updatedAt is null (RPC didn't populate sync_metadata),
      // treat as unknown freshness and fall back to live rather than serving
      // potentially stale D1 rows without a signal.
      if (d1.updatedAt === null) {
        const live = await this.queryLive(liveEndpoint, liveQuery);
        return { rows: live.rows, _source: 'live', _fallback_reason: 'd1_freshness_unknown' };
      }

      const staleness = Date.now() - d1.updatedAt;
      if (staleness > STALE_THRESHOLD_MS) {
        const staleDays = Math.floor(staleness / (24 * 60 * 60 * 1000));
        const live = await this.queryLive(liveEndpoint, liveQuery);
        return {
          rows: live.rows,
          _source: 'live',
          _stale_days: staleDays,
          _fallback_reason: `d1_stale_${staleDays}d`,
        };
      }

      return { rows: d1.rows, _source: 'd1' };
    } catch {
      // D1 unavailable — fall back to live ST rather than surfacing an error.
      const live = await this.queryLive(liveEndpoint, liveQuery);
      return { rows: live.rows, _source: 'live', _fallback_reason: 'd1_unavailable' };
    }
  }
}
