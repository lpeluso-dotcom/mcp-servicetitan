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

function kvStub(store: Record<string, unknown>) {
  return {
    get: async (k: string, _t?: string) => store[k] ?? null,
    put: async (k: string, v: string) => {
      store[k] = JSON.parse(v);
    },
    delete: async (k: string) => {
      delete store[k];
    },
  };
}

function call(url: string, env: unknown, init?: RequestInit) {
  const req = new Request(url, init);
  return handleOAuthRoute(req, env as never, new URL(req.url));
}

const PENDING = {
  oauthReqInfo: {
    clientId: 'attacker-client',
    redirectUri: 'https://evil.example/cb',
    scope: ['openid'],
  },
  sub: 'user-sub-1',
  email: 'ok@example.org',
  name: 'Ok User',
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('OAuth consent screen (audit S-1)', () => {
  it('POST /approve with decision=approve is what completes authorization', async () => {
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: 'https://client.example/cb?code=x',
    }));
    const store: Record<string, unknown> = { 'approve:st-1': { ...PENDING } };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=st-1&decision=approve',
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    // single-use: the parked state is consumed
    expect(store['approve:st-1']).toBeUndefined();
  });

  it('POST /approve with decision=deny does NOT complete authorization', async () => {
    const completeAuthorization = vi.fn();
    const store: Record<string, unknown> = { 'approve:st-2': { ...PENDING } };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=st-2&decision=deny',
    });
    expect(res!.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(store['approve:st-2']).toBeUndefined();
  });

  it('POST /approve with an unknown state is rejected', async () => {
    const completeAuthorization = vi.fn();
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub({}),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=nope&decision=approve',
    });
    expect(res!.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('re-checks the allow-list at approval time', async () => {
    const completeAuthorization = vi.fn();
    const store: Record<string, unknown> = { 'approve:st-4': { ...PENDING } };
    const env = {
      // email was allow-listed at /callback but has since been removed
      ALLOWED_EMAILS: 'someone-else@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await call('https://example.workers.dev/approve', env, {
      method: 'POST',
      headers: FORM,
      body: 'state=st-4&decision=approve',
    });
    expect(res!.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('the consent page names the client id, redirect uri and scopes', async () => {
    const store: Record<string, unknown> = {
      'approve:st-3': {
        oauthReqInfo: {
          clientId: 'some-client',
          redirectUri: 'https://client.example/cb',
          scope: ['openid', 'email'],
        },
        sub: 'user-sub-3',
        email: 'ok@example.org',
        name: null,
      },
    };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization: vi.fn() },
    };
    const res = await call('https://example.workers.dev/approve?state=st-3', env);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toContain('text/html');
    const html = await res!.text();
    expect(html).toContain('some-client');
    expect(html).toContain('https://client.example/cb');
    expect(html).toContain('openid, email');
    // GET must not consume the parked state
    expect(store['approve:st-3']).toBeDefined();
  });

  it('escapes HTML in the client id so a hostile name cannot inject markup', async () => {
    const store: Record<string, unknown> = {
      'approve:st-5': {
        oauthReqInfo: {
          clientId: '<script>alert(1)</script>',
          redirectUri: 'https://client.example/cb',
          scope: ['openid'],
        },
        sub: 'user-sub-5',
        email: 'ok@example.org',
        name: null,
      },
    };
    const env = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization: vi.fn() },
    };
    const res = await call('https://example.workers.dev/approve?state=st-5', env);
    const html = await res!.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
