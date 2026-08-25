// ============================================================
// edge-rate-limit.ts — Cloudflare's NATIVE `[[ratelimits]]` binding applied at
// the /mcp door, keyed on the AUTHENTICATED ACTOR.
//
// WHAT IT BUYS. One runaway agent client — a retry loop, a misconfigured
// scheduler, a tool-calling model that will not stop — currently reaches the
// full tool surface at whatever rate it can open connections, and a single MCP
// request can fan out into many Durable Object round trips and downstream ST
// calls. This bounds that at the edge, before any of that work is scheduled,
// for the price of one binding call.
//
// WHAT IT IS NOT, AND WHY StRateLimiter STAYS. The native binding is
// PER-CLOUDFLARE-LOCATION and eventually consistent; Cloudflare's docs state it
// is "intentionally designed to not be used as an accurate accounting system".
// It supports only 10s or 60s periods and has no concept of a shared budget
// across locations. It therefore CANNOT enforce the global ServiceTitan API
// quota, which is the entire job of the StRateLimiter Durable Object. The two
// solve different problems at different layers:
//
//     this module     one CALLER, at the EDGE, approximately
//     StRateLimiter   the whole WORKER against a THIRD PARTY, accurately
//
// Neither subsumes the other and neither should be deleted in favour of the
// other. StRateLimiter is owned elsewhere; nothing here touches it.
//
// FAIL-OPEN. A limiter that hard-fails the door is a worse outage than the
// abuse it prevents, and an unbound binding (local dev, a fresh account, the
// test suite) must not lock everyone out. Both cases allow the request. The
// binding being absent is therefore NOT a silent security hole — it is a
// deliberate degradation of a best-effort abuse control, and the accurate
// quota guard is a separate, always-present mechanism.
// ============================================================

/** Shape of Cloudflare's rate-limit binding. Optional — see FAIL-OPEN above. */
export interface EdgeRateLimitEnv {
  MCP_EDGE_RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** CORS fields carried onto the 429, mirroring the /mcp 401 path. */
export interface EdgeCorsOptions {
  origin: string;
  methods: string;
  headers: string;
  exposeHeaders: string;
}

/**
 * True when the caller may proceed.
 *
 * @param actor the AUTHENTICATED identity from resolveAuth — never a header the
 *   caller chooses and never the client IP, so a single credential cannot buy
 *   extra budget by rotating source addresses.
 */
export async function edgeRateLimitAllows(env: EdgeRateLimitEnv, actor: string): Promise<boolean> {
  const binding = env.MCP_EDGE_RL;
  if (!binding) return true;

  try {
    // Namespaced so the key can never be empty and can never collide with a
    // key some future call site rate-limits on a different dimension.
    const { success } = await binding.limit({ key: `mcp:${actor || 'anonymous'}` });
    return success;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[edge-rate-limit] binding failed, allowing: ${(e as Error).message}`);
    return true;
  }
}

/** Retry-After, in seconds. Matches the 60s window configured in wrangler.toml. */
const RETRY_AFTER_SEC = 60;

/** The 429 served to a throttled MCP caller. */
export function rateLimitedMcpResponse(cors: EdgeCorsOptions): Response {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      message:
        'Too many MCP requests for this credential. This is a per-caller edge limit; retry after the window resets.',
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(RETRY_AFTER_SEC),
        'access-control-allow-origin': cors.origin,
        'access-control-allow-methods': cors.methods,
        'access-control-allow-headers': cors.headers,
        'access-control-expose-headers': cors.exposeHeaders,
        // ACAO is per-request-reflected, not '*' — tell any intermediary cache
        // the response varies by Origin (same reasoning as the 401 path).
        vary: 'origin',
      },
    }
  );
}
