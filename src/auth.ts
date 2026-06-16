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
// JWT flow: extract Authorization: Bearer <JWT>, verify signature, return role from claim.
// Fallback: validate X-Sync-Key → opt-in check (X-MCP-Role: admin) → D1 lookup.
// Returns 'admin' only when the caller presents valid credentials and has admin role.
// Degrades to 'default' silently (D1 error, key mismatch, missing header) so the MCP
// session stays alive with the safe tool set.
export async function resolveAuth(request: Request, env: Env): Promise<AuthResult> {
  const fallbackActor = safeActorHeader(request.headers.get('x-actor'));

  // Lockdown short-circuit (v1.5.2). MCP_LOCKDOWN=true forces every caller into
  // the lockdown role regardless of credentials — toolsForRole() then strips
  // all writes + st_call. Use this when the server is fronting an untrusted
  // network or when you want defence-in-depth during an incident.
  if (env.MCP_LOCKDOWN === 'true') {
    return { authenticated: true, role: 'lockdown', actor: fallbackActor, authMode: 'none' };
  }

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

export interface ConnectorAuth {
  role: Role;
  owner: string;
}

/**
 * Resolve a Claude Desktop connector token (the `/c/<token>/mcp` route). Desktop's connector
 * UI accepts only a URL — it cannot send X-Sync-Key — so the secret lives in the URL path and
 * IS the credential. We SHA-256 the presented token and look it up in mcp_auth_tokens (same
 * hash-in-D1 pattern as mcp_roles); a hit that hasn't expired returns its role + owner.
 *
 * Fail-closed: unknown/expired token, missing table, or any D1 error ⇒ null (deny). The role
 * is constrained to CONNECTOR_ROLES (never 'admin' via this path), defaulting to 'readonly' —
 * so a misconfigured row can only ever GRANT LESS, never escalate to writes.
 */
export async function verifyConnectorToken(
  token: string | undefined,
  env: Env,
): Promise<ConnectorAuth | null> {
  if (!token || token.length < 16) return null; // reject empty / too-short tokens
  let hashHex: string;
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
  try {
    const row = await env.DB.prepare(
      'SELECT role, owner, expires_at FROM mcp_auth_tokens WHERE token_hash = ?',
    )
      .bind(hashHex)
      .first<{ role: string; owner: string | null; expires_at: number | null }>();
    if (!row) return null;
    if (row.expires_at != null && row.expires_at < Date.now()) return null; // expired
    const role: Role = (CONNECTOR_ROLES as readonly string[]).includes(row.role)
      ? (row.role as Role)
      : 'readonly';
    return { role, owner: safeActorHeader(row.owner) };
  } catch {
    return null; // table missing / D1 error ⇒ deny
  }
}

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
