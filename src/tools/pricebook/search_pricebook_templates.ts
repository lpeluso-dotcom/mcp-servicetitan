// ============================================================
// search_pricebook_templates — natural-language search over QSC estimate
// templates + proposals (Supabase search_templates RPC, migration 0015).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, shapePriceRow } from '../../supabase';
import { goldAsOf } from '../../gold-watermark';

interface Args { query: string; limit?: number; }

export const search_pricebook_templates: ToolDef<Args> = {
  name: 'search_pricebook_templates',
  description:
    'Search QSC estimate templates and proposals by name/keyword. Returns template & proposal hits ' +
    'with item counts, tier/proposal context, and a reference total. ' +
    'Note: total_price_ref may be null — QSC uses dynamic pricing computed at invoice time. ' +
    'Returns up to `limit` matches (default 12, max 25).',
  zodSchema: {
    query: z.string().min(1).max(300).describe('Template or proposal name/keyword'),
    limit: z.number().int().min(1).max(25).default(12).optional().describe('Max results (default 12, max 25)'),
  },
  async handler(env: Env, args: Args) {
    const limit = Math.min(args.limit ?? 12, 25);
    const [rows, asOf] = await Promise.all([
      sbRpc<Array<Record<string, unknown>>>(env, 'search_templates', {
        query_text: args.query, limit_rows: limit,
      }),
      goldAsOf(env, 'pricebook_templates'),
    ]);
    return {
      results: (rows ?? []).map((r) => shapePriceRow(r)),
      query: args.query,
      _source: 'supabase',
      ...asOf,
    };
  },
};
