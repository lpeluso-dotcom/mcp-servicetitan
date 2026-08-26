import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetchesWithTruncation, stReadGuarded } from '../../composite-helpers';
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
  // L5 composite — envelope keys (customerId/_partial/_failures/_composite/
  // _source/correlation) are always set by the handler, but every fanout
  // payload (customer/locations/jobs/memberships/estimates/invoices) is
  // z.unknown() on purpose: gatherFetches sets a sub-result to `null` on
  // partial failure (see c10_composites.test.ts), and each success shape is
  // itself a raw ST resource (object) or list (array) depending on the
  // endpoint — a strict type here would reject exactly the partial-failure
  // case this composite exists to report. transformResult (limitArrays +
  // excludeFields) may also add `${key}_truncated` keys, which the SDK's
  // default (non-strict) object schema silently tolerates without needing
  // to be declared here.
  outputSchema: {
    customerId: z.number(),
    customer: z.unknown().optional(),
    locations: z.unknown().optional(),
    jobs: z.unknown().optional(),
    memberships: z.unknown().optional(),
    estimates: z.unknown().optional(),
    invoices: z.unknown().optional(),
    _partial: z.boolean().optional(),
    _failures: z.array(z.unknown()).optional(),
    _composite: z.string().optional(),
    _source: z.string().optional(),
    correlation: z.string().optional(),
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

    const fanout = await gatherFetchesWithTruncation([
      { name: 'customer',    promise: stReadGuarded(env, h, `/crm/v2/tenant/${tenant}/customers/${customerId}`, signal) },
      { name: 'locations',   promise: stReadGuarded(env, h, `/crm/v2/tenant/${tenant}/locations?customerId=${customerId}`, signal) },
      { name: 'jobs',        promise: stReadGuarded(env, h, `/jpm/v2/tenant/${tenant}/jobs?customerId=${customerId}`, signal) },
      { name: 'memberships', promise: stReadGuarded(env, h, `/memberships/v2/tenant/${tenant}/memberships?customerId=${customerId}&status=Active`, signal) },
      { name: 'estimates',   promise: stReadGuarded(env, h, `/sales/v2/tenant/${tenant}/estimates?customerId=${customerId}`, signal) },
      { name: 'invoices',    promise: stReadGuarded(env, h, `/accounting/v2/tenant/${tenant}/invoices?customerId=${customerId}`, signal) },
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
      // F-11: name every list arm ST reported more pages for, so a page-one
      // answer is DISCLOSED, not served silently as the whole set.
      _truncated: fanout.truncated,
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation,
    };

    // 4. Lock-holder writes D1 cache (only a COMPLETE snapshot), then ALWAYS
    //    releases so concurrent waiters can read / re-fire.
    //    F-11: never cache a TRUNCATED snapshot — a fast complete re-read next
    //    call beats serving a cached partial as authoritative for 5 minutes.
    //    The release must fire regardless of truncation, or the single-flight
    //    lock leaks and every waiter polls to its deadline.
    if (acquired) {
      if (fanout.truncated.length === 0) {
        await mvWrite(env, customerId, result, env.MCP_SERVICE_VERSION ?? '0.0.0');
      }
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
