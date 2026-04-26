// ============================================================
// mcp-servicetitan — Worker entrypoint
// F2: D1 role lookup via resolveRole (own-DB mcp_roles).
//
// Routing:
//   POST /mcp          → createMcpHandler (MCP protocol)
//   GET  /health       → Hono (liveness + tool inventory)
//   /admin/*           → Hono (operator routes)
//   /webhooks/*        → Hono (H13 adds /webhooks/st for HMAC-verified ingest)
//   *                  → 404
// ============================================================

import { Hono } from 'hono';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import { TOOLS, toolsForRole } from './tools/index';
import { registerTool, type RequestContext } from './tool-registry';
import { resolveRole } from './auth';
import { requireAdminKey } from './routes/admin-guard';
import { auditHealthHandler } from './routes/admin-health-audit';

// Durable Object classes must be exported from the worker entry point.
export { StRateLimiter } from './durable/st-rate-limiter';
export { CustomerSnapshotSingleflight } from './durable/customer-snapshot-flight';

// ─── Hono app for non-MCP routes ──────────────────────────────
const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'mcp-servicetitan',
    version: c.env.MCP_SERVICE_VERSION,
    toolCount: TOOLS.length,
    tools: TOOLS.map((t) => t.name),
    transport: 'agents-sdk createMcpHandler (Streamable HTTP)',
    taylorAi: 'service-binding',
  });
});

// List roles — requires X-Sync-Key matching env secret.
app.get('/admin/roles', async (c) => {
  const denied = requireAdminKey(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare('SELECT key_hash, role, owner, note, created_at FROM mcp_roles ORDER BY created_at DESC').all();
  return c.json({ roles: rows.results });
});

// /admin/metrics — tool call summary from audit_log.
// p50/p95/p99 are in the CF Analytics Engine dashboard (MCP_METRICS dataset).
app.get('/admin/metrics', async (c) => {
  const denied = requireAdminKey(c);
  if (denied) return denied;
  try {
    const [hourly, topTools, errors] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COUNT(*) as calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                AVG(latency_ms) as avg_latency_ms
         FROM audit_log WHERE ts > ?`
      ).bind(Date.now() - 3600_000).first<{ calls: number; errors: number; avg_latency_ms: number }>(),
      c.env.DB.prepare(
        `SELECT operation as tool, COUNT(*) as calls, AVG(latency_ms) as avg_ms
         FROM audit_log WHERE ts > ?
         GROUP BY operation ORDER BY calls DESC LIMIT 10`
      ).bind(Date.now() - 86400_000).all(),
      c.env.DB.prepare(
        `SELECT source, message, COUNT(*) as count
         FROM error_log WHERE ts > ?
         GROUP BY source, message ORDER BY count DESC LIMIT 10`
      ).bind(Date.now() - 3600_000).all(),
    ]);
    return c.json({
      period_1h: hourly,
      top_tools_24h: topTools.results,
      errors_1h: errors.results,
      _note: 'p50/p95/p99 latency percentiles available in CF Analytics Engine dashboard (MCP_METRICS dataset)',
    });
  } catch (e) {
    return c.json({ error: 'metrics query failed', detail: (e as Error).message }, 500);
  }
});

// /admin/health/audit — last-activity probe so future telemetry-silence is detectable in one curl.
app.get('/admin/health/audit', auditHealthHandler);

// /webhooks/st — HMAC-verified ST webhook ingest (H13 stub).
app.post('/webhooks/st', (c) => c.json({ error: 'H13: webhook ingest not yet implemented' }, 501));

app.notFound((c) => c.json({ error: 'not found' }, 404));

// ─── CORS for MCP Inspector + remote MCP clients ──────────────
// Inspector at localhost:5173 requires mcp-session-id in both allowed
// request headers AND exposeHeaders for session resumption.
const CORS_OPTIONS = {
  origin: '*', // F1 dev-friendly; tighten for prod in H13
  methods: 'GET, POST, OPTIONS, DELETE',
  headers: 'content-type, mcp-session-id, authorization, x-sync-key, x-mcp-role, x-actor, x-correlation-id',
  exposeHeaders: 'mcp-session-id',
  maxAge: 86400,
};

// ─── Per-request McpServer build ──────────────────────────────
// Required per CF docs: post-SDK-1.26.0 a shared global McpServer is a
// known security vuln (cross-request state bleed). Build one per request.
function buildServer(env: Env, execCtx: ExecutionContext, reqCtx: RequestContext): McpServer {
  const server = new McpServer({
    name: 'qsc-mcp-servicetitan',
    version: env.MCP_SERVICE_VERSION,
  });
  const visible = toolsForRole(reqCtx.role);
  for (const tool of visible) {
    registerTool(server, tool, env, execCtx, reqCtx);
  }
  return server;
}

// ─── Export ───────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Dispatch non-MCP routes to Hono.
    if (
      url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/admin') ||
      url.pathname.startsWith('/webhooks') ||
      (url.pathname === '/' && request.method === 'GET')
    ) {
      return app.fetch(request, env, execCtx);
    }

    // MCP dispatch: resolve role via D1 mcp_roles (F2), build per-request server.
    const actor = request.headers.get('x-actor') ?? 'claude-code';
    const role = await resolveRole(request, env);
    const reqCtx: RequestContext = { actor, role };

    const server = buildServer(env, execCtx, reqCtx);
    const handler = createMcpHandler(server, {
      route: '/mcp',
      corsOptions: CORS_OPTIONS,
    });
    return handler(request, env, execCtx);
  },
};
