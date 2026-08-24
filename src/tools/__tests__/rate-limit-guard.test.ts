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

  // Wave 2: the old default was 'crm', which charged every unparseable
  // endpoint to a real family's 60/min budget. Unattributable traffic now
  // gets its own 'other' bucket (DEFAULT_FAMILY_CAP) and still counts
  // against the global aggregate.
  it('buckets an unparseable path into "other", not crm', () => {
    expect(familyFromEndpoint('/')).toBe('other');
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

  // Wave 2: the deny is an McpError('rate_limited') carrying retry_after_ms,
  // not a bare Error the tool layer cannot classify.
  it('denies with McpError(rate_limited) + retry_after_ms', async () => {
    const env = {
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn(async () =>
            new Response(JSON.stringify({ allowed: false, retryAfter: 30 }), { status: 200 })
          ),
        }),
      },
    };
    const err = await checkRateLimit(env as any, 'dispatch').catch((e) => e as any);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBe(30_000);
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
