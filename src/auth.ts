// ============================================================
// auth.ts — Inbound role resolution + outbound auth to taylor-ai
// ============================================================

import type { Env } from './env';

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

// Resolve caller role for this request.
// Flow: validate X-Sync-Key (constant-time) → opt-in check (X-MCP-Role: admin) → D1 lookup.
// Returns 'admin' only when the caller presents the correct key AND has an admin row in
// mcp_roles AND explicitly opts in via X-MCP-Role: admin. Degrades to 'default' silently
// (D1 error, key mismatch, missing header) so the MCP session stays alive with the safe tool set.
export async function resolveRole(request: Request, env: Env): Promise<'admin' | 'default'> {
  const syncKey = request.headers.get('x-sync-key');
  if (!syncKey) return 'default';
  if (!(await timingSafeEqual(syncKey, env.MCP_SYNC_KEY))) return 'default';

  if (request.headers.get('x-mcp-role') !== 'admin') return 'default';

  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(syncKey));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    const row = await env.DB.prepare('SELECT role FROM mcp_roles WHERE key_hash = ?')
      .bind(hashHex)
      .first<{ role: string }>();
    return row?.role === 'admin' ? 'admin' : 'default';
  } catch {
    return 'default';
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

export function newCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}-${rand}`;
}
