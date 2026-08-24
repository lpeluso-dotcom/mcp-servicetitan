// ============================================================
// StRateLimiter — Durable Object for ServiceTitan API rate limiting.
//
// ONE DO instance holds BOTH the global aggregate counter and every
// per-family counter (the `families` Map). Callers must therefore address a
// single fixed DO id — see LIMITER_DO_NAME in rate-limit-guard.ts.
//
// Wave 2 / workstream A fixed two design bugs here:
//   * the aggregate cap used to be counted per-family, because the guard
//     derived the DO id from the family name. AGGREGATE_CAP is a GLOBAL
//     budget; splitting it per family multiplied the real ceiling by the
//     number of families in play. The counters live together in one
//     instance precisely so one round-trip enforces both.
//   * FAMILY_CAP[family] returned `undefined` for any family it did not
//     declare, and `count >= undefined` is `false` — so undeclared families
//     (sales, inventory, payroll, marketing, taskmanagement) were UNLIMITED.
//     DEFAULT_FAMILY_CAP now backstops every lookup.
//
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
/**
 * A family is whatever `familyFromEndpoint` pulled off the ST path, so it is
 * a plain string — NOT a closed union. Typing it as a union is what let
 * `FAMILY_CAP[family]` type-check while returning undefined at runtime.
 */
export type Family = string;

const WINDOW_MS = 60_000;
const AGGREGATE_CAP = 80;

/**
 * Cap applied to any family FAMILY_CAP does not name. Deliberately
 * conservative: an unrecognised path segment is either a new ST surface we
 * have not budgeted for, or a malformed endpoint. Either way it should draw
 * from a small allowance, never from an implicit infinity.
 */
export const DEFAULT_FAMILY_CAP = 20;

export const FAMILY_CAP: Record<string, number> = {
  crm: 60, jpm: 60, pricebook: 30, memberships: 30,
  dispatch: 40, reporting: 20, telecom: 30, forms: 20, tasks: 30, accounting: 20,
  // ── real ST path segments that were never declared (hence unlimited) ──
  // `tasks` above never matched anything: ST's path segment is
  // /taskmanagement/. Kept for back-compat, aliased here.
  taskmanagement: 30,
  sales: 30,
  inventory: 30,
  payroll: 20,
  marketing: 20,
  settings: 30,
  schedulingpro: 20,
  // Bucket for endpoints whose family could not be parsed. Previously these
  // were charged to `crm`, inflating a real family's counter with traffic
  // that was not its own.
  other: DEFAULT_FAMILY_CAP,
};

/** Cap for a family, with an explicit floor instead of implicit infinity. */
export function capForFamily(family: string): number {
  return FAMILY_CAP[family] ?? DEFAULT_FAMILY_CAP;
}

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

    const declared = capForFamily(family);
    // Math.max(1, …) so a halved cap of a tiny family never becomes 0, which
    // would wedge that family shut for the whole penalty window.
    const cap = now < fs.halvedUntil ? Math.max(1, Math.floor(declared / 2)) : declared;

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
