// ============================================================
// Wave 2 / Workstream A — the direct ST_PROXY write sites are gated.
//
// readST/readSTPost cover the read surface. These tools bypass both and
// hit env.ST_PROXY.fetch directly, so each needed its own wiring:
//
//   st_call                      GET (/api/st/read) + non-GET (/api/st/write)
//   assign_technicians           unassign + assign (2 writes)
//   st_add_invoice_line_item     /api/st/write (one PATCH per line item)
//   st_create_adjustment_invoice /api/st/write
//   st_patch_service durableWrite  /api/st/durable-write submit
//
// The assertion is an ORDERING invariant rather than a call count: every
// outbound ST request must be IMMEDIATELY preceded by a limiter check on the
// shared call log. Counting checks is brittle here because the same handler
// also does gated reads; ordering states the actual requirement — nothing
// reaches ServiceTitan without first spending budget.
//
// Proxy-internal traffic (/api/sql/read against the D1 mirror, and the
// durable-write STATUS POLL) is deliberately NOT gated: neither reaches the
// ServiceTitan API, so charging them to ST's quota would throttle us against
// a limit they do not consume.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { durableWrite } from '../st_patch_service';
import { assign_technicians } from '../jobs/assign_technicians';
import { st_call } from '../st_call';

const CTX = { actor: 'vitest', correlation: 'corr-w2' };

/** URLs that leave the proxy for ServiceTitan and therefore must be gated. */
const GATED = ['/api/st/read', '/api/st/write', '/api/st/durable-write'];
/** Proxy-internal URLs that must NOT consume ST budget. */
function isGatedUrl(url: string): boolean {
  if (url.includes('/api/st/durable-write/') && url.endsWith('/status')) return false; // poll
  if (url.includes('dryRun=1')) return false; // proxy-side echo, never reaches ST
  return GATED.some((p) => url.includes(p));
}

function makeStatefulDB() {
  const tokens = new Map<string, { consumed_at: number | null; expires_at: number }>();
  return {
    tokens,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt: any = {
        bind: vi.fn((...args: unknown[]) => {
          captured.push(...args);
          return stmt;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR IGNORE INTO confirmation_tokens/i.test(sql)) {
            tokens.set(String(captured[0]), { consumed_at: null, expires_at: Number(captured[5]) });
          } else if (/UPDATE confirmation_tokens SET consumed_at/i.test(sql)) {
            const row = tokens.get(String(captured[1]));
            if (row) row.consumed_at = Number(captured[0]);
          }
          return { success: true };
        }),
        first: vi.fn(async () => {
          if (/SELECT consumed_at, expires_at FROM confirmation_tokens/i.test(sql)) {
            return tokens.get(String(captured[0])) ?? null;
          }
          return null;
        }),
      };
      return stmt;
    }),
  };
}

/**
 * An env whose limiter and ST_PROXY write to ONE ordered log, so the tests
 * can assert that a check precedes each outbound ST call.
 */
function makeTracedEnv(stImpl: (url: string, init?: any) => Promise<Response>, opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  const log: string[] = [];
  const doFetch = vi.fn(async (url: string, init?: any): Promise<Response> => {
    if (url.endsWith('/check')) {
      const family = JSON.parse(init.body).family;
      log.push(`check:${family}`);
      return new Response(
        JSON.stringify(allow ? { allowed: true } : { allowed: false, retryAfter: 9 }),
        { status: 200 }
      );
    }
    log.push('backoff');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const stFetch = vi.fn(async (url: string, init?: any) => {
    log.push(`st:${url}`);
    return stImpl(url, init);
  });
  const env: any = {
    ST_PROXY: { fetch: stFetch },
    ST_RATE_LIMITER: { idFromName: vi.fn((n: string) => n), get: vi.fn(() => ({ fetch: doFetch })) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
    DB: makeStatefulDB(),
    // Test seam: collapse the invoicing read-after-write backoff (2s + 10s)
    // so these tests stay offline-fast.
    VERIFY_BACKOFF_MS: [],
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
  return { env, log, stFetch, doFetch };
}

/**
 * Every outbound ST request in the log is immediately preceded by a limiter
 * check. Also asserts at least one such request happened, so a handler that
 * silently short-circuits cannot pass vacuously.
 */
function assertEveryStCallIsGated(log: string[], expectedFamily?: string) {
  const gatedIndexes = log
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => entry.startsWith('st:') && isGatedUrl(entry.slice(3)));

  expect(gatedIndexes.length).toBeGreaterThan(0);
  for (const { entry, i } of gatedIndexes) {
    const prev = log[i - 1];
    expect(prev, `ungated ST call: ${entry} (preceded by ${prev ?? 'nothing'})`).toMatch(/^check:/);
    if (expectedFamily) expect(prev).toBe(`check:${expectedFamily}`);
  }
}

const okJson = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

// ── durableWrite (st_patch_service / st_create_service / material pair) ──

describe('durableWrite submit is rate limited', () => {
  it('checks the limiter for the pricebook family before submitting', async () => {
    let call = 0;
    const { env, log } = makeTracedEnv(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ instance_id: 'i-1' }), { status: 202 });
      return new Response(JSON.stringify({ status: 'complete', output: { id: 1 } }), { status: 200 });
    });

    await durableWrite(env, {
      actor: 'vitest',
      operation: 'service.patch',
      target: { id: '1', type: 'service' },
      payload: { cost: 1 },
      correlation: 'c',
    });

    assertEveryStCallIsGated(log, 'pricebook');
  });

  it('does NOT spend budget on the status poll (proxy-internal, never reaches ST)', async () => {
    let call = 0;
    const { env, log } = makeTracedEnv(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ instance_id: 'i-1' }), { status: 202 });
      return new Response(JSON.stringify({ status: 'complete', output: { id: 1 } }), { status: 200 });
    });

    await durableWrite(env, {
      actor: 'vitest',
      operation: 'service.patch',
      target: { id: '1', type: 'service' },
      payload: {},
      correlation: 'c',
      _pollMaxAttempts: 2,
      _pollIntervalMs: 0,
    });

    expect(log.filter((l) => l.startsWith('check:'))).toHaveLength(1);
  });

  it('an explicit deny stops the submit from reaching the proxy', async () => {
    const { env, stFetch } = makeTracedEnv(okJson({}), { allow: false });

    await expect(
      durableWrite(env, {
        actor: 'vitest',
        operation: 'service.patch',
        target: { id: '1', type: 'service' },
        payload: {},
        correlation: 'c',
      })
    ).rejects.toMatchObject({ code: 'rate_limited', retry_after_ms: 9_000 });

    expect(stFetch).not.toHaveBeenCalled();
  });
});

// ── assign_technicians (two writes) ─────────────────────────

describe('assign_technicians is rate limited', () => {
  const ARGS = { appointmentId: 5, technicianIds: [7] };

  it('gates both ST writes (unassign + assign)', async () => {
    const { env, log } = makeTracedEnv(okJson({ ok: true }));

    const dry: any = await assign_technicians.handler(env, ARGS, CTX);
    log.length = 0;
    await assign_technicians.handler(
      env,
      { ...ARGS, dryRun: false, confirmation_token: dry.confirmation_token },
      CTX
    );

    assertEveryStCallIsGated(log, 'jpm');
    expect(log.filter((l) => l === 'check:jpm')).toHaveLength(2);
  });

  it('a deny stops the write before it reaches the proxy', async () => {
    const { env } = makeTracedEnv(okJson({ ok: true }));
    const dry: any = await assign_technicians.handler(env, ARGS, CTX);

    // Deny only the confirm leg.
    env.ST_RATE_LIMITER = {
      idFromName: vi.fn((n: string) => n),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ allowed: false, retryAfter: 9 }), { status: 200 })
        ),
      })),
    };
    env.ST_PROXY.fetch.mockClear();

    await expect(
      assign_technicians.handler(
        env,
        { ...ARGS, dryRun: false, confirmation_token: dry.confirmation_token },
        CTX
      )
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });
});

// ── st_call (GET read path + non-GET write path) ────────────

describe('st_call is rate limited on both legs', () => {
  it('gates the GET leg with the path family', async () => {
    const { env, log } = makeTracedEnv(okJson({ data: [] }));

    await st_call.handler(env, { method: 'GET', path: '/crm/v2/tenant/000000000/customers' }, CTX);

    assertEveryStCallIsGated(log, 'crm');
  });

  it('gates the non-GET leg with the path family', async () => {
    const { env, log } = makeTracedEnv(okJson({ id: 1 }));
    const args = { method: 'POST' as const, path: '/jpm/v2/tenant/000000000/jobs', body: { a: 1 } };

    const dry: any = await st_call.handler(env, args, CTX);
    log.length = 0;
    await st_call.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);

    assertEveryStCallIsGated(log, 'jpm');
  });
});

// ── invoicing writes ────────────────────────────────────────

describe('invoicing writes are rate limited', () => {
  it('st_add_invoice_line_item gates every /api/st/write PATCH', async () => {
    const { st_add_invoice_line_item } = await import('../invoicing/st_add_invoice_line_item');
    const { env, log } = makeTracedEnv(async (url: string) => {
      if (url.includes('/api/st/write')) {
        return new Response(JSON.stringify({ id: 99 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 1,
              syncStatus: 'Posted',
              items: [{ id: 99, skuName: 'X', quantity: 1, unitPrice: 100, total: 100 }],
            },
          ],
        }),
        { status: 200 }
      );
    });

    const args: any = {
      invoiceId: 1,
      lineItems: [{ skuId: 2, description: 'test line', quantity: 1, unitPrice: 100 }],
    };
    const dry: any = await st_add_invoice_line_item.handler(env, args, CTX);
    log.length = 0;
    await st_add_invoice_line_item
      .handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
      .catch(() => undefined); // post-write verification may not be satisfiable on a stub

    assertEveryStCallIsGated(log, 'accounting');
  });

  it('st_create_adjustment_invoice gates the /api/st/write POST', async () => {
    const { st_create_adjustment_invoice } = await import('../invoicing/st_create_adjustment_invoice');
    const { env, log } = makeTracedEnv(async (url: string) => {
      if (url.includes('/api/st/write')) {
        return new Response(JSON.stringify({ id: 42, items: [{ id: 1 }] }), { status: 200 });
      }
      if (url.includes('/api/sql/read')) {
        // SKU resolution against the D1 mirror — proxy-internal, ungated.
        return new Response(JSON.stringify({ results: [{ kind: 'service', code: 'SKU-1', name: 'SKU-1' }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: 1, jobId: 1, customerId: 1, batch: null, businessUnitId: 1, syncStatus: 'Posted' }],
        }),
        { status: 200 }
      );
    });

    const args: any = {
      parentInvoiceId: 1,
      lineItems: [{ skuName: 'SKU-1', description: 'credit', quantity: 1, unitPrice: -10 }],
    };
    const dry: any = await st_create_adjustment_invoice.handler(env, args, CTX);
    expect(dry.confirmation_token, 'dryRun must produce a token for this test to mean anything').toBeTypeOf('string');

    log.length = 0;
    await st_create_adjustment_invoice
      .handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
      .catch(() => undefined);

    assertEveryStCallIsGated(log, 'accounting');
  });
});
