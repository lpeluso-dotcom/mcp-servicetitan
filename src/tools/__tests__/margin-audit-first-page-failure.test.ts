import { describe, it, expect, vi } from 'vitest';
import { margin_audit } from '../composites/margin_audit';

const CORRELATION = 'test-corr';
const CTX = { actor: 'vitest', correlation: CORRELATION };

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('rl-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockImplementation(
          async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })
        ),
      }),
    },
  };
}

describe('margin_audit first-page failures', () => {
  it('throws upstream_error instead of returning zero totals when page 1 fails', async () => {
    const env = makeEnv(async () => new Response('upstream', { status: 500 }));

    await expect(
      margin_audit.handler(
        env,
        { businessUnitId: 3, from: '2026-01-01', to: '2026-03-31' },
        CTX
      )
    ).rejects.toMatchObject({ code: 'upstream_error', correlation: CORRELATION });
  });
});
