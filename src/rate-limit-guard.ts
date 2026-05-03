import type { Env } from './env';

export function familyFromEndpoint(endpoint: string): string {
  const m = endpoint.match(/^\/([a-z]+)\//);
  return m?.[1] ?? 'crm';
}

export async function checkRateLimit(env: Env, family: string): Promise<void> {
  const id = env.ST_RATE_LIMITER.idFromName(family);
  const stub = env.ST_RATE_LIMITER.get(id);
  const resp = await stub.fetch('https://do/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family }),
  });
  const data = await resp.json<{ allowed: boolean; retryAfter?: number }>();
  if (!data.allowed) throw new Error(`ST rate limit: retry after ${data.retryAfter ?? 60}s (family: ${family})`);
}

export async function reportBackoff(env: Env, family: string, retryAfter: number): Promise<void> {
  const id = env.ST_RATE_LIMITER.idFromName(family);
  const stub = env.ST_RATE_LIMITER.get(id);
  await stub.fetch('https://do/backoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family, retryAfter }),
  });
}
