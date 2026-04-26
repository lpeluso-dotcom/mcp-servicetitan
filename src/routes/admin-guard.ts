import type { Context } from 'hono';
import type { Env } from '../env';

/**
 * Returns null if the request carries the correct X-Sync-Key, otherwise a
 * 401 Response. Use at the top of every /admin/* handler:
 *
 *   const denied = requireAdminKey(c);
 *   if (denied) return denied;
 *
 * Centralizing the check prevents drift across /admin routes — see
 * /admin/roles, /admin/metrics, /admin/health/audit, and any future
 * webhook ingest routes.
 */
export function requireAdminKey(c: Context<{ Bindings: Env }>): Response | null {
  if (c.req.header('x-sync-key') !== c.env.MCP_SYNC_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}
