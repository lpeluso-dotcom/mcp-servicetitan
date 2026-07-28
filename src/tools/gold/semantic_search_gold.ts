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

// ── Post-retrieval layer ────────────────────────────────────
// match_entities is raw cosine-similarity top-k. Returning it verbatim is
// wrong for this index for three measured reasons (all live 2026-07-28):
//
//   * DUPLICATION — the line grains compose content_text from just
//     [sku_name, line_type], so one string recurs up to 71 times
//     ("Florence · SC" = 71, "Replace OEM Condenser Fan Motor · Service" = 20).
//     A raw top-10 can be ten copies of one sentence.
//   * SKEW — invoice_item (132,684) + estimate_line (43,725) are 50.6% of the
//     348,996-chunk index, so line grains monopolise any unfiltered search.
//   * NO FLOOR — pure top-k always returns something. The nonsense query
//     "asdkjqwoeiuzxcv" scored 0.723-0.735 and looked like a real answer.
//
// These tools feed Miss Dawn (Retell), Pulitzer and the mcp-hopper read
// gateway, so a confident-looking wrong answer can reach a customer on a
// phone call. Prefer "no confident matches" over nearest-available noise.

/**
 * Minimum cosine similarity to report a match.
 *
 * 0.75 sits above the measured nonsense-query ceiling (0.7352 for
 * "asdkjqwoeiuzxcv") and below genuine hits (0.886 for "condenser fan motor
 * replacement", 0.80-0.83 for job-grain prose).
 */
const DEFAULT_RELEVANCE_FLOOR = 0.75;

/**
 * Per-entity floor overrides. Deliberately empty.
 *
 * Measured ceilings do differ by entity (business_unit ~0.900 vs invoice_item
 * ~0.698), but that gap reflects how degenerate the line-grain template is, not
 * a different similarity scale. Lowering the line-grain floor to "reach" their
 * ceiling would simply admit noise: the best invoice_item hit for "water heater
 * flush and inspection line item" was "WATER/LEAK DET · Service" at 0.6975 —
 * below even the nonsense-query ceiling, and not a water-heater flush at all.
 * Line-grain recall is fixed upstream by enriching the chunk template
 * (qsc-vector allowlist), not by relaxing this floor.
 */
const RELEVANCE_FLOOR_BY_ENTITY: Record<string, number> = {};

/**
 * Over-fetch factor before dedup. `k * 5` is provably insufficient — 71 copies
 * of a single content_text were measured, so k=10 at k*5 could still collapse
 * to one row. Bounded by MAX_OVERFETCH to keep the RPC payload sane.
 */
const OVERFETCH_MULTIPLIER = 25;
const MIN_OVERFETCH = 50;
const MAX_OVERFETCH = 500;

/** Bounded sample of the underlying keys behind a deduped match. */
const MAX_SOURCE_KEYS = 5;

interface ShapedMatch extends MatchRow {
  occurrence_count: number;
  source_keys: string[];
}

function floorFor(entityKey: string): number {
  return RELEVANCE_FLOOR_BY_ENTITY[entityKey] ?? DEFAULT_RELEVANCE_FLOOR;
}

/**
 * Collapse rows sharing a content_text. The best-scoring row represents the
 * group; the rest become occurrence_count plus a capped source_keys sample.
 */
function dedupeByContent(rows: MatchRow[]): ShapedMatch[] {
  const groups = new Map<string, ShapedMatch>();
  for (const row of rows) {
    const existing = groups.get(row.content_text);
    if (existing) {
      existing.occurrence_count += 1;
      if (existing.source_keys.length < MAX_SOURCE_KEYS) existing.source_keys.push(row.source_key);
      if (row.similarity > existing.similarity) existing.similarity = row.similarity;
    } else {
      groups.set(row.content_text, { ...row, occurrence_count: 1, source_keys: [row.source_key] });
    }
  }
  return [...groups.values()].sort((a, b) => b.similarity - a.similarity);
}

/**
 * Cap how many slots any one entity may take, then backfill from the remainder
 * so a diverse head does not cost the caller result count.
 */
function applyPerEntityQuota(matches: ShapedMatch[], k: number): { kept: ShapedMatch[]; quotaApplied: boolean } {
  const quota = Math.max(2, Math.ceil(k / 4));
  const counts = new Map<string, number>();
  const kept: ShapedMatch[] = [];
  const overflow: ShapedMatch[] = [];

  for (const m of matches) {
    const seen = counts.get(m.entity_key) ?? 0;
    if (seen < quota) {
      counts.set(m.entity_key, seen + 1);
      kept.push(m);
    } else {
      overflow.push(m);
    }
  }

  const quotaApplied = overflow.length > 0 && kept.length < matches.length;
  // Backfill in similarity order once every entity has had its fair shot.
  for (const m of overflow) {
    if (kept.length >= k) break;
    kept.push(m);
  }
  return { kept: kept.slice(0, k), quotaApplied };
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
    const fetchK = Math.min(Math.max(k * OVERFETCH_MULTIPLIER, MIN_OVERFETCH), MAX_OVERFETCH);

    // CRITICAL: all 5 named params, even null (see file header, gotcha #2).
    const rows = await sbRpc<MatchRow[]>(env, 'match_entities', {
      query_embedding: embedding,
      p_entity_key: args.entity_key ?? null,
      p_grain: null,
      p_trade: args.trade ?? null,
      p_k: fetchK,
    }, 'vec'); // schema selection (see file header, gotcha #1)

    const raw = rows ?? [];
    const warnings: string[] = [];

    if (args.trade !== undefined) {
      warnings.push(
        `trade_filter_excludes_untagged: 62.3% of the index (217,581 of 348,996 chunks) has a NULL ` +
        `trade_bu and can never match trade="${args.trade}". Whole nouns are invisible under this ` +
        `filter — invoice_item, estimate_line, location, pricebook and membership are 100% untagged. ` +
        `Re-run without \`trade\` to search the full corpus.`,
      );
    }

    // 1. Relevance floor — drop nearest-available noise before anything else.
    const aboveFloor = raw.filter((r) => r.similarity >= floorFor(r.entity_key));
    if (aboveFloor.length === 0) {
      const best = raw.reduce((m, r) => Math.max(m, r.similarity), 0);
      warnings.push(
        raw.length === 0
          ? 'no confident matches: the index returned nothing for this query.'
          : `no confident matches: best similarity ${best.toFixed(3)} is below the ${DEFAULT_RELEVANCE_FLOOR} ` +
            `relevance floor, so the nearest-available rows were withheld as noise rather than reported ` +
            `as answers.`,
      );
      return {
        matches: [],
        query: args.query,
        _relevance_floor: DEFAULT_RELEVANCE_FLOOR,
        _source: 'supabase-vec-gold',
        _warnings: warnings,
      };
    }

    // 2. Dedup on content_text.
    const deduped = dedupeByContent(aboveFloor);

    // 3. Per-entity quota — only when the caller did not name an entity.
    const { kept, quotaApplied } = args.entity_key === undefined
      ? applyPerEntityQuota(deduped, k)
      : { kept: deduped.slice(0, k), quotaApplied: false };

    if (quotaApplied) {
      warnings.push(
        'per_entity_quota_applied: one noun would otherwise have filled the result set ' +
        '(invoice_item + estimate_line are 50.6% of the index). Narrow with entity_key for a single-noun search.',
      );
    }
    if (kept.length < k && raw.length >= fetchK) {
      warnings.push(
        `result_set_truncated_by_duplication: only ${kept.length} distinct chunk(s) survived from ` +
        `${raw.length} fetched — the index is duplicate-dense for this query, so fewer than k=${k} ` +
        `distinct results exist within the over-fetch window.`,
      );
    }

    return {
      matches: kept,
      query: args.query,
      _relevance_floor: DEFAULT_RELEVANCE_FLOOR,
      _source: 'supabase-vec-gold',
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
