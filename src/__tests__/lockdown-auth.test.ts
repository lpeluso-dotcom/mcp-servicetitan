// ============================================================
// lockdown-auth.test.ts — MCP_LOCKDOWN must NARROW authenticated
// callers, never WAIVE authentication. Regression guard for the
// 2026-07-13 finding: the v1.5.2 short-circuit returned
// authenticated:true before any credential check.
// ============================================================
import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { resolveAuth, verifyConnectorToken } from '../auth';

const SYNC_KEY = 'test-sync-key-1234567890';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.test/mcp', { method: 'POST', headers });
}

function envWith(extra: Record<string, unknown> = {}): any {
  return { MCP_SYNC_KEY: SYNC_KEY, ...extra };
}

function d1RowEnv(row: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  return envWith({
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    ...extra,
  });
}

describe('MCP_LOCKDOWN auth ordering', () => {
  const jwtSecret = 'test-jwt-secret-long-enough-for-hs256';

  async function signToken(claims: Record<string, unknown>): Promise<string> {
    const token = new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt();
    return token.sign(new TextEncoder().encode(jwtSecret));
  }

  it('rejects a caller with NO credentials even when lockdown is on', async () => {
    const auth = await resolveAuth(req(), envWith({ MCP_LOCKDOWN: 'true' }));
    expect(auth.authenticated).toBe(false);
  });

  it('rejects a caller with a WRONG sync key when lockdown is on', async () => {
    const auth = await resolveAuth(
      req({ 'x-sync-key': 'wrong-key' }),
      envWith({ MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(false);
  });

  it('downgrades a valid sync-key caller to the lockdown role', async () => {
    const auth = await resolveAuth(
      req({ 'x-sync-key': SYNC_KEY }),
      envWith({ MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('lockdown');
    expect(auth.authMode).toBe('sync-key');
  });

  it('downgrades even an ADMIN sync-key caller to the lockdown role', async () => {
    const auth = await resolveAuth(
      req({ 'x-sync-key': SYNC_KEY, 'x-mcp-role': 'admin' }),
      d1RowEnv({ role: 'admin' }, { MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('lockdown');
  });

  it('leaves roles untouched when lockdown is off (regression)', async () => {
    const auth = await resolveAuth(req({ 'x-sync-key': SYNC_KEY }), envWith());
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('default');
  });

  it('verifyConnectorToken downgrades a default-role connector token to lockdown', async () => {
    const conn = await verifyConnectorToken(
      'connector-token-abcdef1234567890',
      d1RowEnv({ role: 'default', owner: 'jessica.hunt', expires_at: null }, { MCP_LOCKDOWN: 'true' }),
    );
    expect(conn).not.toBeNull();
    expect(conn!.role).toBe('lockdown');
  });

  it('verifyConnectorToken still rejects unknown tokens under lockdown', async () => {
    const conn = await verifyConnectorToken(
      'connector-token-abcdef1234567890',
      d1RowEnv(null as unknown as Record<string, unknown>, { MCP_LOCKDOWN: 'true' }),
    );
    expect(conn).toBeNull();
  });

  it('downgrades a valid JWT admin caller to the lockdown role', async () => {
    const token = await signToken({ sub: 'jwt-user', actor: 'jwt-admin', role: 'admin' });
    const auth = await resolveAuth(
      req({ authorization: `Bearer ${token}` }),
      envWith({ JWT_SECRET: jwtSecret, MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('lockdown');
    expect(auth.authMode).toBe('jwt');
  });
});
