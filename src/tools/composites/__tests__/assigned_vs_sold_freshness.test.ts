// ============================================================
// assigned_vs_sold_estimate_audit — freshness disclosure (MB-1 / QUA-1141)
//
// This audit feeds commission/bonus review. Reading the `estimates` mirror
// raw meant a frozen or empty mirror rendered as "0 mismatches — attribution
// is clean", which is the most believable wrong answer the tool can give.
// v2 (F1/F5): freshness comes from the estimates table's MAX(synced_at)
// probe, so a clean audit on a LIVE mirror is an honest clean audit, and
// old-but-final examined rows are never called stale.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assigned_vs_sold_estimate_audit } from '../assigned_vs_sold_estimate_audit';
import { fetchMirrorTableMax, readMirror } from '../../../mirror-pg';

vi.mock('../../../mirror-pg', () => ({
  readMirror: vi.fn(),
  fetchMirrorTableMax: vi.fn(),
}));

const ctx = { actor: 'test', correlation: 'c1' } as any;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const ARGS = { startDate: '2026-05-01', endDate: '2026-05-31' };

/** Prime the audit read and table-level freshness probe. */
function primeMirror(
  rows: Array<Record<string, unknown>>,
  tableMax: string | null = hoursAgo(1),
) {
  vi.mocked(readMirror).mockResolvedValue(rows as any);
  vi.mocked(fetchMirrorTableMax).mockResolvedValue({ estimates: tableMax });
  return vi.mocked(readMirror);
}

/** A flagged row (Sold, blank sold_by) with a controllable synced_at. */
const flagged = (synced_at: string | null) => ({
  estimate_id: 2, job_id: 101, status: 'Sold', total: 700, sold_by: '',
  modified_at: '2026-05-15T13:00:00Z', job_business_unit: 'PSR', job_type: 'SC',
  job_techs_csv: 'Brooks Hunsucker', synced_at,
});

/** A clean row — examined but never emitted. */
const clean = (synced_at: string | null) => ({
  estimate_id: 1, job_id: 100, status: 'Sold', total: 500, sold_by: 'Brooks Hunsucker',
  modified_at: '2026-05-15T12:00:00Z', job_business_unit: 'PSR', job_type: 'SC',
  job_techs_csv: 'Brooks Hunsucker', synced_at,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('assigned_vs_sold_estimate_audit freshness disclosure (MB-1 / QUA-1141)', () => {
  it('reads the Supabase mirror and carries e.synced_at for the page-age disclosure', async () => {
    const spy = primeMirror([]);
    await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(String(spy.mock.calls[0][1])).toMatch(/e\.synced_at/);
    expect(String(spy.mock.calls[0][1])).toContain('mirror.estimates');
  });

  it('does NOT present "0 mismatches" as a clean audit when the mirror cannot prove liveness', async () => {
    primeMirror([], null);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.summary.flagged).toBe(0);
    expect(out.summary.count_is_authoritative).toBe(false);
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out._warning).toMatch(/not proof/i);
  });

  it('a zero-row window on a LIVE mirror is an honest clean window (F5)', async () => {
    primeMirror([]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.summary.flagged).toBe(0);
    expect(out.summary.count_is_authoritative).toBe(true);
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('stamps a fresh mirror authoritative — even when the audit flags nothing', async () => {
    primeMirror([clean(hoursAgo(3))]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.summary.flagged).toBe(0);
    expect(out.summary.count_is_authoritative).toBe(true);
    expect(out._freshness).toBe('fresh');
    expect(out._mirror_table).toBe('estimates');
    expect(out._warning).toBeUndefined();
  });

  it('old-but-final examined rows on a LIVE mirror are not called stale (F1)', async () => {
    primeMirror([clean(hoursAgo(24 * 30))]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out._freshness).toBe('fresh');
    expect(out.summary.count_is_authoritative).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('flags a frozen mirror (table MAX weeks old) as unknown and withholds authority', async () => {
    primeMirror([clean(hoursAgo(24 * 30)), flagged(hoursAgo(24 * 30))], hoursAgo(24 * 30));
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.summary.flagged).toBe(1);
    expect(out.summary.count_is_authoritative).toBe(false);
    expect(out._freshness).toBe('unknown');
    expect(out._warning).toMatch(/no row change in|indistinguishable/);
  });

  it('keeps synced_at out of the emitted mismatch rows (stamp-only plumbing)', async () => {
    primeMirror([flagged(hoursAgo(1))]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.mismatches[0].estimate_id).toBe(2);
    expect(out.mismatches[0].synced_at).toBeUndefined();
  });
});
