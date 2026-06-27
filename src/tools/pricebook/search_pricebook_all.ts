// ============================================================
// search_pricebook_all — Dawn-tier pricebook lookup
//
// Adapter for a Retell agent. Replaces the
// `validate_pricebook` HTTP tool on sentry-quinn that searches all
// three pb_* D1 tables (services, materials, equipment) in one shot.
//
// Why this exists vs the typed search_pricebook_services /
// search_materials tools: Dawn's flow expects a single merged result
// across the three pricebook surfaces, ranked by price desc, with a
// `type` discriminator on each row. The typed tools split per surface
// and hit live ST. This tool reads D1 directly via servicetitan-proxy's
// /api/sql/read proxy — much faster (sub-100ms typical) for voice.
// ============================================================
import { z } from 'zod';
import { McpError } from '../../errors';
import { queryD1 as d1ProxyQuery } from '../../d1-proxy';
import type { Env } from '../../env';
import type { ToolDef } from '../index';

interface Args {
  code?: string;
  query?: string;
}

interface PricebookItem {
  code: string;
  name: string;
  description: string;
  category: string;
  price: number;
  member_price: number | null;
  // Estimated labor hours for services + equipment (decimal: 0.75 = 45 min, 1.5 = 90 min).
  // NULL for materials (no labor attached) and for items where ST has no value set.
  hours: number | null;
  type: 'service' | 'material' | 'equipment';
  // ST's most-recent computed sell price for services (dynamic pricing).
  // NULL for materials/equipment — only pb_services has this column.
  calculated_price: number | null;
}

const SQL_BY_CODE_SVC =
  `SELECT code, name, description, category_name as category, price, member_price, hours, calculated_price, 'service' as type
   FROM pb_services WHERE code = ? LIMIT 1`;
const SQL_BY_CODE_MAT =
  `SELECT code, name, description, category_name as category, cost as price, NULL as member_price, NULL as hours, NULL as calculated_price, 'material' as type
   FROM pb_materials WHERE code = ? LIMIT 1`;
const SQL_BY_CODE_EQUIP =
  `SELECT code, name, description, category_name as category, price, member_price, hours, NULL as calculated_price, 'equipment' as type
   FROM pb_equipment WHERE code = ? LIMIT 1`;

const SQL_BY_NAME_SVC =
  `SELECT code, name, description, category_name as category, price, member_price, hours, calculated_price, 'service' as type
   FROM pb_services WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category_name LIKE ?)
   ORDER BY COALESCE(calculated_price, price) DESC LIMIT 5`;
const SQL_BY_NAME_MAT =
  `SELECT code, name, description, category_name as category, cost as price, NULL as member_price, NULL as hours, NULL as calculated_price, 'material' as type
   FROM pb_materials WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category_name LIKE ?)
   ORDER BY cost DESC LIMIT 3`;
const SQL_BY_NAME_EQUIP =
  `SELECT code, name, description, category_name as category, price, member_price, hours, NULL as calculated_price, 'equipment' as type
   FROM pb_equipment WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category_name LIKE ?)
   ORDER BY price DESC LIMIT 3`;

/**
 * Generate code variants to try in order. Spoken input like "flu150" resolves
 * to "FLU-150" via the uppercase+hyphen step. Variants are deduped to skip
 * redundant queries when the input is already in canonical form.
 */
export function codeVariants(raw: string): string[] {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  const hyphenated = upper.replace(/^([A-Z]+)(\d.*)$/, '$1-$2');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [trimmed, upper, hyphenated]) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// queryD1 now lives in src/d1-proxy.ts with retry + classification + correlation.
// Local alias preserves the original signature so the rest of this file
// reads the same.
function queryD1(
  env: Env,
  sql: string,
  params: unknown[],
  correlation?: string,
): Promise<PricebookItem[]> {
  return d1ProxyQuery<PricebookItem>(env, sql, params, {
    correlation,
    tag: 'search_pricebook_all',
  });
}

const withPricing = (r: PricebookItem) => ({
  ...r,
  // Preserve the numeric `price` contract: never null for a null-price
  // service. Dawn/Retell may read `price` as a number; honesty about
  // dynamic pricing now comes from calculated_price + pricing.
  price: r.price ?? 0,
  member_price: r.member_price ?? null,
  description: r.description ?? '',
  category: r.category ?? '',
  calculated_price: r.calculated_price ?? null,
  pricing: r.type === 'material'
    ? 'cost'
    : (r.calculated_price != null ? 'dynamic' : (r.price ? 'static' : 'dynamic-unknown')),
});

export const search_pricebook_all: ToolDef<Args> = {
  name: 'search_pricebook_all',
  description:
    'Search ServiceTitan pricebook across services, materials, and equipment in one call. Use code for an exact lookup, or query for fuzzy name/description/category matching. Returns up to 8 items ranked by price descending, each with a type discriminator (service/material/equipment), member_price where applicable, and `hours` (estimated labor in decimal hours: 0.75 = 45 min, 1.5 = 90 min) on services + equipment. Materials return hours = null (no labor attached). When asked about time/duration/how long, surface `hours` — do NOT say the data is missing. Source: D1 (pb_services / pb_materials / pb_equipment via servicetitan-proxy). Sub-100ms typical. PRICE CAVEAT: QSC prices dynamically — price 0/null does NOT mean free or unpriced. When present, calculated_price is ST\'s most-recent computed sell; the pricing flag marks each item static|dynamic|cost|dynamic-unknown. Never tell the user an item is unpriced.',
  stEndpoint: { method: 'GET', path: 'd1://pb_services+pb_materials+pb_equipment', source: 'd1' },
  zodSchema: {
    code: z.string().optional().describe('Exact pricebook code (e.g. "HUM-120"). Wins over query if both provided.'),
    query: z.string().min(1).max(100).optional().describe('Free-text term to fuzzy-match against name, description, or category. Tech slang should be translated by the caller (e.g. "Navien" → "tankless water heater").'),
  },
  async handler(env, args, { correlation }) {
    const code = args.code?.trim();
    const query = args.query?.trim();

    if (!code && !query) {
      throw new McpError(
        'validation_error',
        'search_pricebook_all requires either `code` (exact lookup) or `query` (fuzzy search).',
        { correlation }
      );
    }

    try {
      // Code path — exact match across all 3 tables, return first hit.
      // Tries code variants in order so spoken/typed input "flu150" resolves
      // to the canonical "FLU-150" without the caller having to format it:
      //   1. raw          (flu150)
      //   2. UPPERCASE    (FLU150)
      //   3. UPPER + hyphen between letter prefix + digit suffix (FLU-150)
      if (code) {
        const variants = codeVariants(code);
        for (const variant of variants) {
          for (const sql of [SQL_BY_CODE_SVC, SQL_BY_CODE_MAT, SQL_BY_CODE_EQUIP]) {
            const rows = await queryD1(env, sql, [variant], correlation);
            if (rows.length > 0) {
              return {
                status: 'success',
                count: rows.length,
                matched_code: variant,
                items: rows.map(withPricing),
                _source: 'd1',
              };
            }
          }
        }
        return { status: 'not_found', message: `No pricebook item with code "${code}" (also tried ${variants.slice(1).join(', ')}).`, count: 0, items: [], _source: 'd1' };
      }

      // Query path — fuzzy search across all 3 tables, merge + rank by price desc, top 8
      const q = `%${query}%`;
      const [services, materials, equipment] = await Promise.all([
        queryD1(env, SQL_BY_NAME_SVC, [q, q, q], correlation),
        queryD1(env, SQL_BY_NAME_MAT, [q, q, q], correlation),
        queryD1(env, SQL_BY_NAME_EQUIP, [q, q, q], correlation),
      ]);

      const merged = [...services, ...materials, ...equipment]
        .map(withPricing)
        .sort((a, b) => ((b.calculated_price ?? b.price) || 0) - ((a.calculated_price ?? a.price) || 0))
        .slice(0, 8);

      if (merged.length === 0) {
        return { status: 'not_found', message: `Nothing found for "${query}". Try a different term.`, count: 0, items: [], _source: 'd1' };
      }

      return { status: 'success', count: merged.length, items: merged, _source: 'd1' };
    } catch (err) {
      throw new McpError('upstream_error', `search_pricebook_all failed: ${(err as Error).message}`, { correlation });
    }
  },
};
