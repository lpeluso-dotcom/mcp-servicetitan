// ============================================================
// titan_advisor_score — ServiceTitan Titan Advisor adoption score over a date
// window, from the Woz gold warehouse (Supabase). Daily snapshots landed from
// ST report 79127569 by qsc-hopper.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { sbSelect } from '../../supabase';

/** Guards the two values that get interpolated into the PostgREST query string. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Explicit row caps. This Supabase project has NO server-side backstop — `pgrst.db_max_rows`
 * is unset (verified 2026-08-04) — so without these a wide window would stream everything:
 * the feature grain alone is 131 rows/day, i.e. ~48,000 rows for a single year with
 * detail:true.
 *
 * daily and sections are sized to clear a ~13-month window, which is the longest trend
 * anyone asks for. features is deliberately capped MUCH lower: 131 rows/day means a year of
 * full detail is not a useful response shape at any size, so the cap forces a narrower
 * window rather than returning a payload nothing can read. Hitting any cap sets `truncated`,
 * so a partial series can never be mistaken for a complete one.
 */
const LIMIT_DAILY = 400;      // 1 row/day   → ~13 months
const LIMIT_SECTIONS = 3_200; // 8 rows/day  → ~13 months
const LIMIT_FEATURES = 6_000; // 131 rows/day → ~46 days at full detail
import type { ToolDef } from '../index';

interface Args {
  from: string;
  to: string;
  section?: string;
  detail?: boolean;
}

interface SnapRow {
  snapshot_date: string; earned: number; available: number;
  pct: number; feature_count: number; checkpoint_count: number;
}
interface SectionRow extends Omit<SnapRow, 'checkpoint_count'> {
  section_name: string; remaining: number;
}
interface FeatureRow {
  snapshot_date: string; section_name: string; feature_name: string;
  earned: number; available: number; remaining: number; status: string | null;
  stage?: string | null; primary_goal?: string | null; secondary_goal?: string | null;
  is_required?: boolean | null;
}

export const titan_advisor_score: ToolDef<Args> = {
  name: 'titan_advisor_score',
  description:
    "QSC's ServiceTitan Titan Advisor score by day, with the per-section breakdown and " +
    'optional per-feature detail. Sourced from daily snapshots of ST report 79127569 in the ' +
    'Woz gold warehouse. ' +
    'IMPORTANT — report the PERCENTAGE, not earned points. ServiceTitan keeps ADDING ' +
    'checkpoints, so available points grow over time (390 in Aug 2025 → 476 in Aug 2026); ' +
    'earned-point counts are not comparable across dates, percentages are. ' +
    'IMPORTANT — a FALLING score is real data, not an error. Usage checkpoints decay when a ' +
    'behaviour stops (e.g. "Offer financing payment options" went 4 → 0 points during 2026). ' +
    'Investigate a drop; do not smooth or dismiss it. ' +
    'SCOPE — this measures ServiceTitan FEATURE ADOPTION only. It is not revenue, margin, ' +
    'job count, or technician performance, and it must never be presented as a business KPI ' +
    'or used as a proxy for one. When asked about pricebook health, job costing, or ' +
    'operational performance, use the tools that return real counts and dollars instead. ' +
    'Source: computed from the Supabase gold.snap_titan_advisor_daily / ' +
    'agg_titan_advisor_section_daily / fct_titan_advisor_feature_daily views.',
  stEndpoint: { method: 'GET', path: 'supabase://gold/titan_advisor', source: 'computed' },
  zodSchema: {
    // ISO_DATE, not a bare string: these two values are interpolated into the PostgREST query
    // string, so an unvalidated value could smuggle an extra parameter ('2026-08-01&limit=99999',
    // '2026-08-01&select=*') past the intended date window. `section` is encodeURIComponent'd
    // below; validating these at the schema is the equivalent guarantee for a date.
    from: z.string().regex(ISO_DATE, "Must be ISO 'YYYY-MM-DD'.")
      .describe("Window start, ISO 'YYYY-MM-DD' (inclusive)."),
    to: z.string().regex(ISO_DATE, "Must be ISO 'YYYY-MM-DD'.")
      .describe("Window end, ISO 'YYYY-MM-DD' (inclusive)."),
    section: z.string().optional().describe(
      'Restrict the section breakdown (and detail rows, if requested) to one section, e.g. ' +
      '"Pricebook", "Selling & Performing Work", "Job Booking & Dispatching".'),
    // z.boolean(), NOT z.coerce.boolean(): coerce runs Boolean(value), so the string "false"
    // would arrive as TRUE — the opposite of the caller's intent — and silently pull 131
    // rows/day. Plain boolean matches every other optional flag in this repo.
    detail: z.boolean().optional().describe(
      'Include per-feature rows (131/day). Off by default — use it to find which features ' +
      'are dragging a section down.'),
  },
  async handler(env, args) {
    const window = `snapshot_date=gte.${args.from}&snapshot_date=lte.${args.to}`;
    const sectionFilter = args.section
      ? `&section_name=eq.${encodeURIComponent(args.section)}`
      : '';

    // ORDER DESC + limit, THEN reverse — so a cap drops the OLDEST days, never the newest.
    // Ordering asc and limiting truncates the recent end: "show me the whole trend" would
    // silently return the oldest N days and stop short of today, which reads as a pipeline
    // that died rather than a window that was too wide.
    const daily = (await sbSelect<SnapRow[]>(
      env,
      `snap_titan_advisor_daily?${window}&order=snapshot_date.desc&limit=${LIMIT_DAILY}`,
      'gold')).reverse();

    const sections = (await sbSelect<SectionRow[]>(
      env,
      `agg_titan_advisor_section_daily?${window}${sectionFilter}` +
      `&order=snapshot_date.desc,section_name.asc&limit=${LIMIT_SECTIONS}`,
      'gold')).reverse();

    // Same desc-then-reverse reasoning as above: keep the most RECENT days when the cap bites.
    const features = args.detail
      ? (await sbSelect<FeatureRow[]>(
          env,
          `fct_titan_advisor_feature_daily?${window}${sectionFilter}` +
          `&order=snapshot_date.desc,section_name.asc,feature_name.asc&limit=${LIMIT_FEATURES}`,
          'gold')).reverse()
      : undefined;

    // Say so when a cap bit. A silently-truncated series is worse than a smaller one: the
    // trend would look like it ended, and a caller would read the last row as "today".
    const truncated =
      daily.length >= LIMIT_DAILY ||
      sections.length >= LIMIT_SECTIONS ||
      (features?.length ?? 0) >= LIMIT_FEATURES;

    return {
      window: { from: args.from, to: args.to },
      daily,
      sections,
      ...(features ? { features } : {}),
      ...(truncated
        ? { truncated: true, _truncation_note:
            'A row cap was hit, so this window is INCOMPLETE — do not read the last row as ' +
            'the latest day. Narrow the date range, or drop detail:true, and re-query.' }
        : {}),
      _source: 'gold',
      _scope_basis:
        'Report the percentage, not earned points — available points grow over time as ' +
        'ServiceTitan adds checkpoints, so earned counts are not comparable across dates. ' +
        'A falling score is real data (checkpoints decay when a behaviour stops), not an ' +
        'error. This measures ServiceTitan feature adoption only — never present it as a ' +
        'business KPI (revenue, margin, job count, or technician performance).',
    };
  },
  transformResult: defaultShaper,
};
