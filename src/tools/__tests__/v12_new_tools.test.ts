// ============================================================
// v1.2 F.1 tests — st_get_capacity_slots, st_run_report,
// st_post_marketing_attribution.
//
// Pattern mirrors existing t7_*.test.ts: stateful D1 mock for the write
// tool (so the dryRun → confirm round-trip exercises verifyToken end-to-end).
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { st_get_capacity_slots } from '../dispatch/st_get_capacity_slots';
import { st_run_report } from '../reporting/st_run_report';
import { st_post_marketing_attribution } from '../marketing/st_post_marketing_attribution';
import { search_pricebook_all, codeVariants } from '../pricebook/search_pricebook_all';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

interface TokenRow {
  token_hash: string;
  consumed_at: number | null;
  expires_at: number;
}

function makeStatefulDB() {
  const tokens: Map<string, TokenRow> = new Map();
  return {
    tokens,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt = {
        bind: vi.fn(function (this: any, ...args: unknown[]) {
          captured.push(...args);
          return this;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR IGNORE INTO confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            // INSERT params: token_hash, tool, args_hash, actor, issued_at, expires_at, correlation
            const expiresAt = Number(captured[5]);
            tokens.set(tokenHash, { token_hash: tokenHash, consumed_at: null, expires_at: expiresAt });
          } else if (/UPDATE confirmation_tokens SET consumed_at/i.test(sql)) {
            const consumedAt = Number(captured[0]);
            const tokenHash = String(captured[1]);
            const row = tokens.get(tokenHash);
            if (row) row.consumed_at = consumedAt;
          }
          return { success: true };
        }),
        first: vi.fn(async () => {
          if (/SELECT consumed_at, expires_at FROM confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            return tokens.get(tokenHash) ?? null;
          }
          return null;
        }),
      };
      return stmt;
    }),
  };
}

function makeDB(firstResult: unknown = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

function makeWriteEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeStatefulDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

function liveOkDirect(data: unknown) {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}

function liveOkWrapped(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

// ── F.1.a — st_get_capacity_slots ──────────────────────────────

describe('st_get_capacity_slots', () => {
  it('declares the v1.2 stEndpoint descriptor (POST /capacity)', () => {
    expect(st_get_capacity_slots.stEndpoint).toEqual({
      method: 'POST',
      path: '/dispatch/v2/tenant/{tid}/capacity',
      source: 'live',
    });
  });

  it('requires startsOnOrAfter and endsOnOrBefore', () => {
    const schema = z.object(st_get_capacity_slots.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ startsOnOrAfter: '2026-05-01T08:00Z' }).success).toBe(false);
  });

  it('accepts the minimum required args and POSTs to /capacity (not /capacity-planning)', async () => {
    const env = makeEnv(liveOkDirect({ slots: [] }));
    const result: any = await st_get_capacity_slots.handler(
      env,
      { startsOnOrAfter: '2026-05-01T08:00Z', endsOnOrBefore: '2026-05-07T17:00Z' },
      CTX
    );
    expect(result.slots).toBeDefined();
    expect(result._source).toBe('live');
    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    // Must hit /capacity, NOT /capacity-planning (gotcha: T7 get_capacity is the planning one).
    expect(url).toContain('%2Fcapacity');
    expect(url).not.toContain('capacity-planning');
  });

  it('passes businessUnitIds and skillBasedAvailability through the body', async () => {
    const env = makeEnv(liveOkDirect({ slots: [] }));
    await st_get_capacity_slots.handler(
      env,
      {
        startsOnOrAfter: '2026-05-01T08:00Z',
        endsOnOrBefore: '2026-05-07T17:00Z',
        businessUnitIds: [3, 7],
        skillBasedAvailability: true,
      },
      CTX
    );
    const [, init] = env.ST_PROXY.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.businessUnitIds).toEqual([3, 7]);
    expect(body.skillBasedAvailability).toBe(true);
  });
});

// ── F.1.b — st_run_report ──────────────────────────────────────

describe('st_run_report', () => {
  it('declares the canonical stEndpoint as the run path', () => {
    expect(st_run_report.stEndpoint?.method).toBe('POST');
    expect(st_run_report.stEndpoint?.path).toContain('/data');
    expect(st_run_report.stEndpoint?.source).toBe('live');
  });

  it('mode=list_categories hits /report-categories (no required args beyond mode)', async () => {
    const env = makeEnv(liveOkWrapped([{ id: 'cat1' }]));
    const result: any = await st_run_report.handler(env, { mode: 'list_categories' }, CTX);
    expect(result.mode).toBe('list_categories');
    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    // Default fetch (no init) is GET.
    expect(init === undefined || init.method === undefined || init.method === 'GET').toBe(true);
    expect(url).toContain('report-categories');
  });

  it('mode=list_reports requires categoryId', async () => {
    const env = makeEnv(liveOkWrapped([]));
    await expect(
      st_run_report.handler(env, { mode: 'list_reports' }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('mode=list_reports hits the per-category reports endpoint', async () => {
    const env = makeEnv(liveOkWrapped([{ id: 'r1' }]));
    await st_run_report.handler(env, { mode: 'list_reports', categoryId: 'cat1' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('report-category%2Fcat1%2Freports');
  });

  it('mode=describe_report rejects when categoryId or reportId missing', async () => {
    const env = makeEnv(liveOkDirect({}));
    await expect(
      st_run_report.handler(env, { mode: 'describe_report' }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      st_run_report.handler(env, { mode: 'describe_report', categoryId: 'cat1' }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      st_run_report.handler(env, { mode: 'describe_report', reportId: 'r1' }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('mode=describe_report hits the singular-report endpoint when both IDs present', async () => {
    const env = makeEnv(liveOkDirect({ id: 'r1', parameters: [] }));
    const result: any = await st_run_report.handler(
      env,
      { mode: 'describe_report', categoryId: 'cat1', reportId: 'r1' },
      CTX
    );
    expect(result.mode).toBe('describe_report');
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('report-category%2Fcat1%2Freports%2Fr1');
  });

  it('mode=run rejects when parameters[] missing', async () => {
    const env = makeEnv(liveOkDirect({}));
    await expect(
      st_run_report.handler(env, { mode: 'run', categoryId: 'cat1', reportId: 'r1' }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('mode=run POSTs to .../data with parameters body', async () => {
    const env = makeEnv(liveOkDirect({ rows: [] }));
    await st_run_report.handler(
      env,
      {
        mode: 'run',
        categoryId: 'cat1',
        reportId: 'r1',
        parameters: [{ name: 'From', value: '2026-01-01' }],
        pageSize: 50,
      },
      CTX
    );
    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(url).toContain('reports%2Fr1%2Fdata');
    const body = JSON.parse(init.body);
    expect(body.parameters).toEqual([{ name: 'From', value: '2026-01-01' }]);
    expect(body.pageSize).toBe(50);
    expect(body.page).toBe(1);
  });
});

// ── F.1.c — st_post_marketing_attribution ──────────────────────

describe('st_post_marketing_attribution', () => {
  it('is a write tool with the templated stEndpoint', () => {
    expect(st_post_marketing_attribution.isWrite).toBe(true);
    expect(st_post_marketing_attribution.stEndpoint).toEqual({
      method: 'POST',
      path: '/marketingads/v2/tenant/{tid}/{kind}-attributions',
      source: 'live',
    });
  });

  it('schema accepts each kind', () => {
    const schema = z.object(st_post_marketing_attribution.zodSchema);
    for (const kind of ['job', 'web_booking', 'web_lead_form', 'external_call']) {
      expect(
        schema.safeParse({ kind, attributionData: { utmSource: 'google' }, jobId: 1, bookingId: 1, leadFormId: 1, externalCallId: 'x' }).success
      ).toBe(true);
    }
  });

  it('validate rejects kind=job without jobId', async () => {
    const env = makeWriteEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      st_post_marketing_attribution.handler(
        env,
        { kind: 'job', attributionData: { utmSource: 'google' } },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('validate rejects kind=web_booking without bookingId', async () => {
    const env = makeWriteEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      st_post_marketing_attribution.handler(
        env,
        { kind: 'web_booking', attributionData: {} },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('validate rejects kind=external_call without externalCallId or callId', async () => {
    const env = makeWriteEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      st_post_marketing_attribution.handler(
        env,
        { kind: 'external_call', attributionData: {} },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('dryRun → confirm round-trip POSTs to job-attributions for kind=job', async () => {
    const env = makeWriteEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const dry: any = await st_post_marketing_attribution.handler(
      env,
      {
        kind: 'job',
        jobId: 42,
        attributionData: { utmSource: 'google', utmCampaign: 'spring-2026' },
      },
      CTX
    );
    expect(dry.dryRun).toBe(true);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();

    const live: any = await st_post_marketing_attribution.handler(
      env,
      {
        kind: 'job',
        jobId: 42,
        attributionData: { utmSource: 'google', utmCampaign: 'spring-2026' },
        dryRun: false,
        confirmation_token: dry.confirmation_token,
      },
      CTX
    );
    expect(live.dryRun).toBe(false);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('/api/st/write');
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/marketingads/v2/tenant/000000000/job-attributions');
    expect(body.method).toBe('POST');
    expect(body.payload.jobId).toBe(42);
    expect(body.payload.attributionData.utmCampaign).toBe('spring-2026');
  });

  it('dryRun → confirm round-trip POSTs to web-booking-attributions for kind=web_booking', async () => {
    const env = makeWriteEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const dry: any = await st_post_marketing_attribution.handler(
      env,
      { kind: 'web_booking', bookingId: 9, attributionData: { gclid: 'abc' } },
      CTX
    );
    await st_post_marketing_attribution.handler(
      env,
      {
        kind: 'web_booking',
        bookingId: 9,
        attributionData: { gclid: 'abc' },
        dryRun: false,
        confirmation_token: dry.confirmation_token,
      },
      CTX
    );
    const [, init] = env.ST_PROXY.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/marketingads/v2/tenant/000000000/web-booking-attributions');
    expect(body.payload.bookingId).toBe(9);
  });

  it('dryRun → confirm round-trip POSTs to web-lead-form-attributions for kind=web_lead_form', async () => {
    const env = makeWriteEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const dry: any = await st_post_marketing_attribution.handler(
      env,
      { kind: 'web_lead_form', leadFormId: 5, attributionData: { fbclid: 'xyz' } },
      CTX
    );
    await st_post_marketing_attribution.handler(
      env,
      {
        kind: 'web_lead_form',
        leadFormId: 5,
        attributionData: { fbclid: 'xyz' },
        dryRun: false,
        confirmation_token: dry.confirmation_token,
      },
      CTX
    );
    const [, init] = env.ST_PROXY.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/marketingads/v2/tenant/000000000/web-lead-form-attributions');
    expect(body.payload.leadFormId).toBe(5);
  });

  it('dryRun → confirm round-trip POSTs to external-call-attributions for kind=external_call', async () => {
    const env = makeWriteEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const dry: any = await st_post_marketing_attribution.handler(
      env,
      {
        kind: 'external_call',
        externalCallId: 'lace-123',
        attributionData: { sessionId: 's1' },
      },
      CTX
    );
    await st_post_marketing_attribution.handler(
      env,
      {
        kind: 'external_call',
        externalCallId: 'lace-123',
        attributionData: { sessionId: 's1' },
        dryRun: false,
        confirmation_token: dry.confirmation_token,
      },
      CTX
    );
    const [, init] = env.ST_PROXY.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/marketingads/v2/tenant/000000000/external-call-attributions');
    expect(body.payload.externalCallId).toBe('lace-123');
  });
});

// ── search_pricebook_all — D1 read, smoke test ───────────────────

describe('search_pricebook_all', () => {
  function makeD1Env(results: unknown[]) {
    return {
      ST_PROXY: {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ success: true, results }), { status: 200 })
        ),
      },
      MCP_SYNC_KEY: 'test-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      DB: {},
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
    };
  }

  it('code lookup calls ST_PROXY with /api/sql/read (D1 path, not ST read path)', async () => {
    const env = makeD1Env([{ code: 'FLU-150', name: 'Flush', description: '', category: 'Drain', price: 150, member_price: null, type: 'service' }]);
    const result: any = await search_pricebook_all.handler(env as any, { code: 'FLU-150' }, { actor: 'vitest', correlation: 'test' });
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    const [url] = (env.ST_PROXY.fetch as any).mock.calls[0];
    expect(url).toContain('/api/sql/read');
    expect(url).not.toContain('/api/st/read');
  });

  it('query path fans out across all 3 D1 tables and merges results', async () => {
    const env = makeD1Env([]);
    await search_pricebook_all.handler(env as any, { query: 'flush' }, { actor: 'vitest', correlation: 'test' });
    // 3 parallel queries for query path (services + materials + equipment)
    expect((env.ST_PROXY.fetch as any).mock.calls.length).toBe(3);
  });

  it('rejects when neither code nor query provided', async () => {
    const env = makeD1Env([]);
    await expect(
      search_pricebook_all.handler(env as any, {}, { actor: 'vitest', correlation: 'test' })
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  // Pins the fix for "when asked how much time, surface estimated labor on service code".
  // pb_services.hours + pb_equipment.hours are now selected and passed through to the agent.
  it('returns hours field for services (estimated labor in decimal hours)', async () => {
    const env = makeD1Env([
      { code: 'ACC-006', name: 'Roof Access', description: 'Roof access labor', category: 'Access', price: 138.75, member_price: null, hours: 0.75, type: 'service' },
    ]);
    const result: any = await search_pricebook_all.handler(env as any, { code: 'ACC-006' }, { actor: 'vitest', correlation: 'test' });
    expect(result.status).toBe('success');
    expect(result.items[0].hours).toBe(0.75);
    expect(result.items[0].type).toBe('service');
  });

  it('returns hours: null for materials (no labor attached)', async () => {
    const env = makeD1Env([
      { code: 'MAT-001', name: 'Copper Pipe', description: '', category: 'Pipe', price: 12.5, member_price: null, hours: null, type: 'material' },
    ]);
    const result: any = await search_pricebook_all.handler(env as any, { code: 'MAT-001' }, { actor: 'vitest', correlation: 'test' });
    expect(result.items[0].hours).toBeNull();
    expect(result.items[0].type).toBe('material');
  });

  // Pins the fix for dynamic pricing: a service with price=0 but calculated_price=200
  // must rank ABOVE a $50 material, and expose calculated_price + pricing fields.
  it('calculated_price: dynamic service (price 0, calculated_price 200) ranks above $50 material in fuzzy results', async () => {
    // Three parallel fetches: services, materials, equipment
    const svcRow = { code: 'SVC-DYN', name: 'Dynamic Service', description: '', category: 'HVAC', price: 0, calculated_price: 200, member_price: null, hours: 1.0, type: 'service' };
    const matRow = { code: 'MAT-050', name: 'Some Material', description: '', category: 'Parts', price: 50, calculated_price: null, member_price: null, hours: null, type: 'material' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [svcRow] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [matRow] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [] }), { status: 200 }));
    const env = {
      ST_PROXY: { fetch: fetchMock },
      MCP_SYNC_KEY: 'test-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      DB: {},
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
    };
    const result: any = await search_pricebook_all.handler(env as any, { query: 'service' }, { actor: 'vitest', correlation: 'test' });
    expect(result.status).toBe('success');
    expect(result.items[0].code).toBe('SVC-DYN');
    expect(result.items[0].calculated_price).toBe(200);
    expect(result.items[0].pricing).toBe('dynamic');
    // Regression guard: the numeric `price` contract must survive — a null-price
    // dynamic service still reports price as the number 0, not null/undefined.
    expect(result.items[0].price).toBe(0);
    expect(result.items[1].code).toBe('MAT-050');
    expect(result.items[1].pricing).toBe('cost');
  });

  // Pins the highest-risk branch: a real dynamic service whose calculated_price
  // sync is stale/missing (price 0, calculated_price null) must flag as
  // 'dynamic-unknown' — NOT 'static' and NOT misreported as free/unpriced.
  it('calculated_price: service with price 0 and no calculated_price flags pricing=dynamic-unknown', async () => {
    const svcRow = { code: 'SVC-STALE', name: 'Stale Sync Service', description: '', category: 'HVAC', price: 0, calculated_price: null, member_price: null, hours: 1.0, type: 'service' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [svcRow] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [] }), { status: 200 }));
    const env = {
      ST_PROXY: { fetch: fetchMock },
      MCP_SYNC_KEY: 'test-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      DB: {},
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
    };
    const result: any = await search_pricebook_all.handler(env as any, { query: 'service' }, { actor: 'vitest', correlation: 'test' });
    expect(result.status).toBe('success');
    expect(result.items[0].code).toBe('SVC-STALE');
    expect(result.items[0].pricing).toBe('dynamic-unknown');
    expect(result.items[0].price).toBe(0);
  });
});

describe('codeVariants', () => {
  it('dedupes when input is already canonical', () => {
    expect(codeVariants('FLU-150')).toEqual(['FLU-150']);
  });

  it('adds uppercase and hyphenated variants for lowercase spoken input', () => {
    const v = codeVariants('flu150');
    expect(v).toContain('flu150');
    expect(v).toContain('FLU150');
    expect(v).toContain('FLU-150');
  });
});
