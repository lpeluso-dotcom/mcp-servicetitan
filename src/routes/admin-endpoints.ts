// ============================================================
// admin-endpoints.ts — /admin/endpoints inventory route.
//
// Iterates the TOOLS registry and reports each tool's ST endpoint
// descriptor (or null if undeclared). Used to:
//   - audit ST API coverage vs. the dev-portal catalog
//   - find tools that haven't been backfilled with stEndpoint
//   - feed dashboards/preflight checks for v1.x expansion
//
// Auth: X-Sync-Key (same as other /admin/* routes).
// ============================================================
import type { Context } from 'hono';
import type { Env } from '../env';
import { TOOLS } from '../tools/index';
import { requireAdminKey } from './admin-guard';

export async function endpointsHandler(c: Context<{ Bindings: Env }>) {
  const denied = await requireAdminKey(c);
  if (denied) return denied;
  const rows = TOOLS.map((t) => ({
    toolName: t.name,
    isWrite: !!t.isWrite,
    adminOnly: !!t.adminOnly,
    stMethod: t.stEndpoint?.method ?? null,
    stPath: t.stEndpoint?.path ?? null,
    source: t.stEndpoint?.source ?? null,
    declared: !!t.stEndpoint,
  }));
  const undeclared = rows.filter((r) => !r.declared).map((r) => r.toolName);
  return c.json({
    count: rows.length,
    declared_count: rows.length - undeclared.length,
    undeclared_count: undeclared.length,
    undeclared,
    rows,
  });
}
