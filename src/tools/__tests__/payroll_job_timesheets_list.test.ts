import { describe, it, expect, vi } from 'vitest';
import { payroll_job_timesheets_list } from '../payroll/payroll_job_timesheets_list';

// Probe job 77423990 (Brooks Hunsucker, 2026-02-20) shape.
const PROBE_ROW = {
  id: 77457122,
  jobId: 77423990,
  appointmentId: 77423991,
  technicianId: 75766687,
  dispatchedOn: '2026-02-20T16:38:00Z',
  arrivedOn: '2026-02-20T17:02:00Z',
  canceledOn: null,
  doneOn: '2026-02-20T19:34:00Z',
  createdOn: '2026-02-20T16:38:00Z',
  modifiedOn: '2026-02-20T19:34:00Z',
  active: true,
};

const PROBE_D1_ROW = {
  timesheet_id: 77457122,
  job_id: 77423990,
  appointment_id: 77423991,
  technician_id: 75766687,
  dispatched_on: '2026-02-20T16:38:00Z',
  arrived_on: '2026-02-20T17:02:00Z',
  canceled_on: null,
  done_on: '2026-02-20T19:34:00Z',
  drive_minutes: 24,
  working_minutes: 152,
  active: 1,
  created_at: '2026-02-20T16:38:00Z',
  modified_at: '2026-02-20T19:34:00Z',
  // synced_at within the freshness window (1h ago) so the freshness check
  // keeps us on the D1 path.
  synced_at: new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
};

// Build an env that handles both /api/sql/read (D1) and /api/st/read (live ST).
// Each URL gets its own response from `responses`.
function envWith(responses: Array<{ urlContains: string; body: object; status?: number }>) {
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    for (const r of responses) {
      if (u.includes(r.urlContains)) {
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ success: false, error: 'no mock match' }), { status: 500 });
  });
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('payroll_job_timesheets_list', () => {
  describe('D1 mode (default auto)', () => {
    it('serves a single-job query from D1 when fresh', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [PROBE_D1_ROW] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990 },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('d1');
      expect(out.count).toBe(1);
      expect(out.timesheets[0].drive_minutes).toBe(24);
      expect(out.timesheets[0].working_minutes).toBe(152);
      expect(out.timesheets[0].active).toBe(true);
    });

    it('falls back to live ST on empty D1 with a jobId filter', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
        { urlContains: '/api/st/read', body: { data: [PROBE_ROW] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990 },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('live');
      expect(out._fallback_reason).toBe('d1_empty');
      expect(out.timesheets[0].drive_minutes).toBe(24);
    });

    it('returns empty D1 result without fallback when no jobId/appointmentId filter is set', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        {},
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('d1');
      expect(out.count).toBe(0);
    });

    it("source: 'd1' forces D1 only (no live fallback even on empty)", async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990, source: 'd1' },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('d1');
      expect(out.count).toBe(0);
      // Should not have attempted /api/st/read.
      const calls = (env.ST_PROXY.fetch as any).mock.calls;
      expect(calls.every((c: any[]) => !String(c[0]).includes('/api/st/read'))).toBe(true);
    });

    // QA regression — without this guard, appointmentId+source:'auto' on empty
    // D1 fell through to the live BATCH endpoint, which only forwards
    // page/pageSize/active/modifiedOnOrAfter. That dropped appointmentId and
    // returned unrelated timesheets labeled _source: 'live'. Same bug class
    // applies to technicianId, active, arrived-window filters.
    it('appointmentId on empty D1 does NOT fall back to live (cannot honor filter)', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { appointmentId: 5555 },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('d1');
      expect(out.count).toBe(0);
      expect(out._fallback_skipped).toBe('unsupported_live_filter:appointmentId');
      const calls = (env.ST_PROXY.fetch as any).mock.calls;
      expect(calls.every((c: any[]) => !String(c[0]).includes('/api/st/read'))).toBe(true);
    });

    it('technicianId on empty D1 does NOT fall back to live', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { technicianId: 999 },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('d1');
      expect(out._fallback_skipped).toBe('unsupported_live_filter:technicianId');
    });

    it('arrived-window on empty D1 does NOT fall back to live', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { arrivedOnOrAfter: '2026-01-01', arrivedOnOrBefore: '2026-01-31' },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('d1');
      expect(out._fallback_skipped).toContain('arrivedOnOrAfter');
      expect(out._fallback_skipped).toContain('arrivedOnOrBefore');
    });

    it('jobId + unsupported filter on empty D1 still does NOT fall back (mixed-filter case)', async () => {
      const env = envWith([
        { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990, technicianId: 999 },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      // jobId would normally trigger fallback, but technicianId can't be
      // honored — falling back would silently widen the result. Stay D1.
      expect(out._source).toBe('d1');
      expect(out._fallback_skipped).toBe('unsupported_live_filter:technicianId');
    });
  });

  describe("live mode (source: 'live')", () => {
    it('single-job mode: returns slim shape with computed drive/working minutes', async () => {
      const env = envWith([
        { urlContains: '/api/st/read', body: { data: [PROBE_ROW] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990, source: 'live' },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out.count).toBe(1);
      expect(out.has_more).toBe(false);
      expect(out._source).toBe('live');
      expect(out.timesheets[0]).toEqual({
        timesheet_id: 77457122,
        job_id: 77423990,
        appointment_id: 77423991,
        technician_id: 75766687,
        dispatched_on: '2026-02-20T16:38:00Z',
        arrived_on: '2026-02-20T17:02:00Z',
        canceled_on: null,
        done_on: '2026-02-20T19:34:00Z',
        drive_minutes: 24,
        working_minutes: 152,
        active: true,
        created_on: '2026-02-20T16:38:00Z',
        modified_on: '2026-02-20T19:34:00Z',
      });
      const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F000000000%2Fjobs%2F77423990%2Ftimesheets');
      expect(calledUrl).not.toContain('page%3D');
      expect(calledUrl).not.toContain('modifiedOnOrAfter');
    });

    it('batch mode: paginates and forwards modifiedOnOrAfter + active=Any', async () => {
      const env = envWith([
        { urlContains: '/api/st/read', body: { data: [PROBE_ROW], hasMore: true } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { modifiedOnOrAfter: '2026-05-01T00:00:00Z', page: 2, pageSize: 250, source: 'live' },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out.count).toBe(1);
      expect(out.has_more).toBe(true);
      expect(out.timesheets[0].drive_minutes).toBe(24);
      expect(out.timesheets[0].working_minutes).toBe(152);
      const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F000000000%2Fjobs%2Ftimesheets');
      expect(calledUrl).toContain('page%3D2');
      expect(calledUrl).toContain('pageSize%3D250');
      expect(calledUrl).toContain('active%3DAny');
      expect(calledUrl).toContain('modifiedOnOrAfter%3D2026-05-01T00%253A00%253A00Z');
    });

    it('null timestamps produce null drive_minutes / working_minutes', async () => {
      const inProgress = {
        ...PROBE_ROW,
        id: 9999,
        arrivedOn: undefined,
        doneOn: undefined,
      };
      const env = envWith([
        { urlContains: '/api/st/read', body: { data: [inProgress] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990, source: 'live' },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out.timesheets[0].arrived_on).toBeNull();
      expect(out.timesheets[0].done_on).toBeNull();
      expect(out.timesheets[0].drive_minutes).toBeNull();
      expect(out.timesheets[0].working_minutes).toBeNull();
    });

    it('throws McpError on upstream failure', async () => {
      const env = envWith([
        { urlContains: '/api/st/read', body: {}, status: 503 },
      ]);
      await expect(
        payroll_job_timesheets_list.handler(
          env,
          { jobId: 1, source: 'live' },
          { actor: 'test', correlation: 'c1' },
        ),
      ).rejects.toThrow(/readST 503 on \/payroll\/v2\/tenant\/.*\/jobs\/1\/timesheets/);
    });

    // QA regression — explicit 'live' with a filter the live endpoint cannot
    // honor must fail loud, not silently widen the result set.
    it("rejects source: 'live' + appointmentId (live endpoint cannot filter by appointmentId)", async () => {
      const env = envWith([
        { urlContains: '/api/st/read', body: { data: [] } },
      ]);
      await expect(
        payroll_job_timesheets_list.handler(
          env,
          { appointmentId: 5555, source: 'live' },
          { actor: 'test', correlation: 'c1' },
        ),
      ).rejects.toThrow(/cannot honor filter\(s\): appointmentId/);
      // Live ST must NOT have been called.
      const calls = (env.ST_PROXY.fetch as any).mock.calls;
      expect(calls.every((c: any[]) => !String(c[0]).includes('/api/st/read'))).toBe(true);
    });

    it("rejects source: 'live' + technicianId / active / arrived-window", async () => {
      const env = envWith([
        { urlContains: '/api/st/read', body: { data: [] } },
      ]);
      await expect(
        payroll_job_timesheets_list.handler(
          env,
          { technicianId: 999, active: true, source: 'live' },
          { actor: 'test', correlation: 'c1' },
        ),
      ).rejects.toThrow(/cannot honor filter\(s\): technicianId, active/);
    });

    it("source: 'live' + jobId + modifiedOnOrAfter passes through (both are honored)", async () => {
      const env = envWith([
        { urlContains: '/api/st/read', body: { data: [PROBE_ROW] } },
      ]);
      const out = (await payroll_job_timesheets_list.handler(
        env,
        { jobId: 77423990, modifiedOnOrAfter: '2026-01-01T00:00:00Z', source: 'live' },
        { actor: 'test', correlation: 'c1' },
      )) as any;
      expect(out._source).toBe('live');
      expect(out.count).toBe(1);
    });
  });
});
