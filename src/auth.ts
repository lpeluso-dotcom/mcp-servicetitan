// ============================================================
// auth.ts — Outbound auth to taylor-ai's /api/st/read
// Uses the shared MCP_SYNC_KEY from wrangler secrets.
// ============================================================

import type { Env } from './env';

export function authHeaders(env: Env, correlation: string, actor: string): Record<string, string> {
  return {
    'X-Sync-Key': env.MCP_SYNC_KEY,
    'X-Correlation-Id': correlation,
    'X-Actor': actor,
    'User-Agent': `mcp-servicetitan/${env.MCP_SERVICE_VERSION}`,
  };
}

/**
 * Generate a ULID-like correlation ID. Not strictly ULID-spec — just a
 * time-prefixed random string suitable for tracing across services.
 */
export function newCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}-${rand}`;
}
