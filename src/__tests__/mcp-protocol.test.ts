// ============================================================
// mcp-protocol.test.ts — Phase 2 Task 2.1
//
// Protocol-level integration test: our other 543 tests call tool handlers
// directly and never exercise the actual MCP registration layer. This test
// drives the real buildServer() through an in-memory linked MCP transport
// pair with a real SDK Client, so a registration-shape regression (wrong
// config keys, missing annotations, broken structuredContent) is caught
// even though every individual handler test still passes.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestContext } from '../tool-registry';
import { toolsForRole } from '../tools/index';

// src/index.ts's OTHER top-level imports (agents/mcp's createMcpHandler, and
// ./oauth's @cloudflare/workers-oauth-provider) reach into `cloudflare:workers` /
// `cloudflare:email` virtual modules that only exist inside the real workerd
// runtime, not plain Node — so this vitest suite (environment: 'node') cannot
// load the un-mocked module graph. Neither dependency is touched by
// buildServer() itself (they're only used by the fetch() default export for
// unrelated HTTP routing), so stubbing them here is safe and keeps this a real
// exercise of the actual buildServer() + registerTool() registration path.
vi.mock('agents/mcp', () => ({ createMcpHandler: () => () => new Response() }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response() }),
  handleOAuthRoute: async () => new Response(),
}));

const { buildServer } = await import('../index');

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null), // always a cache miss
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(): any {
  return {
    DB: makeDB(),
    ST_PROXY: {
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 1, name: 'Fixture Customer' }] }), { status: 200 })),
    },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
  };
}

const execCtx = { waitUntil: () => undefined } as any;

async function connectedClient(reqCtx: RequestContext) {
  const server = buildServer(makeEnv(), execCtx, reqCtx);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-protocol-test-client', version: '0.0.0-test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('MCP protocol layer — buildServer via in-memory client', () => {
  it('tools/list returns exactly the default-role tool set, each with a title', async () => {
    const reqCtx: RequestContext = { actor: 'test-mcp-protocol', role: 'default' };
    const { client } = await connectedClient(reqCtx);

    const listed = await client.listTools();
    const expectedNames = toolsForRole('default').map((t) => t.name).sort();
    const actualNames = listed.tools.map((t) => t.name).sort();

    expect(listed.tools.length).toBe(toolsForRole('default').length);
    expect(actualNames).toEqual(expectedNames);
    for (const tool of listed.tools) {
      expect(typeof tool.title).toBe('string');
      expect(tool.title!.length).toBeGreaterThan(0);
    }
  });

  it('at least one tool exposes annotations with a readOnlyHint (and both true/false appear)', async () => {
    const reqCtx: RequestContext = { actor: 'test-mcp-protocol', role: 'default' };
    const { client } = await connectedClient(reqCtx);

    const listed = await client.listTools();
    const withReadOnlyHint = listed.tools.filter((t) => t.annotations?.readOnlyHint !== undefined);
    expect(withReadOnlyHint.length).toBeGreaterThan(0);

    const readOnlyValues = new Set(withReadOnlyHint.map((t) => t.annotations!.readOnlyHint));
    expect(readOnlyValues.has(true)).toBe(true);
    expect(readOnlyValues.has(false)).toBe(true);

    // Every tool with annotations should also report openWorldHint === false
    // (closed-world ST tenant, per deriveAnnotations).
    for (const tool of listed.tools) {
      if (tool.annotations) {
        expect(tool.annotations.openWorldHint).toBe(false);
      }
    }
  });

  it('tools/call on a simple read tool (st_list_customers) returns structuredContent', async () => {
    const reqCtx: RequestContext = { actor: 'test-mcp-protocol', role: 'default' };
    const { client } = await connectedClient(reqCtx);

    const result = await client.callTool({ name: 'st_list_customers', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(result.structuredContent).toBeDefined();
    expect(typeof result.structuredContent).toBe('object');
  });

  // Phase 2 Task 2.2 — real safety net for the top-10 outputSchema rollout.
  // Everything above proves the tool CAN return structuredContent; this
  // block proves the SDK's own runtime outputSchema validation
  // (`validateToolOutput` in @modelcontextprotocol/sdk) does NOT reject a
  // real call for tools that now carry an outputSchema. If any of these
  // schemas were too strict, the call below would come back with
  // isError:true (an "Output validation error: ..." McpError), not a
  // handler-level failure — so a green isError:false here is the actual
  // proof the schema is safe to ship.
  describe('outputSchema — real registration path (top-10 tools)', () => {
    it('get_job: tools/call succeeds and structuredContent passes runtime outputSchema validation', async () => {
      const reqCtx: RequestContext = { actor: 'test-mcp-protocol', role: 'default' };
      const { client } = await connectedClient(reqCtx);

      const result = await client.callTool({ name: 'get_job', arguments: { jobId: 123 } });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
      expect((result.structuredContent as any).job).toBeDefined();
      expect((result.structuredContent as any)._source).toBe('live');
    });

    it('find_customer: tools/call succeeds and structuredContent passes runtime outputSchema validation', async () => {
      const reqCtx: RequestContext = { actor: 'test-mcp-protocol', role: 'default' };
      const { client } = await connectedClient(reqCtx);

      const result = await client.callTool({ name: 'find_customer', arguments: { name: 'Fixture' } });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
      expect(Array.isArray((result.structuredContent as any).customers)).toBe(true);
    });

    it('list_unpaid_invoices: tools/call succeeds and structuredContent passes runtime outputSchema validation', async () => {
      const reqCtx: RequestContext = { actor: 'test-mcp-protocol', role: 'default' };
      const { client } = await connectedClient(reqCtx);

      const result = await client.callTool({ name: 'list_unpaid_invoices', arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
      expect(Array.isArray((result.structuredContent as any).invoices)).toBe(true);
    });
  });
});
