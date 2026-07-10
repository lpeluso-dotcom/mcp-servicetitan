// ============================================================
// search_pricebook_services
//
// QUA-267 finding 2 (2026-05-26): added `code` parameter for exact-code
// lookup. Pre-fix, callers like Dawn that passed a service code as
// `name` (e.g. "P1HL22") got fuzzy-matched against unrelated services
// (HV-RES-ST topped the result list for "P1HL22"). Now: when `code`
// is provided, we short-circuit to a D1 exact lookup via
// servicetitan-proxy with codeVariants(); only fall back to fuzzy live
// ST if D1 has no row.
// ============================================================

import { z } from 'zod';
import { readST } from '../../st';
import { codeVariants } from './search_pricebook_all';
import { queryD1First } from '../../d1-proxy';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const TENANT_ID = '000000000';

const SQL_BY_CODE = `SELECT
  id, code, name, description, category_name, price, member_price, hours,
  is_labor, material_cost, active, cost, use_static_prices, calculated_price,
  addon_price, addon_member_price, taxable, account
FROM pb_services
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
        { correlation, tag: 'search_pricebook_services:by_code' },
      );
      if (row) return { ...row, _matched_code: variant };
    } catch {
      // Best-effort — fall through to next variant / live ST on any error.
    }
  }
  return null;
}

export const search_pricebook_services: ToolDef<Args> = {
  name: 'search_pricebook_services',
  description:
    'Search pricebook services by exact `code` (e.g. "WHEH-140", "P1HL22"), or fuzzy `name`/category. ' +
    'Exact-code path hits D1 directly (sub-100ms) and short-circuits on hit. ' +
    'Fuzzy path falls through to live ST. ' +
    'Source: D1 for exact code (fresh nightly); live ST for name/category fuzzy. Default page size 50, max 200.',
  zodSchema: {
    code: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Exact pricebook code (e.g. "WHEH-140"). Wins over `name` if both provided. Tries the raw value, UPPERCASE, and UPPERCASE-hyphenated variants in order.',
      ),
    name: z.string().optional().describe('Service name or token (partial match against live ST)'),
    categoryId: z.number().int().positive().optional().describe('Filter by category ID'),
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/services', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    // Exact-code path (D1) — try first, return early on hit.
    if (args.code) {
      const exact = await lookupExactCode(env, args.code, correlation);
      if (exact) {
        return { services: [exact], _source: 'd1-exact', _matched_code: args.code };
      }
      // No D1 row — fall through to live ST with the code as a fuzzy name token.
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
      `/pricebook/v2/tenant/${TENANT_ID}/services`,
      query,
    );
    return { services: data.data ?? [], _source: 'live' };
  },
  transformResult: defaultShaper,
};
