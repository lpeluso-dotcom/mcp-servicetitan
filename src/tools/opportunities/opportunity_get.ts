import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import { stampMirrorFreshness, fetchTableMax } from '../../mirror-freshness';
import type { ToolDef } from '../index';

interface Args {
  opportunityId: number;
}

interface OpportunityRow {
  opportunity_id: number;
  job_id: number | null;
  location_id: number | null;
  project_id: number | null;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  status: string | null;
  follow_up_date: string | null;
  last_follow_up_date: string | null;
  follow_ups_count: number | null;
  estimate_amount: number | null;
  sold_estimate_amount: number | null;
  open_estimates_count: number | null;
  sold_estimates_count: number | null;
  recommended_estimates_count: number | null;
  job_type_name: string | null;
  business_unit: string | null;
  technicians_json: string | null;
  created_by_users_json: string | null;
  location_name: string | null;
  location_address: string | null;
  created_date: string | null;
  modified_date: string | null;
  job_completed_on: string | null;
  active: number;
  synced_at: string | null;
}

interface EstimateRow {
  estimate_id: number;
  job_id: number | null;
  project_id: number | null;
  name: string | null;
  status: string | null;
  total: number | null;
  sold_by: string | null;
  active: number;
  modified_at: string | null;
}

function parseJsonArray(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const opportunity_get: ToolDef<Args> = {
  name: 'opportunity_get',
  description:
    'Get a single Opportunity from D1 (`opportunities` table) plus any linked Estimates for the same job/project. ' +
    'Returns the parent Opportunity row + child estimates array so a caller has the full follow-up context in one call. ' +
    'Source: D1.',
  zodSchema: {
    opportunityId: z.number().int().positive().describe('Opportunity ID'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/sales/v2/tenant/{tid}/opportunities/{id}',
    source: 'd1',
  },
  async handler(env, args, { correlation }) {
    try {
      const [{ rows }, tableMax] = await Promise.all([
        readD1<OpportunityRow>(
          env,
          'SELECT * FROM opportunities WHERE opportunity_id = ? LIMIT 1',
          [args.opportunityId],
        ),
        fetchTableMax(env, ['opportunities']),
      ]);
      if (rows.length === 0) {
        // MB-1 / QUA-1141: `not_found` here is a claim about the MIRROR, not
        // about ServiceTitan. The table-level probe distinguishes the two
        // cases: on a LIVE mirror this stamps fresh and reads as "not in the
        // mirror as of the last sync"; on an empty/frozen mirror (which has
        // happened in production) it stamps unknown/stale with a warning.
        return {
          status: 'not_found',
          opportunity: null,
          estimates: [],
          _source: 'd1',
          ...stampMirrorFreshness(rows, { table: 'opportunities', tableMax }),
          _not_found_caveat:
            `No row for opportunity ${args.opportunityId} in the taylor-ai D1 mirror as of its ` +
            `last sync (see _freshness). If the mirror is not proven fresh this does NOT ` +
            `establish that the opportunity is absent from ServiceTitan — confirm against live ` +
            `ST before acting on it.`,
        };
      }
      const opp = rows[0];

      // Join on job_id (preferred) or project_id. Both filters; LEFT JOIN doesn't
      // really apply because we're querying the estimates table directly.
      let estimates: EstimateRow[] = [];
      if (opp.job_id !== null || opp.project_id !== null) {
        const where: string[] = [];
        const params: unknown[] = [];
        if (opp.job_id !== null) {
          where.push('job_id = ?');
          params.push(opp.job_id);
        }
        if (opp.project_id !== null) {
          where.push('project_id = ?');
          params.push(opp.project_id);
        }
        // taylor-ai estimates: title is `summary`, timestamp is `modified_date`;
        // alias both so the EstimateRow shape stays stable.
        const sql =
          `SELECT estimate_id, job_id, project_id, summary AS name, status, total, sold_by, active, modified_date AS modified_at ` +
          `FROM estimates WHERE (${where.join(' OR ')}) ORDER BY modified_date DESC LIMIT 25`;
        const { rows: estRows } = await readD1<EstimateRow>(env, sql, params);
        estimates = estRows;
      }

      return {
        status: 'success',
        opportunity: {
          ...opp,
          active: opp.active !== 0,
          technicians: parseJsonArray(opp.technicians_json),
          created_by_users: parseJsonArray(opp.created_by_users_json),
        },
        estimates: estimates.map((e) => ({ ...e, active: e.active !== 0 })),
        _source: 'd1',
        ...stampMirrorFreshness(rows, { table: 'opportunities', tableMax }),
      };
    } catch (err) {
      throw new McpError(
        'upstream_error',
        `opportunity_get failed: ${(err as Error).message}`,
        { correlation },
      );
    }
  },
  transformResult: defaultShaper,
};
