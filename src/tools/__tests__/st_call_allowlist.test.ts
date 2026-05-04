import { describe, it, expect } from 'vitest';
import { st_call } from '../st_call';

const CTX = { actor: 'test-actor', correlation: 'test-corr' };

function makeEnv(): any {
  return {
    ST_PROXY: { fetch: () => new Response(JSON.stringify({}), { status: 200 }) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: {},
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

describe('st_call — path-prefix allowlist', () => {
  it('allows paths in the allowlist', async () => {
    const env = makeEnv();
    // Path in allowlist: /crm/v2/...
    const result = st_call.handler(env, {
      method: 'GET',
      path: '/crm/v2/customers',
    }, CTX);
    // Should not throw; GET routes to read proxy
    await expect(result).resolves.toBeDefined();
  });

  it('rejects paths not in the allowlist', async () => {
    const env = makeEnv();
    // Path not in allowlist: /external/evil
    const result = st_call.handler(env, {
      method: 'GET',
      path: '/external/evil',
    }, CTX);
    // Should throw validation_error
    await expect(result).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('normalizes /task-management/ to /taskmanagement/ and allows it', async () => {
    const env = makeEnv();
    // Path with /task-management/ (ST's legacy form) normalizes to /taskmanagement/ and passes
    const result = st_call.handler(env, {
      method: 'GET',
      path: '/task-management/v2/something',
    }, CTX);
    // Should not throw
    await expect(result).resolves.toBeDefined();
  });
});
