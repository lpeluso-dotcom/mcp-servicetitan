// ============================================================
// search_materials
//
// QUA-267 finding 2 (2026-05-26): added `code` parameter for exact-code
// lookup. pb_materials is stale in D1 (~23d as of 2026-04-22 note),
// but exact codes change rarely so D1 is still safe for the lookup —
// and we fall through to live ST if D1 doesn't have the code. Mirrors
// search_pricebook_services's shape.
// ============================================================

import { z } from 'zod';
import { readST } from '../../st';
import { codeVariants } from './search_pricebook_all';
import { queryD1First } from '../../d1-proxy';
import type { Env } from '../../env';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

const SQL_BY_CODE = `SELECT
  id, code, name, description, category_name, price, member_price, cost,
  active, unit_of_measure, taxable, account, primary_vendor_name,
  primary_vendor_id, is_inventory
FROM pb_materials
WHERE code = ?
LIMIT 1`;

interface Args {
  code?: string;
  name?: string;
  categoryId?: number;
  active?: boolean;
  page?: number;
  pageSize?: number;
}

async function lookupExactCode(
  env: Env,
  code: string,
  correlation?: string,
): Promise<unknown | null> {
  for (const variant of codeVariants(code)) {
    try {
      const row = await queryD1First<Record<string, unknown>>(
        env,
        SQL_BY_CODE,
        [variant],
        { correlation, tag: 'search_materials:by_code' },
      );
      if (row) return { ...row, _matched_code: variant };
    } catch {
      // Best-effort — fall through to next variant / live ST on any error.
    }
  }
  return null;
}

export const search_materials: ToolDef<Args> = {
  name: 'search_materials',
  description:
    'Search pricebook materials by exact `code` (e.g. "PRV-075"), or fuzzy `name`/category. ' +
    'Exact-code path hits D1 directly (sub-100ms) and short-circuits on hit. ' +
    'Fuzzy path falls through to live ST. ' +
    'Source: D1 for exact code (pb_materials may be stale; falls through to live ST on miss); live ST for name/category fuzzy.',
  zodSchema: {
    code: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Exact material code (e.g. "PRV-075"). Wins over `name` if both provided. Tries the raw value, UPPERCASE, and UPPERCASE-hyphenated variants in order.',
      ),
    name: z.string().optional().describe('Material name or token (partial match against live ST)'),
    categoryId: z.number().int().positive().optional().describe('Filter by category ID'),
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/materials', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (args.code) {
      const exact = await lookupExactCode(env, args.code, correlation);
      if (exact) {
        return { materials: [exact], _source: 'd1-exact', _matched_code: args.code };
      }
    }

    const query: Record<string, unknown> = {
      name: args.name ?? args.code,
      categoryId: args.categoryId,
      active: args.active,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/pricebook/v2/tenant/${TENANT_ID}/materials`,
      query,
    );
    return { materials: data.data ?? [], _source: 'live' };
  },
};
