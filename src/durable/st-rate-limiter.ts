// ============================================================
// StRateLimiter — Durable Object for ServiceTitan API rate limiting.
//
// ONE DO instance holds the global aggregate counter, every per-family
// counter, and the recent report-identity ledger. Callers must therefore
// address a single fixed DO id — see LIMITER_DO_NAME in rate-limit-guard.ts.
//
// ── What ServiceTitan actually documents ─────────────────────
// https://help.servicetitan.com/docs/default-api-rate-limitsfor-regular-apis-and-reporting-apis
//   * Regular APIs:   60 calls per SECOND per application per tenant.
//   * Reporting APIs: 1 of the SAME report per minute per tenant.
//
// Everything below is derived from those two numbers. ServiceTitan documents
// NO per-endpoint-family volume limit, so this file must not pretend to model
// one — see FAMILY fairness note.
//
// ── Wave 2 history ───────────────────────────────────────────
// Three bugs were fixed here, in two passes:
//   * the aggregate cap used to be counted per-family, because the guard
//     derived the DO id from the family name. The counters live together in
//     one instance precisely so one round-trip enforces both.
//   * FAMILY_CAP[family] returned `undefined` for any family it did not
//     declare, and `count >= undefined` is `false` — so undeclared families
//     (sales, inventory, payroll, marketing, taskmanagement) were UNLIMITED.
//   * the cap NUMBERS were invented. AGGREGATE_CAP = 80/MINUTE was ~45x
//     stricter than ST's real ceiling and the wrong SHAPE for a per-second
//     limit; `reporting: 20/min` modelled a volume limit that does not exist.
//     Both are corrected below against the documented figures.
//
// Strongly consistent counters persisted to DO storage so they survive
// hibernation (CF evicts idle DO instances after ~10s).
//
// Protocol (Workers call via RPC fetch):
//   POST /check   { family: string, identity?: string }
//     → 200 { allowed: true }
//     → 200 { allowed: false, retryAfter: number, retryAfterMs: number,
//             reason: DenyReason }
//   POST /backoff { family: string, retryAfter: number }
//     → 200 { ok: true }  — absorbs ST 429 Retry-After, halves the family cap
// ============================================================

/** Descriptive list of ST path segments we have seen. NOT the cap source —
 *  caps are uniform (see capForFamily), so adding to this list changes
 *  nothing. Kept only so readers can see what a "family" looks like. */
export const FAMILIES = [
  'crm', 'jpm', 'pricebook', 'memberships', 'dispatch', 'reporting',
  'telecom', 'forms', 'taskmanagement', 'accounting', 'sales', 'inventory',
  'payroll', 'marketing', 'settings', 'schedulingpro',
] as const;

/**
 * A family is whatever `familyFromEndpoint` pulled off the ST path, so it is
 * a plain string — NOT a closed union. Typing it as a union is what let
 * `FAMILY_CAP[family]` type-check while returning undefined at runtime.
 */
export type Family = string;

export type DenyReason = 'aggregate' | 'family' | 'same_report_within_window';

export interface CheckVerdict {
  allowed: boolean;
  /** Whole seconds, for human-facing messages and Retry-After semantics. */
  retryAfter?: number;
  /**
   * Exact milliseconds until the budget refills. The seconds value rounds UP
   * to 1s even when the window has 3ms left, which would make the Worker's
   * pacing wait ~300x longer than necessary on a burst.
   */
  retryAfterMs?: number;
  reason?: DenyReason;
}

// ── ServiceTitan's documented ceiling ───────────────────────

/** ST: "60 calls per second per application per tenant" (regular APIs). */
export const ST_DOCUMENTED_CALLS_PER_SECOND = 60;

/**
 * HEADROOM ASSUMPTION — read before changing AGGREGATE_CAP.
 *
 * The 60/s ceiling is per APPLICATION per TENANT, and this Worker is not the
 * only caller on QSC's tenant quota: taylor-ai (and anything else wired to
 * the same ST app) draws from the same 60/s. We therefore budget ONE THIRD of
 * the documented ceiling for mcp-servicetitan and leave the rest for them.
 *
 * There is a second reason the number is a third and not a half. The
 * aggregate uses a FIXED window anchored at the first request in the window,
 * so the worst case is a full budget spent at the end of one window and
 * another full budget at the start of the next — 2 x AGGREGATE_CAP inside
 * roughly one second. At 20 that worst case is 40/s, still under ST's 60/s
 * even before counting other callers. At 30 it would be 60/s and we would be
 * exactly at the limit with zero room for taylor-ai.
 *
 * If we ever get a dedicated ST application (separate quota) or real
 * RateLimit-* headers to read remaining quota from, revisit this.
 */
export const WORKER_QUOTA_FRACTION = 1 / 3;

/**
 * The aggregate window is ONE SECOND, matching the shape of ST's limit.
 * A 60s window was the wrong shape: it throttles a legal burst AND permits
 * 3,600 calls inside a single second, which is what ST actually rejects.
 */
export const AGGREGATE_WINDOW_MS = 1_000;

/** 20 calls/second = 1/3 of ST's documented 60/s. See WORKER_QUOTA_FRACTION. */
export const AGGREGATE_CAP = Math.floor(ST_DOCUMENTED_CALLS_PER_SECOND * WORKER_QUOTA_FRACTION);

// ── per-family fairness (NOT an ST limit) ───────────────────

/**
 * ServiceTitan documents no per-family volume limit, so a differentiated
 * table of per-family numbers (crm: 60, pricebook: 30, reporting: 20 …) was
 * modelling a limit that does not exist — every one of those numbers was
 * invented.
 *
 * What a per-family counter IS good for is BLAST RADIUS: one runaway tool
 * fanning out on /jpm/ should not be able to spend the Worker's entire burst
 * budget and starve every other tool. So the cap is a single fairness rule
 * stated as a fraction of our own budget — "no one family may take more than
 * 60% of the burst" — and it is deliberately uniform. A single-family
 * workload (the common case: a composite paging one endpoint) still gets most
 * of the budget.
 *
 * The same number backstops families we have never seen, which is the fix for
 * the `count >= undefined` hole.
 */
export const FAMILY_BURST_FRACTION = 0.6;
export const FAMILY_WINDOW_MS = AGGREGATE_WINDOW_MS;
export const DEFAULT_FAMILY_CAP = Math.floor(AGGREGATE_CAP * FAMILY_BURST_FRACTION);

/** Cap for a family. Uniform by design — see the note above. */
export function capForFamily(_family: string): number {
  return DEFAULT_FAMILY_CAP;
}

// ── ST's real reporting limit: same report, once a minute ───

/** ST: "1 of the same report per minute per tenant". */
export const IDENTITY_WINDOW_MS = 60_000;

/**
 * Ledger bound. Every check persists state, so an unbounded identity map is
 * an unbounded DO storage write. Entries expire after IDENTITY_WINDOW_MS
 * anyway; this is the belt-and-braces ceiling.
 */
export const MAX_TRACKED_IDENTITIES = 512;

/**
 * Floor on the penalty applied when ST hands us a 429 Retry-After. ST's
 * reporting window is a minute, so a sub-minute penalty is not worth
 * applying.
 */
const BACKOFF_MIN_PENALTY_MS = 60_000;

interface FamilyState {
  count: number;
  windowStart: number;
  halvedUntil: number;
}

interface PersistedState {
  families: [string, FamilyState][];
  aggregateCount: number;
  aggregateWindowStart: number;
  /** identity -> epoch ms of the last ALLOWED call for it. */
  identities?: [string, number][];
}

export class StRateLimiter {
  private state: DurableObjectState;
  private families: Map<Family, FamilyState> = new Map();
  private identities: Map<string, number> = new Map();
  private aggregateCount = 0;
  private aggregateWindowStart = Date.now();

  constructor(state: DurableObjectState) {
    this.state = state;
    // blockConcurrencyWhile ensures no fetch() runs until storage is loaded.
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<PersistedState>('ratelimit');
      if (stored) {
        this.families = new Map(stored.families as [Family, FamilyState][]);
        this.identities = new Map(stored.identities ?? []);
        this.aggregateCount = stored.aggregateCount;
        this.aggregateWindowStart = stored.aggregateWindowStart;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json<{ family: Family; identity?: string; retryAfter?: number }>();
    const family = body.family;

    let result: unknown;
    if (url.pathname === '/check') {
      result = this.check(family, body.identity);
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
      identities: Array.from(this.identities.entries()),
    };
    await this.state.storage.put('ratelimit', data);
  }

  private getFamily(family: Family): FamilyState {
    if (!this.families.has(family)) {
      this.families.set(family, { count: 0, windowStart: Date.now(), halvedUntil: 0 });
    }
    return this.families.get(family)!;
  }

  /** Drop expired identities, then bound the map by age (oldest first). */
  private pruneIdentities(now: number): void {
    for (const [key, seenAt] of this.identities) {
      if (now - seenAt >= IDENTITY_WINDOW_MS) this.identities.delete(key);
    }
    if (this.identities.size <= MAX_TRACKED_IDENTITIES) return;
    const byAge = Array.from(this.identities.entries()).sort((a, b) => a[1] - b[1]);
    for (const [key] of byAge.slice(0, this.identities.size - MAX_TRACKED_IDENTITIES)) {
      this.identities.delete(key);
    }
  }

  private check(family: Family, identity?: string): CheckVerdict {
    const now = Date.now();

    // ── ST's reporting rule, checked FIRST ───────────────────
    // Deliberately before the counters: a repeat of the same report is going
    // to be rejected by ST regardless of how much budget we have, so it must
    // not consume any. Rejecting here costs the caller nothing.
    if (identity !== undefined) {
      this.pruneIdentities(now);
      const seenAt = this.identities.get(identity);
      if (seenAt !== undefined && now - seenAt < IDENTITY_WINDOW_MS) {
        const remainingMs = seenAt + IDENTITY_WINDOW_MS - now;
        return {
          allowed: false,
          retryAfter: Math.ceil(remainingMs / 1000),
          retryAfterMs: remainingMs,
          reason: 'same_report_within_window',
        };
      }
    }

    if (now - this.aggregateWindowStart >= AGGREGATE_WINDOW_MS) {
      this.aggregateCount = 0;
      this.aggregateWindowStart = now;
    }

    if (this.aggregateCount >= AGGREGATE_CAP) {
      const remainingMs = this.aggregateWindowStart + AGGREGATE_WINDOW_MS - now;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
        retryAfterMs: Math.max(1, remainingMs),
        reason: 'aggregate',
      };
    }

    const fs = this.getFamily(family);

    if (now - fs.windowStart >= FAMILY_WINDOW_MS) {
      fs.count = 0;
      fs.windowStart = now;
    }

    const declared = capForFamily(family);
    // Math.max(1, …) so a halved cap never becomes 0, which would wedge that
    // family shut for the whole penalty window.
    const cap = now < fs.halvedUntil ? Math.max(1, Math.floor(declared / 2)) : declared;

    if (fs.count >= cap) {
      const remainingMs = fs.windowStart + FAMILY_WINDOW_MS - now;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
        retryAfterMs: Math.max(1, remainingMs),
        reason: 'family',
      };
    }

    fs.count++;
    this.aggregateCount++;
    if (identity !== undefined) this.identities.set(identity, now);
    return { allowed: true };
  }

  private applyBackoff(family: Family, retryAfterSeconds: number): void {
    const fs = this.getFamily(family);
    const penaltyMs = Math.max(retryAfterSeconds * 1000, BACKOFF_MIN_PENALTY_MS);
    fs.halvedUntil = Math.max(fs.halvedUntil, Date.now() + penaltyMs);
  }
}
