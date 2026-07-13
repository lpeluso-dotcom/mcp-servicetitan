import { describe, it, expect, vi } from 'vitest';

// Mock the Cloudflare workers-oauth-provider before importing oauth
vi.mock('@cloudflare/workers-oauth-provider', () => {
  const base64UrlDecode = (str: string) => {
    // Base64url to base64
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    base64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    // Convert to string
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

describe('OAuth CSRF cookie', () => {
  it('sets a __Host- prefixed cookie on /authorize', async () => {
    const env: any = {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
      ACCESS_CLIENT_ID: 'client-id',
      SELF_ORIGIN: 'https://mcp-servicetitan.lpeluso.workers.dev',
      OAUTH_KV: { put: vi.fn(async () => {}) },
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn(async () => ({ clientId: 'c1', scope: ['openid'] })),
      },
    };
    const url = new URL('https://mcp-servicetitan.lpeluso.workers.dev/authorize');
    const res = await handleOAuthRoute(new Request(url, { method: 'GET' }), env, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    const cookie = res!.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith('__Host-mcpst_oauth_csrf=')).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
