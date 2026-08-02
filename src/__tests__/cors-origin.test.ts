import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare dependencies that only exist in workerd runtime
vi.mock('agents/mcp', () => ({ createMcpHandler: () => () => new Response() }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response() }),
  handleOAuthRoute: async () => new Response(),
}));

const { corsOriginFor } = await import('../index');

function reqWithOrigin(origin?: string): Request {
  return new Request('https://mcp.test/mcp', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
}

describe('corsOriginFor', () => {
  it('reflects claude.ai', () => {
    expect(corsOriginFor(reqWithOrigin('https://claude.ai'))).toBe('https://claude.ai');
  });
  it('reflects MCP Inspector localhost origins', () => {
    expect(corsOriginFor(reqWithOrigin('http://localhost:6274'))).toBe('http://localhost:6274');
    expect(corsOriginFor(reqWithOrigin('http://localhost:5173'))).toBe('http://localhost:5173');
  });
  it('does NOT reflect unknown origins', () => {
    expect(corsOriginFor(reqWithOrigin('https://evil.example'))).toBe('https://claude.ai');
  });
  it('falls back safely when no Origin header is present (non-browser clients)', () => {
    expect(corsOriginFor(reqWithOrigin())).toBe('https://claude.ai');
  });
});
