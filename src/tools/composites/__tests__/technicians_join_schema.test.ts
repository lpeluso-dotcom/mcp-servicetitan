// ============================================================
// Regression guard — the `technicians` join-column drift.
//
// D1 `technicians` is keyed on `tech_id`. There is NO `technician_id` column
// on that table; `job_timesheets` is what carries `technician_id`. Three tools
// drifted onto the wrong side of that join and died at runtime with
// "no such column", while their unit tests kept passing because those tests
// mock readD1 and never look at the SQL.
//
// Live-verified 2026-07-28 against D1 `taylor-ai`
// (ba02a8c6-bcff-4119-b797-0b4250a3edcf):
//   SELECT name FROM pragma_table_info('technicians')
//     -> tech_id, name, business_unit, team, role, phone, email, active, synced_at
//   SELECT name FROM pragma_table_info('job_timesheets')
//     -> timesheet_id, job_id, appointment_id, technician_id, dispatched_on,
//        arrived_on, canceled_on, done_on, drive_minutes, working_minutes,
//        active, created_at, modified_at, synced_at
//
// These tests assert the emitted SQL only ever attributes real columns to the
// `technicians` table, so this class of drift cannot silently return.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tech_scorecard } from '../tech_scorecard';
import { tech_drive_time_summary } from '../tech_drive_time_summary';
import { job_cost_actuals } from '../job_cost_actuals';
import * as d1 from '../../../d1';
import * as helpers from '../../../composite-helpers';
import * as auth from '../../../auth';

const ctx = { actor: 'test', correlation: 'c1' } as any;

/** Live D1 schema for `technicians` — see header for provenance. */
const TECHNICIANS_COLUMNS = new Set([
  'tech_id',
  'name',
  'business_unit',
  'team',
  'role',
  'phone',
  'email',
  'active',
  'synced_at',
]);

/**
 * Collect every column reference the SQL attributes to the `technicians` table.
 *
 * Handles the two shapes used in this repo:
 *   1. `... JOIN technicians <alias> ON ...`  -> every `<alias>.<col>` in the statement
 *   2. `SELECT <cols> FROM technicians WHERE <col> ...` (no other table) -> bare identifiers
 */
function technicianColumnRefs(sql: string): string[] {
  const joined = sql.match(/\bjoin\s+technicians\s+(?:as\s+)?(\w+)/i);
  if (joined) {
    const alias = joined[1];
    const refs = sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'gi'));
    return [...refs].map((m) => m[1]);
  }

  const bare = sql.match(/\bfrom\s+technicians\b/i);
  if (!bare) return [];

  // Single-table statement: SELECT list + WHERE predicate identifiers are all
  // technicians columns. Strip aliases (`tech_id AS technician_id` -> tech_id)
  // and drop SQL keywords/placeholders.
  const selectList = sql.match(/\bselect\s+([\s\S]+?)\s+from\s+technicians\b/i)?.[1] ?? '';
  const wherePart = sql.match(/\bfrom\s+technicians\b([\s\S]*)$/i)?.[1] ?? '';
  const KEYWORDS = new Set([
    'where', 'and', 'or', 'in', 'limit', 'order', 'by', 'asc', 'desc',
    'as', 'null', 'is', 'not', 'select', 'from', 'on', 'group', 'having',
  ]);
  const refs: string[] = [];
  for (const expr of selectList.split(',')) {
    // `a AS b` -> a ; plain `a` -> a
    const col = expr.trim().split(/\s+as\s+/i)[0].trim();
    if (/^\w+$/.test(col) && !KEYWORDS.has(col.toLowerCase())) refs.push(col);
  }
  for (const m of wherePart.matchAll(/\b([a-z_]\w*)\b/gi)) {
    const tok = m[1];
    if (!KEYWORDS.has(tok.toLowerCase()) && tok.toLowerCase() !== 'technicians') refs.push(tok);
  }
  return refs;
}

function expectValidTechniciansSql(sql: string) {
  const refs = technicianColumnRefs(sql);
  expect(refs.length, `no technicians column refs parsed out of: ${sql}`).toBeGreaterThan(0);
  for (const col of refs) {
    expect(
      TECHNICIANS_COLUMNS.has(col),
      `SQL references technicians.${col}, which does not exist in D1. ` +
        `Real columns: ${[...TECHNICIANS_COLUMNS].join(', ')}. SQL:\n${sql}`,
    ).toBe(true);
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('technicians join column (D1 schema drift guard)', () => {
  it('tech_scorecard joins technicians on a real column', async () => {
    const spy = vi.spyOn(d1, 'readD1').mockResolvedValue({ rows: [] } as any);
    await tech_scorecard.handler({} as any, { weekStart: '2026-07-20', weekEnd: '2026-07-26' }, ctx);

    const sql = String(spy.mock.calls[0][1]);
    expect(sql).toMatch(/join\s+technicians/i);
    expectValidTechniciansSql(sql);
  });

  it('tech_drive_time_summary selects technicians on a real column', async () => {
    const spy = vi.spyOn(d1, 'readD1').mockResolvedValue({ rows: [] } as any);
    await tech_drive_time_summary.handler(
      {} as any,
      { technicianId: 57699315, startDate: '2026-07-01', endDate: '2026-07-27' },
      ctx,
    );

    const techSql = spy.mock.calls
      .map((c) => String(c[1]))
      .find((s) => /\bfrom\s+technicians\b/i.test(s));
    expect(techSql, 'tech_drive_time_summary never queried technicians').toBeDefined();
    expectValidTechniciansSql(techSql!);
  });

  it('job_cost_actuals looks up missing tech names on a real column', async () => {
    // The technicians lookup only fires when a timesheet tech is absent from
    // appointment_assignments — set that up explicitly.
    const spy = vi.spyOn(d1, 'readD1').mockImplementation(async (_env: any, sql: any) => {
      const s = String(sql);
      if (/\bfrom\s+job_timesheets\b/i.test(s)) {
        return {
          rows: [
            {
              timesheet_id: 1,
              job_id: 30035955,
              appointment_id: 1,
              technician_id: 57699315,
              dispatched_on: null,
              arrived_on: '2026-07-21T08:00:00',
              canceled_on: null,
              done_on: null,
              drive_minutes: 12,
              working_minutes: 90,
              active: 1,
            },
          ],
        } as any;
      }
      if (/\bfrom\s+technicians\b/i.test(s)) {
        return { rows: [{ technician_id: 57699315, name: 'Hunter A Herring', business_unit: 'HVAC' }] } as any;
      }
      // jobs / appointments / appointment_assignments / estimates
      return { rows: [] } as any;
    });

    vi.spyOn(auth, 'authHeaders').mockReturnValue({});
    // stRead is evaluated eagerly to build the gatherFetches argument, so it
    // must be stubbed too — mocking gatherFetches alone still hits env.ST_PROXY.
    vi.spyOn(helpers, 'stRead').mockResolvedValue(null as any);
    vi.spyOn(helpers, 'gatherFetches').mockResolvedValue({
      results: { invoice: null },
      partial: false,
      failures: [],
    } as any);

    await job_cost_actuals.handler({ ST_TENANT_ID: '431848990' } as any, { jobId: 30035955 }, ctx);

    const techSql = spy.mock.calls
      .map((c) => String(c[1]))
      .find((s) => /\bfrom\s+technicians\b/i.test(s));
    expect(techSql, 'job_cost_actuals never queried technicians').toBeDefined();
    expectValidTechniciansSql(techSql!);
  });
});
