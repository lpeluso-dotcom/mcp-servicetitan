// src/observability/tracing.test.ts
// TDD for the mcp-servicetitan Phoenix tracer: one root span per MCP tool call,
// fail-open into this worker's own otel_span_queue (migrations/0005). Ported
// from qsc-hopper-phoenix/src/observability/tracing.ts with TracerEnv = { DB }
// (this repo's D1 binding), no WorkflowTracer (no Cloudflare Workflows here),
// and a new traceTool() export tailored to tool-registry.ts's success/catch
// paths. attrs must never carry raw tool args/results — callers pass only
// ids/flags — so these tests assert attrs_json round-trips exactly what was
// given, nothing more.
import { describe, it, expect, vi } from 'vitest';
import { traceTool } from './tracing';

// Fake D1 that records every INSERT's bound values. `throwOnRun` makes .run() throw,
// exercising writeSpanRow's internal fail-open catch.
function fakeD1(throwOnRun = false) {
  const rows: any[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async run() {
              if (throwOnRun) throw new Error('d1 down');
              rows.push({ sql, args });
            },
          };
        },
      };
    },
  } as any;
  return { DB, rows };
}

describe('traceTool', () => {
  it('writes exactly one ok root span with the operation/attrs/status when fn resolves ok', async () => {
    const { DB, rows } = fakeD1();
    const attrs = { correlation: 'c-123', role: 'default', actor: 'luke', partial: false };

    await traceTool(
      { DB },
      'search_pricebook_services',
      attrs,
      async () => ({ status: 'ok', latencyMs: 42 })
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args[3]).toBeNull(); // parent_span_id — root span
    expect(row.args[4]).toBe('mcp-servicetitan'); // service_name
    expect(row.args[5]).toBe('search_pricebook_services'); // operation
    expect(row.args[6]).toBe('luke'); // actor
    expect(row.args[7]).toBe('interactive'); // qsc_run_kind
    expect(row.args[8]).toBe('ok'); // status
    expect(row.args[9]).toBe(42); // latency_ms
    expect(JSON.parse(row.args[10])).toEqual(attrs); // attrs_json — exactly what was passed, nothing more
  });

  it('writes exactly one error root span when fn resolves with status error', async () => {
    const { DB, rows } = fakeD1();
    const attrs = { correlation: 'c-456', role: 'admin', actor: 'luke', code: 'upstream_error' };

    await traceTool(
      { DB },
      'book_job',
      attrs,
      async () => ({ status: 'error', latencyMs: 7 })
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args[3]).toBeNull();
    expect(row.args[8]).toBe('error');
    expect(row.args[9]).toBe(7);
    expect(JSON.parse(row.args[10])).toEqual(attrs);
  });

  it('never throws even when the inner fn itself throws, and still emits an error span', async () => {
    const { DB, rows } = fakeD1();
    const attrs = { correlation: 'c-789', role: 'default', actor: 'luke' };

    await expect(
      traceTool({ DB }, 'get_customer', attrs, async () => {
        throw new Error('unexpected fn throw');
      })
    ).resolves.toBeUndefined();

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args[8]).toBe('error');
    const parsedAttrs = JSON.parse(row.args[10]);
    expect(parsedAttrs).toMatchObject(attrs);
    expect(parsedAttrs.error).toBe('unexpected fn throw');
  });

  it('is fail-open: a D1 write failure never escapes traceTool, even on the ok path', async () => {
    const { DB } = fakeD1(true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      traceTool({ DB }, 'get_job', {}, async () => ({ status: 'ok', latencyMs: 1 }))
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });

  it('is fail-open: a D1 write failure never escapes traceTool even when fn also throws', async () => {
    const { DB } = fakeD1(true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      traceTool({ DB }, 'get_job', {}, async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
