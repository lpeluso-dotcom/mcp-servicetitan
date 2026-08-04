// ============================================================
// titan_advisor_score — ServiceTitan Titan Advisor adoption score over a date
// window, from the Woz gold warehouse (Supabase). Daily snapshots landed from
// ST report 79127569 by qsc-hopper.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { sbSelect } from '../../supabase';
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
    from: z.string().describe("Window start, ISO 'YYYY-MM-DD' (inclusive)."),
    to: z.string().describe("Window end, ISO 'YYYY-MM-DD' (inclusive)."),
    section: z.string().optional().describe(
      'Restrict the section breakdown (and detail rows, if requested) to one section, e.g. ' +
      '"Pricebook", "Selling & Performing Work", "Job Booking & Dispatching".'),
    detail: z.coerce.boolean().optional().describe(
      'Include per-feature rows (131/day). Off by default — use it to find which features ' +
      'are dragging a section down.'),
  },
  async handler(env, args) {
    const window = `snapshot_date=gte.${args.from}&snapshot_date=lte.${args.to}`;
    const sectionFilter = args.section
      ? `&section_name=eq.${encodeURIComponent(args.section)}`
      : '';

    const daily = await sbSelect<SnapRow[]>(
      env, `snap_titan_advisor_daily?${window}&order=snapshot_date.asc`, 'gold');

    const sections = await sbSelect<SectionRow[]>(
      env,
      `agg_titan_advisor_section_daily?${window}${sectionFilter}` +
      `&order=snapshot_date.asc,section_name.asc`,
      'gold');

    const features = args.detail
      ? await sbSelect<FeatureRow[]>(
          env,
          `fct_titan_advisor_feature_daily?${window}${sectionFilter}` +
          `&order=snapshot_date.asc,section_name.asc,feature_name.asc`,
          'gold')
      : undefined;

    return {
      window: { from: args.from, to: args.to },
      daily,
      sections,
      ...(features ? { features } : {}),
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
