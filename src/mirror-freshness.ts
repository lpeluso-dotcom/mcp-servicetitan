// ============================================================
// mirror-freshness.ts — freshness disclosure for taylor-ai D1 mirror reads.
//
// WHY THIS EXISTS (audit MB-1 / QUA-1141)
//
// `src/read-router.ts` already implements the right defense — staleness
// threshold, live fallback, `_stale_days` disclosure, table allow-list — and
// has ZERO non-test importers. Every mirror-reading tool calls readD1/queryD1
// raw instead, so a frozen or empty mirror is served to callers as current
// truth, with no signal that anything is wrong.
//
// That is not hypothetical. Both of these are true in production today:
//   - the `opportunities` mirror is empty, so the Pulitzer feed reports
//     `count: 0` and the daily report reads "clean board";
//   - `job_timesheets` has been frozen since 2026-07-01, so tech scorecards
//     come back silently zero-filled.
//
// In both cases the tool is confidently wrong, which is worse than an error:
// an error gets investigated, a zero gets believed.
//
// v2 REDESIGN (adversarial-review findings F1 / F2 / F5)
//
// The first cut derived freshness from the newest RETURNED row's `synced_at`.
// That was wrong in production, in both directions:
//
//   F1 — mirrors are INCREMENTALLY synced: unchanged rows keep their original
//     `synced_at` forever (prod probe 2026-08-02: 5 of 43,093 pb_services
//     rows synced <48h). Row-derived staleness therefore called HEALTHY
//     mirrors stale on most real calls — a stamp that cries wolf trains
//     callers to ignore it.
//   F2 — multi-table stamps took the global MAX across independently-synced
//     tables (prod MAXes: pb_equipment 04:28, pb_materials 09:05, pb_services
//     13:21), so one fresh table hid a week-frozen sibling — recreating the
//     exact frozen-table incident class this mechanism exists to prevent.
//   F5 — a miss on a provably-alive table warned "mirror may be empty or its
//     sync failed" even when the miss was just a typo'd code.
//
// The redesign: freshness comes from the TABLE-level `MAX(synced_at)` — the
// one row-derivable statistic that actually moves on every sync tick. Tools
// fetch it with `fetchTableMax` (ONE cheap UNION ALL probe, folded into the
// tool's existing Promise.all where possible) and pass it as `opts.tableMax`.
// Each table gets its own verdict in `_tables`; the headline is the WORST
// table. Returned rows then only decide `_empty` — and an empty result from
// a proven-fresh table is an honest zero ("not in the mirror as of the last
// sync"), not an alarm.
//
// Degraded mode (no/failed probe) keeps the old row-level reading but with
// F1's asymmetry made explicit: a recent newest-row can still PROVE the sync
// ran ('fresh'), but an old newest-row proves nothing — it is exactly what
// an incrementally-synced mirror looks like on a normal day — so it reports
// 'unknown', never 'stale'.
//
// THE RULE survives the redesign: silence is never freshness. Every path
// that cannot prove data is current says `unknown` and explains why. But the
// converse now holds too: the stamp never claims staleness it cannot prove.
// ============================================================

import type { Env } from './env';
import { readD1 } from './d1';

/** Age past which mirror data is called stale. Matches read-router's 48h. */
export const STALE_THRESHOLD_HOURS = 48;

export type Freshness = 'fresh' | 'stale' | 'unknown';

/** Per-table verdict, present when `opts.tableMax` was provided. */
export interface TableFreshness {
  /** Age of the table's MAX(synced_at) in hours, or null when unprovable. */
  stale_hours: number | null;
  freshness: Freshness;
}

export interface FreshnessStamp {
  /** The mirror table(s) these rows came from (joined name for multi-table). */
  _mirror_table: string;
  /**
   * Table mode: the worst (oldest) table's age in hours, null when the
   * headline is 'unknown'. Degraded mode: age of the newest returned row,
   * or null when it cannot be determined.
   */
  _stale_hours: number | null;
  /** `unknown` whenever freshness could not be PROVEN — never a default of `fresh`. */
  _freshness: Freshness;
  /**
   * True when the mirror returned no rows. With a fresh table-level MAX this
   * is an honest zero ("not in the mirror as of the last sync") and carries
   * no warning; without one, see `_warning` before trusting it.
   */
  _empty: boolean;
  /** Per-table verdicts — always present when `opts.tableMax` was passed (non-empty). */
  _tables?: Record<string, TableFreshness>;
  /** Human-readable caveat. Present whenever the result needs one. */
  _warning?: string;
}

interface StampOptions {
  /** Mirror table name, used in the warning text so the caller knows what to check. */
  table: string;
  /** Column carrying the sync timestamp. Defaults to `synced_at`. */
  syncedAtField?: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /**
   * Map of mirror table name → that table's MAX(synced_at) (ISO string,
   * epoch ms, or null), usually from `fetchTableMax`. When present (and
   * non-empty), freshness is judged per table — the F1/F2 fix. An empty
   * object (the fetchTableMax failure contract) degrades to row-level mode.
   */
  tableMax?: Record<string, unknown>;
}

/** Read a field off a row of unknown shape without assuming an index signature. */
function fieldOf(row: unknown, field: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[field]
    : undefined;
}

/** Parse a sync timestamp: ISO string or epoch millis. Junk/null -> undefined. */
function parseSyncedAt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** Age in hours (clock-skew clamped to 0), rounded to one decimal. */
function ageHours(now: number, then: number): number {
  return Number(Math.max(0, (now - then) / 3_600_000).toFixed(1));
}

/**
 * Describe the freshness of a set of rows read from the taylor-ai D1 mirror.
 *
 * Spread the result into a tool's response so the caller sees the caveat
 * alongside the data. Never throws — a disclosure helper that can fail would
 * just be one more way to lose the disclosure.
 */
export function stampMirrorFreshness(
  // Deliberately `unknown` per row: this is adopted across ~20 tools that each
  // have their own typed row interface, and none of them carry an index
  // signature. Requiring Record<string, unknown> would push an `as any` into
  // every call site — exactly the friction that gets a disclosure dropped.
  rows: ReadonlyArray<unknown> | null | undefined,
  opts: StampOptions
): FreshnessStamp {
  const { table, syncedAtField = 'synced_at', now = Date.now() } = opts;
  const list = Array.isArray(rows) ? rows : [];
  const base = { _mirror_table: table, _empty: list.length === 0 };

  // ── Table-level mode: judge each mirror by its own MAX(synced_at) ────
  const tableEntries =
    opts.tableMax && Object.keys(opts.tableMax).length > 0 ? Object.entries(opts.tableMax) : null;
  if (tableEntries) {
    const tables: Record<string, TableFreshness> = {};
    const staleTables: Array<[string, number]> = [];
    const unknownTables: string[] = [];
    let worst: number | null = null;

    for (const [t, v] of tableEntries) {
      const parsed = parseSyncedAt(v);
      if (parsed === undefined) {
        // An empty (or never-synced) table has MAX(synced_at) = NULL — it
        // cannot prove its sync is alive, so it cannot vouch for a zero.
        tables[t] = { stale_hours: null, freshness: 'unknown' };
        unknownTables.push(t);
        continue;
      }
      const age = ageHours(now, parsed);
      const f: Freshness = age > STALE_THRESHOLD_HOURS ? 'stale' : 'fresh';
      tables[t] = { stale_hours: age, freshness: f };
      if (f === 'stale') staleTables.push([t, age]);
      if (worst === null || age > worst) worst = age;
    }

    // ALL fresh → fresh; ANY stale → stale (a frozen table must never hide
    // behind a fresh sibling — F2); else → unknown.
    const headline: Freshness =
      staleTables.length > 0 ? 'stale' : unknownTables.length > 0 ? 'unknown' : 'fresh';

    let warning: string | undefined;
    if (headline === 'stale') {
      const named = staleTables
        .map(([t, age]) => `\`${t}\` (last synced ${age}h ago)`)
        .join(', ');
      warning =
        `STALE DATA: D1 mirror table(s) ${named} are past the ${STALE_THRESHOLD_HOURS}h sync ` +
        `threshold. These results reflect the mirror, not live ServiceTitan, and may be missing ` +
        `recent changes entirely.` +
        (unknownTables.length > 0
          ? ` Additionally, ${unknownTables.map((t) => `\`${t}\``).join(', ')} returned no ` +
            `MAX(synced_at) at all and could not prove liveness.`
          : '');
    } else if (headline === 'unknown') {
      warning =
        `Freshness unknown for \`${table}\`: mirror table(s) ` +
        `${unknownTables.map((t) => `\`${t}\``).join(', ')} returned no MAX(synced_at) — an ` +
        `empty table cannot prove its sync is alive. A zero or miss from it is NOT proof that ` +
        `zero matching records exist; confirm against live ServiceTitan before trusting it.`;
    }
    // headline === 'fresh': no warning — even when rows are empty. A live
    // mirror returning zero matching rows is a real zero as of the last
    // sync (the honest-empty semantics; F5).

    return {
      ...base,
      _stale_hours: headline === 'unknown' ? null : worst,
      _freshness: headline,
      _tables: tables,
      ...(warning !== undefined ? { _warning: warning } : {}),
    };
  }

  // ── Degraded mode (no table-level probe): rows are all we have ───────
  // A zero row count with no table MAX has two indistinguishable causes —
  // there genuinely are no matching records, or the mirror is empty / its
  // sync failed. Only the caller can tell them apart, and only if we say so.
  if (list.length === 0) {
    return {
      ...base,
      _stale_hours: null,
      _freshness: 'unknown',
      _warning:
        `0 rows returned from the taylor-ai D1 mirror table \`${table}\` and no table-level ` +
        `MAX(synced_at) was available. This is NOT proof that zero matching records exist — the ` +
        `mirror may be empty or its sync may have failed, which has happened to \`opportunities\` ` +
        `and \`job_timesheets\` in production. Confirm against live ServiceTitan before reporting ` +
        `this count as a real zero.`,
    };
  }

  let newest: number | undefined;
  for (const row of list) {
    const t = parseSyncedAt(fieldOf(row, syncedAtField));
    if (t !== undefined && (newest === undefined || t > newest)) newest = t;
  }

  // ── No usable timestamp: cannot prove anything, so claim nothing ─────
  if (newest === undefined) {
    return {
      ...base,
      _stale_hours: null,
      _freshness: 'unknown',
      _warning:
        `Freshness unknown for \`${table}\`: the ${list.length} row(s) returned carry no readable ` +
        `\`${syncedAtField}\` (either the SELECT omits it or every value is NULL), and no ` +
        `table-level MAX(synced_at) was available — this data could be any age.`,
    };
  }

  const rounded = ageHours(now, newest);

  // A recently-synced returned row IS proof the sync ran — degraded mode may
  // still say 'fresh'.
  if (rounded <= STALE_THRESHOLD_HOURS) {
    return { ...base, _stale_hours: rounded, _freshness: 'fresh' };
  }

  // F1: an old newest-row proves NOTHING. Mirrors are incrementally synced —
  // unchanged rows keep their original synced_at forever, so old returned
  // rows are what a healthy mirror serves on a normal day. Never 'stale'.
  return {
    ...base,
    _stale_hours: rounded,
    _freshness: 'unknown',
    _warning:
      `Freshness unknown for \`${table}\`: the newest returned row was synced ${rounded}h ago, ` +
      `but the mirror is incrementally synced — unchanged rows keep their original ` +
      `\`${syncedAtField}\` forever, so row-level age cannot distinguish old-but-final data ` +
      `from a frozen sync. No table-level MAX(synced_at) was available to settle it; confirm ` +
      `against live ServiceTitan if currency matters.`,
  };
}

/** Only ever called with in-repo constants; asserted anyway (defense-in-depth). */
const TABLE_NAME_RE = /^[a-z_]+$/;

/**
 * Fetch each table's MAX(synced_at) in ONE readD1 round trip:
 *
 *   SELECT '<t>' AS t, MAX(synced_at) AS m FROM <t> UNION ALL ...
 *
 * Table names are joined into the SQL, so they must come only from in-repo
 * constants — asserted against /^[a-z_]+$/ regardless; any violation (or any
 * query failure) returns {} so the stamp degrades to row-level mode rather
 * than throwing. Losing the probe costs precision, never availability.
 */
export async function fetchTableMax(
  env: Env,
  tables: string[],
): Promise<Record<string, unknown>> {
  try {
    if (tables.length === 0) return {};
    if (tables.some((t) => !TABLE_NAME_RE.test(t))) return {};
    const sql = tables
      .map((t) => `SELECT '${t}' AS t, MAX(synced_at) AS m FROM ${t}`)
      .join(' UNION ALL ');
    const { rows } = await readD1<{ t: string; m: unknown }>(env, sql);
    const out: Record<string, unknown> = {};
    // Pre-seed null so a table the query somehow failed to report reads as
    // 'unknown' downstream instead of silently dropping out of the verdict.
    for (const t of tables) out[t] = null;
    for (const r of rows ?? []) {
      if (r && typeof r.t === 'string' && r.t in out) out[r.t] = r.m ?? null;
    }
    return out;
  } catch {
    return {};
  }
}
