// ============================================================
// open_opportunities_pulitzer_feed — freshness disclosure (MB-1 / QUA-1141)
//
// This feed drives Pulitzer's daily open-opportunities report. Because it read
// the taylor-ai D1 mirror raw, an EMPTY `opportunities` table rendered as a
// confident `summary.count: 0` — and the daily report told everyone the board
// was clean. These tests pin the fix: a zero from the mirror must never be
// presented as an authoritative zero.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readD1Mock = vi.fn();
vi.mock('../../../d1', () => ({
  readD1: (...args: unknown[]) => readD1Mock(...args),
}));

import { open_opportunities_pulitzer_feed as feed } from '../open_opportunities_pulitzer_feed';

const CTX = { actor: 'test', correlation: 'c1' };
const makeEnv = (): any => ({ ST_PROXY: { fetch: vi.fn() }, MCP_SYNC_KEY: 'k' });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => readD1Mock.mockReset());

describe('the empty-mirror trap', () => {
  it('does NOT present a zero count as authoritative when the mirror is empty', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r.summary.count).toBe(0);
    // The whole point: the zero is still reported, but flagged as unproven.
    expect(r.summary.count_is_authoritative).toBe(false);
    expect(r._freshness).toBe('unknown');
    expect(r._empty).toBe(true);
    expect(r._warning).toMatch(/not proof/i);
  });
});

describe('freshness is disclosed on real data', () => {
  it('marks a fresh mirror authoritative', async () => {
    readD1Mock.mockResolvedValueOnce({
      rows: [{ opportunity_id: 1, estimate_amount: 100, sold_estimate_amount: 0, synced_at: hoursAgo(1) }],
    });

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r.summary.count).toBe(1);
    expect(r.summary.count_is_authoritative).toBe(true);
    expect(r._freshness).toBe('fresh');
    expect(r._warning).toBeUndefined();
  });

  it('flags a frozen mirror as stale and withholds authority', async () => {
    // The job_timesheets failure mode: rows present, but a month old.
    readD1Mock.mockResolvedValueOnce({
      rows: [{ opportunity_id: 1, estimate_amount: 0, sold_estimate_amount: 0, synced_at: hoursAgo(24 * 30) }],
    });

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r._freshness).toBe('stale');
    expect(r.summary.count_is_authoritative).toBe(false);
    expect(r._warning).toMatch(/STALE DATA/);
    expect(r._stale_hours).toBeGreaterThan(48);
  });
});

describe('the query can actually answer the freshness question', () => {
  it('SELECTs synced_at — without it the feed cannot know its own age', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    await feed.handler(makeEnv(), {}, CTX);

    const [, sql] = readD1Mock.mock.calls[0];
    expect(sql).toMatch(/o\.synced_at/);
  });

  it('names the mirror table it read, so the caveat is actionable', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    const r: any = await feed.handler(makeEnv(), {}, CTX);
    expect(r._mirror_table).toBe('opportunities');
  });
});
