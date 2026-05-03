import { jwtVerify } from 'jose';

export interface JwtClaims {
  sub: string;
  actor: string;
  role: 'default' | 'admin';
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return {
      sub: String(payload.sub ?? ''),
      actor: String((payload as Record<string, unknown>).actor ?? 'jwt-client'),
      role: (payload as Record<string, unknown>).role === 'admin' ? 'admin' : 'default',
    };
  } catch {
    return null;
  }
}
