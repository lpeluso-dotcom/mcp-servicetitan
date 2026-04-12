// ============================================================
// siro.ts — Siro API helper (Bearer token auth)
// ServiceTitan acquired Siro; we expose Siro read tools
// under mcp-servicetitan alongside the ST tools.
//
// Two Siro APIs exist:
//  - https://functions.siro.ai/api-externalApi — org-level read API (Bearer auth)
//  - https://api.siro.ai — entity extractions (OAuth, different flow)
//
// This helper handles the Bearer-auth external API. For entity
// extractions we'd need a separate OAuth flow using SIRO_OAUTH_*
// credentials — deferred to phase 2.
// ============================================================

import type { Env } from './env';
import { McpError, mapUpstreamStatus } from './errors';

const SIRO_BASE = 'https://functions.siro.ai/api-externalApi';

/**
 * Fetch a Siro external API path (e.g. "/v1/core/mobile-events?pageSize=50").
 * Returns parsed JSON.
 */
export async function siroFetch(env: Env, path: string, correlation: string): Promise<unknown> {
  if (!env.SIRO_API_TOKEN) {
    throw new McpError('auth_failed', 'SIRO_API_TOKEN not configured on this worker', { correlation });
  }
  const url = `${SIRO_BASE}${path}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.SIRO_API_TOKEN}`,
      Accept: 'application/json',
      'X-Correlation-Id': correlation,
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `Siro ${resp.status} ${path}: ${body.slice(0, 200)}`,
      { correlation }
    );
  }

  return resp.json();
}
