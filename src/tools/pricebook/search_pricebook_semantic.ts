// ============================================================
// search_pricebook_semantic — hybrid (code + lexical + vector) search
// over the shared Supabase pricebook store. Embeds the query via Workers
// AI, then calls the search_pricebook_hybrid RPC (migration 0014).
// Natural-language OR code queries both work; embed failure degrades to
// lexical (query_embedding=null) — the RPC handles both.
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { embedQuery, sbRpc, shapePriceRow } from '../../supabase';
import { goldAsOf } from '../../gold-watermark';

interface Args { query: string; topK?: number; }

export const search_pricebook_semantic: ToolDef<Args> = {
  name: 'search_pricebook_semantic',
  description:
    'Semantic/hybrid search over the QSC pricebook — services, materials, equipment, fees. ' +
    'Use for natural-language descriptions ("replace capacitor on heat pump") or codes ("CAP-240"). ' +
    'Returns matches ranked by a fusion of exact-code, lexical, and vector similarity, with match_kind. ' +
    'Note: price may be null — QSC uses dynamic pricing computed at invoice time; never treat null as free. ' +
    'Returns up to topK matches (default 10, max 20).',
  zodSchema: {
    query: z.string().min(1).max(500).describe('Natural-language description or a pricebook code'),
    topK: z.number().int().min(1).max(20).default(10).optional().describe('Max results (default 10, max 20)'),
  },
  async handler(env: Env, args: Args) {
    const limit = Math.min(args.topK ?? 10, 20);
    const embedding = await embedQuery(env, args.query);
    const [rows, asOf] = await Promise.all([
      sbRpc<Array<Record<string, unknown>>>(env, 'search_pricebook_hybrid', {
        query_text: args.query,
        limit_rows: limit,
        query_embedding: embedding,     // null → lexical-only path in the RPC
        match_count: 50,
      }),
      goldAsOf(env, 'pricebook'),
    ]);
    return {
      matches: (rows ?? []).map((r) => shapePriceRow(r)),
      query: args.query,
      _source: 'supabase-hybrid',
      _embedded: embedding !== null,
      ...asOf,
    };
  },
};
