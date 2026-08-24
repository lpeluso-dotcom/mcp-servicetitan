// ============================================================
// CustomerSnapshotSingleflight — Durable Object for deduplicating
// concurrent customer_snapshot composite calls.
//
// Problem: two concurrent calls for the same customerId would both fan
// out to 7 downstream ST calls (14 total), burning rate-limit budget
// and producing redundant work.
//
// Solution: the first call acquires a per-customerId lock in this DO.
// Subsequent concurrent calls for the same ID wait on a promise that
// resolves when the first call completes. The result is served from the
// mv_customer_snapshot D1 cache — the first caller writes it, waiters read it.
//
// Protocol:
//   POST /acquire { customerId: number }
//     → 200 { acquired: true }   — caller is the active fetcher; it must POST /release when done
//     → 200 { acquired: false, waitMs: number } — caller should re-poll after waitMs
//   POST /release { customerId: number }
//     → 200 { ok: true }
// ============================================================

const LOCK_TTL_MS = 30_000; // if the fetcher crashes, release after 30s

// DO storage key holding the serialized lock table.
const STORAGE_KEY = 'locks';

interface LockState {
  heldSince: number;
}

export class CustomerSnapshotSingleflight {
  private state: DurableObjectState;
  private locks: Map<number, LockState> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
    // HIBERNATION SAFETY (Wave 2, workstream E item 4).
    //
    // This class used to keep `locks` in memory ONLY and never touch
    // state.storage. Cloudflare evicts idle Durable Objects, and every eviction
    // silently dropped every lock — the singleflight degraded to a no-op with
    // NO signal at all. The failure is invisible from outside: two concurrent
    // customer_snapshot calls each fan out to 7 downstream ST calls (14 total)
    // and nothing anywhere reports that dedup stopped working.
    //
    // The sibling StRateLimiter already guards against exactly this. Same
    // pattern here: blockConcurrencyWhile ensures no fetch() runs until the
    // lock table is loaded, so a revived instance cannot hand out a lock that
    // another caller is still holding.
    state.blockConcurrencyWhile(async () => {
      try {
        const stored = await state.storage.get<[number, LockState][]>(STORAGE_KEY);
        if (stored) this.locks = new Map(stored);
      } catch (e) {
        // Fail-open: an unreadable rehydrate degrades to the old
        // in-memory-only behaviour rather than wedging the DO on construction.
        // eslint-disable-next-line no-console
        console.error(`[snapshot-flight] lock rehydrate failed: ${(e as Error).message}`);
      }
    });
  }

  /** Write-through. Fail-open — persistence must never fail the caller's composite. */
  private async persist(): Promise<void> {
    try {
      await this.state.storage.put(STORAGE_KEY, [...this.locks]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[snapshot-flight] lock persist failed: ${(e as Error).message}`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json<{ customerId: number }>();
    const { customerId } = body;

    if (url.pathname === '/acquire') {
      const result = this.acquire(customerId);
      // Persist on BOTH outcomes: a denial can still have evicted a stale lock.
      await this.persist();
      return Response.json(result);
    }
    if (url.pathname === '/release') {
      this.locks.delete(customerId);
      await this.persist();
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unknown path' }, { status: 404 });
  }

  private acquire(customerId: number): { acquired: boolean; waitMs?: number } {
    const now = Date.now();
    const existing = this.locks.get(customerId);

    if (existing) {
      // Evict stale lock (fetcher crashed without releasing).
      if (now - existing.heldSince > LOCK_TTL_MS) {
        this.locks.delete(customerId);
      } else {
        // Another caller holds the lock — tell waiter to retry after a short back-off.
        const elapsed = now - existing.heldSince;
        const remaining = LOCK_TTL_MS - elapsed;
        return { acquired: false, waitMs: Math.min(remaining, 500) };
      }
    }

    this.locks.set(customerId, { heldSince: now });
    return { acquired: true };
  }
}
