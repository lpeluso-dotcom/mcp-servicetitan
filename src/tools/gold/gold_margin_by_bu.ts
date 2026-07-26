// ============================================================
// gold_margin_by_bu — item/material margin by business unit over a window,
// sourced from the Supabase gold warehouse via the gold.margin_by_bu RPC
// (qsc-vector migration 0011). This is ITEM/MATERIAL margin only — it does
// NOT include labor burden, because gold has no timesheet grain. For a
// single job's labor-inclusive burden use job_cost_actuals (D1).
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { sbRpc } from '../../supabase';
import type { ToolDef } from '../index';

interface Args {
  from: string;
  to: string;
  businessUnitId?: number;
}

interface RpcRow {
  business_unit_id: number;
  revenue_cents: number;
  cost_cents: number;
  gp_cents: number;
  gp_pct: number | null;
  job_count: number;
}

const cents = (v: number | null | undefined) => Number(((v ?? 0) / 100).toFixed(2));

export const gold_margin_by_bu: ToolDef<Args> = {
  name: 'gold_margin_by_bu',
  description:
    'Item/material margin by business unit over a completed-date window, from the Woz gold warehouse. ' +
    'Returns revenue, cost, GP$ and GP% per BU. IMPORTANT: this is item/material margin only — it does NOT ' +
    'include labor burden (gold has no timesheet grain). For one job with labor burden, use job_cost_actuals. ' +
    'Source: Supabase gold.margin_by_bu RPC.',
  stEndpoint: { method: 'GET', path: 'supabase://gold/margin_by_bu', source: 'computed' },
  zodSchema: {
    from: z.string().describe("Window start, ISO 'YYYY-MM-DD' (fct_job.completed_date >= from)."),
    to: z.string().describe("Window end, ISO 'YYYY-MM-DD' (fct_job.completed_date <= to)."),
    businessUnitId: z.coerce.number().int().positive().optional()
      .describe('Restrict to one ST business unit ID (optional; omitted = all BUs).'),
  },
  async handler(env, args) {
    const rows = await sbRpc<RpcRow[]>(env, 'margin_by_bu', {
      p_from: args.from,
      p_to: args.to,
      p_bu_id: args.businessUnitId ?? null,
    }, 'gold');
    return {
      window: { from: args.from, to: args.to },
      rows: rows.map((r) => ({
        business_unit_id: r.business_unit_id,
        revenue_$: cents(r.revenue_cents),
        cost_$: cents(r.cost_cents),
        gp_$: cents(r.gp_cents),
        gp_pct: r.gp_pct,
        job_count: r.job_count,
      })),
      count: rows.length,
      _source: 'gold',
      _margin_basis: 'item/material only — excludes labor burden (no gold timesheet grain)',
    };
  },
  transformResult: defaultShaper,
};
