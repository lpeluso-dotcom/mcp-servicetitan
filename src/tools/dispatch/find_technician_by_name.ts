// ============================================================
// find_technician_by_name — resolve a tech name to an ID + profile
//
// Standalone read tool wrapping name-resolver's resolveTechnician()
// (same exact > prefix > contains matcher already used internally by
// list_jobs_today / dispatch_override_audit's technicianName arg), then
// hydrates the match against the technicians D1 row — same shape
// identify_tech_by_phone returns for its tier-2 (canonical) lookup.
//
// Exists because no tool exposed name->ID resolution as a first-class,
// discoverable call: callers had to reverse-engineer a tech's ID via
// job timesheets or job_cost_actuals before st_list_appointments /
// payroll_job_timesheets_list / job_cost_actuals (all ID-only) would work.
// ============================================================

import { z } from 'zod';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';
import { resolveTechnician } from '../../name-resolver';
import { queryD1First } from '../../d1-proxy';
import { stampMirrorFreshness, type FreshnessStamp } from '../../mirror-freshness';
import type { Env } from '../../env';

interface Args {
  name: string;
}

interface FoundResult {
  status: 'found';
  technician_id: number;
  technician_name: string;
  business_unit: string | null;
  role: string | null;
  resolved: 'numeric' | 'exact' | 'prefix' | 'contains';
}

interface AmbiguousResult {
  status: 'ambiguous';
  resolved: 'exact' | 'prefix' | 'contains';
  candidates: { id: number; name: string }[];
}

interface NotFoundResult {
  status: 'not_found';
  resolved_id: number;
  /** MB-1 / QUA-1141: a miss is a claim about the MIRROR, not ServiceTitan. */
  _not_found_caveat: string;
}

// The hydration read hits the `technicians` D1 mirror, so found/not_found
// carry the mirror-freshness stamp; ambiguous never reaches that read.
type Result =
  | (FoundResult & FreshnessStamp)
  | AmbiguousResult
  | (NotFoundResult & FreshnessStamp);

export const find_technician_by_name: ToolDef<Args> = {
  name: 'find_technician_by_name',
  description:
    'Resolve a technician name (full or partial) to their technicianId and roster profile. ' +
    'Uses exact > prefix > contains matching against the active technicians roster; a numeric string ' +
    'passes through as a direct ID lookup. Use this BEFORE calling ID-only tools ' +
    '(st_list_appointments, payroll_job_timesheets_list, job_cost_actuals, assign_technicians) when you ' +
    'only have a tech\'s name. Source: D1 (technicians table via taylor-ai proxy).',
  zodSchema: {
    name: z.string().min(1).describe('Technician name, full or partial (e.g. "Brooks Hunsucker" or "Brooks"). Also accepts a numeric technicianId as a string.'),
  },
  stEndpoint: { method: 'GET', path: 'd1://technicians', source: 'd1' },
  async handler(env: Env, args: Args, ctx?: { correlation?: string }): Promise<Result> {
    const correlation = ctx?.correlation;
    const r = await resolveTechnician(env, args.name, 'read');

    if (r.ambiguous) {
      return { status: 'ambiguous', resolved: r.resolved as 'exact' | 'prefix' | 'contains', candidates: r.candidates ?? [] };
    }

    const row = await queryD1First<{
      tech_id: number;
      name: string;
      business_unit: string | null;
      role: string | null;
      synced_at: string | null;
    }>(
      env,
      `SELECT tech_id, name, business_unit, role, synced_at FROM technicians WHERE tech_id = ? AND active = 1`,
      [r.id],
      { correlation, tag: 'find_technician_by_name' },
    );

    if (!row) {
      // MB-1 / QUA-1141: not_found means "not in the MIRROR" — a new hire is
      // absent until the next technicians sync, so a miss is not proof the
      // tech doesn't exist in ServiceTitan.
      return {
        status: 'not_found',
        resolved_id: r.id,
        ...stampMirrorFreshness([], { table: 'technicians' }),
        _not_found_caveat:
          `No active row for technician ${r.id} in the taylor-ai D1 mirror. This does NOT prove ` +
          `the tech does not exist in ServiceTitan — new hires are missing until the next ` +
          `technicians sync. Confirm against live ST before acting on this.`,
      };
    }

    return {
      status: 'found',
      technician_id: row.tech_id,
      technician_name: row.name,
      business_unit: row.business_unit,
      role: row.role,
      resolved: r.resolved,
      // MB-1 / QUA-1141: a hit off a frozen mirror may be an ex-tech.
      ...stampMirrorFreshness([row], { table: 'technicians' }),
    };
  },
  transformResult: defaultShaper,
};
