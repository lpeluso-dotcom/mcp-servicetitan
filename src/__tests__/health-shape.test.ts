import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare dependencies that only exist in workerd runtime
vi.mock('agents/mcp', () => ({ createMcpHandler: () => () => new Response() }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response() }),
  handleOAuthRoute: async () => new Response(),
}));

const { healthPayload } = await import('../index');
const { TOOLS } = await import('../tools/index');

describe('/health payload', () => {
  const env: any = { MCP_SERVICE_VERSION: '1.7.0-test', MCP_LOCKDOWN: undefined };

  it('keeps toolCount for the mcp-dashboard probe', () => {
    expect(healthPayload(env).toolCount).toBe(TOOLS.length);
  });

  it('does NOT enumerate tool names unauthenticated (QUA-519)', () => {
    expect(Object.keys(healthPayload(env))).not.toContain('tools');
  });

  it('reports lockdown state', () => {
    expect(healthPayload({ ...env, MCP_LOCKDOWN: 'true' }).lockdown).toBe(true);
  });
});
