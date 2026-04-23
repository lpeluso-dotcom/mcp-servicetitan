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

interface LockState {
  heldSince: number;
}

export class CustomerSnapshotSingleflight {
  private locks: Map<number, LockState> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json<{ customerId: number }>();
    const { customerId } = body;

    if (url.pathname === '/acquire') {
      return Response.json(this.acquire(customerId));
    }
    if (url.pathname === '/release') {
      this.locks.delete(customerId);
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
