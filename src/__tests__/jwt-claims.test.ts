import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyJwt } from '../jwt';

const SECRET = 'test-secret-at-least-16-chars-long';
const KEY = new TextEncoder().encode(SECRET);
const AUD = 'mcp-servicetitan';
const ISS = 'https://issuer.example';

async function sign(
  claims: Record<string, unknown>,
  opts: { exp?: string | number; aud?: string; iss?: string } = {},
): Promise<string> {
  let b = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
  if (opts.exp !== undefined) b = b.setExpirationTime(opts.exp);
  if (opts.aud) b = b.setAudience(opts.aud);
  if (opts.iss) b = b.setIssuer(opts.iss);
  return b.sign(KEY);
}

describe('verifyJwt claim enforcement (audit S-2)', () => {
  it('accepts a well-formed token with exp, aud and iss', async () => {
    const t = await sign({ sub: 'u1', actor: 'tester', role: 'default' }, { exp: '5m', aud: AUD, iss: ISS });
    const claims = await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS });
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('u1');
    expect(claims!.actor).toBe('tester');
    expect(claims!.role).toBe('default');
  });

  it('REJECTS a token with no exp claim', async () => {
    const t = await sign({ sub: 'u1' }, { aud: AUD, iss: ISS });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('REJECTS an expired token', async () => {
    const t = await sign({ sub: 'u1' }, { exp: Math.floor(Date.now() / 1000) - 600, aud: AUD, iss: ISS });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('REJECTS a token minted for a different audience', async () => {
    const t = await sign({ sub: 'u1' }, { exp: '5m', aud: 'some-other-service', iss: ISS });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('REJECTS a token from a different issuer', async () => {
    const t = await sign({ sub: 'u1' }, { exp: '5m', aud: AUD, iss: 'https://evil.example' });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('still rejects a short secret', async () => {
    const t = await sign({ sub: 'u1' }, { exp: '5m', aud: AUD, iss: ISS });
    expect(await verifyJwt(t, 'short', { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('requires exp even when no audience or issuer is configured', async () => {
    const noExp = await sign({ sub: 'u1' });
    expect(await verifyJwt(noExp, SECRET)).toBeNull();
    const withExp = await sign({ sub: 'u1' }, { exp: '5m' });
    expect(await verifyJwt(withExp, SECRET)).not.toBeNull();
  });

  it('promotes role:admin and defaults everything else to default', async () => {
    const admin = await sign({ sub: 'u1', role: 'admin' }, { exp: '5m' });
    expect((await verifyJwt(admin, SECRET))!.role).toBe('admin');
    const weird = await sign({ sub: 'u1', role: 'superuser' }, { exp: '5m' });
    expect((await verifyJwt(weird, SECRET))!.role).toBe('default');
  });

  it('rejects a token with no sub', async () => {
    const t = await sign({ actor: 'nobody' }, { exp: '5m' });
    expect(await verifyJwt(t, SECRET)).toBeNull();
  });
});
