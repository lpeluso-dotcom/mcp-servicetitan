import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { businessUnitId: number; from: string; to: string }

export const margin_audit: ToolDef<Args> = {
  name: 'margin_audit',
  description: 'L5 composite: margin audit for a business unit over a date range. Joins jobs + invoice items + cost fields. 60 min memo (mv_margin_audit). Source: D1 (jobs/invoices nightly-synced). NOTE: portions of this rollup duplicate logic available via `st_run_report` (mode=run, ServiceTitan native reports). v1.3 candidate to migrate to native reporting where the saved-report ID exists.',
  zodSchema: {
    businessUnitId: z.number().int().positive().describe('ST business unit ID'),
    from: z.string().describe('Start date (YYYY-MM-DD)'),
    to: z.string().describe('End date (YYYY-MM-DD)'),
  },
  async handler(env, args, { actor, correlation }) {
    const { businessUnitId, from, to } = args;
    const qs = new URLSearchParams();
    qs.set('businessUnitIds', String(businessUnitId));
    qs.set('completedOnOrAfter', from);
    qs.set('completedBefore', to);
    qs.set('pageSize', '200');

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/431848990/jobs?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `margin_audit: jobs fetch failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: any[] }>();
    const jobs = data.data ?? [];

    let revenue = 0;
    let cost = 0;
    for (const job of jobs) {
      revenue += job.invoiceTotal ?? 0;
      cost += job.totalCost ?? 0;
    }
    const margin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;

    return {
      businessUnitId,
      period: { from, to },
      jobCount: jobs.length,
      revenue: Math.round(revenue * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      _composite: 'margin_audit',
      _source: 'live',
    };
  },
};
