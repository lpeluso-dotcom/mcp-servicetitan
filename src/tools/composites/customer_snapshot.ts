import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetches, stRead } from '../../composite-helpers';
import type { ToolDef } from '../index';
import type { Env } from '../../env';
import { excludeFields, limitArrays } from '../../response-shape';

interface Args { customerId: number }

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;     // 5 min materialized view TTL
const SINGLEFLIGHT_MAX_WAIT_MS = 6_000;     // max wait for another caller to finish
const SINGLEFLIGHT_POLL_INTERVAL_MS = 500;  // default re-poll interval

interface SnapshotRow {
  snapshot: string;
  expires_at: number;
}

async function mvRead(env: Env, customerId: number): Promise<unknown | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT snapshot, expires_at FROM mv_customer_snapshot WHERE customer_id = ?'
    )
      .bind(customerId)
      .first<SnapshotRow>();
    if (row && row.expires_at > Date.now()) {
      return JSON.parse(row.snapshot);
    }
  } catch {
    // non-fatal — treat as cache miss
  }
  return null;
}

async function mvWrite(env: Env, customerId: number, snapshot: unknown, version: string): Promise<void> {
  try {
    const now = Date.now();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO mv_customer_snapshot (customer_id, snapshot, computed_at, expires_at, source_version) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(customerId, JSON.stringify(snapshot), now, now + SNAPSHOT_TTL_MS, version)
      .run();
  } catch {
    // non-fatal — cache write failure doesn't affect the caller
  }
}

// MANDATORY: uses CUSTOMER_SNAPSHOT_FLIGHT DO for single-flight dedup (§12 adoption).
// Fires 6 parallel sub-calls; singleflight DO prevents thundering-herd on same customerId.
export const customer_snapshot: ToolDef<Args> = {
  name: 'customer_snapshot',
  description: 'L5 composite: returns a full customer snapshot — customer details, locations, jobs, memberships, estimates, and invoices in a single call. Uses single-flight DO to prevent thundering-herd. ~5 min cache via mv_customer_snapshot. Source: mixed (D1 + live ST for memberships).',
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers/{id}', source: 'mixed' },
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { customerId } = args;

    // 1. D1 materialized view cache — fastest path, no DO overhead.
    const cached = await mvRead(env, customerId);
    if (cached !== null) {
      return { ...(cached as Record<string, unknown>), _source: 'mv_d1', correlation };
    }

    // 2. Try to acquire single-flight lock to prevent concurrent fanouts.
    const doId = env.CUSTOMER_SNAPSHOT_FLIGHT.idFromName(String(customerId));
    const doStub = env.CUSTOMER_SNAPSHOT_FLIGHT.get(doId);

    let acquired = false;
    try {
      const acqResp = await doStub.fetch('https://do/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId }),
      });
      const acq = await acqResp.json<{ acquired: boolean; waitMs?: number }>();

      if (!acq.acquired) {
        // Another caller is actively fetching — poll D1 until it writes the cache.
        const waitMs = acq.waitMs ?? SINGLEFLIGHT_POLL_INTERVAL_MS;
        const deadline = Date.now() + SINGLEFLIGHT_MAX_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, waitMs));
          const hit = await mvRead(env, customerId);
          if (hit !== null) {
            return { ...(hit as Record<string, unknown>), _source: 'mv_d1_wait', correlation };
          }
        }
        // Poll exhausted without a cache hit — fall through to fire own fanout (degraded path).
      } else {
        acquired = true;
      }
    } catch {
      // DO unreachable — proceed without singleflight (degraded path).
    }

    // 3. Fire parallel fanout (lock-holder or degraded fallback).
    const h = authHeaders(env, correlation, actor);
    const tenant = '000000000';
    const signal = AbortSignal.timeout(15_000);

    const fanout = await gatherFetches([
      { name: 'customer',    promise: stRead(env, h, `/crm/v2/tenant/${tenant}/customers/${customerId}`, signal) },
      { name: 'locations',   promise: stRead(env, h, `/crm/v2/tenant/${tenant}/locations?customerId=${customerId}`, signal) },
      { name: 'jobs',        promise: stRead(env, h, `/jpm/v2/tenant/${tenant}/jobs?customerId=${customerId}`, signal) },
      { name: 'memberships', promise: stRead(env, h, `/memberships/v2/tenant/${tenant}/memberships?customerId=${customerId}&status=Active`, signal) },
      { name: 'estimates',   promise: stRead(env, h, `/sales/v2/tenant/${tenant}/estimates?customerId=${customerId}`, signal) },
      { name: 'invoices',    promise: stRead(env, h, `/accounting/v2/tenant/${tenant}/invoices?customerId=${customerId}`, signal) },
    ]);

    // Memberships needs client-side re-filter — ST status filter is unreliable (verified 2026-04-23).
    const membershipsRaw = fanout.results.memberships;
    const memberships = Array.isArray(membershipsRaw)
      ? (membershipsRaw as Record<string, unknown>[]).filter((m) => m.status === 'Active')
      : membershipsRaw;

    const result = {
      customerId,
      _partial: fanout.partial,
      _failures: fanout.failures,
      customer: fanout.results.customer,
      locations: fanout.results.locations,
      jobs: fanout.results.jobs,
      memberships,
      estimates: fanout.results.estimates,
      invoices: fanout.results.invoices,
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation,
    };

    // 4. Lock-holder writes D1 cache, then releases so concurrent waiters can read.
    if (acquired) {
      await mvWrite(env, customerId, result, env.MCP_SERVICE_VERSION ?? '0.0.0');
      doStub
        .fetch('https://do/release', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customerId }),
        })
        .catch(() => undefined);
    }

    return result;
  },
  transformResult: (r) => limitArrays(excludeFields(r as Record<string, unknown>), {
    jobs: 25,
    invoices: 25,
    estimates: 25,
    locations: 10,
  }),
};
