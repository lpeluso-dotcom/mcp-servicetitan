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

/**
 * Consult the limiter before an ST call. Throws McpError('rate_limited')
 * carrying retry_after_ms when the budget is spent.
 *
 * Fails OPEN if the DO itself is unreachable: the limiter protects ST's
 * quota, it is not a correctness gate, and a wedged DO must not take the
 * whole connector offline. It never fails open on an explicit deny.
 */
export async function checkRateLimit(env: Env, family: string): Promise<void> {
  if (!limiterBound(env)) return;

  let data: { allowed: boolean; retryAfter?: number };
  try {
    const resp = await limiterStub(env).fetch('https://do/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family }),
    });
    data = await resp.json<{ allowed: boolean; retryAfter?: number }>();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[rate-limit] limiter unavailable, failing open: ${(e as Error).message}`);
    return;
  }

  if (!data.allowed) {
    const retryAfter = data.retryAfter ?? 60;
    throw new McpError(
      'rate_limited',
      `ST rate limit: retry after ${retryAfter}s (family: ${family})`,
      { retry_after_ms: retryAfter * 1000, details: { family, retry_after_s: retryAfter } },
    );
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
): Promise<Response> {
  return guardedFamilyFetch(env, familyFromEndpoint(endpoint), run);
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
): Promise<Response> {
  await checkRateLimit(env, family);
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
