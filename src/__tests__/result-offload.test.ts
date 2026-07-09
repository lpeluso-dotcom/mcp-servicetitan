// ============================================================
// result-offload.test.ts — Phase 2 Task 2.4
//
// Oversized tool results (some composites/lists run 60KB-400KB) bloat
// client context if inlined whole. offloadIfLarge() gates on
// JSON.stringify(result).length: under RESULT_THRESHOLD the behavior must
// be BYTE-IDENTICAL to the pre-existing tool-registry.ts inline path (same
// text content block + same structuredContent wrapping rule) — test group
// 1 pins that guarantee. Over threshold, the full payload is stashed in KV
// (PROXY_STATE, key `result:{correlation}`) and the tool call returns a
// short summary + an MCP resource_link; registerResultResource() wires the
// companion `mcp-st://results/{id}` resource that reads it back.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  offloadIfLarge,
  registerResultResource,
  RESULT_THRESHOLD,
  RESULT_TTL_S,
} from '../resources/results';

function makeEnv() {
  // A stateful in-memory KV mock: put() actually persists so a later get()
  // in the same test can see it (needed for the protocol-path round trip
  // below), while both remain vi.fn() spies for call-shape assertions.
  const store = new Map<string, string>();
  return {
    PROXY_STATE: {
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    },
  } as any;
}

describe('offloadIfLarge — under threshold (byte-identical guarantee)', () => {
  it('returns offloaded:false with a text block equal to JSON.stringify(result) and unchanged structuredContent, and never touches KV', async () => {
    const env = makeEnv();
    const result = { customers: [{ id: 1, name: 'Fixture Customer' }], total: 1 };

    const shaped = await offloadIfLarge(env, 'corr-under-1', result);

    expect(shaped.offloaded).toBe(false);
    expect(shaped.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
    expect(shaped.structuredContent).toEqual(result);
    expect(env.PROXY_STATE.put).not.toHaveBeenCalled();
  });

  it('wraps a bare array result as { result } for structuredContent, same as the pre-existing rule', async () => {
    const env = makeEnv();
    const result = [1, 2, 3];

    const shaped = await offloadIfLarge(env, 'corr-under-2', result);

    expect(shaped.offloaded).toBe(false);
    expect(shaped.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
    expect(shaped.structuredContent).toEqual({ result });
    expect(env.PROXY_STATE.put).not.toHaveBeenCalled();
  });

  it('wraps a null result as { result: null }, matching the `?? null` / { result } branches', async () => {
    const env = makeEnv();

    const shaped = await offloadIfLarge(env, 'corr-under-3', null);

    expect(shaped.offloaded).toBe(false);
    expect(shaped.content).toEqual([{ type: 'text', text: 'null' }]);
    expect(shaped.structuredContent).toEqual({ result: null });
    expect(env.PROXY_STATE.put).not.toHaveBeenCalled();
  });
});

describe('offloadIfLarge — over threshold', () => {
  function bigResult() {
    // Comfortably over RESULT_THRESHOLD (80_000 bytes).
    return {
      invoices: Array.from({ length: 3000 }, (_, i) => ({
        id: i,
        summary: 'x'.repeat(30),
      })),
      total: 3000,
    };
  }

  it('offloads to KV and returns a summary + resource_link, with a _truncated structuredContent', async () => {
    const env = makeEnv();
    const result = bigResult();
    const text = JSON.stringify(result);
    expect(text.length).toBeGreaterThan(RESULT_THRESHOLD);

    const shaped = await offloadIfLarge(env, 'corr-over-1', result);

    expect(shaped.offloaded).toBe(true);

    // content[0] is a short text summary, NOT the full payload.
    expect(shaped.content[0].type).toBe('text');
    expect((shaped.content[0] as { text: string }).text.length).toBeLessThan(text.length);

    // content[1] is the resource_link.
    const link = shaped.content[1] as {
      type: string;
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    };
    expect(link.type).toBe('resource_link');
    expect(link.uri).toBe('mcp-st://results/corr-over-1');
    expect(link.name).toBeTruthy();
    expect(link.mimeType).toBe('application/json');

    expect(shaped.structuredContent._truncated).toBe(true);
    expect(shaped.structuredContent._full).toBe('mcp-st://results/corr-over-1');
    expect(shaped.structuredContent._bytes).toBe(text.length);

    // KV.put was called with the correlation-scoped key, the full JSON, and a TTL.
    expect(env.PROXY_STATE.put).toHaveBeenCalledTimes(1);
    const [key, storedValue, opts] = env.PROXY_STATE.put.mock.calls[0];
    expect(key).toBe('result:corr-over-1');
    expect(storedValue).toBe(text);
    expect(opts).toMatchObject({ expirationTtl: RESULT_TTL_S });
  });
});

describe('registerResultResource — round-trip via a connected MCP client', () => {
  async function connectedClient(env: ReturnType<typeof makeEnv>) {
    const server = new McpServer({ name: 'test-results', version: '0.0.0-test' });
    registerResultResource(server, env);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'result-offload-test-client', version: '0.0.0-test' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('reads back the full stored JSON for a present id', async () => {
    const env = makeEnv();
    const stored = JSON.stringify({ invoices: [{ id: 1 }], total: 1 });
    env.PROXY_STATE.get.mockImplementation(async (key: string) =>
      key === 'result:abc123' ? stored : null
    );

    const client = await connectedClient(env);
    const read = await client.readResource({ uri: 'mcp-st://results/abc123' });

    expect(env.PROXY_STATE.get).toHaveBeenCalledWith('result:abc123');
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0].uri).toBe('mcp-st://results/abc123');
    expect(read.contents[0].mimeType).toBe('application/json');
    expect((read.contents[0] as { text: string }).text).toBe(stored);
  });

  it('surfaces a friendly not-found error for a missing/expired id', async () => {
    const env = makeEnv(); // get() always resolves null
    const client = await connectedClient(env);

    await expect(client.readResource({ uri: 'mcp-st://results/does-not-exist' })).rejects.toThrow(
      /expired or not found/i
    );
  });
});

describe('Protocol path — a tool whose result is huge offloads through the real registration wiring', () => {
  it('tools/call carries a resource_link content item, and resources/read on that uri returns the payload', async () => {
    const env = makeEnv();

    const server = new McpServer({ name: 'test-protocol', version: '0.0.0-test' });
    registerResultResource(server, env);

    const bigPayload = {
      items: Array.from({ length: 3000 }, (_, i) => ({ id: i, blob: 'y'.repeat(30) })),
    };

    server.registerTool(
      'huge_tool',
      { title: 'huge tool', description: 'returns an oversized result', inputSchema: {} },
      async () => {
        const shaped = await offloadIfLarge(env, 'corr-protocol-1', bigPayload);
        return { content: shaped.content, structuredContent: shaped.structuredContent };
      }
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'protocol-path-test-client', version: '0.0.0-test' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const called = await client.callTool({ name: 'huge_tool', arguments: {} });
    expect(called.isError).toBeFalsy();
    const content = called.content as Array<Record<string, unknown>>;
    const link = content.find((c) => c.type === 'resource_link') as
      | { uri: string; type: string }
      | undefined;
    expect(link).toBeDefined();
    expect(link!.uri).toBe('mcp-st://results/corr-protocol-1');
    expect((called.structuredContent as any)._truncated).toBe(true);

    const read = await client.readResource({ uri: link!.uri });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual(bigPayload);
  });
});
