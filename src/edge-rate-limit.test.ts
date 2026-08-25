// ============================================================
// edge-rate-limit.test.ts — Wave 2, workstream E item 6.
//
// WHAT THIS IS. Cloudflare's native `[[ratelimits]]` binding, applied at the
// /mcp door and keyed on the AUTHENTICATED ACTOR, so one runaway agent client
// cannot fan a single loop out into 100 DO round trips.
//
// WHAT THIS IS NOT — and cannot become. It does not replace StRateLimiter.
// The native binding is per-Cloudflare-location and eventually consistent;
// Cloudflare's docs say it is "intentionally designed to not be used as an
// accurate accounting system". It supports only 10s or 60s periods and has no
// notion of a global budget, so it cannot enforce the GLOBAL ServiceTitan API
// quota that StRateLimiter exists for. Different problem, different tool,
// different layer: this one bounds ONE CALLER at the EDGE; that one bounds the
// WHOLE WORKER against a THIRD PARTY. Neither subsumes the other.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { edgeRateLimitAllows, rateLimitedMcpResponse } from './edge-rate-limit';

function envWith(limit?: (o: { key: string }) => Promise<{ success: boolean }>): any {
  return limit ? { MCP_EDGE_RL: { limit } } : {};
}

const CORS = {
  origin: 'https://claude.ai',
  methods: 'GET,POST,OPTIONS',
  headers: 'content-type, authorization',
  exposeHeaders: 'mcp-session-id',
};

describe('edgeRateLimitAllows', () => {
  it('allows when the binding is absent (local dev, tests, unconfigured account)', async () => {
    expect(await edgeRateLimitAllows(envWith(), 'someone')).toBe(true);
  });

  it('keys the limiter on the authenticated actor, not the IP or the path', async () => {
    const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
    await edgeRateLimitAllows(envWith(limit), 'lpeluso@qualityservicecompany.net');
    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit.mock.calls[0][0].key).toContain('lpeluso@qualityservicecompany.net');
  });

  it('gives two different actors two different keys', async () => {
    const seen: string[] = [];
    const limit = vi.fn(async (o: { key: string }) => {
      seen.push(o.key);
      return { success: true };
    });
    await edgeRateLimitAllows(envWith(limit), 'agent-a');
    await edgeRateLimitAllows(envWith(limit), 'agent-b');
    expect(new Set(seen).size).toBe(2);
  });

  it('denies when the binding reports the budget is spent', async () => {
    expect(await edgeRateLimitAllows(envWith(async () => ({ success: false })), 'noisy')).toBe(false);
  });

  it('fails OPEN when the binding throws', async () => {
    // A rate limiter that hard-fails the door is a worse outage than the abuse
    // it prevents. Every other guard in this worker (cache, tracing, audit) is
    // fail-open for the same reason.
    const limit = vi.fn(async () => {
      throw new Error('rate limiter unavailable');
    });
    expect(await edgeRateLimitAllows(envWith(limit), 'x')).toBe(true);
  });

  it('does not blow up on an empty actor string', async () => {
    const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
    expect(await edgeRateLimitAllows(envWith(limit), '')).toBe(true);
    expect(limit.mock.calls[0][0].key.length).toBeGreaterThan(0);
  });
});

describe('rateLimitedMcpResponse', () => {
  it('is a 429 with a retry-after header', async () => {
    const r = rateLimitedMcpResponse(CORS);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
  });

  it('carries the same reflected CORS headers as the 401 path', () => {
    const r = rateLimitedMcpResponse(CORS);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    // ACAO is per-request-reflected, so intermediaries must be told it varies.
    expect(r.headers.get('vary')).toBe('origin');
  });

  it('returns a JSON body naming the limit, not an empty 429', async () => {
    const body = await rateLimitedMcpResponse(CORS).json<{ error: string; message: string }>();
    expect(body.error).toBe('rate_limited');
    expect(body.message).toMatch(/\S/);
  });
});

describe('index.ts wires the guard into the /mcp door', () => {
  it('calls edgeRateLimitAllows after auth resolves and before the server is built', async () => {
    const src = (await import('./index.ts?raw')).default;
    expect(src).toMatch(/edgeRateLimitAllows/);
    expect(src).toMatch(/rateLimitedMcpResponse/);

    const authAt = src.indexOf('const auth = request.method');
    // The CALL, not the import at the top of the file.
    const guardAt = src.indexOf('await edgeRateLimitAllows(');
    const buildAt = src.indexOf('const server = buildServer(runtimeEnv, execCtx, reqCtx)');
    expect(authAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(authAt); // keyed on the AUTHENTICATED actor
    expect(guardAt).toBeLessThan(buildAt); // before any downstream work
  });

  it('does not remove or reroute the StRateLimiter DO', async () => {
    const src = (await import('./index.ts?raw')).default;
    expect(src).toMatch(/StRateLimiter/);
  });
});
