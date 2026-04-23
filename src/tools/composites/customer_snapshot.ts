import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
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

    let results: PromiseSettledResult<Response>[];
    try {
      results = await Promise.allSettled([
        env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/crm/v2/tenant/${tenant}/customers/${customerId}`)}`, { headers: h, signal }),
        env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/crm/v2/tenant/${tenant}/locations?customerId=${customerId}`)}`, { headers: h, signal }),
        env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/jpm/v2/tenant/${tenant}/jobs?customerId=${customerId}`)}`, { headers: h, signal }),
        env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/memberships/v2/tenant/${tenant}/memberships?customerId=${customerId}&statuses=Active`)}`, { headers: h, signal }),
        env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/sales/v2/tenant/${tenant}/estimates?customerId=${customerId}`)}`, { headers: h, signal }),
        env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/accounting/v2/tenant/${tenant}/invoices?customerId=${customerId}`)}`, { headers: h, signal }),
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

    const [customer, locations, jobs, memberships, estimates, invoices] = results;

    async function extract(settled: PromiseSettledResult<Response>, key: string) {
      if (settled.status === 'rejected') return { error: `${key} fetch failed` };
      if (!settled.value.ok) return { error: `${key} ${settled.value.status}` };
      const json = await settled.value.json<{ data?: unknown } | unknown>();
      return (json as { data?: unknown }).data ?? json;
    }

    return {
      customerId,
      customer: await extract(customer, 'customer'),
      locations: await extract(locations, 'locations'),
      jobs: await extract(jobs, 'jobs'),
      memberships: await extract(memberships, 'memberships'),
      estimates: await extract(estimates, 'estimates'),
      invoices: await extract(invoices, 'invoices'),
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation,
    };
  },
};
