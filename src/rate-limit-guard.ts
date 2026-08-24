// ============================================================
// rate-limit-guard.ts — the Worker side of the StRateLimiter DO.
//
// Every outbound ServiceTitan call goes through checkRateLimit() before it
// leaves the Worker, and reports a 429's Retry-After back via
// reportBackoff(). Prior to Wave 2 the only live caller was pagedStRead,
// which in turn had a single caller (margin_audit) — so ~110 tools shared
// zero governance and st_run_report ate 429s it could have avoided.
//
// ── Why ONE Durable Object id ────────────────────────────────
// This module used to do `idFromName(family)`, giving each endpoint family
// its own DO instance and therefore its own copy of the aggregate counter.
// AGGREGATE_CAP (80/min) is meant to be the GLOBAL ceiling; per-family
// instances turned it into 80/min PER FAMILY. StRateLimiter already keeps
// per-family counters in a Map inside one instance, so routing everything to
// a single fixed id fixes the aggregate WITHOUT costing a second round trip:
// one DO call still returns both the family verdict and the global verdict.
//
// ── Caps ─────────────────────────────────────────────────────
// The NUMBERS live in st-rate-limiter.ts and are derived from ServiceTitan's
// documented limits (60 calls/second per app per tenant for regular APIs;
// 1 of the same report per minute for reporting), with an explicit headroom
// assumption because we share the tenant quota with taylor-ai. Read
// WORKER_QUOTA_FRACTION there before changing anything.
//
// ── Latency ──────────────────────────────────────────────────
// The cost is one in-colo DO fetch (~1-5 ms) per ST call, against an ST API
// round trip of ~100-800 ms — call it 1-3% overhead. It is deliberately NOT
// batched, leased, or short-circuited for "cheap" reads: every ST call
// consumes the same ST quota regardless of how cheap it is for us, and a
// client-side lease would have to be re-synchronised across isolates, which
// reintroduces exactly the over-counting bug being fixed here. Reads served
// from D1 never reach this module, so the D1-first tools pay nothing.
// A single DO instance is not a throughput concern: the cap it enforces is
// 80 requests/minute, four orders of magnitude below DO capacity.
// ============================================================

import type { Env } from './env';
import { McpError } from './errors';

/**
 * The one and only StRateLimiter instance id. Do not derive this from the
 * family — see the header note.
 */
export const LIMITER_DO_NAME = 'st-global';

/** Fallback bucket for endpoints whose family cannot be parsed. */
export const UNKNOWN_FAMILY = 'other';

/**
 * Pull the ST API family off an endpoint path (`/crm/v2/...` → `crm`).
 *
 * Unmatched paths bucket into `other`, NOT `crm`. Charging unparseable
 * traffic to crm inflated a real family's counter with calls that were not
 * its own — crm would throttle early while the mystery traffic went
 * unattributed. `other` has its own DEFAULT_FAMILY_CAP allowance and still
 * counts against the global aggregate, which is what actually protects ST.
 */
export function familyFromEndpoint(endpoint: string): string {
  const m = endpoint.match(/^\/([a-z]+)\//);
  return m?.[1] ?? UNKNOWN_FAMILY;
}

/**
 * True when the limiter binding is present. Absent only in unit tests and in
 * local harnesses that never reach real ST — the binding is declared for
 * every deployed environment in wrangler.toml, so a missing binding in prod
 * is a deploy failure, not a runtime condition.
 */
function limiterBound(env: Env): boolean {
  const ns = (env as Partial<Env>)?.ST_RATE_LIMITER;
  return typeof (ns as { idFromName?: unknown } | undefined)?.idFromName === 'function';
}

function limiterStub(env: Env) {
  const id = env.ST_RATE_LIMITER.idFromName(LIMITER_DO_NAME);
  return env.ST_RATE_LIMITER.get(id);
}

export interface RateLimitOptions {
  /**
   * Canonical identity of a ServiceTitan REPORT run — report id plus every
   * input that changes the rows. ServiceTitan allows "1 of the same report
   * per minute per tenant", which is an identity rule, not a volume bucket,
   * so it can only be enforced if the caller says WHICH report this is.
   * Omit for every non-reporting call.
   */
  identity?: string;
}

/** Deny reasons the DO can return. */
type DenyReason = 'aggregate' | 'family' | 'same_report_within_window';

interface CheckResponse {
  allowed: boolean;
  retryAfter?: number;
  retryAfterMs?: number;
  reason?: DenyReason;
}

// ── Bounded pacing ───────────────────────────────────────────
//
// The aggregate and family windows are ~1 SECOND, so a burst that overshoots
// the budget refills almost immediately. Throwing at the caller would convert
// "wait 300ms" into a hard failure — and there is a real bounded fan-out in
// this repo that would break: get_configurable_equipment_children issues up
// to 25 parallel readST calls, wider than the per-second budget by design.
//
// So a SHORT budget denial is waited out, not raised. The bounds are exported
// because they are the worst-case latency this adds to a request:
// MAX_PACE_ATTEMPTS * MAX_PACE_WAIT_MS, and only under contention.
//
// Never applied to `same_report_within_window`: that window is a MINUTE, and
// holding a request open that long is worse than failing it — the caller has
// a cached result to use instead.

/** Longest single wait we will absorb rather than raising to the caller. */
export const MAX_PACE_WAIT_MS = 1_200;
/** Most consecutive waits before giving up and raising. */
export const MAX_PACE_ATTEMPTS = 3;

let pacingSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test seam. Lets a test drive the pacing loop against a virtual clock
 * instead of sitting through real seconds. Returns the previous impl.
 */
export function _setPacingSleep(fn: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
  const prev = pacingSleep;
  pacingSleep = fn;
  return prev;
}

function denyMessage(reason: DenyReason | undefined, family: string, retryAfter: number): string {
  if (reason === 'same_report_within_window') {
    return (
      `ST reporting limit: ServiceTitan allows 1 run of the same report per minute per tenant, ` +
      `and this exact report (same id AND same parameters) already ran inside that window. ` +
      `Retry after ${retryAfter}s, or re-read the cached result.`
    );
  }
  // Unchanged wording for the ordinary budget denials — callers and tests
  // match on it.
  return `ST rate limit: retry after ${retryAfter}s (family: ${family})`;
}

/**
 * Consult the limiter before an ST call. Throws McpError('rate_limited')
 * carrying retry_after_ms when the budget is spent, or when `identity` names
 * a report that already ran inside ST's one-per-minute window.
 *
 * Fails OPEN if the DO itself is unreachable: the limiter protects ST's
 * quota, it is not a correctness gate, and a wedged DO must not take the
 * whole connector offline. It never fails open on an explicit deny.
 */
export async function checkRateLimit(
  env: Env,
  family: string,
  opts: RateLimitOptions = {},
): Promise<void> {
  if (!limiterBound(env)) return;

  const body = JSON.stringify(
    // Only send `identity` when there is one, so the ordinary request body
    // stays byte-identical to what it has always been.
    opts.identity === undefined ? { family } : { family, identity: opts.identity },
  );

  for (let attempt = 0; ; attempt++) {
    let data: CheckResponse;
    try {
      const resp = await limiterStub(env).fetch('https://do/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      data = await resp.json<CheckResponse>();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[rate-limit] limiter unavailable, failing open: ${(e as Error).message}`);
      return;
    }

    if (data.allowed) return;

    const retryAfter = data.retryAfter ?? 60;
    const retryAfterMs = data.retryAfterMs ?? retryAfter * 1000;
    const paceable = data.reason !== 'same_report_within_window' && retryAfterMs <= MAX_PACE_WAIT_MS;

    if (paceable && attempt < MAX_PACE_ATTEMPTS) {
      // Jitter so a wide parallel fan-out does not re-check in lockstep and
      // hand the whole refilled window to whichever call wakes first.
      await pacingSleep(retryAfterMs + Math.floor(Math.random() * 25));
      continue;
    }

    throw new McpError('rate_limited', denyMessage(data.reason, family, retryAfter), {
      retry_after_ms: retryAfterMs,
      details: { family, retry_after_s: retryAfter, reason: data.reason ?? 'budget' },
    });
  }
}

/** Feed an ST 429's Retry-After back into the limiter (halves the family cap). */
export async function reportBackoff(env: Env, family: string, retryAfter: number): Promise<void> {
  if (!limiterBound(env)) return;
  try {
    await limiterStub(env).fetch('https://do/backoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family, retryAfter }),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[rate-limit] backoff report failed: ${(e as Error).message}`);
  }
}

// TODO(rate-limit): ServiceTitan MAY emit RateLimit-Limit / RateLimit-Remaining /
// RateLimit-Reset alongside a 429. Feeding real remaining quota back into the DO
// would beat any hardcoded fraction of the documented 60/s. It is NOT wired up
// because our calls go through the servicetitan-proxy Worker (taylor-ai), which
// lives in another repo, and nothing in this repo or its docs shows whether the
// proxy forwards those headers to us. Confirm on the proxy side first, then read
// them here — do not write speculative parsing for headers that may never arrive.

/** Parse a Retry-After header (delta-seconds form) with a 60s fallback. */
export function parseRetryAfterSeconds(header: string | null | undefined): number {
  const n = parseInt(header ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * Wrap one outbound ST request: check the budget, run the fetch, and report
 * the backoff if ST answers 429. Returns the raw Response so each call site
 * keeps its own error-shaping.
 *
 * `endpoint` is the ST API path (e.g. `/jpm/v2/tenant/1/jobs`), NOT the
 * proxy URL — the family is derived from it.
 */
export async function guardedStFetch(
  env: Env,
  endpoint: string,
  run: () => Promise<Response>,
  opts: RateLimitOptions = {},
): Promise<Response> {
  return guardedFamilyFetch(env, familyFromEndpoint(endpoint), run, opts);
}

/**
 * Same as guardedStFetch when the caller already knows the family and there
 * is no ST path to parse — e.g. the durable-write submit, which posts an
 * `operation` name rather than an endpoint.
 */
export async function guardedFamilyFetch(
  env: Env,
  family: string,
  run: () => Promise<Response>,
  opts: RateLimitOptions = {},
): Promise<Response> {
  await checkRateLimit(env, family, opts);
  const resp = await run();
  if (resp.status === 429) {
    await reportBackoff(env, family, parseRetryAfterSeconds(resp.headers.get('Retry-After')));
  }
  return resp;
}

/**
 * The McpError a 429 (from ST or from our own limiter) should surface.
 * Keeps retry_after_ms populated on every rate-limited path.
 */
export function rateLimitedError(
  message: string,
  retryAfterSeconds: number,
  correlation?: string,
): McpError {
  return new McpError('rate_limited', message, {
    retry_after_ms: retryAfterSeconds * 1000,
    correlation,
  });
}
