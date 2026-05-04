import type { Env } from './env';

export const PUBLIC_TENANT_ID_PLACEHOLDER = '000000000';

function configuredTenantId(env: Pick<Env, 'ST_TENANT_ID'>): string {
  const tenantId = env.ST_TENANT_ID?.trim();
  return tenantId || PUBLIC_TENANT_ID_PLACEHOLDER;
}

export function rewriteTenantPlaceholders(
  env: Pick<Env, 'ST_TENANT_ID'>,
  value: string
): string {
  const tenantId = configuredTenantId(env);
  if (tenantId === PUBLIC_TENANT_ID_PLACEHOLDER) return value;
  return value.replaceAll(PUBLIC_TENANT_ID_PLACEHOLDER, tenantId);
}

function rewriteInput(input: RequestInfo | URL, env: Env): RequestInfo | URL {
  if (typeof input === 'string') return rewriteTenantPlaceholders(env, input);
  if (input instanceof URL) return new URL(rewriteTenantPlaceholders(env, input.toString()));
  if (input instanceof Request) {
    return new Request(rewriteTenantPlaceholders(env, input.url), input);
  }
  return input;
}

function rewriteInit(init: RequestInit | undefined, env: Env) {
  if (!init || typeof init.body !== 'string') return init;
  return {
    ...init,
    body: rewriteTenantPlaceholders(env, init.body),
  };
}

export function withTenantRewrite(env: Env): Env {
  return {
    ...env,
    ST_PROXY: {
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        return env.ST_PROXY.fetch(rewriteInput(input, env), rewriteInit(init, env));
      },
    } as Fetcher,
  };
}
