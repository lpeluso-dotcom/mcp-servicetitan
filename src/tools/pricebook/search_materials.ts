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
import { readST, rejectUnsupportedSTFilters } from '../../st';
import { codeVariants } from './search_pricebook_all';
import { queryD1First } from '../../d1-proxy';
import { stampMirrorFreshness, fetchTableMax } from '../../mirror-freshness';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const TENANT_ID = '000000000';

const SQL_BY_CODE = `SELECT
  id, code, name, description, category_name, price, member_price, cost,
  active, unit_of_measure, taxable, account, primary_vendor_name,
  primary_vendor_id, is_inventory, synced_at
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
    'Look up pricebook materials by exact `code` (e.g. "PRV-075") against D1 (sub-100ms), ' +
    'or list them live via `active`/`page`/`pageSize`. ' +
    'For fuzzy name/description matching use search_pricebook_all({query}) instead — ServiceTitan has ' +
    'no name or category filter on this endpoint and silently ignores both (QUA-951), so passing them ' +
    'would return an unfiltered first page that looks like matches. ' +
    'Source: D1 for exact code (may be stale; a code miss returns an honest empty, not a live page); live ST for plain listing. Default page size 50, max 200.',
  zodSchema: {
    code: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Exact material code (e.g. "PRV-075"). Tries the raw value, UPPERCASE, and UPPERCASE-hyphenated variants in order. Returns empty if no such code exists.',
      ),
    name: z
      .string()
      .optional()
      .describe('NOT SUPPORTED by ServiceTitan on this endpoint — passing it returns a validation error. Use search_pricebook_all({query}).'),
    categoryId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('NOT SUPPORTED by ServiceTitan on this endpoint — passing it returns a validation error. Filter client-side against list_service_categories.'),
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/materials', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    // QUA-951 / F-09: verified live 2026-08-04 — `name` and `categoryId` are
    // discarded by ST on /pricebook/v2/tenant/{tid}/materials (only `active`
    // and `ids` are honoured). Forwarding them returned an unfiltered first
    // page that looked like matches. Reject rather than return wrong data.
    rejectUnsupportedSTFilters(
      args as unknown as Record<string, unknown>,
      {
        name:
          'ServiceTitan has no name filter on /pricebook/v2/tenant/{tid}/materials. ' +
          'Use search_pricebook_all({query}) for fuzzy name/description matching, or ' +
          'pass `code` here for an exact-code lookup.',
        categoryId:
          'ServiceTitan has no categoryId filter on /pricebook/v2/tenant/{tid}/materials. ' +
          'Page the catalogue and filter client-side against list_service_categories.',
      },
      correlation,
    );

    if (args.code) {
      // Table-level freshness probe (F1 redesign) — concurrent with the code
      // lookup; never rejects (degrades to {}).
      const tableMaxP = fetchTableMax(env, ['pb_materials']);
      const exact = await lookupExactCode(env, args.code, correlation);
      if (exact) {
        // MB-1 / QUA-1141: this serves a raw pb_materials mirror row — stamp
        // it so a hit off a frozen mirror is disclosed instead of served
        // silently. Freshness is judged by the TABLE's MAX(synced_at): the
        // row's own synced_at only says when the row itself last changed.
        // synced_at is stamp plumbing, stripped from the emitted row.
        const { synced_at: _synced_at, ...material } = exact as Record<string, unknown>;
        return {
          materials: [material],
          _source: 'd1-exact',
          _matched_code: args.code,
          ...stampMirrorFreshness([exact], { table: 'pb_materials', tableMax: await tableMaxP }),
        };
      }
      // QUA-951 / F-09: no D1 row. This used to fall through to live ST with
      // `name=<code>` — a parameter ST ignores — so an unknown code came back
      // as an unfiltered page of ~50 arbitrary materials that looked like
      // matches. There is no server-side code filter to fall back to, so the
      // honest answer to "no such code" is an empty result.
      return {
        materials: [],
        _source: 'd1-exact',
        _matched_code: null,
        _note: `No pricebook material found with code "${args.code}". Tried variants: ${codeVariants(args.code).join(', ')}. For fuzzy matching use search_pricebook_all({query}).`,
        ...stampMirrorFreshness([], { table: 'pb_materials', tableMax: await fetchTableMax(env, ['pb_materials']) }),
      };
    }

    // Plain listing — only ST-honoured params (active/page/pageSize).
    const query: Record<string, unknown> = {
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
  transformResult: defaultShaper,
};
