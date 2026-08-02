// ============================================================
// pricebook_markup_drift — margin-discipline composite (QUA-739).
//
// Flags materials + equipment whose markup ((price-cost)/cost) deviates
// from their category's median markup by more than `threshold`. SQLite
// has no MEDIAN() aggregate, so the per-category median is computed in TS
// after pulling every computable (cost>0 AND price>0) row. Also surfaces
// two margin-risk populations that aren't "markup outliers" in the
// statistical sense but are real margin exposure:
//   - equipment with cost>0 but price=0 — equipment is ALWAYS static-priced
//     in ServiceTitan, so this is unbilled cost, not a pricing choice
//     (live-probed 2026-07-09: 140 active rows).
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
import { stampMirrorFreshness } from '../../mirror-freshness';
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
  // Feeds the freshness stamp only — never emitted on outlier rows.
  synced_at: string | null;
}

interface EquipmentNoPriceRow {
  id: number;
  code: string | null;
  name: string | null;
  cost: number;
  synced_at: string | null;
}

interface CountRow {
  cnt: number;
  // MAX(synced_at) — COUNT(*) aggregates row age away, so the count query
  // carries its own freshness evidence (tech_scorecard pattern).
  synced_at: string | null;
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
const MARKUP_SQL = `SELECT m.id, m.code, m.name, c.name AS category_name, m.cost, m.price, 'material' AS kind, m.synced_at
   FROM pb_materials m
   LEFT JOIN pb_categories c ON c.id = json_extract(m.categories_json, '$[0]')
   WHERE m.active = 1 AND m.cost > 0 AND m.price > 0
   UNION ALL
   SELECT e.id, e.code, e.name, c.name AS category_name, e.cost, e.price, 'equipment' AS kind, e.synced_at
   FROM pb_equipment e
   LEFT JOIN pb_categories c ON c.id = json_extract(e.categories_json, '$[0]')
   WHERE e.active = 1 AND e.cost > 0 AND e.price > 0`;

const EQUIPMENT_COST_NO_PRICE_SQL = `SELECT id, code, name, cost, synced_at
   FROM pb_equipment
   WHERE active = 1 AND cost > 0 AND price = 0
   ORDER BY cost DESC`;

// COUNT(*) aggregates synced_at away — carry MAX(synced_at) alongside the
// count so this query can still vouch for the mirror's age (MB-1 / QUA-1141,
// same fix as tech_scorecard's GROUP BY).
const MATERIAL_PLACEHOLDER_COUNT_SQL = `SELECT COUNT(*) AS cnt, MAX(synced_at) AS synced_at
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
    'with cost>0 but price=0 (equipment is ALWAYS static-priced in ServiceTitan, so this is unbilled-cost ' +
    'exposure, not a pricing choice) and a count of material (cost=0,price=0) placeholders. Use before a ' +
    'margin review, after a vendor cost update, or when spot-checking pricebook pricing drift. ' +
    'DYNAMIC-PRICING NOTE: QSC prices every active service dynamically at invoice time (use_static_prices=0 ' +
    'fleet-wide) — a service’s 0 price/cost is by design, not a markup problem, so services are excluded ' +
    'entirely and this composite never queries pb_services. Source: D1 pb_materials + pb_equipment.',
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

    // synced_at feeds the stamp below; keep it off the emitted risk rows.
    let marginRisk: Record<string, unknown> | undefined;
    let riskRows: Array<{ synced_at: string | null }> = [];
    if (includeMarginRisk) {
      const [equipNoPrice, placeholders] = await Promise.all([
        readD1<EquipmentNoPriceRow>(env, EQUIPMENT_COST_NO_PRICE_SQL, []),
        readD1<CountRow>(env, MATERIAL_PLACEHOLDER_COUNT_SQL, []),
      ]);
      riskRows = [...equipNoPrice.rows, ...placeholders.rows];
      marginRisk = {
        equipmentCostNoPrice: equipNoPrice.rows.slice(0, EXAMPLE_CAP).map(({ synced_at: _, ...r }) => r),
        equipmentCostNoPriceCount: equipNoPrice.rows.length,
        materialPlaceholderCount: placeholders.rows[0]?.cnt ?? 0,
      };
    }

    // MB-1 / QUA-1141: one stamp across everything read from both tables —
    // the placeholder COUNT row contributes via its MAX(synced_at), so even a
    // zero-computable-rows run can prove the mirror is alive.
    const freshness = stampMirrorFreshness([...rows, ...riskRows], { table: 'pb_materials+pb_equipment' });

    return {
      filters: { threshold, minCategoryPeers, includeMarginRisk },
      summary: {
        items_examined: rows.length,
        categories_examined: categoriesExamined,
        categories_skipped_insufficient_peers: categoriesSkipped,
        outliers_found: outliersFound,
        metrics_are_authoritative: freshness._freshness === 'fresh',
      },
      outliers: outliersCapped,
      marginRisk,
      _composite: 'pricebook_markup_drift',
      _source: 'd1',
      ...freshness,
      _note:
        'Services are excluded entirely: QSC prices every active service dynamically at invoice time ' +
        '(use_static_prices=0 fleet-wide), so a service’s 0 price/cost is by design, not a markup gap. ' +
        'Markup math applies only to materials + equipment. Equipment with cost>0/price=0 is surfaced ' +
        'separately in marginRisk (unbilled-cost exposure) because equipment is always static-priced.',
    };
  },
  transformResult: defaultShaper,
};
