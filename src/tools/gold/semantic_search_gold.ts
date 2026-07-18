// ============================================================
// semantic_search_gold — natural-language semantic search over the QSC
// gold warehouse vector index (Woz gold -> vec.entity_chunks, Supabase
// project nlaaliehqpgskjmiuzze). Embeds the query via Workers AI
// (bge-base-en-v1.5, 768-d) and calls the vec.match_entities RPC
// (qsc-vector migration 0005). Backs the forthcoming TAI-STV2 connector.
//
// Cross-entity — NOT pricebook-specific. Contrast with
// search_pricebook_semantic, which reads a DIFFERENT table
// (pricebook_items) in the SAME Supabase project via a DIFFERENT RPC
// (search_pricebook_hybrid, public schema). This tool spans all 12 Woz
// gold nouns (job, invoice_item, estimate, estimate_line, pricebook,
// pricebook_category, business_unit, job_type, lead_source, location,
// truck, membership) in the `vec` schema.
//
// Two gotchas verified LIVE against nlaaliehqpgskjmiuzze on 2026-07-18
// (curl against the deployed RPC, not just read from docs/notes):
//
//   1. `vec` is a non-public exposed schema
//      (`alter role authenticator set pgrst.db_schemas = 'public, gold,
//      vec'` — qsc-vector migration 0001). PostgREST resolves an
//      unqualified `/rpc/<fn>` call against the FIRST schema in that list
//      (`public`) unless the request carries `Content-Profile: vec`.
//      Omitting it 404s: `PGRST202 Could not find the function
//      public.match_entities`. sbRpc's optional 4th (schema) argument
//      sets this header — see src/supabase.ts.
//   2. PostgREST resolves this function by the EXACT set of provided
//      named args. Omitting p_grain/p_trade (even as explicit nulls)
//      silently breaks the p_entity_key filter — confirmed by a live A/B:
//      identical query + entity_key filter, only difference being
//      whether p_grain/p_trade were sent, empty result vs. correctly
//      filtered rows. ALWAYS send all five named params.
//
// Unlike search_pricebook_semantic, there is no lexical fallback:
// match_entities is pure cosine-similarity (no hybrid text branch in the
// SQL), so calling it with a null query_embedding would not error — it
// would return p_k rows in arbitrary order with similarity: null,
// dressed up as a ranked result. That's worse than failing loudly, so on
// embed failure this tool throws instead of degrading silently.
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { embedQuery, sbRpc } from '../../supabase';

const ENTITY_KEYS = [
  'job', 'invoice_item', 'estimate', 'estimate_line', 'pricebook',
  'pricebook_category', 'business_unit', 'job_type', 'lead_source',
  'location', 'truck', 'membership',
] as const;

interface Args {
  query: string;
  entity_key?: (typeof ENTITY_KEYS)[number];
  trade?: string;
  k?: number;
}

interface MatchRow {
  entity_key: string;
  source_key: string;
  content_text: string;
  grain: string | null;
  trade_bu: string | null;
  similarity: number;
}

export const semantic_search_gold: ToolDef<Args> = {
  name: 'semantic_search_gold',
  description:
    'Natural-language semantic search over the QSC gold warehouse vector index (Woz gold — jobs, invoice line items, ' +
    'estimates, estimate lines, pricebook items, pricebook categories, business units, job types, lead sources, ' +
    'locations, trucks, memberships). Embeds the query and returns the closest content chunks ranked by cosine ' +
    'similarity. Cross-entity by default — narrow with entity_key and/or trade. Results carry no PII by construction.',
  zodSchema: {
    query: z.string().min(1).max(500).describe('Natural-language search query'),
    entity_key: z.enum(ENTITY_KEYS).optional().describe(
      'Restrict to one gold noun: job, invoice_item, estimate, estimate_line, pricebook, pricebook_category, ' +
      'business_unit, job_type, lead_source, location, truck, membership',
    ),
    trade: z.string().min(1).max(200).optional().describe('Restrict to a trade/business-unit label (e.g. "HVAC Service Residential")'),
    k: z.number().int().min(1).max(20).default(10).optional().describe('Max results (default 10, max 20)'),
  },
  async handler(env: Env, args: Args) {
    const embedding = await embedQuery(env, args.query);
    if (!embedding) {
      throw new Error(
        'semantic_search_gold: query embedding failed (Workers AI bge-base-en-v1.5 unavailable) — ' +
        'no lexical fallback for the gold vector index (match_entities is pure-vector)',
      );
    }
    const k = Math.min(args.k ?? 10, 20);
    // CRITICAL: all 5 named params, even null (see file header, gotcha #2).
    const rows = await sbRpc<MatchRow[]>(env, 'match_entities', {
      query_embedding: embedding,
      p_entity_key: args.entity_key ?? null,
      p_grain: null,
      p_trade: args.trade ?? null,
      p_k: k,
    }, 'vec'); // schema selection (see file header, gotcha #1)
    return {
      matches: rows ?? [],
      query: args.query,
      _source: 'supabase-vec-gold',
    };
  },
};
