// ============================================================
// pricebook_cost_drift — recently-modified cost-bearing items (QUA-739).
//
// Returns active materials + equipment with cost>0 whose D1 row was
// modified within a rolling `windowDays` window. Useful for spot-checking
// after a vendor cost update, or as a "what changed lately" feed before a
// margin review.
//
// SQLite date-filter gotcha: pb_materials/pb_equipment.updated_at is the
// real ST `modifiedOn`, stored as ISO with a 'T'/'Z'
// (e.g. "2026-07-09T15:43:46.6Z"). SQLite's datetime('now', ...) returns a
// SPACE-separated string ("2026-07-10 00:..") — a raw `updated_at >=
// datetime('now', ...)` compare silently breaks at the T-vs-space byte. We
// compare date-only instead: substr(updated_at,1,10) >= date('now', ?),
// with the window bound to a parameter (never string-interpolated).
//
// HONESTY NOTE: updated_at reflects ANY field ST changed on the row, not
// specifically cost — a window over it over-reports non-cost edits (a
// category rename bumps modifiedOn just like a cost change does). This
// composite surfaces recently-MODIFIED cost-bearing items, not verified
// cost deltas. A true old->new cost delta needs a cost-history snapshot,
// which does not exist yet (deferred — vendor_snapshots/st_cost_review_queue
// are empty in D1).
//
// HARD RULE: services are 100% dynamically priced by QSC (use_static_prices=0
// fleet-wide) — this composite never queries pb_services.
//
// Source: D1 (pb_materials + pb_equipment) via servicetitan-proxy /api/sql/read.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import { shapePriceRow } from '../../supabase';
import type { ToolDef } from '../index';

interface Args {
  windowDays?: number;
}

interface CostDriftRow {
  id: number;
  code: string | null;
  name: string | null;
  category_name: string | null;
  cost: number;
  price: number;
  updated_at: string | null;
  kind: 'material' | 'equipment';
}

const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const RESULT_CAP = 200;

function clampWindowDays(raw: number | undefined): number {
  const v = raw ?? DEFAULT_WINDOW_DAYS;
  return Math.min(Math.max(Math.trunc(v), MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
}

const SQL = `SELECT id, code, name, category_name, cost, price, updated_at, 'material' AS kind
   FROM pb_materials
   WHERE active = 1 AND cost > 0 AND substr(updated_at, 1, 10) >= date('now', ?)
   UNION ALL
   SELECT id, code, name, category_name, cost, price, updated_at, 'equipment' AS kind
   FROM pb_equipment
   WHERE active = 1 AND cost > 0 AND substr(updated_at, 1, 10) >= date('now', ?)
   ORDER BY updated_at DESC
   LIMIT ?`;

export const pricebook_cost_drift: ToolDef<Args> = {
  name: 'pricebook_cost_drift',
  description:
    'Surfaces active, cost-bearing (cost>0) materials + equipment whose D1 row was recently modified — ' +
    'a rolling `windowDays` window (default 30, clamped to 1-365) against updated_at (ServiceTitan’s ' +
    'modifiedOn). Use to spot-check items after a vendor cost update, or as a "what changed lately" feed ' +
    'before a margin review. HONESTY NOTE: updated_at reflects ANY field ST changed, not specifically cost, ' +
    'so this surfaces recently-modified cost-bearing items, not verified cost deltas — a true old-to-new ' +
    'cost delta needs a cost-history snapshot (not built yet). DYNAMIC-PRICING NOTE: QSC prices every active ' +
    'service dynamically at invoice time (use_static_prices=0 fleet-wide), so services are out of scope ' +
    'entirely — this composite never queries pb_services. Source: D1 pb_materials + pb_equipment.',
  stEndpoint: { method: 'GET', path: 'd1://pb_materials+pb_equipment', source: 'd1' },
  annotations: { readOnlyHint: true },
  zodSchema: {
    windowDays: z
      .number()
      .int()
      .optional()
      .describe(`Lookback window in days against updated_at, clamped to 1-${MAX_WINDOW_DAYS}. Default ${DEFAULT_WINDOW_DAYS}.`),
  },
  async handler(env, args, { correlation: _correlation }) {
    const windowDays = clampWindowDays(args.windowDays);
    const dateParam = `-${windowDays} days`;

    const { rows } = await readD1<CostDriftRow>(env, SQL, [dateParam, dateParam, RESULT_CAP]);

    // shapePriceRow: QSC runs dynamic pricing, so a stored price of 0 is NOT
    // "free" — it means the price is computed at invoice time. D1 stores a
    // literal 0 for 16,322 of 16,543 pb_materials rows, so an unshaped
    // `price: r.price` reported almost the whole pricebook as $0. The shaper
    // maps 0 -> null and tags every row with price_basis. `cost` is a real
    // vendor cost and is deliberately not a price field, so it survives as-is.
    const items = rows.map((r) =>
      shapePriceRow({
        id: r.id,
        code: r.code,
        name: r.name,
        kind: r.kind,
        category: r.category_name && r.category_name.trim() !== '' ? r.category_name : 'Uncategorized',
        cost: r.cost,
        price: r.price,
        updated_at: r.updated_at,
      }),
    );

    return {
      window_days: windowDays,
      count: items.length,
      items,
      _composite: 'pricebook_cost_drift',
      _source: 'd1',
      _note:
        'updated_at is ST modifiedOn (any-field change), so this surfaces recently-MODIFIED cost-bearing ' +
        'items, not verified cost changes — true old→new cost delta needs a cost-history snapshot (deferred).',
    };
  },
  transformResult: defaultShaper,
};
