import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { businessUnitId?: number; lookbackDays?: number }

// 60 min memo. Identifies commercial plumbing customers from jobs + tags D1 table.
export const commercial_plumbing_opportunities: ToolDef<Args> = {
  name: 'commercial_plumbing_opportunities',
  description: 'L5 composite: commercial plumbing upsell opportunities — customers with commercial plumbing history who haven\'t booked in 90+ days. 60 min memo. Source: D1 (jobs + tags nightly-synced).',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    lookbackDays: z.number().int().positive().default(90).describe('Days without booking to consider an opportunity (default: 90)'),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { businessUnitId, lookbackDays = 90 } = args;
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const query: Record<string, unknown> = {
      jobTypeName: 'Plumbing',
      completedBefore: cutoff.toISOString(),
      pageSize: 200,
    };
    if (businessUnitId) query.businessUnitIds = businessUnitId;

    const data = await readST<{ data?: any[] }>(
      env,
      { actor, correlation },
      `/jpm/v2/tenant/000000000/jobs`,
      query,
    );
    const jobs = data.data ?? [];

    // Deduplicate by customer — one opportunity per customer
    const seen = new Set<number>();
    const opportunities: any[] = [];
    for (const job of jobs) {
      if (job.customerId && !seen.has(job.customerId)) {
        seen.add(job.customerId);
        opportunities.push({
          customerId: job.customerId,
          lastJobId: job.id,
          lastJobDate: job.completedOn,
          daysSinceLastJob: Math.floor((Date.now() - new Date(job.completedOn).getTime()) / 86400000),
        });
      }
    }

    return {
      opportunities,
      count: opportunities.length,
      lookbackDays,
      _composite: 'commercial_plumbing_opportunities',
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
