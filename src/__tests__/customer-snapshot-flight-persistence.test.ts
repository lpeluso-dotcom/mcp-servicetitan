// ============================================================
// customer-snapshot-flight-persistence.test.ts — Wave 2, workstream E item 4.
//
// THE BUG. CustomerSnapshotSingleflight held its locks in a plain in-memory
// `Map` and never touched `state.storage`. Cloudflare evicts idle Durable
// Objects, and every eviction silently dropped every lock — the singleflight
// degraded to a no-op with NO signal at all. The failure mode is invisible:
// two concurrent customer_snapshot calls each fan out to 7 downstream ST calls
// and nothing anywhere reports that dedup stopped working.
//
// Its sibling StRateLimiter already guards against exactly this with
// blockConcurrencyWhile + state.storage (see h3_do_hibernation.test.ts). This
// follows that established pattern, and this file mirrors that file's
// eviction-simulation strategy: mutate one instance, then construct a NEW
// instance over the SAME storage and assert the state carried over.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { CustomerSnapshotSingleflight } from '../durable/customer-snapshot-flight';

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    map: m,
    get: vi.fn(async <T = unknown>(k: string) => m.get(k) as T),
    put: vi.fn(async (k: string, v: unknown) => {
      m.set(k, v);
    }),
    delete: vi.fn(async (k: string) => m.delete(k)),
  };
}

function makeDOState(storage: ReturnType<typeof makeStorage>): any {
  return {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
  };
}

function call(
  df: CustomerSnapshotSingleflight,
  path: '/acquire' | '/release',
  customerId: number
) {
  return df
    .fetch(
      new Request(`https://do${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId }),
      })
    )
    .then((r) => r.json<{ acquired?: boolean; waitMs?: number; ok?: boolean }>());
}

describe('CustomerSnapshotSingleflight — hibernation safety', () => {
  it('persists the lock to DO storage when it is acquired', async () => {
    const storage = makeStorage();
    const df = new CustomerSnapshotSingleflight(makeDOState(storage));

    const r = await call(df, '/acquire', 42);
    expect(r.acquired).toBe(true);
    expect(storage.put).toHaveBeenCalled();
    expect(storage.map.has('locks')).toBe(true);
  });

  it('KEEPS the lock across a simulated eviction — the actual regression', async () => {
    const storage = makeStorage();

    // Caller A acquires and starts its 7-call fan-out.
    const first = new CustomerSnapshotSingleflight(makeDOState(storage));
    expect((await call(first, '/acquire', 7)).acquired).toBe(true);

    // Cloudflare evicts the idle DO mid-flight. A fresh instance rehydrates.
    const revived = new CustomerSnapshotSingleflight(makeDOState(storage));

    // Caller B must still be told to wait. Before this fix it was handed the
    // lock and duplicated the entire fan-out.
    const second = await call(revived, '/acquire', 7);
    expect(second.acquired).toBe(false);
    expect(second.waitMs).toBeGreaterThan(0);
  });

  it('persists the release so a revived instance hands the lock to the next caller', async () => {
    const storage = makeStorage();

    const df = new CustomerSnapshotSingleflight(makeDOState(storage));
    await call(df, '/acquire', 9);
    await call(df, '/release', 9);

    const revived = new CustomerSnapshotSingleflight(makeDOState(storage));
    expect((await call(revived, '/acquire', 9)).acquired).toBe(true);
  });

  it('still evicts a stale lock after LOCK_TTL_MS across a rehydrate', async () => {
    const storage = makeStorage();
    const df = new CustomerSnapshotSingleflight(makeDOState(storage));

    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(t0);
      expect((await call(df, '/acquire', 5)).acquired).toBe(true);

      // Fetcher crashed without releasing; 31s later a new instance rehydrates.
      spy.mockReturnValue(t0 + 31_000);
      const revived = new CustomerSnapshotSingleflight(makeDOState(storage));
      expect((await call(revived, '/acquire', 5)).acquired).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('starts clean when storage is empty', async () => {
    const storage = makeStorage();
    const df = new CustomerSnapshotSingleflight(makeDOState(storage));
    expect((await call(df, '/acquire', 1)).acquired).toBe(true);
  });

  it('keeps locks for different customers independent across a rehydrate', async () => {
    const storage = makeStorage();
    const df = new CustomerSnapshotSingleflight(makeDOState(storage));
    await call(df, '/acquire', 100);

    const revived = new CustomerSnapshotSingleflight(makeDOState(storage));
    expect((await call(revived, '/acquire', 100)).acquired).toBe(false);
    expect((await call(revived, '/acquire', 200)).acquired).toBe(true);
  });

  it('serves 404 on an unknown path', async () => {
    const storage = makeStorage();
    const df = new CustomerSnapshotSingleflight(makeDOState(storage));
    const resp = await df.fetch(
      new Request('https://do/nope', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: 1 }),
      })
    );
    expect(resp.status).toBe(404);
  });

  it('a storage failure never breaks the lock protocol (fail-open)', async () => {
    const storage = makeStorage();
    storage.put.mockRejectedValue(new Error('storage down'));
    const df = new CustomerSnapshotSingleflight(makeDOState(storage));
    // Degrades to the old in-memory-only behaviour rather than throwing at the
    // caller, which would fail the whole customer_snapshot composite.
    expect((await call(df, '/acquire', 3)).acquired).toBe(true);
    expect((await call(df, '/acquire', 3)).acquired).toBe(false);
  });
});
