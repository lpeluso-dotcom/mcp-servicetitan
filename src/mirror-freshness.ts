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
// DESIGN CONSTRAINT — why this reads rows, not sync_metadata
//
// D1 does not expose `sync_metadata` across the proxy boundary. The one tool
// in this repo with a working freshness guard (payroll_job_timesheets_list)
// documents this and reads `synced_at` off the rows themselves. This helper
// generalizes that proven approach rather than inventing a second one.
//
// A direct consequence: a query that does not SELECT `synced_at` cannot know
// its own age. That is not an edge case to paper over — it is precisely the
// Pulitzer feed's defect — so it reports `unknown`, never `fresh`.
//
// THE RULE: silence is never freshness. Every path that cannot prove data is
// current says `unknown` and explains why. A caller must never be able to
// mistake "we could not tell" for "it's fine".
// ============================================================

/** Age past which mirror data is called stale. Matches read-router's 48h. */
export const STALE_THRESHOLD_HOURS = 48;

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface FreshnessStamp {
  /** The mirror table these rows came from. */
  _mirror_table: string;
  /** Age of the newest row in hours, or null when it cannot be determined. */
  _stale_hours: number | null;
  /** `unknown` whenever freshness could not be PROVEN — never a default of `fresh`. */
  _freshness: Freshness;
  /** True when the mirror returned no rows — see the warning before trusting a zero count. */
  _empty: boolean;
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

/**
 * Describe the freshness of a set of rows read from the taylor-ai D1 mirror.
 *
 * Spread the result into a tool's response so the caller sees the caveat
 * alongside the data. Never throws — a disclosure helper that can fail would
 * just be one more way to lose the disclosure.
 */
export function stampMirrorFreshness(
  // Deliberately `unknown` per row: this is adopted across ~17 tools that each
  // have their own typed row interface, and none of them carry an index
  // signature. Requiring Record<string, unknown> would push an `as any` into
  // every call site — exactly the friction that gets a disclosure dropped.
  rows: ReadonlyArray<unknown> | null | undefined,
  opts: StampOptions
): FreshnessStamp {
  const { table, syncedAtField = 'synced_at', now = Date.now() } = opts;
  const list = Array.isArray(rows) ? rows : [];
  const base = { _mirror_table: table, _stale_hours: null, _empty: list.length === 0 };

  // ── Empty mirror: the trap that produced "clean board" ──────────────
  // A zero row count has two indistinguishable causes — there genuinely are
  // no matching records, or the mirror is empty / its sync failed. Only the
  // caller can tell them apart, and only if we say so.
  if (list.length === 0) {
    return {
      ...base,
      _freshness: 'unknown',
      _warning:
        `0 rows returned from the taylor-ai D1 mirror table \`${table}\`. This is NOT proof ` +
        `that zero matching records exist — the mirror may be empty or its sync may have ` +
        `failed, which has happened to \`opportunities\` and \`job_timesheets\` in production. ` +
        `Confirm against live ServiceTitan before reporting this count as a real zero.`,
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
      _freshness: 'unknown',
      _warning:
        `Freshness unknown for \`${table}\`: the ${list.length} row(s) returned carry no readable ` +
        `\`${syncedAtField}\`. Add \`${syncedAtField}\` to the SELECT to enable staleness ` +
        `disclosure — until then this data could be any age.`,
    };
  }

  // Clock skew between the sync writer and this worker can put a timestamp
  // slightly in the future; report 0 rather than a negative age.
  const staleHours = Math.max(0, (now - newest) / 3_600_000);
  const rounded = Number(staleHours.toFixed(1));

  if (rounded > STALE_THRESHOLD_HOURS) {
    return {
      ...base,
      _stale_hours: rounded,
      _freshness: 'stale',
      _warning:
        `STALE DATA: the newest row in the D1 mirror table \`${table}\` was synced ${rounded}h ago ` +
        `(threshold ${STALE_THRESHOLD_HOURS}h). These results reflect the mirror, not live ` +
        `ServiceTitan, and may be missing recent changes entirely.`,
    };
  }

  return { ...base, _stale_hours: rounded, _freshness: 'fresh' };
}
