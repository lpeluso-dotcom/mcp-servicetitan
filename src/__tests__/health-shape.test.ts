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

  // MCP_SERVICE_VERSION is a hand-edited literal that read "1.7.0" across ~10
  // prod deploys while the last git tag was v1.5.1, so it cannot identify
  // deployed code. `commit` is stamped by deploy.yml and cannot drift.
  it('reports the deployed commit sha', () => {
    expect(healthPayload({ ...env, GIT_SHA: 'abc1234' }).commit).toBe('abc1234');
  });

  it('falls back to "unknown" when GIT_SHA is not injected', () => {
    expect(healthPayload(env).commit).toBe('unknown');
  });
});
