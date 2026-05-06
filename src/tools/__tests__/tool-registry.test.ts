import { describe, it, expect, vi } from 'vitest';
import { registerTool } from '../../tool-registry';
import type { ToolDef } from '../index';

describe('registerTool — transformResult', () => {
  it('applies transformResult before serialize', async () => {
    const tool: ToolDef<{ q: string }> = {
      name: 'fixture_tool',
      description: 'fixture',
      zodSchema: {},
      async handler() {
        return { paginationToken: 'noise', id: 1, name: 'x' };
      },
      transformResult: (r: any) => {
        const { paginationToken, ...rest } = r;
        return rest;
      },
    };

    const captured: any[] = [];
    const server = {
      tool: (_n: string, _d: string, _s: any, fn: any) => {
        captured.push(fn);
      },
    } as any;
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const env = {
      DB: { prepare: vi.fn().mockReturnValue(stmt) },
      MCP_METRICS: { writeDataPoint: vi.fn() },
    } as any;
    const execCtx = { waitUntil: () => undefined } as any;
    const reqCtx = { actor: 'test', role: 'default' } as const;

    registerTool(server, tool as any, env, execCtx, reqCtx);
    const wrapped = captured[0];
    const out = await wrapped({ q: 'hi' });
    const text = out.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.paginationToken).toBeUndefined();
    expect(parsed.id).toBe(1);
  });
});
