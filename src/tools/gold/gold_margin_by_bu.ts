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
    'Returns revenue, cost, GP$ and GP% per BU. ' +
    'IMPORTANT — GP% here is NOT a true margin and will look implausibly high (often 93-100%). Two costs ' +
    'are missing, not zero: (1) labor burden, because gold has no timesheet grain; (2) item cost for ' +
    'dynamically-priced pricebook items, because ServiceTitan does not return a cost for them via API — ' +
    'QSC prices dynamically by default, so cost_$ reads 0 for whole business units. Treat GP% as a ' +
    'relative signal between BUs over the same window, never as a reportable margin. ' +
    'For one job with real labor burden, use job_cost_actuals. Source: Supabase gold.margin_by_bu RPC.',
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
      // Travels WITH the rows, not just in the tool description — a caller that already has the
      // numbers in hand is exactly who is about to quote GP% at someone.
      _margin_basis:
        'NOT a true margin — two costs are missing, not zero: labor burden (no gold timesheet grain) ' +
        'and item cost for dynamically-priced pricebook items (ServiceTitan returns no cost for them, ' +
        'and QSC prices dynamically by default). Relative signal between BUs only.',
    };
  },
  transformResult: defaultShaper,
};
