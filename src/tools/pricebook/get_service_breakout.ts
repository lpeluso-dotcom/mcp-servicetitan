// ============================================================
// get_service_breakout — a service's labor + component materials/equipment,
// plus recommendation/upgrade links. Reads the service's jsonb link columns
// (migration 0009) then resolves component items in one batch st_id=in.() select.
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbSelect, shapePriceRow } from '../../supabase';
import { goldAsOf } from '../../gold-watermark';

interface Args { code: string; }

type Row = Record<string, unknown>;
const LINK_COLS = ['service_materials', 'service_equipment', 'recommendations', 'upgrades'] as const;

function skuIds(row: Row): number[] {
  const ids = new Set<number>();
  for (const col of LINK_COLS) {
    const arr = row[col];
    if (Array.isArray(arr)) for (const e of arr) {
      const id = (e as { skuId?: number })?.skuId;
      if (typeof id === 'number') ids.add(id);
    }
  }
  return [...ids];
}

const SELECT_COLS =
  'st_id,code,name,description,item_type,category_name,st_price,member_price,cost,labor_hours,material_cost,unit_of_measure,primary_vendor_name,primary_vendor_part_number,service_materials,service_equipment,recommendations,upgrades';

export const get_service_breakout: ToolDef<Args> = {
  name: 'get_service_breakout',
  description:
    'Break out a pricebook service into its labor plus component materials and equipment, with ' +
    'recommended add-ons and upgrade options. Pass the service `code`. ' +
    'Note: prices may be null — QSC uses dynamic pricing computed at invoice time.',
  zodSchema: {
    code: z.string().min(1).max(64).describe('Service code (e.g. "SVC-1")'),
  },
  async handler(env: Env, args: Args) {
    const [svcRows, asOf] = await Promise.all([
      sbSelect<Row[]>(
        env, `pricebook_items?code=eq.${encodeURIComponent(args.code)}&item_type=eq.service&select=${SELECT_COLS}&limit=1`,
      ),
      goldAsOf(env, 'pricebook'),
    ]);
    const svc = svcRows?.[0];
    // The miss path needs the stamp MORE than the hit path, not less: "not
    // found" from a frozen mirror and "not found" from a current one are the
    // same three words, and only one of them means the item does not exist.
    if (!svc) return { service: null, not_found: true, _source: 'supabase', ...asOf };

    const ids = skuIds(svc);
    let components: Row[] = [];
    if (ids.length) {
      components = await sbSelect<Row[]>(
        env, `pricebook_items?st_id=in.(${ids.join(',')})&select=${SELECT_COLS}`,
      );
    }
    const byId = new Map(components.map((c) => [c.st_id as number, shapePriceRow(c)]));
    const pick = (col: typeof LINK_COLS[number]) =>
      (Array.isArray(svc[col]) ? (svc[col] as Array<{ skuId?: number }>) : [])
        .map((e) => byId.get(e.skuId as number)).filter(Boolean);

    return {
      service: shapePriceRow(svc),
      materials: pick('service_materials'),
      equipment: pick('service_equipment'),
      recommendations: pick('recommendations'),
      upgrades: pick('upgrades'),
      _source: 'supabase',
      ...asOf,
    };
  },
};
