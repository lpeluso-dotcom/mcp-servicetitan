// ============================================================
// registry-native.test.ts — Phase 2 Task 2.1
//
// Exercises the registerTool() bridge against a stub McpServer that
// captures the registerTool(name, config, handler) call shape (SDK's
// config-object form), asserting:
//   - spec-correct annotations (readOnlyHint / destructiveHint /
//     idempotentHint / openWorldHint) per tool.isWrite + stEndpoint.method
//   - title present (tool.title fallback to name.replace(/_/g, ' '))
//   - handler return carries BOTH content[0].text (JSON string, unchanged
//     back-compat shape) AND structuredContent (object, spec-required)
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { registerTool } from '../tool-registry';
import type { ToolDef } from '../tools/index';

interface CapturedRegistration {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: {
      title: string;
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  };
  handler: (args: Record<string, unknown>) => Promise<any>;
}

function makeStubServer() {
  const registrations: CapturedRegistration[] = [];
  const server = {
    registerTool: (name: string, config: CapturedRegistration['config'], handler: CapturedRegistration['handler']) => {
      registrations.push({ name, config, handler });
    },
  };
  return { server: server as any, registrations };
}

function makeDB(firstResult: unknown = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(): any {
  return {
    DB: makeDB(),
    MCP_METRICS: { writeDataPoint: vi.fn() },
  };
}

const execCtx = { waitUntil: () => undefined } as any;
const reqCtx = { actor: 'test-registry-native', role: 'default' } as const;

// ── Fixtures ─────────────────────────────────────────────────

const readTool: ToolDef<Record<string, unknown>> = {
  name: 'fixture_read_tool',
  description: 'A read-only fixture tool',
  zodSchema: {},
  async handler() {
    return { ok: true, value: 1 };
  },
};

const additiveWriteTool: ToolDef<Record<string, unknown>> = {
  name: 'fixture_additive_write_tool',
  description: 'An additive (POST) write fixture tool',
  zodSchema: {},
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/fixture', source: 'live' },
  async handler() {
    return { created: true, id: 42 };
  },
};

const destructiveWriteTool: ToolDef<Record<string, unknown>> = {
  name: 'fixture_destructive_write_tool',
  description: 'A destructive (PATCH) write fixture tool',
  zodSchema: {},
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/fixture/{id}', source: 'live' },
  async handler() {
    return { updated: true };
  },
};

// A non-object result (array) — exercises the structuredContent wrap rule:
// "if result is not a non-null object, wrap it as { result } for
// structuredContent ONLY (leave the text block as raw JSON.stringify unchanged)".
const primitiveResultTool: ToolDef<Record<string, unknown>> = {
  name: 'fixture_primitive_result_tool',
  description: 'A read tool that returns a bare array',
  zodSchema: {},
  async handler() {
    return [1, 2, 3];
  },
};

describe('registerTool — native SDK config-object registration', () => {
  it('registers via server.registerTool(name, config, handler), not the legacy server.tool()', () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, readTool, makeEnv(), execCtx, reqCtx);
    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe('fixture_read_tool');
    expect(registrations[0].config.description).toBe('A read-only fixture tool');
    expect(registrations[0].config.inputSchema).toBe(readTool.zodSchema);
  });

  it('read tool: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false', () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, readTool, makeEnv(), execCtx, reqCtx);
    const { annotations } = registrations[0].config;
    expect(annotations).toBeDefined();
    expect(annotations!.readOnlyHint).toBe(true);
    expect(annotations!.destructiveHint).toBe(false);
    expect(annotations!.idempotentHint).toBe(true);
    expect(annotations!.openWorldHint).toBe(false);
    expect(annotations!.title).toBe('fixture read tool');
  });

  it('additive write (POST): readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=false', () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, additiveWriteTool, makeEnv(), execCtx, reqCtx);
    const { annotations } = registrations[0].config;
    expect(annotations!.readOnlyHint).toBe(false);
    // Additive creates are NOT destructive — MCP spec defaults destructiveHint
    // to true when omitted, so this must be set explicitly to false.
    expect(annotations!.destructiveHint).toBe(false);
    expect(annotations!.idempotentHint).toBe(false);
    expect(annotations!.openWorldHint).toBe(false);
  });

  it('destructive write (PATCH): readOnlyHint=false, destructiveHint=true, openWorldHint=false', () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, destructiveWriteTool, makeEnv(), execCtx, reqCtx);
    const { annotations } = registrations[0].config;
    expect(annotations!.readOnlyHint).toBe(false);
    // PATCH modifies existing data — destructive.
    expect(annotations!.destructiveHint).toBe(true);
    expect(annotations!.openWorldHint).toBe(false);
  });

  it('title falls back to name.replace(/_/g, " ") when tool.title is absent', () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, additiveWriteTool, makeEnv(), execCtx, reqCtx);
    expect(registrations[0].config.title).toBe('fixture additive write tool');
    expect(registrations[0].config.annotations!.title).toBe('fixture additive write tool');
  });

  it('uses tool.title verbatim when provided', () => {
    const titled: ToolDef<Record<string, unknown>> = { ...readTool, title: 'Custom Display Title' };
    const { server, registrations } = makeStubServer();
    registerTool(server, titled, makeEnv(), execCtx, reqCtx);
    expect(registrations[0].config.title).toBe('Custom Display Title');
    expect(registrations[0].config.annotations!.title).toBe('Custom Display Title');
  });

  it('openWorldHint is always false (closed-world ST tenant), across read/additive/destructive', () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, readTool, makeEnv(), execCtx, reqCtx);
    registerTool(server, additiveWriteTool, makeEnv(), execCtx, reqCtx);
    registerTool(server, destructiveWriteTool, makeEnv(), execCtx, reqCtx);
    for (const reg of registrations) {
      expect(reg.config.annotations!.openWorldHint).toBe(false);
    }
  });

  it('invoking the captured handler returns BOTH content[0].text and structuredContent on success', async () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, readTool, makeEnv(), execCtx, reqCtx);
    const result = await registrations[0].handler({});

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, value: 1 });

    expect(result.structuredContent).toEqual({ ok: true, value: 1 });
  });

  it('wraps non-object (array) results as { result } for structuredContent only — text stays raw JSON', async () => {
    const { server, registrations } = makeStubServer();
    registerTool(server, primitiveResultTool, makeEnv(), execCtx, reqCtx);
    const result = await registrations[0].handler({});

    // Back-compat: text block is the raw JSON.stringify(result), unwrapped.
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);

    // structuredContent must be an object per spec, so arrays get wrapped.
    expect(result.structuredContent).toEqual({ result: [1, 2, 3] });
  });

  it('error path is unchanged: isError=true, no structuredContent required', async () => {
    const throwingTool: ToolDef<Record<string, unknown>> = {
      name: 'fixture_throwing_tool',
      description: 'always throws',
      zodSchema: {},
      async handler() {
        throw new Error('boom');
      },
    };
    const { server, registrations } = makeStubServer();
    registerTool(server, throwingTool, makeEnv(), execCtx, reqCtx);
    const result = await registrations[0].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
  });
});
