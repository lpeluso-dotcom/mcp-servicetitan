import { jwtVerify } from 'jose';

export interface JwtClaims {
  sub: string;
  actor: string;
  role: 'default' | 'admin';
}

export interface JwtVerifyOptions {
  audience?: string;
  issuer?: string;
}

const MIN_HS256_SECRET_LENGTH = 16;

export async function verifyJwt(
  token: string,
  secret: string,
  opts: JwtVerifyOptions = {},
): Promise<JwtClaims | null> {
  if (typeof secret !== 'string' || secret.length < MIN_HS256_SECRET_LENGTH || secret === 'undefined') {
    return null;
  }

  try {
    // audience/issuer are enforced only when configured, so an unconfigured
    // deployment does not lock itself out. `exp`, by contrast, is ALWAYS
    // required (checked below): jose silently accepts a token that omits the
    // claim entirely, which made such a token valid forever. (audit S-2)
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      ...(opts.audience ? { audience: opts.audience } : {}),
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
      clockTolerance: 30,
    });

    if (typeof payload.exp !== 'number') return null;

    const sub = String(payload.sub ?? '');
    if (!sub) return null;

    return {
      sub,
      actor: String((payload as Record<string, unknown>).actor ?? 'jwt-client'),
      role: (payload as Record<string, unknown>).role === 'admin' ? 'admin' : 'default',
    };
  } catch {
    return null;
  }
}
