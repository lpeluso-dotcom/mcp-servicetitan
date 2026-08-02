// ============================================================
// assigned_vs_sold_estimate_audit — freshness disclosure (MB-1 / QUA-1141)
//
// This audit feeds commission/bonus review. Reading the `estimates` mirror
// raw meant a frozen or empty mirror rendered as "0 mismatches — attribution
// is clean", which is the most believable wrong answer the tool can give.
// The stamp is computed over the EXAMINED rows (pre-filter), so a clean
// audit over fresh rows still proves its own age.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assigned_vs_sold_estimate_audit } from '../assigned_vs_sold_estimate_audit';
import * as d1 from '../../../d1';

const ctx = { actor: 'test', correlation: 'c1' } as any;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const ARGS = { startDate: '2026-05-01', endDate: '2026-05-31' };

function primeMirror(rows: Array<Record<string, unknown>>) {
  return vi.spyOn(d1, 'readD1').mockResolvedValue({ rows } as any);
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
  it('the SELECT carries e.synced_at — the rows must be able to prove their age', async () => {
    const spy = primeMirror([]);
    await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(String(spy.mock.calls[0][1])).toMatch(/e\.synced_at/);
  });

  it('does NOT present "0 mismatches" as a clean audit when the mirror is empty', async () => {
    primeMirror([]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.summary.flagged).toBe(0);
    expect(out.summary.count_is_authoritative).toBe(false);
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out._warning).toMatch(/not proof/i);
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

  it('flags a frozen mirror as stale and withholds authority', async () => {
    primeMirror([clean(hoursAgo(24 * 30)), flagged(hoursAgo(24 * 30))]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.summary.flagged).toBe(1);
    expect(out.summary.count_is_authoritative).toBe(false);
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });

  it('keeps synced_at out of the emitted mismatch rows (stamp-only plumbing)', async () => {
    primeMirror([flagged(hoursAgo(1))]);
    const out: any = await assigned_vs_sold_estimate_audit.handler({} as any, ARGS, ctx);
    expect(out.mismatches[0].estimate_id).toBe(2);
    expect(out.mismatches[0].synced_at).toBeUndefined();
  });
});
