// ============================================================
// ap-inbox.ts — transport for ServiceTitan's AP-Inbox internal API.
//
// WHY THIS IS NOT src/st.ts. readST() routes through the ST_PROXY service
// binding to taylor-ai, which authenticates with OAuth client_credentials
// against api.servicetitan.io. The AP inbox does not live there: verified
// 2026-08-24 across three independent sources, ServiceTitan has NO public or
// OAuth API for AP bills. go.servicetitan.com/app/api/accounting/inbox/* is
// session-cookie authenticated and is the only way in.
//
// So this is a direct fetch to a different host with a different auth model,
// shaped after src/supabase.ts (the repo's other direct-fetch client) rather
// than st.ts.
//
// CREDENTIAL POLICY — non-negotiable, from the design doc §3.2:
//   - Cookies are CALLER-SUPPLIED per call. A human captures them from a live
//     browser session (st-internal-api's Copy-as-cURL step).
//   - Nothing is persisted. Not in D1, not in KV, not in a Durable Object,
//     not in a module-level variable.
//   - No login, no refresh, no path that could originate a session without a
//     human. If a feature seems to need one, stop and escalate.
//   - No credential ever reaches an error message, log line, or exception.
//
// Probe 0 (2026-08-24) confirmed a Worker on Cloudflare's edge reaches this
// API with replayed cookies: HTTP 200, byte-identical to a dev-box control.
// That is a point-in-time result, not a durable contract — __cf_bm (~30 min)
// and cf_clearance are bot-management tokens and scoring can tighten without
// notice. Hence the challenge-page detection below.
// ============================================================

import { McpError, mapUpstreamStatus } from './errors';

const BASE = 'https://go.servicetitan.com/app/api/accounting/inbox';

/** Matches src/supabase.ts's per-fetch budget. ST's UI calls are well under this. */
const FETCH_TIMEOUT_MS = 25_000;

/** Ceiling on how much of an error body reaches an exception message. */
const ERROR_BODY_CAP = 400;

export interface ApInboxAuth {
  /**
   * The raw `Cookie` header value from a live browser session. Must carry
   * `.AspNetCore.AUTH*` (~24h), `__cf_bm` (~30m) and `cf_clearance`.
   */
  session_cookie: string;
  /** URL-DECODED value of the `X-CSRF-Token` cookie. Writes 403 without it. */
  csrf_token: string;
}

function headersFor(auth: ApInboxAuth, withBody: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    ...(withBody ? { 'content-type': 'application/json' } : {}),
    cookie: auth.session_cookie,
    'x-csrf-token': auth.csrf_token,
    'x-requested-with': 'XMLHttpRequest',
    // A browser sets these automatically on a same-origin fetch. A Worker does
    // not — omitting them is the most likely cause of a silent 403.
    origin: 'https://go.servicetitan.com',
    referer: 'https://go.servicetitan.com/',
  };
}

/**
 * One call against the AP-inbox internal API.
 *
 * Throws McpError on anything that is not a clean JSON 2xx. Never degrades to
 * a partial result: a challenge page or an expired session must surface as an
 * actionable error, because the alternative is a caller treating "0 rows" as
 * "no duplicates found".
 */
export async function apInboxFetch<T = unknown>(
  auth: ApInboxAuth,
  path: string,
  opts: {
    method: 'GET' | 'POST';
    body?: unknown;
    query?: Record<string, string | number>;
    correlation?: string;
  },
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));

  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method,
      headers: headersFor(auth, hasBody),
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new McpError('timeout', `AP-inbox request to ${path} failed or timed out: ${msg}`, {
      correlation: opts.correlation,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new McpError(
      'auth_failed',
      `ServiceTitan rejected the session on ${path} (HTTP ${res.status}). The session cookie or ` +
        `CSRF token has expired — .AspNetCore.AUTH* last ~24h and __cf_bm ~30 min. ` +
        `Re-capture a fresh "Copy as cURL" from a go.servicetitan.com/app/api/* request and retry. ` +
        `Do NOT retry with the same credentials.`,
      { correlation: opts.correlation },
    );
  }

  const body = await res.text().catch(() => '');

  if (!res.ok) {
    // Deliberately interpolates only the response body — never a header.
    throw new McpError(
      mapUpstreamStatus(res.status),
      `AP-inbox ${opts.method} ${path} returned HTTP ${res.status}: ${body.slice(0, ERROR_BODY_CAP)}`,
      { correlation: opts.correlation },
    );
  }

  // A Cloudflare bot-management challenge answers 200 with HTML. Parsing that
  // as JSON throws something unhelpful; detect it explicitly so the human is
  // told what actually happened.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new McpError(
      'auth_failed',
      `AP-inbox ${path} returned ${contentType || 'an unknown content type'} instead of JSON — ` +
        `almost certainly a Cloudflare challenge page, which means __cf_bm / cf_clearance have ` +
        `expired. Re-capture the session and retry. Never retry into a challenge.`,
      { correlation: opts.correlation },
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new McpError(
      'upstream_error',
      `AP-inbox ${path} returned unparseable JSON (${body.length} bytes).`,
      { correlation: opts.correlation },
    );
  }
}

/**
 * Unwrap ServiceTitan's `{value, text}` field wrapper.
 *
 * Every billData field is wrapped, including the ones that look scalar.
 * Prefer `.value`; fall back to `.text`.
 */
export function unwrap(v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    const o = v as { value?: unknown; text?: unknown };
    if ('value' in o && o.value !== undefined && o.value !== null) return o.value;
    if ('text' in o) return o.text;
  }
  return v;
}
