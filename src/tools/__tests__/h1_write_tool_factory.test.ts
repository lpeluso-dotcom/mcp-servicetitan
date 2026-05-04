// ============================================================
// H1 tests — defineWriteTool factory.
// Stateful D1 mock that simulates the confirmation_tokens table so the
// dryRun → confirm round-trip exercises verifyToken end-to-end.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

interface TokenRow { token_hash: string; consumed_at: number | null; expires_at: number }

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

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeStatefulDB(),
    PROXY_STATE: {},
  };
}

const sampleTool = defineWriteTool<{
  customerId: number;
  note: string;
  dryRun?: boolean;
  confirmation_token?: string;
}>({
  name: 'sample_write_tool',
  description: 'Test write tool',
  zodSchema: {
    customerId: z.number().int().positive(),
    note: z.string().min(1),
  },
  endpoint: ({ customerId }) => `/crm/v2/tenant/000000000/customers/${customerId}/notes`,
  method: 'POST',
  payload: ({ note }) => ({ note }),
  businessArgs: ({ customerId, note }) => ({ customerId, note }),
});

describe('defineWriteTool', () => {
  it('augments zodSchema with dryRun + confirmation_token defaults', () => {
    const schema = z.object(sampleTool.zodSchema);
    const parsed = schema.safeParse({ customerId: 1, note: 'x' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dryRun).toBe(true);
    }
  });

  it('marks the tool isWrite=true', () => {
    expect(sampleTool.isWrite).toBe(true);
  });

  it('dryRun branch returns dryRun envelope without calling ST_PROXY', async () => {
    const env = makeEnv(async () => {
      throw new Error('ST_PROXY should not be called on dryRun');
    });
    const result: any = await sampleTool.handler(env, { customerId: 1, note: 'x' }, CTX);
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('sample_write_tool');
    expect(result.confirmation_token).toMatch(/^sample_write_tool\|/);
    expect(result.expires_in_seconds).toBe(900);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('missing confirmation_token after dryRun=false rejects with validation_error', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      sampleTool.handler(env, { customerId: 1, note: 'x', dryRun: false }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('happy path: dryRun → confirm round-trip executes the write', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ ok: true, id: 99 }), { status: 200 }));

    const dry: any = await sampleTool.handler(env, { customerId: 1, note: 'x' }, CTX);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();

    const live: any = await sampleTool.handler(
      env,
      { customerId: 1, note: 'x', dryRun: false, confirmation_token: dry.confirmation_token },
      CTX
    );
    expect(live.dryRun).toBe(false);
    expect(live.tool).toBe('sample_write_tool');
    expect(live.result).toEqual({ ok: true, id: 99 });

    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('/api/st/write');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/crm/v2/tenant/000000000/customers/1/notes');
    expect(body.method).toBe('POST');
    expect(body.payload).toEqual({ note: 'x' });
  });

  it('upstream non-OK throws upstream_error', async () => {
    const env = makeEnv(async () => new Response('boom', { status: 500 }));
    const dry: any = await sampleTool.handler(env, { customerId: 1, note: 'x' }, CTX);
    await expect(
      sampleTool.handler(
        env,
        { customerId: 1, note: 'x', dryRun: false, confirmation_token: dry.confirmation_token },
        CTX
      )
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('reusing the same confirmation_token a second time is rejected by the gate', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    const dry: any = await sampleTool.handler(env, { customerId: 1, note: 'x' }, CTX);
    await sampleTool.handler(
      env,
      { customerId: 1, note: 'x', dryRun: false, confirmation_token: dry.confirmation_token },
      CTX
    );
    await expect(
      sampleTool.handler(
        env,
        { customerId: 1, note: 'x', dryRun: false, confirmation_token: dry.confirmation_token },
        CTX
      )
    ).rejects.toThrow(/already used/);
  });

  it('tampering businessArgs after dryRun invalidates the HMAC', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    const dry: any = await sampleTool.handler(env, { customerId: 1, note: 'x' }, CTX);
    await expect(
      sampleTool.handler(
        env,
        { customerId: 1, note: 'y', dryRun: false, confirmation_token: dry.confirmation_token },
        CTX
      )
    ).rejects.toThrow(/args changed/);
  });

  it('validate hook rejects cross-field invariants before issuing a token', async () => {
    const calls: string[] = [];
    const env = makeEnv(async () => {
      calls.push('fetch');
      return new Response('{}', { status: 200 });
    });
    const tool = defineWriteTool<{
      status: 'Open' | 'Sold';
      soldBy?: number;
      dryRun?: boolean;
      confirmation_token?: string;
    }>({
      name: 'sample_validate_tool',
      description: 'Test tool with cross-field rule',
      zodSchema: {
        status: z.enum(['Open', 'Sold']),
        soldBy: z.number().int().positive().optional(),
      },
      validate: (args) => {
        if (args.status === 'Sold' && args.soldBy === undefined) {
          throw new Error('soldBy required when status=Sold');
        }
      },
      endpoint: () => `/x/y`,
      method: 'PATCH',
      payload: (args) => ({ status: args.status, soldBy: args.soldBy }),
    });
    await expect(tool.handler(env, { status: 'Sold' }, CTX)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('soldBy'),
    });
    expect(calls).toHaveLength(0);
    // Sold + soldBy passes
    const ok: any = await tool.handler(env, { status: 'Sold', soldBy: 42 }, CTX);
    expect(ok.dryRun).toBe(true);
  });

  it('tampering tool name in token rejects', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    const dry: any = await sampleTool.handler(env, { customerId: 1, note: 'x' }, CTX);
    const forged = dry.confirmation_token.replace(/^sample_write_tool/, 'other_tool');
    await expect(
      sampleTool.handler(
        env,
        { customerId: 1, note: 'x', dryRun: false, confirmation_token: forged },
        CTX
      )
    ).rejects.toThrow(/different tool/);
  });
});
