// ============================================================
// open_opportunities_pulitzer_feed — freshness disclosure (MB-1 / QUA-1141)
//
// This feed drives Pulitzer's daily open-opportunities report. Because it read
// the taylor-ai D1 mirror raw, an EMPTY `opportunities` table rendered as a
// confident `summary.count: 0` — and the daily report told everyone the board
// was clean. These tests pin the v2 (F1/F2/F5) fix: freshness comes from the
// TABLE-level MAX(synced_at) probe, not the returned rows' own synced_at —
// so a genuinely-empty table (MAX null) is 'unknown', a live table with zero
// matching rows is an HONEST zero, and old-but-final rows on a live table are
// never called stale.
//
// The handler issues THREE queries per call (cohort aggregate + row page +
// the fetchTableMax probe, via Promise.all) — the mock serves all of them by
// inspecting the SQL rather than queueing responses.
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

/**
 * Serve all three of the handler's queries: the fetchTableMax probe (matched
 * on `AS t,`) answers with `tableMax`, the cohort aggregate (matched on
 * COUNT(*)) gets totals derived from `rows`; everything else gets the rows.
 */
const primeMirror = (rows: Array<Record<string, unknown>>, tableMax: string | null) => {
  readD1Mock.mockImplementation((_env: unknown, sql: string) => {
    if (/AS t,/.test(sql)) {
      return Promise.resolve({ rows: [{ t: 'opportunities', m: tableMax }] });
    }
    if (/COUNT\(\*\)/.test(sql)) {
      return Promise.resolve({
        rows: [{
          cohort_count: rows.length,
          cohort_estimate_amount: rows.reduce((s, r) => s + Number(r.estimate_amount ?? 0), 0),
          cohort_sold_amount: rows.reduce((s, r) => s + Number(r.sold_estimate_amount ?? 0), 0),
        }],
      });
    }
    return Promise.resolve({ rows });
  });
};

/** The row-page query is the one that must carry synced_at — find it. */
const rowsQuerySql = (): string => {
  const call = readD1Mock.mock.calls.find(
    ([, sql]) => !/COUNT\(\*\)/.test(sql as string) && !/AS t,/.test(sql as string),
  );
  expect(call).toBeDefined();
  return call![1] as string;
};

beforeEach(() => readD1Mock.mockReset());

describe('the empty-mirror trap (the production incident: MAX(synced_at) is NULL)', () => {
  it('does NOT present a zero count as authoritative when the table cannot prove liveness', async () => {
    primeMirror([], null);

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r.summary.count).toBe(0);
    // The whole point: the zero is still reported, but flagged as unproven.
    expect(r.summary.count_is_authoritative).toBe(false);
    expect(r._freshness).toBe('unknown');
    expect(r._empty).toBe(true);
    expect(r._warning).toMatch(/not proof/i);
  });
});

describe('honest empty (F5): a live table with zero matching rows is a real zero', () => {
  it('marks a zero cohort authoritative when the table MAX is fresh — no scary warning', async () => {
    primeMirror([], hoursAgo(2));

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r.summary.count).toBe(0);
    expect(r.summary.count_is_authoritative).toBe(true);
    expect(r._freshness).toBe('fresh');
    expect(r._empty).toBe(true);
    expect(r._warning).toBeUndefined();
  });
});

describe('freshness is judged by the TABLE, not the returned rows (F1)', () => {
  it('marks a fresh mirror authoritative', async () => {
    primeMirror(
      [{ opportunity_id: 1, estimate_amount: 100, sold_estimate_amount: 0, synced_at: hoursAgo(1) }],
      hoursAgo(1),
    );

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r.summary.count).toBe(1);
    expect(r.summary.count_is_authoritative).toBe(true);
    expect(r._freshness).toBe('fresh');
    expect(r._warning).toBeUndefined();
  });

  it('old-but-final rows on a live table are NOT called stale (incremental-sync reality)', async () => {
    primeMirror(
      [{ opportunity_id: 1, estimate_amount: 0, sold_estimate_amount: 0, synced_at: hoursAgo(24 * 30) }],
      hoursAgo(1),
    );

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r._freshness).toBe('fresh');
    expect(r.summary.count_is_authoritative).toBe(true);
    expect(r._warning).toBeUndefined();
  });

  it('flags a frozen mirror (table MAX weeks old) as unknown and withholds authority', async () => {
    primeMirror(
      [{ opportunity_id: 1, estimate_amount: 0, sold_estimate_amount: 0, synced_at: hoursAgo(24 * 30) }],
      hoursAgo(24 * 30),
    );

    const r: any = await feed.handler(makeEnv(), {}, CTX);

    expect(r._freshness).toBe('unknown');
    expect(r.summary.count_is_authoritative).toBe(false);
    expect(r._warning).toMatch(/no row change in|indistinguishable/);
    expect(r._warning).toMatch(/opportunities/);
    expect(r._stale_hours).toBeGreaterThan(48);
  });
});

describe('the queries can actually answer the freshness question', () => {
  it('issues the fetchTableMax probe for the opportunities table', async () => {
    primeMirror([], hoursAgo(1));

    await feed.handler(makeEnv(), {}, CTX);

    const probe = readD1Mock.mock.calls.find(([, sql]) => /AS t,/.test(sql as string));
    expect(probe).toBeDefined();
    expect(probe![1]).toMatch(/MAX\(synced_at\)/);
    expect(probe![1]).toMatch(/FROM opportunities/);
  });

  it('SELECTs synced_at on the row page (degraded-mode fallback evidence)', async () => {
    primeMirror([], hoursAgo(1));

    await feed.handler(makeEnv(), {}, CTX);

    expect(rowsQuerySql()).toMatch(/o\.synced_at/);
  });

  it('names the mirror table it read, so the caveat is actionable', async () => {
    primeMirror([], hoursAgo(1));
    const r: any = await feed.handler(makeEnv(), {}, CTX);
    expect(r._mirror_table).toBe('opportunities');
    expect(r._tables).toHaveProperty('opportunities');
  });
});
