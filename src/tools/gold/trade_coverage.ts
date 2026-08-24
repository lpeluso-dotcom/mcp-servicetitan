// ============================================================
// trade_coverage — how much of the gold vector index (vec.entity_chunks,
// Supabase nlaaliehqpgskjmiuzze) carries a NULL trade_bu, MEASURED at call
// time rather than written down.
//
// Why this file exists
// --------------------
// semantic_search_gold's `trade_filter_excludes_untagged` warning used to
// hardcode "62.3% of the index (217,581 of 348,996 chunks) ... invoice_item,
// estimate_line, location, pricebook and membership are 100% untagged". Those
// figures were true on 2026-07-18. Two shipped tickets later — QUA-1059 (gold
// widening) and QUA-1060 (chunk-template enrichment + a 215,217-chunk
// re-embed) — the live numbers were 8.9% overall and invoice_item 0.0%, and
// the warning's "re-run without `trade` to search the full corpus" advice had
// inverted from good to bad. The index is rebuilt nightly by qsc-vector, so a
// constant in this warning is a lie with a delay fuse, not a one-off mistake.
// Everything numeric here is therefore derived from the DB.
//
// Cost
// ----
// A count over ~349k rows on every search call would be absurd, so the whole
// measurement is read through the shared D1 cache (`mcp_cache`) with a
// COVERAGE_TTL_SEC window. STALENESS WINDOW: a reported figure can be up to
// COVERAGE_TTL_SEC old (6h), i.e. it may trail the nightly qsc-vector re-embed
// (09:30 UTC) by at most that long. `measured_at` is carried in the payload and
// surfaced in the warning so a reader can see how fresh it is. On a cache miss
// the probe costs ~3 sequential hops (~30 small PostgREST count requests, each
// an index-scan count, issued in bounded-concurrency batches).
//
// Failure policy: FAIL SOFT. getTradeCoverage swallows everything and returns
// null. A search must never fail because a warning could not be computed.
// ============================================================
import type { Env } from '../../env';
import { cacheGet } from '../../cache';
import { sbCount, sbSelect } from '../../supabase';
import { goldAsOf } from '../../gold-watermark';

const CHUNKS = 'entity_chunks';
const NULL_TRADE = 'trade_bu=is.null';
const VEC = 'vec';

const CACHE_NAMESPACE = 'servicetitan:gold-trade-coverage';
const CACHE_KEY = 'vec.entity_chunks';

/**
 * How long a measurement is reused. 6h keeps the figures re-measured several
 * times a day (the index changes at most once a night) while capping the probe
 * at ~4 runs/day estate-wide, because the cache is D1-backed and therefore
 * shared across isolates rather than per-isolate.
 */
export const COVERAGE_TTL_SEC = 6 * 3600;

/** Max concurrent PostgREST count requests (Workers allows 6 open connections). */
const PROBE_CONCURRENCY = 6;

/** How many nouns the warning names, and therefore how many get a total-count probe. */
const MAX_NAMED_NOUNS = 6;

/**
 * Nouns whose trade_bu is NULL BY DESIGN, not by omission.
 *
 * qsc-vector's TRADE_BU_COLUMN deliberately does not map these two: the
 * ServiceTitan category hierarchy's 65 roots are supplier catalogues
 * (Winsupply, Ferguson, Coolfront, Trane), not trades, so a root-derived trade
 * would be fiction. They must never be reported as a coverage gap to be fixed.
 *
 * This is a CLASSIFICATION, not a measurement — the share for each of these is
 * still counted live below, so if qsc-vector ever starts tagging them the
 * number moves on its own. Only the by-design/gap label is written down here,
 * and it has to be changed in lockstep with qsc-vector's TRADE_BU_COLUMN.
 */
const UNTAGGED_BY_DESIGN = new Set(['pricebook', 'pricebook_category']);

/** Below this overall untagged share there is no material untagged content — say nothing. */
const MATERIAL_UNTAGGED_SHARE = 0.005;

/**
 * At/above this share, "just search without `trade`" is the right advice. Below
 * it, telling a caller to drop the filter throws away a good filter over a
 * mostly-tagged corpus, so the warning points at the specific nouns instead.
 */
const FULL_CORPUS_ADVICE_SHARE = 0.25;

export interface NounCoverage {
  entity_key: string;
  untagged_chunks: number;
  /** Total chunks for the noun — only probed for the nouns the warning names. */
  total_chunks: number | null;
  untagged_share: number | null;
  by_design: boolean;
}

export interface TradeCoverage {
  /**
   * When WE RAN THE COUNTS. This is always "just now" on a cache miss and is
   * NOT a statement about how old the index is — see `gold_as_of` for that.
   * The distinction is the whole reason this field could not be reused as a
   * data-age watermark: a frozen index measured a second ago still reports a
   * second-old `measured_at`.
   */
  measured_at: string;
  /**
   * When the data behind these counts was BUILT — the vec re-embed and the
   * gold build behind it, whichever is older. Null when unprovable.
   * Optional so a `TradeCoverage` cached before this field existed still
   * deserialises instead of throwing.
   */
  gold_as_of?: string | null;
  total_chunks: number;
  untagged_chunks: number;
  untagged_share: number;
  /** Nouns with at least one untagged chunk, worst first. */
  nouns: NounCoverage[];
  /** Untagged chunks in nouns the registry did not list — a completeness check, not a gap. */
  other_untagged_chunks: number;
  discovered_noun_count: number;
  fully_tagged_noun_count: number;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  });
  await Promise.all(workers);
  return out;
}

/**
 * The noun registry, read from `vec.pii_allowlist` — the table that decides
 * which nouns qsc-vector embeds at all. Read from the DB rather than a literal
 * so a noun added upstream shows up here without a code change; anything it
 * still misses lands in `other_untagged_chunks` instead of vanishing.
 */
async function discoverNouns(env: Env): Promise<string[]> {
  const rows = await sbSelect<Array<{ entity_key: string }>>(
    env, `pii_allowlist?select=entity_key&limit=1000`, VEC,
  );
  return [...new Set(rows.map((r) => r.entity_key))].sort();
}

/** One live measurement. Throws on any failure — getTradeCoverage is the soft wrapper. */
export async function measureTradeCoverage(env: Env): Promise<TradeCoverage> {
  const [total, untagged, nouns, asOf] = await Promise.all([
    sbCount(env, `${CHUNKS}?select=chunk_id`, VEC),
    sbCount(env, `${CHUNKS}?select=chunk_id&${NULL_TRADE}`, VEC),
    discoverNouns(env),
    goldAsOf(env, 'vec'),
  ]);

  const perNoun = await mapLimit(nouns, PROBE_CONCURRENCY, async (entity_key) => ({
    entity_key,
    untagged_chunks: await sbCount(env, `${CHUNKS}?select=chunk_id&${NULL_TRADE}&entity_key=eq.${entity_key}`, VEC),
  }));

  const untaggedNouns = perNoun
    .filter((n) => n.untagged_chunks > 0)
    .sort((a, b) => b.untagged_chunks - a.untagged_chunks);

  // Only the nouns the warning will actually name earn a second (total) count.
  const named = untaggedNouns.slice(0, MAX_NAMED_NOUNS);
  const totals = new Map(
    await mapLimit(named, PROBE_CONCURRENCY, async (n) => [
      n.entity_key,
      await sbCount(env, `${CHUNKS}?select=chunk_id&entity_key=eq.${n.entity_key}`, VEC),
    ] as const),
  );

  const attributed = untaggedNouns.reduce((sum, n) => sum + n.untagged_chunks, 0);

  return {
    measured_at: new Date().toISOString(),
    gold_as_of: asOf._gold_as_of,
    total_chunks: total,
    untagged_chunks: untagged,
    untagged_share: total > 0 ? untagged / total : 0,
    nouns: untaggedNouns.map((n) => {
      const nounTotal = totals.get(n.entity_key) ?? null;
      return {
        entity_key: n.entity_key,
        untagged_chunks: n.untagged_chunks,
        total_chunks: nounTotal,
        untagged_share: nounTotal && nounTotal > 0 ? n.untagged_chunks / nounTotal : null,
        by_design: UNTAGGED_BY_DESIGN.has(n.entity_key),
      };
    }),
    other_untagged_chunks: Math.max(0, untagged - attributed),
    discovered_noun_count: nouns.length,
    fully_tagged_noun_count: perNoun.length - untaggedNouns.length,
  };
}

/**
 * Cached, fail-soft coverage. Returns null rather than throwing — a warning
 * that cannot be computed must degrade, never break the search that carries it.
 */
export async function getTradeCoverage(env: Env): Promise<TradeCoverage | null> {
  try {
    return await cacheGet<TradeCoverage>(
      env, CACHE_NAMESPACE, CACHE_KEY, COVERAGE_TTL_SEC, () => measureTradeCoverage(env),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[trade_coverage] measurement failed: ${(e as Error).message}`);
    return null;
  }
}

const pct = (share: number) => `${(share * 100).toFixed(1).replace(/\.0$/, '')}%`;
const num = (n: number) => n.toLocaleString('en-US');

/** "location 40.1%" — falls back to a chunk count when the noun's total was not probed. */
function describeNoun(n: NounCoverage): string {
  return n.untagged_share === null
    ? `${n.entity_key} (${num(n.untagged_chunks)} chunks)`
    : `${n.entity_key} ${pct(n.untagged_share)}`;
}

/**
 * The `_warnings` entry for a trade-filtered search, or null when there is
 * nothing material to warn about.
 *
 * Every figure comes from `coverage`. Passing null (a failed probe) degrades to
 * a qualitative note — the caller still learns that a trade filter excludes
 * untagged chunks, but no number is invented to say so.
 */
export function buildTradeWarning(coverage: TradeCoverage | null, trade: string): string | null {
  if (!coverage) {
    return `trade_filter_unverified: a \`trade\` filter can only match chunks that carry a trade_bu, ` +
      `so any untagged chunk is excluded from this result. Live index coverage could not be measured ` +
      `for this call, so the excluded share is unknown — treat a thin result under trade="${trade}" as ` +
      `possibly truncated and re-run without \`trade\` to check.`;
  }

  if (coverage.untagged_share < MATERIAL_UNTAGGED_SHARE) return null;

  // Name a bounded head only — the live index has 17 nouns with at least one
  // untagged chunk, and listing all of them makes the warning a wall of text a
  // caller skips. The rest is rolled into one weighted clause so nothing is
  // silently dropped.
  const named = coverage.nouns.slice(0, MAX_NAMED_NOUNS);
  const tail = coverage.nouns.slice(MAX_NAMED_NOUNS);
  const tailChunks = tail.reduce((sum, n) => sum + n.untagged_chunks, 0) + coverage.other_untagged_chunks;

  const byDesign = named.filter((n) => n.by_design);
  const gaps = named.filter((n) => !n.by_design);

  const parts = [
    `trade_filter_excludes_untagged: ${pct(coverage.untagged_share)} of the index ` +
    `(${num(coverage.untagged_chunks)} of ${num(coverage.total_chunks)} chunks) has a NULL trade_bu ` +
    `and cannot match trade="${trade}".`,
  ];

  if (byDesign.length > 0) {
    parts.push(
      `Untagged BY DESIGN, not a gap (share of that noun): ${byDesign.map(describeNoun).join(', ')} — ` +
      `qsc-vector deliberately does not map these; the ST category roots are supplier catalogues, not ` +
      `trades. Reach them with \`entity_key\` and no \`trade\`.`,
    );
  }
  if (gaps.length > 0) {
    parts.push(`Untagged as a GAP (share of that noun): ${gaps.map(describeNoun).join(', ')}.`);
  }
  if (tailChunks > 0) {
    parts.push(
      tail.length > 0
        ? `Plus ${num(tailChunks)} untagged chunk(s) across ${tail.length} smaller noun(s).`
        : `Plus ${num(tailChunks)} untagged chunk(s) in nouns outside the registry.`,
    );
  }

  parts.push(
    coverage.untagged_share >= FULL_CORPUS_ADVICE_SHARE
      ? 'Most of the index is invisible under this filter — re-run without `trade` to search the full corpus.'
      : `The other ${pct(1 - coverage.untagged_share)} of the index IS tagged, so \`trade\` is safe for the ` +
        `bulk of the corpus — drop it only to reach the nouns above.`,
  );

  // Two different clocks, named apart on purpose. "Measured" is when we ran
  // the counts (always recent); "index built" is how old the data those counts
  // describe actually is. Printing only the first invites the reader to treat
  // a freshly-counted frozen index as fresh.
  parts.push(
    `Coverage measured ${coverage.measured_at} (re-measured at most every ${COVERAGE_TTL_SEC / 3600}h); ` +
    (coverage.gold_as_of
      ? `index last built ${coverage.gold_as_of}.`
      : `index build time UNKNOWN — the coverage figures describe an index of unverified age.`),
  );

  return parts.join(' ');
}
