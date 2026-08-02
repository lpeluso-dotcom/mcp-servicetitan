// ============================================================
// admin-endpoints.ts — /admin/endpoints inventory route + coverage gate.
//
// Iterates the TOOLS registry and reports each tool's ST endpoint
// descriptor (or null if undeclared). Used to:
//   - audit ST API coverage vs. the dev-portal catalog
//   - find tools that haven't been backfilled with stEndpoint
//   - feed dashboards/preflight checks for v1.x expansion
//
// /admin/endpoints          — full inventory (declared + undeclared).
// /admin/endpoints/coverage — pass/fail gate. Returns 200 when every
//                             non-exempt tool declares stEndpoint, 422
//                             otherwise. Used by preflight to keep new
//                             tools honest.
//
// Auth: X-Sync-Key (same as other /admin/* routes).
// ============================================================
import type { Context } from 'hono';
import type { Env } from '../env';
import { TOOLS } from '../tools/index';
import { requireAdminKey } from './admin-guard';

/**
 * Tools that are not expected to declare a single `stEndpoint` because they
 * are either generic escape hatches (`st_call`) or aggregate over so many
 * endpoints that a single descriptor would be misleading. Composites that
 * have a primary ST endpoint SHOULD declare it (with `source: 'live'` or
 * `'mixed'`) and are NOT exempt.
 */
const COVERAGE_EXEMPT = new Set<string>([
  // Generic ST escape hatch (admin-only). Maps to any ST endpoint by definition.
  'st_call',
  // Siro tools — external Siro API, not ServiceTitan. No ST endpoint to map.
  'siro_list_mobile_events',
  'siro_get_recording_summary',
  'siro_get_engagement',
  // Dawn SMS tools — D1-only, no ServiceTitan endpoint (v1.6.0).
  'identify_tech_by_phone',
  'save_tech_debrief',
  // Vectorize semantic search — proxies to taylor-ai worker, not a ServiceTitan endpoint.
  'search_pricebook_semantic',
  // Supabase-backed pricebook tools — hit Supabase, not ServiceTitan.
  'search_pricebook_templates',
  'get_proposal_tiers',
  'find_packages_with_item',
  'get_service_breakout',
  // Supabase-backed Woz gold vector search (TAI-STV2) — hits Supabase, not ServiceTitan.
  'semantic_search_gold',
]);

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
    exempt: COVERAGE_EXEMPT.has(t.name),
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

export async function endpointsCoverageHandler(c: Context<{ Bindings: Env }>) {
  const denied = await requireAdminKey(c);
  if (denied) return denied;
  const total = TOOLS.length;
  const declared = TOOLS.filter((t) => !!t.stEndpoint).length;
  const gaps = TOOLS.filter((t) => !t.stEndpoint && !COVERAGE_EXEMPT.has(t.name)).map((t) => t.name);
  const exempt = TOOLS.filter((t) => COVERAGE_EXEMPT.has(t.name)).map((t) => t.name);
  const ok = gaps.length === 0;
  const body = {
    ok,
    total,
    declared,
    declaredPct: total > 0 ? Math.round((declared / total) * 1000) / 10 : 0,
    exempt,
    gaps,
  };
  return c.json(body, ok ? 200 : 422);
}
