import { describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import { resolveRole } from '../../auth';

describe('jwt-auth dual-mode', () => {
  const secret = 'test-secret-key';

  async function signToken(claims: Record<string, unknown>): Promise<string> {
    const token = new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt();
    return token.sign(new TextEncoder().encode(secret));
  }

  function makeEnv(jwtSecret: string) {
    return {
      JWT_SECRET: jwtSecret,
      MCP_SYNC_KEY: 'fallback-key',
      DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) },
    };
  }

  function makeRequest(authHeader?: string, syncKey?: string): Request {
    const headers = new Headers();
    if (authHeader) headers.set('authorization', authHeader);
    if (syncKey) headers.set('x-sync-key', syncKey);
    return new Request('http://localhost/', { headers });
  }

  it('returns admin role for valid admin JWT', async () => {
    const token = await signToken({ sub: 'user-123', actor: 'admin-user', role: 'admin' });
    const env = makeEnv(secret) as any;
    const req = makeRequest(`Bearer ${token}`);

    const role = await resolveRole(req, env);
    expect(role).toBe('admin');
  });

  it('returns default role for valid default JWT', async () => {
    const token = await signToken({ sub: 'user-456', actor: 'user', role: 'default' });
    const env = makeEnv(secret) as any;
    const req = makeRequest(`Bearer ${token}`);

    const role = await resolveRole(req, env);
    expect(role).toBe('default');
  });

  it('returns default role for JWT with missing role claim', async () => {
    const token = await signToken({ sub: 'user-789', actor: 'user' });
    const env = makeEnv(secret) as any;
    const req = makeRequest(`Bearer ${token}`);

    const role = await resolveRole(req, env);
    expect(role).toBe('default');
  });

  it('returns default role for invalid JWT', async () => {
    const env = makeEnv(secret) as any;
    const req = makeRequest('Bearer invalid.jwt.token');

    const role = await resolveRole(req, env);
    expect(role).toBe('default');
  });

  it('falls back to X-Sync-Key when no JWT present', async () => {
    const env = makeEnv(secret) as any;
    const req = makeRequest(undefined, 'fallback-key');
    req.headers.set('x-mcp-role', 'admin');

    // Mock DB response for sync-key path
    const hashStmt = { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ role: 'admin' }) }) };
    env.DB.prepare = vi.fn().mockReturnValue(hashStmt);

    const role = await resolveRole(req, env);
    expect(role).toBe('admin');
  });

  it('returns default when no JWT and no sync-key', async () => {
    const env = makeEnv(secret) as any;
    const req = makeRequest();

    const role = await resolveRole(req, env);
    expect(role).toBe('default');
  });

  it('prefers JWT over X-Sync-Key when both present', async () => {
    const token = await signToken({ sub: 'jwt-user', actor: 'jwt-actor', role: 'admin' });
    const env = makeEnv(secret) as any;
    const req = makeRequest(`Bearer ${token}`, 'different-sync-key');
    req.headers.set('x-mcp-role', 'admin');

    const role = await resolveRole(req, env);
    expect(role).toBe('admin');
  });
});
