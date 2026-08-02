/**
 * oauth.ts — Phase-2 OAuth hardening for the read-only ServiceTitan connector (QUA).
 *
 * Wraps the worker with @cloudflare/workers-oauth-provider so the Claude Desktop connector
 * authenticates via OAuth (DCR, no token-in-URL) federated to Cloudflare Access (SaaS-OIDC) →
 * QSC M365/Entra. Per-user identity + Access audit. Mirrors the hardened qsc-hopper oauth.ts
 * (post adversarial review wf_e5cba561) — the apiHandler is supplied by index.ts (it builds the
 * read-only McpServer with the OAuth'd identity).
 *
 * Defense-in-depth: /callback verifies the id_token sig + iss + aud + nonce, enforces an
 * ALLOWED_EMAILS allow-list (not just the Access policy), and binds the callback to the
 * originating browser with a SameSite=Lax CSRF cookie. redirect_uri is pinned to SELF_ORIGIN.
 */

import { OAuthProvider, type OAuthHelpers, type AuthRequest, base64UrlToBytes, parseJwtJsonPart } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';

const LOGIN_TTL = 600;
const JWKS_CACHE_KEY = 'oauth:access-jwks';
const JWKS_TTL = 3600;
// __Host- prefix (securing-MCP guide): browser-enforced Secure + Path=/ +
// no Domain — a sibling *.workers.dev host cannot plant or override it.
const CSRF_COOKIE = '__Host-mcpst_oauth_csrf';
const DEFAULT_ALLOWED = 'office@qualityservicecompany.net,lpeluso@qualityservicecompany.net';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randB64url(n: number): string { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
function selfOrigin(env: Env, request: Request): string {
  return (env.SELF_ORIGIN && env.SELF_ORIGIN.replace(/\/$/, '')) || new URL(request.url).origin;
}
function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS || DEFAULT_ALLOWED).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}
function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

interface AccessEndpoints { authorize: string; token: string; jwks: string; issuer: string }
function accessEndpoints(env: Env): AccessEndpoints {
  const issuer = (env.ACCESS_ISSUER ?? '').replace(/\/$/, '');
  return { issuer, authorize: `${issuer}/authorization`, token: `${issuer}/token`, jwks: `${issuer}/jwks` };
}

interface Jwk { kid?: string; kty: string; n: string; e: string; alg?: string; use?: string }
async function getJwks(env: Env, jwksUrl: string, force = false): Promise<Jwk[]> {
  if (!force) {
    const cached = await env.OAUTH_KV.get(JWKS_CACHE_KEY, 'json').catch(() => null);
    if (cached && Array.isArray((cached as { keys?: Jwk[] }).keys)) return (cached as { keys: Jwk[] }).keys;
  }
  const resp = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`jwks fetch ${resp.status}`);
  const doc = (await resp.json()) as { keys: Jwk[] };
  await env.OAUTH_KV.put(JWKS_CACHE_KEY, JSON.stringify(doc), { expirationTtl: JWKS_TTL }).catch(() => {});
  return doc.keys;
}
async function verifyIdToken(idToken: string, env: Env): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const header = parseJwtJsonPart(parts[0]) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unsupported id_token alg ${header.alg}`);
  const { jwks: jwksUrl, issuer } = accessEndpoints(env);
  if (!issuer) throw new Error('ACCESS_ISSUER not configured');
  let keys = await getJwks(env, jwksUrl);
  let jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) { keys = await getJwks(env, jwksUrl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('no matching JWKS key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('id_token signature invalid');
  const claims = parseJwtJsonPart(parts[1]) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('id_token expired/no-exp');
  if (typeof claims.iss !== 'string' || claims.iss.replace(/\/$/, '') !== issuer) throw new Error('id_token iss mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_CLIENT_ID)) throw new Error('id_token aud mismatch');
  return claims;
}

interface LoginState { oauthReqInfo: AuthRequest; codeVerifier: string; nonce: string; csrf: string }

export async function handleOAuthRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { authorize, token: tokenUrl } = accessEndpoints(env);
  const callbackUrl = `${selfOrigin(env, request)}/callback`;

  if (url.pathname === '/authorize' && request.method === 'GET') {
    let oauthReqInfo: AuthRequest;
    try { oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
    catch { return new Response('invalid_request', { status: 400 }); }
    if (!oauthReqInfo.clientId) return new Response('invalid_request', { status: 400 });
    const codeVerifier = randB64url(32);
    const codeChallenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
    const nonce = randB64url(16);
    const csrf = randB64url(16);
    const state = crypto.randomUUID();
    await env.OAUTH_KV.put(`login:${state}`, JSON.stringify({ oauthReqInfo, codeVerifier, nonce, csrf } satisfies LoginState), { expirationTtl: LOGIN_TTL });
    const u = new URL(authorize);
    u.searchParams.set('client_id', env.ACCESS_CLIENT_ID);
    u.searchParams.set('redirect_uri', callbackUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return new Response(null, { status: 302, headers: { location: u.toString(), 'set-cookie': `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${LOGIN_TTL}` } });
  }

  if (url.pathname === '/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code) return new Response('invalid_callback', { status: 400 });
    const stored = (await env.OAUTH_KV.get(`login:${state}`, 'json')) as LoginState | null;
    if (!stored) return new Response('invalid_or_expired_state', { status: 400 });
    await env.OAUTH_KV.delete(`login:${state}`);
    if (!stored.csrf || getCookie(request, CSRF_COOKIE) !== stored.csrf) return new Response('csrf_check_failed', { status: 403 });
    const { oauthReqInfo, codeVerifier, nonce } = stored;
    if (!oauthReqInfo.clientId) return new Response('invalid_oauth_request', { status: 400 });
    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.ACCESS_CLIENT_ID, client_secret: env.ACCESS_CLIENT_SECRET, code, redirect_uri: callbackUrl, code_verifier: codeVerifier }).toString(),
    });
    if (!tokenResp.ok) return new Response('upstream_token_exchange_failed', { status: 502 });
    const body = (await tokenResp.json()) as { id_token?: string; access_token?: string; expires_in?: number };
    if (!body.id_token) return new Response('no_id_token', { status: 502 });
    let claims: Record<string, unknown>;
    try { claims = await verifyIdToken(body.id_token, env); }
    catch { return new Response('id_token_verification_failed', { status: 401 }); }
    if (claims.nonce !== nonce) return new Response('nonce_mismatch', { status: 401 });
    const email = String(claims.email ?? '').toLowerCase();
    const sub = String(claims.sub ?? '');
    if (!sub) return new Response('no_subject', { status: 401 });
    if (!email) { console.error('[oauth] /callback: no email claim; keys=', Object.keys(claims).join(',')); return new Response('no_email', { status: 403 }); }
    if (claims.email_verified === false) return new Response('email_not_verified', { status: 403 });
    if (!allowedEmails(env).includes(email)) { console.error('[oauth] /callback: email not allow-listed; domain=', email.split('@')[1] ?? '?'); return new Response('forbidden', { status: 403 }); }
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo, userId: sub, scope: oauthReqInfo.scope, metadata: { label: email },
      props: { email, sub, name: claims.name ?? null, upstreamExpiresIn: body.expires_in ?? null },
    });
    return new Response(null, { status: 302, headers: { location: redirectTo, 'set-cookie': `${CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
  }

  return null;
}

/**
 * Build the OAuthProvider. `apiHandler` (supplied by index.ts) serves /mcp-oauth — it builds the
 * read-only McpServer with the OAuth'd identity. `defaultFetch` is the existing worker router.
 */
export function createOAuthProvider(
  defaultFetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>,
  apiHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> },
): OAuthProvider {
  return new OAuthProvider({
    apiRoute: '/mcp-oauth',
    apiHandler: apiHandler as never,
    defaultHandler: { fetch: defaultFetch } as never,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: ['openid', 'email', 'profile'],
    // OAuth 2.1 removes the `plain` PKCE method — it offers no cryptographic protection, since
    // the verifier and the challenge are the same string. The library defaults this to TRUE for
    // backward compatibility, so until now BOTH connectors advertised
    // `code_challenge_methods_supported: ["plain","S256"]` (verified live 2026-08-01 against
    // /.well-known/oauth-authorization-server on mcp-servicetitan AND qsc-hopper).
    //
    // This flag is not cosmetic. In workers-oauth-provider 0.8.1 it does two things:
    //   - oauth-provider.js:1163 — metadata advertises only ["S256"]
    //   - oauth-provider.js:2961 — /authorize THROWS on a `plain` challenge method
    // so it closes the downgrade rather than merely hiding it. That is why no DCR-registration
    // acceptance probe was needed to settle QUA-1117 item 4.
    //
    // Claude's client uses S256, so this is not a client-compatibility risk.
    allowPlainPKCE: false,
    tokenExchangeCallback: async (options) => {
      const raw = Number((options.props as { upstreamExpiresIn?: number } | undefined)?.upstreamExpiresIn);
      const ttl = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 300), 3600) : 3600;
      return { accessTokenProps: options.props, newProps: options.props, accessTokenTTL: ttl };
    },
  });
}

export type { OAuthHelpers };
