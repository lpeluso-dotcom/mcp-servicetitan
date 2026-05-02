import type { Context } from 'hono';
import type { Env } from '../env';
import { timingSafeEqual } from '../auth';

/**
 * Returns null if the request carries the correct X-Sync-Key, otherwise a
 * 401 Response. Use at the top of every /admin/* handler:
 *
 *   const denied = await requireAdminKey(c);
 *   if (denied) return denied;
 *
 * Centralizing the check prevents drift across /admin routes — see
 * /admin/roles, /admin/metrics, /admin/health/audit, and any future
 * webhook ingest routes. Uses constant-time comparison to match auth.ts.
 */
export async function requireAdminKey(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const provided = c.req.header('x-sync-key') ?? '';
  if (!(await timingSafeEqual(provided, c.env.MCP_SYNC_KEY))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}
