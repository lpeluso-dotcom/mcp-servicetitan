// ============================================================
// search_pricebook_all — Dawn-tier pricebook lookup
//
// Adapter for QSC's Miss Dawn (Retell agent). Replaces the
// `validate_pricebook` HTTP tool on sentry-quinn that searches all
// three pb_* D1 tables (services, materials, equipment) in one shot.
//
// Why this exists vs the typed search_pricebook_services /
// search_materials tools: Dawn's flow expects a single merged result
// across the three pricebook surfaces, ranked by price desc, with a
// `type` discriminator on each row. The typed tools split per surface
// and hit live ST. This tool reads D1 directly via taylor-ai's
// /api/sql/read proxy — much faster (sub-100ms typical) for voice.
// ============================================================
import { z } from 'zod';
import { McpError } from '../../errors';
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
  type: 'service' | 'material' | 'equipment';
}

const SQL_BY_CODE_SVC =
  `SELECT code, name, description, category_name as category, price, member_price, 'service' as type
   FROM pb_services WHERE code = ? LIMIT 1`;
const SQL_BY_CODE_MAT =
  `SELECT code, name, description, category_name as category, cost as price, NULL as member_price, 'material' as type
   FROM pb_materials WHERE code = ? LIMIT 1`;
const SQL_BY_CODE_EQUIP =
  `SELECT code, name, description, category_name as category, price, member_price, 'equipment' as type
   FROM pb_equipment WHERE code = ? LIMIT 1`;

const SQL_BY_NAME_SVC =
  `SELECT code, name, description, category_name as category, price, member_price, 'service' as type
   FROM pb_services WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category_name LIKE ?)
   ORDER BY price DESC LIMIT 5`;
const SQL_BY_NAME_MAT =
  `SELECT code, name, description, category_name as category, cost as price, NULL as member_price, 'material' as type
   FROM pb_materials WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category_name LIKE ?)
   ORDER BY cost DESC LIMIT 3`;
const SQL_BY_NAME_EQUIP =
  `SELECT code, name, description, category_name as category, price, member_price, 'equipment' as type
   FROM pb_equipment WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category_name LIKE ?)
   ORDER BY price DESC LIMIT 3`;

async function queryD1(env: Env, sql: string, params: unknown[]): Promise<PricebookItem[]> {
  const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/sql/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': env.MCP_SYNC_KEY },
    body: JSON.stringify({ sql, params }),
  });
  if (!resp.ok) throw new Error(`d1 read failed: ${resp.status}`);
  const data = (await resp.json()) as { success: boolean; results?: PricebookItem[]; error?: string };
  if (!data.success) throw new Error(data.error || 'd1 read returned success=false');
  return data.results ?? [];
}

export const search_pricebook_all: ToolDef<Args> = {
  name: 'search_pricebook_all',
  description:
    'Search QSC pricebook across services, materials, and equipment in one call. Use code for an exact lookup, or query for fuzzy name/description/category matching. Returns up to 8 items ranked by price descending, each with a type discriminator (service/material/equipment) and member_price where applicable. Source: D1 (pb_services / pb_materials / pb_equipment via taylor-ai). Tuned for QSC Miss Dawn (sub-100ms typical).',
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
      // Code path — exact match across all 3 tables, return first hit
      if (code) {
        for (const sql of [SQL_BY_CODE_SVC, SQL_BY_CODE_MAT, SQL_BY_CODE_EQUIP]) {
          const rows = await queryD1(env, sql, [code]);
          if (rows.length > 0) {
            return {
              status: 'success',
              count: rows.length,
              items: rows.map((r) => ({ ...r, member_price: r.member_price ?? null, description: r.description ?? '', category: r.category ?? '' })),
              _source: 'd1',
            };
          }
        }
        return { status: 'not_found', message: `No pricebook item with code "${code}".`, count: 0, items: [], _source: 'd1' };
      }

      // Query path — fuzzy search across all 3 tables, merge + rank by price desc, top 8
      const q = `%${query}%`;
      const [services, materials, equipment] = await Promise.all([
        queryD1(env, SQL_BY_NAME_SVC, [q, q, q]),
        queryD1(env, SQL_BY_NAME_MAT, [q, q, q]),
        queryD1(env, SQL_BY_NAME_EQUIP, [q, q, q]),
      ]);

      const merged = [...services, ...materials, ...equipment]
        .map((r) => ({ ...r, member_price: r.member_price ?? null, description: r.description ?? '', category: r.category ?? '', price: r.price ?? 0 }))
        .sort((a, b) => (b.price || 0) - (a.price || 0))
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
