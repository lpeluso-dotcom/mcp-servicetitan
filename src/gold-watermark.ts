// ============================================================
// gold-watermark.ts — data-age disclosure for the Supabase-backed tools.
//
// WHY THIS EXISTS
// ---------------
// All nine Supabase-backed tools (four gold, five pricebook) published NO
// data-age signal whatsoever: a grep for `as_of|measured_at|synced_at|
// updated_at` across them returned zero hits. A QSC analytical answer then
// went to the owner's inbox with a wrong headline, because at write-up time
// there was nothing on the response that said how old the warehouse was.
//
// A stale-gold answer that LOOKS fresh is worse than no answer: an error gets
// investigated, a confident number gets quoted.
//
// This module is the Supabase analogue of `src/mirror-freshness.ts` — same
// contract (never throw, never claim freshness it cannot prove, always
// explain an `unknown`), different source. `fetchTableMax` is the house style
// for exactly this problem; the shape here follows it, but the timestamp
// comes from Supabase rather than D1, and — see below — it is a materially
// STRONGER signal than a D1 `synced_at`.
//
// WHERE THE TIMESTAMP COMES FROM (and the trap it avoids)
// -------------------------------------------------------
// NOT from `new Date()`. `src/tools/gold/trade_coverage.ts:158` writes
// `measured_at: new Date().toISOString()`, which is correct FOR WHAT IT IS —
// the time we ran the coverage probe — and would be a lie as a data-age
// watermark, because it is always "seconds ago" no matter how frozen the
// warehouse is. That field is a trap, not a precedent.
//
// The real build stamps already exist upstream:
//
//   * gold      `vec.refresh_state['gold_build_complete_at']` — written by
//               qsc-hopper `src/gold-build-core.ts` (writeWatermark) ONLY
//               after a build in which every noun succeeded and the PII gate
//               passed. qsc-vector's `src/gold-freshness.ts` already reads
//               this same key to refuse to embed stale gold, after the
//               2026-07-21..26 incident where gold froze for five nights
//               while the vector refresh kept reporting success.
//   * vec       the same table's `taylor_jobs_synced_at` row carries an
//               `updated_at` written only on a fully successful qsc-vector
//               refresh — i.e. when the embeddings were last rebuilt. A vec
//               read is bounded by BOTH that and the gold build behind it.
//   * pricebook `max(pricebook_items.synced_at)`. The qsc-pricebook-search
//               refresh stamps EVERY row with the run's `now` and then
//               deletes anything older, so this is a full-reload completion
//               time, not an incremental per-row stamp. That is why the F1
//               caveat from mirror-freshness (unchanged rows keep their
//               original synced_at forever, so an old max proves nothing)
//               does NOT apply here.
//   * pricebook_templates  `max(pb_estimate_templates.synced_at)` — a
//               SEPARATE nightly cron (09:30 UTC) from the item refresh
//               (09:45 UTC). Reading one to vouch for the other is the
//               "fresh sibling hides a frozen table" bug (mirror-freshness
//               finding F2), so the template tools probe their own table.
//
// WHY THIS ONE MAY SAY 'stale' WHEN mirror-freshness MAY NOT
// ----------------------------------------------------------
// mirror-freshness deliberately never emits 'stale', because a D1 mirror's
// `synced_at` cannot distinguish "quiet table" from "frozen sync". These
// watermarks CAN: `gold_build_complete_at` is written on build COMPLETION,
// not on row change, so an old value proves no successful build has finished
// since then — regardless of whether any data changed. The same holds for the
// pricebook full-reload stamp. 'stale' here is a provable claim, so it is
// allowed; 'unknown' is still the answer for everything unprovable.
//
// COST
// ----
// One small PostgREST read per source, behind the shared D1 cache. The cached
// value is the BUILD TIMESTAMP, never a computed age — age is recomputed from
// it on every call. That asymmetry is what makes the TTL safe: a warm cache
// can only delay noticing a NEW build, it can never make an old one look
// fresh.
// ============================================================
import type { Env } from './env';
import { cacheGet } from './cache';
import { sbSelect } from './supabase';

/**
 * Age past which a build is called stale.
 *
 * Every source here rebuilds nightly (gold 09:00 UTC, qsc-vector 09:30,
 * pricebook templates 09:30, pricebook items 09:45), so a perfectly healthy
 * build is ~24h old just before the next one runs. qsc-vector uses 20h for
 * the SAME `gold_build_complete_at` key and is right to: it runs 30 minutes
 * after the build, so it always looks at a fresh one. A tool called at an
 * arbitrary hour does not have that luxury — 20h here would report a healthy
 * warehouse as stale every morning, and a warning that cries wolf daily is a
 * warning callers learn to ignore. 26h = one full cycle plus the 2h
 * TimeoutStartSec the gold unit is allowed to run for.
 */
export const GOLD_STALE_THRESHOLD_HOURS = 26;

/**
 * How long a probed watermark is reused.
 *
 * Safe to be generous (see the COST note above): the cache holds the build
 * timestamp, so staleness keeps accruing correctly off a warm entry. 15
 * minutes keeps the probe to ~4/hour estate-wide while still surfacing a
 * finished nightly build well within the hour.
 */
export const WATERMARK_TTL_SEC = 15 * 60;

/** A watermark stamped slightly ahead of our clock is tolerated this far. */
const FUTURE_SKEW_TOLERANCE_HOURS = 1;

const CACHE_NAMESPACE = 'servicetitan:gold-watermark';

/** The `vec.refresh_state` key qsc-hopper writes on a successful gold build. */
const GOLD_BUILD_KEY = 'gold_build_complete_at';
/** The `vec.refresh_state` key whose `updated_at` marks a successful re-embed. */
const VEC_REFRESH_KEY = 'taylor_jobs_synced_at';

export type WatermarkSource = 'gold' | 'vec' | 'pricebook' | 'pricebook_templates';

/** One resolved upstream: what it is, when it last built, whether the probe worked. */
export interface WatermarkPart {
  source: WatermarkSource;
  /** Human-readable provenance, e.g. `vec.refresh_state[gold_build_complete_at]`. */
  label: string;
  /** ISO build/sync-completion timestamp, or null when there was none to read. */
  builtAt: string | null;
  /** True when the probe itself failed (as opposed to succeeding and finding nothing). */
  failed: boolean;
}

export type GoldFreshness = 'fresh' | 'stale' | 'unknown';

export interface GoldStamp {
  /**
   * When the data behind this response was BUILT — never when it was read.
   * Null when no upstream could prove a build time.
   */
  _gold_as_of: string | null;
  /** Age of that build in hours, one decimal. Null whenever `_gold_as_of` is. */
  _gold_age_hours: number | null;
  /** `stale` is provable here (build-completion stamps); `unknown` is never a default of fresh. */
  _gold_freshness: GoldFreshness;
  /** Which upstream answered — the binding (oldest) one when several were consulted. */
  _gold_watermark_source: string;
  /** Present whenever the caller needs a caveat before quoting these numbers. */
  _gold_warning?: string;
}

/** Age in hours (clock-skew clamped at the caller), one decimal. */
function ageHours(now: number, then: number): number {
  return Number(((now - then) / 3_600_000).toFixed(1));
}

function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Turn resolved upstreams into the caller-facing stamp. Pure — the probe is
 * separate so the verdict can be tested without a network at all.
 *
 * Rule: the answer is the OLDEST upstream, because data can be no fresher
 * than its stalest input; and ANY unprovable upstream forces `unknown`, so a
 * fresh sibling can never vouch for a silent one.
 */
export function buildGoldStamp(parts: WatermarkPart[], now: number): GoldStamp {
  const labels = parts.map((p) => p.label).join(' + ');
  const unprovable: string[] = [];
  let oldest: { ts: number; iso: string; label: string } | null = null;

  for (const p of parts) {
    const t = p.builtAt === null ? undefined : parseTs(p.builtAt);
    if (t === undefined) {
      unprovable.push(
        p.failed
          ? `${p.label} could not be read (probe failed)`
          : p.builtAt === null
            ? `${p.label} has no value — that build has never completed successfully`
            : `${p.label} = ${JSON.stringify(p.builtAt)} is not a parseable timestamp`,
      );
      continue;
    }
    // A watermark stamped in the future would score as maximally fresh under a
    // plain age comparison, so a single corrupt write would disable this
    // disclosure permanently. Treat it as unprovable instead. (Same call
    // qsc-vector's gold-freshness guard makes.)
    if (now - t < -FUTURE_SKEW_TOLERANCE_HOURS * 3_600_000) {
      unprovable.push(
        `${p.label} = ${p.builtAt} is in the future relative to now — a bad write must not read as fresh`,
      );
      continue;
    }
    if (oldest === null || t < oldest.ts) oldest = { ts: t, iso: p.builtAt as string, label: p.label };
  }

  if (unprovable.length > 0) {
    return {
      _gold_as_of: null,
      _gold_age_hours: null,
      _gold_freshness: 'unknown',
      _gold_watermark_source: labels,
      _gold_warning:
        `Data age UNKNOWN: ${unprovable.join('; ')}. These figures could be any age — ` +
        `check that the nightly build ran before treating them as current.`,
    };
  }

  // parts is never empty at any call site, but an empty list must not read as fresh.
  if (oldest === null) {
    return {
      _gold_as_of: null,
      _gold_age_hours: null,
      _gold_freshness: 'unknown',
      _gold_watermark_source: labels || 'none',
      _gold_warning: 'Data age UNKNOWN: no watermark source was consulted.',
    };
  }

  const age = Math.max(0, ageHours(now, oldest.ts));
  if (age <= GOLD_STALE_THRESHOLD_HOURS) {
    return {
      _gold_as_of: oldest.iso,
      _gold_age_hours: age,
      _gold_freshness: 'fresh',
      _gold_watermark_source: oldest.label,
    };
  }

  return {
    _gold_as_of: oldest.iso,
    _gold_age_hours: age,
    _gold_freshness: 'stale',
    _gold_watermark_source: oldest.label,
    _gold_warning:
      `STALE DATA: the last successful build behind this answer completed ${oldest.iso} — ` +
      `${age}h ago, past the ${GOLD_STALE_THRESHOLD_HOURS}h threshold for a nightly rebuild ` +
      `(${oldest.label}). Anything that changed since then is MISSING from these figures. ` +
      `Do not report them as current without re-running the build or confirming against live ` +
      `ServiceTitan.`,
  };
}

/** Provenance label per source, used in the stamp and in warnings. */
const LABELS: Record<WatermarkSource, string> = {
  gold: `vec.refresh_state[${GOLD_BUILD_KEY}]`,
  vec: 'vec index re-embed',
  pricebook: 'max(pricebook_items.synced_at)',
  pricebook_templates: 'max(pb_estimate_templates.synced_at)',
};

interface RefreshStateRow { key: string; value: string | null; updated_at: string | null }

/**
 * One live probe for a source. Throws on any failure — `goldAsOf` is the
 * soft wrapper. Returns the ISO build time, or null when there is no row.
 *
 * `vec` returns TWO parts: a chunk read is bounded by the re-embed that wrote
 * it AND by the gold build the embeddings were derived from. The 2026-07-21
 * incident is precisely the case where those diverge — gold frozen, vector
 * re-embedding it nightly and reporting success — so collapsing them to one
 * number would hide the failure this disclosure exists to catch.
 */
async function probe(env: Env, source: WatermarkSource): Promise<WatermarkPart[]> {
  if (source === 'gold' || source === 'vec') {
    const keys = source === 'gold' ? [GOLD_BUILD_KEY] : [GOLD_BUILD_KEY, VEC_REFRESH_KEY];
    const rows = await sbSelect<RefreshStateRow[]>(
      env,
      `refresh_state?select=key,value,updated_at&key=in.(${keys.join(',')})&limit=${keys.length}`,
      'vec',
    );
    const byKey = new Map((rows ?? []).map((r) => [r.key, r]));
    // The gold build stamps its COMPLETION time into `value`.
    const goldPart: WatermarkPart = {
      source: 'gold',
      label: LABELS.gold,
      builtAt: byKey.get(GOLD_BUILD_KEY)?.value ?? null,
      failed: false,
    };
    if (source === 'gold') return [goldPart];
    // The vector refresh does not stamp a completion VALUE, but it upserts
    // this row's `updated_at` at the end of a fully successful run — so that
    // column is the re-embed's completion time.
    return [
      goldPart,
      {
        source: 'vec',
        label: LABELS.vec,
        builtAt: byKey.get(VEC_REFRESH_KEY)?.updated_at ?? null,
        failed: false,
      },
    ];
  }

  const table = source === 'pricebook' ? 'pricebook_items' : 'pb_estimate_templates';
  const rows = await sbSelect<Array<{ synced_at: string | null }>>(
    env,
    `${table}?select=synced_at&order=synced_at.desc&limit=1`,
  );
  return [{ source, label: LABELS[source], builtAt: rows?.[0]?.synced_at ?? null, failed: false }];
}

/** Cached probe. Returns the parts, or a `failed` part when the probe blew up. */
async function probeCached(env: Env, source: WatermarkSource): Promise<WatermarkPart[]> {
  try {
    return await cacheGet<WatermarkPart[]>(
      env, CACHE_NAMESPACE, source, WATERMARK_TTL_SEC, () => probe(env, source),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[gold-watermark] probe failed for ${source}: ${(e as Error).message}`);
    return [{ source, label: LABELS[source], builtAt: null, failed: true }];
  }
}

/**
 * The tool-facing entry point. Spread the result into a response so the age of
 * the data travels WITH the numbers:
 *
 *   return { rows, ...(await goldAsOf(env, 'gold')) };
 *
 * NEVER throws — a disclosure helper that can fail is just one more way to
 * lose the disclosure. Pass several sources when a tool reads several
 * pipelines; the oldest one wins.
 */
export async function goldAsOf(
  env: Env,
  sources: WatermarkSource | WatermarkSource[],
  now: number = Date.now(),
): Promise<GoldStamp> {
  try {
    const list = Array.isArray(sources) ? sources : [sources];
    const parts = (await Promise.all(list.map((s) => probeCached(env, s)))).flat();
    return buildGoldStamp(parts, now);
  } catch (e) {
    // Belt and braces: probeCached already swallows, so reaching here means
    // something unexpected. Still never propagate.
    // eslint-disable-next-line no-console
    console.error(`[gold-watermark] stamp failed: ${(e as Error).message}`);
    return {
      _gold_as_of: null,
      _gold_age_hours: null,
      _gold_freshness: 'unknown',
      _gold_watermark_source: 'unavailable',
      _gold_warning: 'Data age UNKNOWN: the freshness probe could not be run for this call.',
    };
  }
}
