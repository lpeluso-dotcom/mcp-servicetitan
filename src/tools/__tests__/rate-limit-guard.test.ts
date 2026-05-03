import { describe, it, expect, vi } from 'vitest';
import { familyFromEndpoint, checkRateLimit, reportBackoff } from '../../rate-limit-guard';

describe('familyFromEndpoint', () => {
  it('extracts family from /crm/ endpoints', () => {
    expect(familyFromEndpoint('/crm/v2/customers')).toBe('crm');
  });

  it('extracts family from /dispatch/ endpoints', () => {
    expect(familyFromEndpoint('/dispatch/v2/tenant/123/technicians')).toBe('dispatch');
  });

  it('extracts family from /pricebook/ endpoints', () => {
    expect(familyFromEndpoint('/pricebook/v2/tenant/123/services')).toBe('pricebook');
  });

  it('extracts any family segment from path', () => {
    expect(familyFromEndpoint('/unknown/path')).toBe('unknown');
  });

  it('defaults to crm for root path', () => {
    expect(familyFromEndpoint('/')).toBe('crm');
  });
});

describe('checkRateLimit', () => {
  it('allows when DO returns allowed=true', async () => {
    const doFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), { status: 200 })
    );
    const env = {
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({ fetch: doFetch }),
      },
    };

    await expect(checkRateLimit(env as any, 'dispatch')).resolves.toBeUndefined();
  });

  it('throws when DO returns allowed=false', async () => {
    const doFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: false, retryAfter: 30 }), { status: 200 })
    );
    const env = {
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({ fetch: doFetch }),
      },
    };

    await expect(checkRateLimit(env as any, 'dispatch')).rejects.toThrow('ST rate limit: retry after 30s');
  });

  it('defaults retryAfter to 60s if not provided', async () => {
    const doFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: false }), { status: 200 })
    );
    const env = {
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({ fetch: doFetch }),
      },
    };

    await expect(checkRateLimit(env as any, 'crm')).rejects.toThrow('ST rate limit: retry after 60s');
  });
});

describe('reportBackoff', () => {
  it('calls DO backoff endpoint with family and retryAfter', async () => {
    const doFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const env = {
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({ fetch: doFetch }),
      },
    };

    await reportBackoff(env as any, 'pricebook', 45);

    expect(doFetch).toHaveBeenCalledWith('https://do/backoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family: 'pricebook', retryAfter: 45 }),
    });
  });
});
