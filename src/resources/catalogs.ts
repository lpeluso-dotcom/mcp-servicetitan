// ============================================================
// resources/catalogs.ts — Phase 2 Task 2.5
//
// 3 read-only, fixed-URI (not templated) MCP resources so clients can
// browse ST reference data without spending a tool call:
//
//   - mcp-st://catalog/pricebook-categories — pb_categories D1 mirror
//     (the pricebook category tree: services + materials + equipment).
//   - mcp-st://catalog/technicians          — technicians D1 mirror,
//     PII-stripped (id/name/business_unit/role/active ONLY — no phone,
//     email, or address, even if the underlying row carries one).
//   - mcp-st://catalog/reports              — ST native report-category +
//     report catalog. Discovered live via the SAME two endpoints
//     st_run_report's list_categories/list_reports modes hit (readST
//     against /reporting/v2/.../report-categories and
//     /reporting/v2/.../report-category/{id}/reports), then cached in KV
//     (PROXY_STATE, key `catalog:reports`, 1h TTL) so a resource read
//     doesn't hammer ST on every client poll.
//
// Real D1 column names (taylor-ai, READ-ONLY — never edited from this
// worker):
//   - pb_categories: taylor-ai migrations/0063_pb_categories.sql —
//     id, name, active, parent_id, category_type, position,
//     business_unit_ids_json, description, source, external_id,
//     hide_in_mobile, created_on, modified_on, synced_at.
//   - technicians: no CREATE TABLE ships under taylor-ai/migrations (this
//     table predates the migrations/ convention there). Columns confirmed
//     from taylor-ai's src/gate-st.js COLUMN_MAP (the single source of
//     truth for table shapes per qsc-infra .claude/rules/cloudflare.md) —
//     technicians: ['tech_id','name','business_unit','team','role','phone',
//     'email','active','synced_at'] (synced_at is the mirror sync timestamp
//     that feeds the MB-1 / QUA-1141 freshness stamps and the fetchTableMax
//     MAX(synced_at) probe) — and cross-checked against this worker's own
//     src/tools/dawn/identify_tech_by_phone.ts, which reads the same table
//     with the same tech_id/name/business_unit/role column names.
//
// The technicians mapper below is an EXPLICIT allow-list (tech_id, name,
// business_unit, role, active only), not a trust-the-SQL-projection
// approach — so even if a future readD1 call (or a stray extra column on
// the row) carries phone/email, the resource can never echo it.
// ============================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readD1 } from '../d1';
import { readST } from '../st';
import { newCorrelationId } from '../auth';
import type { Env } from '../env';

const REPORTS_CACHE_KEY = 'catalog:reports';
const REPORTS_CACHE_TTL_S = 3600;
const REPORTING_TENANT_PLACEHOLDER = '000000000';
const RESOURCE_ACTOR = 'mcp-resource:catalogs';

interface ReportSummary {
  id: unknown;
  name: unknown;
}

interface ReportCategoryCatalogEntry {
  id: unknown;
  name: unknown;
  reports: ReportSummary[];
  _error?: string;
}

interface ReportCatalog {
  categories: ReportCategoryCatalogEntry[];
  count: number;
  _cached_at?: string;
  _error?: string;
}

function jsonResourceContents(uri: string, body: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(body),
      },
    ],
  };
}

/**
 * Explicit allow-list mapper for the technicians D1 row — NEVER spreads the
 * raw row. Only these 5 fields are ever returned, regardless of what the
 * SELECT (or a future column addition) puts on the row.
 */
function mapTechnician(row: Record<string, unknown>) {
  return {
    tech_id: row.tech_id ?? null,
    name: row.name ?? null,
    business_unit: row.business_unit ?? null,
    role: row.role ?? null,
    active: row.active ?? null,
  };
}

function mapPbCategory(row: Record<string, unknown>) {
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    parent_id: row.parent_id ?? null,
    active: row.active ?? null,
    category_type: row.category_type ?? null,
  };
}

/**
 * Live discovery of the full report catalog: category list, then one
 * fan-out readST per category for its reports. Mirrors st_run_report's
 * list_categories / list_reports modes exactly (same endpoints, same
 * readST helper) so this resource never drifts from what the tool itself
 * would return.
 *
 * Resilience: a per-category reports fetch failure is caught and recorded
 * on that one entry (_error) without failing the whole catalog. A failure
 * on the top-level category list itself (the thing every other call
 * depends on) is caught here too — the caller never sees a throw, only an
 * empty catalog + _error.
 */
async function discoverReportCatalog(env: Env): Promise<ReportCatalog> {
  const ctx = { actor: RESOURCE_ACTOR, correlation: newCorrelationId() };
  try {
    const catData = await readST<{ data?: Array<Record<string, unknown>> }>(
      env,
      ctx,
      `/reporting/v2/tenant/${REPORTING_TENANT_PLACEHOLDER}/report-categories`,
    );
    const categories = catData.data ?? [];

    const withReports = await Promise.all(
      categories.map(async (cat): Promise<ReportCategoryCatalogEntry> => {
        const catId = cat.id;
        const catName = cat.name;
        try {
          const repData = await readST<{ data?: Array<Record<string, unknown>> }>(
            env,
            ctx,
            `/reporting/v2/tenant/${REPORTING_TENANT_PLACEHOLDER}/report-category/${catId}/reports`,
          );
          const reports = (repData.data ?? []).map((r) => ({ id: r.id, name: r.name }));
          return { id: catId, name: catName, reports };
        } catch (e) {
          return { id: catId, name: catName, reports: [], _error: String((e as Error)?.message ?? e) };
        }
      }),
    );

    return {
      categories: withReports,
      count: withReports.length,
      _cached_at: new Date().toISOString(),
    };
  } catch (e) {
    // Top-level discovery failure (e.g. the category list call itself
    // errored) — never throw out of a resource read; hand back an empty,
    // clearly-marked catalog instead.
    return {
      categories: [],
      count: 0,
      _error: `report catalog discovery failed: ${String((e as Error)?.message ?? e)}`,
    };
  }
}

/** Cache-first read of the report catalog. Only a clean (no top-level
 * _error) discovery is cached, so a transient ST outage doesn't lock in an
 * empty catalog for the full TTL. */
async function getReportCatalog(env: Env): Promise<ReportCatalog> {
  let cached: string | null = null;
  try {
    cached = await env.PROXY_STATE.get(REPORTS_CACHE_KEY);
  } catch {
    // KV blip on read — fall through to a fresh live discovery.
    cached = null;
  }
  if (cached) {
    try {
      return JSON.parse(cached) as ReportCatalog;
    } catch {
      // Corrupt cache entry — fall through to a fresh discovery.
    }
  }

  const catalog = await discoverReportCatalog(env);
  if (!catalog._error) {
    try {
      await env.PROXY_STATE.put(REPORTS_CACHE_KEY, JSON.stringify(catalog), {
        expirationTtl: REPORTS_CACHE_TTL_S,
      });
    } catch {
      // A KV put blip must not fail the read — the freshly discovered
      // catalog is still returned, just uncached for next time.
    }
  }
  return catalog;
}

export function registerCatalogResources(server: McpServer, env: Env): void {
  server.registerResource(
    'pricebook-categories',
    'mcp-st://catalog/pricebook-categories',
    {
      title: 'Pricebook category tree',
      description:
        'ST pricebook category tree (services/materials/equipment categories), mirrored from taylor-ai D1 pb_categories. Read-only browsable reference — no tool call needed.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const { rows } = await readD1<Record<string, unknown>>(
        env,
        'SELECT id, name, parent_id, active, category_type FROM pb_categories ORDER BY name',
      );
      const categories = rows.map(mapPbCategory);
      return jsonResourceContents(uri.href, { categories, count: categories.length });
    },
  );

  server.registerResource(
    'technicians',
    'mcp-st://catalog/technicians',
    {
      title: 'Technician roster (PII-stripped)',
      description:
        'QSC technician roster — tech_id, name, role, business_unit, active ONLY. Phone, email, and address are never included, even if the backing row carries them.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const { rows } = await readD1<Record<string, unknown>>(
        env,
        'SELECT tech_id, name, business_unit, role, active FROM technicians ORDER BY name',
      );
      const technicians = rows.map(mapTechnician);
      return jsonResourceContents(uri.href, { technicians, count: technicians.length });
    },
  );

  server.registerResource(
    'reports',
    'mcp-st://catalog/reports',
    {
      title: 'ServiceTitan report catalog',
      description:
        'ST native report categories with per-category report ids/names, cached hourly (KV, 1h TTL). Use with st_run_report (describe_report, then run) to execute a report found here.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const catalog = await getReportCatalog(env);
      return jsonResourceContents(uri.href, catalog);
    },
  );
}
