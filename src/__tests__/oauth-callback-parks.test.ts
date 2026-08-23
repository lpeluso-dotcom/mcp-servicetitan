import { describe, it, expect, vi, afterEach } from 'vitest';

// Real implementations of the two helpers oauth.ts imports — this test builds a
// genuine RS256 id_token and lets verifyIdToken verify it for real, so the whole
// /callback path (token exchange -> JWKS -> signature -> claims -> allow-list)
// executes rather than being stubbed out.
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

const ISSUER = 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123';
const CLIENT_ID = 'access-client-id';
const ORIGIN = 'https://example.workers.dev';
const KID = 'test-kid-1';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeIdToken(claims: Record<string, unknown>) {
  // workers-types declares generateKey as CryptoKey | CryptoKeyPair; RSA always
  // yields a pair, so narrow explicitly rather than destructuring blind.
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const { publicKey, privateKey } = pair;
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as unknown as Record<string, unknown>;
  const header = b64urlJson({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = b64urlJson(claims);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    idToken: `${header}.${payload}.${b64url(new Uint8Array(sig))}`,
    jwks: { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/callback parks the grant instead of completing it (audit S-1)', () => {
  async function run(email: string) {
    const nonce = 'nonce-abc';
    const csrf = 'csrf-abc';
    const state = 'login-state-1';
    const oauthReqInfo = {
      clientId: 'attacker-client',
      redirectUri: 'https://evil.example/cb',
      scope: ['openid'],
    };

    const { idToken, jwks } = await makeIdToken({
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: 'user-sub-1',
      email,
      email_verified: true,
      name: 'Test User',
      nonce,
    });

    const store: Record<string, unknown> = {
      [`login:${state}`]: { oauthReqInfo, codeVerifier: 'verifier', nonce, csrf },
    };

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id_token: idToken, expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/jwks')) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://evil.example/cb?code=LEAKED' }));
    const env: unknown = {
      ACCESS_ISSUER: ISSUER,
      ACCESS_CLIENT_ID: CLIENT_ID,
      ACCESS_CLIENT_SECRET: 'shh',
      SELF_ORIGIN: ORIGIN,
      ALLOWED_EMAILS: 'ok@example.org',
      OAUTH_KV: {
        get: async (k: string) => store[k] ?? null,
        put: async (k: string, v: string) => {
          store[k] = JSON.parse(v);
        },
        delete: async (k: string) => {
          delete store[k];
        },
      },
      OAUTH_PROVIDER: { completeAuthorization },
    };

    const req = new Request(`${ORIGIN}/callback?state=${state}&code=authcode`, {
      headers: { cookie: `__Host-mcpst_oauth_csrf=${csrf}` },
    });
    const res = await handleOAuthRoute(req, env as never, new URL(req.url));
    return { res, store, completeAuthorization };
  }

  it('redirects an allow-listed user to /approve and mints NO token', async () => {
    const { res, store, completeAuthorization } = await run('ok@example.org');

    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);

    const location = res!.headers.get('location') ?? '';
    expect(location.startsWith(`${ORIGIN}/approve?state=`)).toBe(true);
    // The attacker's redirect_uri must NOT be where the browser is sent.
    expect(location).not.toContain('evil.example');

    // This is the whole point of S-1: identity was proven, but no grant exists yet.
    expect(completeAuthorization).not.toHaveBeenCalled();

    // The grant is parked under a fresh, unguessable key with the right shape.
    const parked = Object.entries(store).filter(([k]) => k.startsWith('approve:'));
    expect(parked).toHaveLength(1);
    const [key, value] = parked[0] as [string, Record<string, unknown>];
    expect(location).toContain(key.slice('approve:'.length));
    expect(value.email).toBe('ok@example.org');
    expect(value.sub).toBe('user-sub-1');
    expect(value.upstreamExpiresIn).toBe(3600);
    expect((value.oauthReqInfo as Record<string, unknown>).clientId).toBe('attacker-client');

    // The single-use login state is consumed.
    expect(store['login:login-state-1']).toBeUndefined();
  });

  it('rejects a non-allow-listed email before parking anything', async () => {
    const { res, store, completeAuthorization } = await run('intruder@example.org');

    expect(res!.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(Object.keys(store).filter((k) => k.startsWith('approve:'))).toHaveLength(0);
  });
});
