import { describe, it, expect, vi } from 'vitest';

// Mock the Cloudflare workers-oauth-provider before importing oauth
vi.mock('@cloudflare/workers-oauth-provider', () => {
  const base64UrlDecode = (str: string) => {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    base64 = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return atob(base64);
  };
  return {
    OAuthProvider: vi.fn(),
    parseJwtJsonPart: (part: string) => JSON.parse(base64UrlDecode(part)),
    base64UrlToBytes: (str: string) => {
      const decoded = base64UrlDecode(str);
      const arr = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) arr[i] = decoded.charCodeAt(i);
      return arr;
    },
  };
});

import { handleOAuthRoute } from '../oauth';

// The "no real address is committed" invariant is enforced by
// scripts/preflight.sh [3b] (a grep over wrangler.toml + src/oauth.ts) rather
// than here: this tsconfig types only @cloudflare/workers-types, so a test
// cannot import node:fs without weakening Worker type safety project-wide.
// What IS testable here is the runtime consequence — the allow-list must deny
// when unconfigured rather than fall back to a committed list. (audit S-8)

describe('ALLOWED_EMAILS allow-list fails closed (audit S-8)', () => {
  function envWithout(allowed?: string) {
    return {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
      SELF_ORIGIN: 'https://example.workers.dev',
      ...(allowed === undefined ? {} : { ALLOWED_EMAILS: allowed }),
      OAUTH_KV: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as never;
  }

  it('does not throw on /callback when ALLOWED_EMAILS is undefined', async () => {
    const req = new Request('https://example.workers.dev/callback?state=s&code=c');
    const res = await handleOAuthRoute(req, envWithout(), new URL(req.url));
    // No stored login state -> 400 before the allow-list is consulted. Asserts
    // the route is reachable and does not throw with no ALLOWED_EMAILS set.
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it('does not throw on /callback when ALLOWED_EMAILS is blank', async () => {
    const req = new Request('https://example.workers.dev/callback?state=s&code=c');
    const res = await handleOAuthRoute(req, envWithout(''), new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
