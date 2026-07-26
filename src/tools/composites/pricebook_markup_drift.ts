// ============================================================
// pricebook_markup_drift — margin-discipline composite (QUA-739).
//
// Flags materials + equipment whose markup ((price-cost)/cost) deviates
// from their category's median markup by more than `threshold`. SQLite
// has no MEDIAN() aggregate, so the per-category median is computed in TS
// after pulling every computable (cost>0 AND price>0) row. Also surfaces
// two margin-risk populations that aren't "markup outliers" in the
// statistical sense but are real margin exposure:
//   - equipment with cost>0 but price=0 — a TRIAGE list, not a finding
//     (live-probed 2026-07-09: 140 active rows).
//     ⚠ CORRECTED 2026-07-26: this used to read "equipment is ALWAYS
//     static-priced in ServiceTitan, so this is unbilled cost, not a
//     pricing choice". That was false — equipment simply has no
//     useStaticPrices field, and the leap from "no flag" to "always
//     static" was never verified. A 0 price does NOT mean the item bills
//     at $0: most such rows are either wired into a dynamically-priced
//     service kit / template line, or are unwired vendor-import catalog
//     rows. The old wording made this composite's output read as dollar
//     exposure and produced a false production-impact ticket (QUA-970,
//     canceled). Emit the count; let the caller trace each row.
//   - materials sitting at (cost=0, price=0) placeholders — surfaced as a
//     COUNT only (2,074 rows live-probed — too many to usefully inline).
//
// HARD RULE: QSC prices every active service dynamically at invoice time
// (use_static_prices=0 fleet-wide, live-verified 2026-07-09 — 0 of 2,804
// active services are static). A service's 0 price/cost is BY DESIGN, not
// a data problem, so services are excluded entirely — this composite never
// queries pb_services and never computes a service markup.
//
// Source: D1 (pb_materials + pb_equipment, category names via pb_categories)
// through servicetitan-proxy /api/sql/read.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  threshold?: number;
  minCategoryPeers?: number;
  includeMarginRisk?: boolean;
}

interface MarkupRow {
  id: number;
  code: string | null;
  name: string | null;
  category_name: string | null;
  cost: number;
  price: number;
  kind: 'material' | 'equipment';
}

interface EquipmentNoPriceRow {
  id: number;
  code: string | null;
  name: string | null;
  cost: number;
}

interface CountRow {
  cnt: number;
}

interface OutlierRow {
  id: number;
  code: string | null;
  name: string | null;
  kind: 'material' | 'equipment';
  category: string;
  cost: number;
  price: number;
  markup: number;
  category_median: number;
  deviation: number;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_CATEGORY_PEERS = 5;
const EXAMPLE_CAP = 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The `category_name` COLUMN is empty fleet-wide (live-probed 2026-07-09:
// 0 of 208 markup-computable materials populate it). The real category
// linkage is `categories_json` (a JSON id array, populated on 207/208) ->
// pb_categories.name. We resolve the primary category (categories_json[0])
// via json_extract + LEFT JOIN so grouping is genuinely category-relative;
// items whose join misses fall to 'Uncategorized' in the handler.
const MARKUP_SQL = `SELECT m.id, m.code, m.name, c.name AS category_name, m.cost, m.price, 'material' AS kind
   FROM pb_materials m
   LEFT JOIN pb_categories c ON c.id = json_extract(m.categories_json, '$[0]')
   WHERE m.active = 1 AND m.cost > 0 AND m.price > 0
   UNION ALL
   SELECT e.id, e.code, e.name, c.name AS category_name, e.cost, e.price, 'equipment' AS kind
   FROM pb_equipment e
   LEFT JOIN pb_categories c ON c.id = json_extract(e.categories_json, '$[0]')
   WHERE e.active = 1 AND e.cost > 0 AND e.price > 0`;

const EQUIPMENT_COST_NO_PRICE_SQL = `SELECT id, code, name, cost
   FROM pb_equipment
   WHERE active = 1 AND cost > 0 AND price = 0
   ORDER BY cost DESC`;

const MATERIAL_PLACEHOLDER_COUNT_SQL = `SELECT COUNT(*) AS cnt
   FROM pb_materials
   WHERE active = 1 AND cost = 0 AND price = 0`;

export const pricebook_markup_drift: ToolDef<Args> = {
  name: 'pricebook_markup_drift',
  description:
    'Margin-discipline audit: flags active materials + equipment whose markup ((price-cost)/cost) deviates ' +
    'from its own category’s median markup by more than `threshold` (default 0.5 = 50 points). Groups by ' +
    'category_name; a category only gets flagged once it has >= minCategoryPeers computable (cost>0 AND ' +
    'price>0) items, so a single wild item in a thin category can’t skew a "median" that isn’t statistically ' +
    'meaningful. Also surfaces two margin-risk populations when includeMarginRisk=true (default): equipment ' +
    'with cost>0 but price=0 and a count of material (cost=0,price=0) placeholders. Use before a ' +
    'margin review, after a vendor cost update, or when spot-checking pricebook pricing drift. ' +
    'DYNAMIC-PRICING NOTE: QSC prices every active service dynamically at invoice time (use_static_prices=0 ' +
    'fleet-wide) — a service’s 0 price/cost is by design, not a markup problem, so services are excluded ' +
    'entirely and this composite never queries pb_services. ' +
    '⚠ equipmentCostNoPrice IS A TRIAGE LIST, NOT DOLLAR EXPOSURE. Do not report its rows as "unbilled cost" ' +
    'or "these invoice at $0". Equipment has no useStaticPrices field, but that does NOT make it always ' +
    'statically priced — a 0 price is normal, and such rows are usually either wired into a dynamically-priced ' +
    'service kit / template line, or unwired vendor-import catalog rows. Trace each row (find_packages_with_item) ' +
    'before escalating. This tool’s earlier "equipment is ALWAYS static-priced" wording caused a false ' +
    'production-impact ticket (QUA-970, canceled 2026-07-26). Source: D1 pb_materials + pb_equipment.',
  stEndpoint: { method: 'GET', path: 'd1://pb_materials+pb_equipment+pb_categories', source: 'd1' },
  annotations: { readOnlyHint: true },
  zodSchema: {
    threshold: z
      .number()
      .positive()
      .optional()
      .describe(`Markup deviation threshold as a fraction (e.g. 0.5 = 50 percentage points). Default ${DEFAULT_THRESHOLD}.`),
    minCategoryPeers: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Minimum number of computable items a category needs before its median markup is trusted. Default ${DEFAULT_MIN_CATEGORY_PEERS}.`),
    includeMarginRisk: z
      .boolean()
      .optional()
      .describe('Include the equipmentCostNoPrice + materialPlaceholderCount risk populations. Default true.'),
  },
  async handler(env, args, { correlation: _correlation }) {
    const threshold = args.threshold ?? DEFAULT_THRESHOLD;
    const minCategoryPeers = args.minCategoryPeers ?? DEFAULT_MIN_CATEGORY_PEERS;
    const includeMarginRisk = args.includeMarginRisk ?? true;

    const { rows } = await readD1<MarkupRow>(env, MARKUP_SQL, []);

    const withMarkup = rows.map((r) => ({
      ...r,
      category: r.category_name && r.category_name.trim() !== '' ? r.category_name : 'Uncategorized',
      markup: (r.price - r.cost) / r.cost,
    }));

    const byCategory = new Map<string, typeof withMarkup>();
    for (const r of withMarkup) {
      const list = byCategory.get(r.category) ?? [];
      list.push(r);
      byCategory.set(r.category, list);
    }

    const outliers: OutlierRow[] = [];
    let categoriesExamined = 0;
    let categoriesSkipped = 0;

    for (const [category, items] of byCategory) {
      if (items.length < minCategoryPeers) {
        categoriesSkipped += 1;
        continue;
      }
      categoriesExamined += 1;
      const categoryMedian = median(items.map((i) => i.markup));
      for (const item of items) {
        const deviation = Math.abs(item.markup - categoryMedian);
        if (deviation > threshold) {
          outliers.push({
            id: item.id,
            code: item.code,
            name: item.name,
            kind: item.kind,
            category,
            cost: item.cost,
            price: item.price,
            markup: Number(item.markup.toFixed(4)),
            category_median: Number(categoryMedian.toFixed(4)),
            deviation: Number(deviation.toFixed(4)),
          });
        }
      }
    }

    outliers.sort((a, b) => b.deviation - a.deviation);
    const outliersFound = outliers.length;
    const outliersCapped = outliers.slice(0, EXAMPLE_CAP);

    let marginRisk: Record<string, unknown> | undefined;
    if (includeMarginRisk) {
      const [equipNoPrice, placeholders] = await Promise.all([
        readD1<EquipmentNoPriceRow>(env, EQUIPMENT_COST_NO_PRICE_SQL, []),
        readD1<CountRow>(env, MATERIAL_PLACEHOLDER_COUNT_SQL, []),
      ]);
      marginRisk = {
        equipmentCostNoPrice: equipNoPrice.rows.slice(0, EXAMPLE_CAP),
        equipmentCostNoPriceCount: equipNoPrice.rows.length,
        materialPlaceholderCount: placeholders.rows[0]?.cnt ?? 0,
      };
    }

    return {
      filters: { threshold, minCategoryPeers, includeMarginRisk },
      summary: {
        items_examined: rows.length,
        categories_examined: categoriesExamined,
        categories_skipped_insufficient_peers: categoriesSkipped,
        outliers_found: outliersFound,
      },
      outliers: outliersCapped,
      marginRisk,
      _composite: 'pricebook_markup_drift',
      _source: 'd1',
      _note:
        'Services are excluded entirely: QSC prices every active service dynamically at invoice time ' +
        '(use_static_prices=0 fleet-wide), so a service’s 0 price/cost is by design, not a markup gap. ' +
        'Markup math applies only to materials + equipment. Equipment with cost>0/price=0 is surfaced ' +
        'separately in marginRisk as a TRIAGE LIST — not dollar exposure. Equipment has no useStaticPrices ' +
        'field, but that does not make it always statically priced; a 0 price does not mean the item bills ' +
        'at $0. Such rows are usually wired into a dynamically-priced service kit / template line, or are ' +
        'unwired vendor-import catalog rows. Trace each row before treating it as unbilled cost.',
    };
  },
  transformResult: defaultShaper,
};
