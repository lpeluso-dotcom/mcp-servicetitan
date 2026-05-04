import { jwtVerify } from 'jose';

export interface JwtClaims {
  sub: string;
  actor: string;
  role: 'default' | 'admin';
}

const MIN_HS256_SECRET_LENGTH = 16;

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  if (typeof secret !== 'string' || secret.length < MIN_HS256_SECRET_LENGTH || secret === 'undefined') {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
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
