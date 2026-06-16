import type { Env } from './env';

export const PUBLIC_TENANT_ID_PLACEHOLDER = '000000000';

function configuredTenantId(env: Pick<Env, 'ST_TENANT_ID'>): string {
  const tenantId = env.ST_TENANT_ID?.trim();
  return tenantId || PUBLIC_TENANT_ID_PLACEHOLDER;
}

// Resolve the public /tenant/000000000/ placeholder to the real ST_TENANT_ID.
// Call this at every data-helper call site (readST/readSTPost, stRead, the write
// factory, st_call). It is a no-op in dev/test where ST_TENANT_ID is the placeholder.
//
// NOTE: a previous `withTenantRewrite(env)` wrapped env.ST_PROXY.fetch to do this
// transparently, but it did not substitute reliably at runtime and leaked
// 000000000 to ST (404s). It was retired in favor of explicit call-site resolution.
export function rewriteTenantPlaceholders(
  env: Pick<Env, 'ST_TENANT_ID'>,
  value: string
): string {
  const tenantId = configuredTenantId(env);
  if (tenantId === PUBLIC_TENANT_ID_PLACEHOLDER) return value;
  return value.replaceAll(PUBLIC_TENANT_ID_PLACEHOLDER, tenantId);
}
