// ============================================================
// StRateLimiter — Durable Object for per-ST-endpoint-family rate limiting.
//
// One DO instance per endpoint family (CRM, JPM, Pricebook, Memberships,
// Dispatch, Reporting, Telecom, Forms, Tasks, Accounting).
// Strongly consistent counters persisted to DO storage so they survive
// hibernation (CF evicts idle DO instances after ~10s).
//
// Protocol (Workers call via RPC fetch):
//   POST /check   { family: string }
//     → 200 { allowed: true } | 200 { allowed: false, retryAfter: number }
//   POST /backoff { family: string, retryAfter: number }
//     → 200 { ok: true }  — absorbs ST 429 Retry-After, halves rate for 60s
// ============================================================

export const FAMILIES = [
  'crm', 'jpm', 'pricebook', 'memberships',
  'dispatch', 'reporting', 'telecom', 'forms', 'tasks', 'accounting',
] as const;
export type Family = (typeof FAMILIES)[number];

const WINDOW_MS = 60_000;
const AGGREGATE_CAP = 80;

const FAMILY_CAP: Record<Family, number> = {
  crm: 60, jpm: 60, pricebook: 30, memberships: 30,
  dispatch: 40, reporting: 20, telecom: 30, forms: 20, tasks: 30, accounting: 20,
};

interface FamilyState {
  count: number;
  windowStart: number;
  halvedUntil: number;
}

interface PersistedState {
  families: [string, FamilyState][];
  aggregateCount: number;
  aggregateWindowStart: number;
}

export class StRateLimiter {
  private state: DurableObjectState;
  private families: Map<Family, FamilyState> = new Map();
  private aggregateCount = 0;
  private aggregateWindowStart = Date.now();

  constructor(state: DurableObjectState) {
    this.state = state;
    // blockConcurrencyWhile ensures no fetch() runs until storage is loaded.
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<PersistedState>('ratelimit');
      if (stored) {
        this.families = new Map(stored.families as [Family, FamilyState][]);
        this.aggregateCount = stored.aggregateCount;
        this.aggregateWindowStart = stored.aggregateWindowStart;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json<{ family: Family; retryAfter?: number }>();
    const family = body.family;

    let result: unknown;
    if (url.pathname === '/check') {
      result = this.check(family);
    } else if (url.pathname === '/backoff') {
      const retryAfterSeconds = Number(body.retryAfter);
      this.applyBackoff(family, isNaN(retryAfterSeconds) ? 60 : retryAfterSeconds);
      result = { ok: true };
    } else {
      return Response.json({ error: 'unknown path' }, { status: 404 });
    }

    // Persist state after every mutation so hibernation doesn't lose counts.
    await this.persistState();
    return Response.json(result);
  }

  private async persistState(): Promise<void> {
    const data: PersistedState = {
      families: Array.from(this.families.entries()),
      aggregateCount: this.aggregateCount,
      aggregateWindowStart: this.aggregateWindowStart,
    };
    await this.state.storage.put('ratelimit', data);
  }

  private getFamily(family: Family): FamilyState {
    if (!this.families.has(family)) {
      this.families.set(family, { count: 0, windowStart: Date.now(), halvedUntil: 0 });
    }
    return this.families.get(family)!;
  }

  private check(family: Family): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();

    if (now - this.aggregateWindowStart >= WINDOW_MS) {
      this.aggregateCount = 0;
      this.aggregateWindowStart = now;
    }

    if (this.aggregateCount >= AGGREGATE_CAP) {
      return { allowed: false, retryAfter: Math.ceil((this.aggregateWindowStart + WINDOW_MS - now) / 1000) };
    }

    const fs = this.getFamily(family);

    if (now - fs.windowStart >= WINDOW_MS) {
      fs.count = 0;
      fs.windowStart = now;
    }

    const cap = now < fs.halvedUntil ? Math.floor(FAMILY_CAP[family] / 2) : FAMILY_CAP[family];

    if (fs.count >= cap) {
      return { allowed: false, retryAfter: Math.ceil((fs.windowStart + WINDOW_MS - now) / 1000) };
    }

    fs.count++;
    this.aggregateCount++;
    return { allowed: true };
  }

  private applyBackoff(family: Family, retryAfterSeconds: number): void {
    const fs = this.getFamily(family);
    const penaltyMs = Math.max(retryAfterSeconds * 1000, WINDOW_MS);
    fs.halvedUntil = Math.max(fs.halvedUntil, Date.now() + penaltyMs);
  }
}
