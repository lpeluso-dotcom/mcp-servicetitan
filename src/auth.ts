// ============================================================
// auth.ts — Inbound role resolution + outbound auth to servicetitan-proxy
// ============================================================

import type { Env } from './env';
import { verifyJwt } from './jwt';

export type Role = 'admin' | 'default' | 'lockdown' | 'readonly';

/** The roles a connector token may map to. 'readonly' is the no-write reporting surface. */
const CONNECTOR_ROLES: readonly Role[] = ['readonly', 'default'];

export interface AuthResult {
  authenticated: boolean;
  role: Role;
  actor: string;
  authMode: 'jwt' | 'sync-key' | 'none';
}

function hasConfiguredSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length > 0 && secret !== 'undefined';
}

// Constant-time string comparison via HMAC. Generates a per-call ephemeral key
// so equal inputs always produce equal MACs; the 32-byte XOR loop runs in full
// regardless of where strings diverge — timing-safe for the sync key check.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])) as CryptoKey;
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ma);
  const vb = new Uint8Array(mb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function hasValidSyncKey(request: Request, env: Env): Promise<boolean> {
  const syncKey = request.headers.get('x-sync-key');
  if (!syncKey || !hasConfiguredSecret(env.MCP_SYNC_KEY)) return false;
  return timingSafeEqual(syncKey, env.MCP_SYNC_KEY);
}

// Resolve caller role for this request.
// Dual-mode auth: JWT first, then fall back to X-Sync-Key (constant-time).
// MCP_LOCKDOWN (v1.5.2; ordering fixed 2026-07-13): when 'true', every
// AUTHENTICATED caller is forced into the lockdown role — toolsForRole()
// then strips all writes + st_call. Lockdown must never waive
// authentication itself: credentials are still required; the switch only
// narrows what they grant.
export async function resolveAuth(request: Request, env: Env): Promise<AuthResult> {
  const auth = await resolveCredentials(request, env);
  if (env.MCP_LOCKDOWN === 'true' && auth.authenticated) {
    return { ...auth, role: 'lockdown' };
  }
  return auth;
}

async function resolveCredentials(request: Request, env: Env): Promise<AuthResult> {
  const fallbackActor = safeActorHeader(request.headers.get('x-actor'));

  // JWT path first
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const claims = await verifyJwt(token, env.JWT_SECRET);
    if (claims) {
      return {
        authenticated: true,
        role: claims.role,
        actor: safeActorHeader(claims.actor),
        authMode: 'jwt',
      };
    }
  }

  // Fall back to X-Sync-Key (legacy)
  const syncKey = request.headers.get('x-sync-key');
  if (!syncKey || !(await hasValidSyncKey(request, env))) {
    return { authenticated: false, role: 'default', actor: fallbackActor, authMode: 'none' };
  }

  if (request.headers.get('x-mcp-role') !== 'admin') {
    return { authenticated: true, role: 'default', actor: fallbackActor, authMode: 'sync-key' };
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(syncKey));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    const row = await env.DB.prepare('SELECT role FROM mcp_roles WHERE key_hash = ?')
      .bind(hashHex)
      .first<{ role: string }>();
    return {
      authenticated: true,
      role: row?.role === 'admin' ? 'admin' : 'default',
      actor: fallbackActor,
      authMode: 'sync-key',
    };
  } catch {
    return { authenticated: true, role: 'default', actor: fallbackActor, authMode: 'sync-key' };
  }
}

export async function resolveRole(request: Request, env: Env): Promise<Role> {
  return (await resolveAuth(request, env)).role;
}

// `verifyConnectorToken` and its ConnectorAuth type were DELETED 2026-08-01 (QUA-1117 item 3)
// along with the `/c/<token>/mcp` route they served. A URL-path credential carried its own role,
// so a token minted role:'default' bypassed the read-only guarantee and reached every write tool.
// See the note at the old route site in src/index.ts. The `mcp_auth_tokens` D1 table (migration
// 0004) is intentionally left in place — dropping a prod table is a separately gated action.

export function authHeaders(env: Env, correlation: string, actor: string): Record<string, string> {
  return {
    'X-Sync-Key': env.MCP_SYNC_KEY,
    'X-Correlation-Id': correlation,
    'X-Actor': actor,
    'User-Agent': `mcp-servicetitan/${env.MCP_SERVICE_VERSION}`,
  };
}

// X-Actor is forwarded upstream to servicetitan-proxy (and into audit_log + Analytics
// Engine indexes). Restrict to a printable ASCII subset to prevent log injection
// and to keep upstream RBAC trust gradients clean if X-Actor ever becomes
// authoritative. Invalid input falls back to the generic 'claude-code' default
// rather than rejecting the request — actors are advisory, not auth.
const ACTOR_RE = /^[a-zA-Z0-9._:-]{1,64}$/;
export function safeActorHeader(raw: string | null): string {
  if (raw && ACTOR_RE.test(raw)) return raw;
  return 'claude-code';
}

export function newCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}-${rand}`;
}
