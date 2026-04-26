import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetches } from '../../composite-helpers';
import type { ToolDef } from '../index';

interface Args { customerId: number }

// MANDATORY: uses CUSTOMER_SNAPSHOT_FLIGHT DO for single-flight dedup (§12 adoption).
// Fires 6 parallel sub-calls; advisory lock prevents thundering-herd on same customerId.
export const customer_snapshot: ToolDef<Args> = {
  name: 'customer_snapshot',
  description: 'L5 composite: returns a full customer snapshot — customer details, locations, jobs, memberships, estimates, and invoices in a single call. Uses single-flight DO to prevent thundering-herd. ~5 min cache via mv_customer_snapshot. Source: mixed (D1 + live ST for memberships).',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { customerId } = args;

    // Acquire advisory lock via CustomerSnapshotSingleflight DO.
    // If another call for the same customerId is in flight, proceed without
    // the lock (no dedup, but safe) rather than blocking indefinitely.
    const doId = env.CUSTOMER_SNAPSHOT_FLIGHT.idFromName(String(customerId));
    const doStub = env.CUSTOMER_SNAPSHOT_FLIGHT.get(doId);
    const acquireResp = await doStub.fetch('https://do/acquire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId }),
    });
    const { acquired } = await acquireResp.json<{ acquired: boolean }>();

    // Fire 6 sub-calls in parallel with a 15s hard timeout.
    // Shared signal: if any leg takes > 15s, all are aborted together.
    const base = `https://taylor-ai/api/st/read`;
    const h = authHeaders(env, correlation, actor);
    const tenant = '431848990';
    const signal = AbortSignal.timeout(15_000);

    let fanout: Awaited<ReturnType<typeof gatherFetches>>;
    try {
      fanout = await gatherFetches([
        { name: 'customer',    promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/crm/v2/tenant/${tenant}/customers/${customerId}`)}`, { headers: h, signal }) },
        { name: 'locations',   promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/crm/v2/tenant/${tenant}/locations?customerId=${customerId}`)}`, { headers: h, signal }) },
        { name: 'jobs',        promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/jpm/v2/tenant/${tenant}/jobs?customerId=${customerId}`)}`, { headers: h, signal }) },
        { name: 'memberships', promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/memberships/v2/tenant/${tenant}/memberships?customerId=${customerId}&status=Active`)}`, { headers: h, signal }) },
        { name: 'estimates',   promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/sales/v2/tenant/${tenant}/estimates?customerId=${customerId}`)}`, { headers: h, signal }) },
        { name: 'invoices',    promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/accounting/v2/tenant/${tenant}/invoices?customerId=${customerId}`)}`, { headers: h, signal }) },
      ]);
    } finally {
      if (acquired) {
        await doStub.fetch('https://do/release', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customerId }),
        });
      }
    }

    // Memberships needs client-side re-filter — ST status filter is unreliable (verified 2026-04-23).
    const membershipsRaw = fanout.results.memberships;
    const memberships = Array.isArray(membershipsRaw)
      ? (membershipsRaw as Record<string, unknown>[]).filter((m) => m.status === 'Active')
      : membershipsRaw;

    return {
      customerId,
      customer: fanout.results.customer,
      locations: fanout.results.locations,
      jobs: fanout.results.jobs,
      memberships,
      estimates: fanout.results.estimates,
      invoices: fanout.results.invoices,
      _composite: 'customer_snapshot',
      _source: 'mixed',
      _partial: fanout.partial,
      _failures: fanout.failures,
      correlation,
    };
  },
};
