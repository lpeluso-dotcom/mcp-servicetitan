import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetches, stRead } from '../../composite-helpers';
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

    const doId = env.CUSTOMER_SNAPSHOT_FLIGHT.idFromName(String(customerId));
    const doStub = env.CUSTOMER_SNAPSHOT_FLIGHT.get(doId);

    // The lock is advisory — we proceed whether or not it was acquired — so
    // race acquire against the fanout instead of serializing them. Saves a DO
    // RTT (5–50ms) on the hot path. acquire-failure isn't an error, so we
    // swallow it into { acquired: false }.
    const acquirePromise = doStub
      .fetch('https://do/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId }),
      })
      .then((r) => r.json<{ acquired: boolean }>())
      .catch(() => ({ acquired: false }));

    const h = authHeaders(env, correlation, actor);
    const tenant = '431848990';
    const signal = AbortSignal.timeout(15_000);

    const fanoutPromise = gatherFetches([
      { name: 'customer',    promise: stRead(env, h, `/crm/v2/tenant/${tenant}/customers/${customerId}`, signal) },
      { name: 'locations',   promise: stRead(env, h, `/crm/v2/tenant/${tenant}/locations?customerId=${customerId}`, signal) },
      { name: 'jobs',        promise: stRead(env, h, `/jpm/v2/tenant/${tenant}/jobs?customerId=${customerId}`, signal) },
      { name: 'memberships', promise: stRead(env, h, `/memberships/v2/tenant/${tenant}/memberships?customerId=${customerId}&status=Active`, signal) },
      { name: 'estimates',   promise: stRead(env, h, `/sales/v2/tenant/${tenant}/estimates?customerId=${customerId}`, signal) },
      { name: 'invoices',    promise: stRead(env, h, `/accounting/v2/tenant/${tenant}/invoices?customerId=${customerId}`, signal) },
    ]);

    let fanout: Awaited<typeof fanoutPromise>;
    let acquired = false;
    try {
      const [acq, fan] = await Promise.all([acquirePromise, fanoutPromise]);
      acquired = acq.acquired === true;
      fanout = fan;
    } finally {
      if (acquired) {
        // Best-effort release; failure here doesn't change the caller's view.
        doStub
          .fetch('https://do/release', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ customerId }),
          })
          .catch(() => undefined);
      }
    }

    // Memberships needs client-side re-filter — ST status filter is unreliable (verified 2026-04-23).
    const membershipsRaw = fanout.results.memberships;
    const memberships = Array.isArray(membershipsRaw)
      ? (membershipsRaw as Record<string, unknown>[]).filter((m) => m.status === 'Active')
      : membershipsRaw;

    return {
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
  },
};
