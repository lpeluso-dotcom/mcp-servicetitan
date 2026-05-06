// ============================================================
// mcp-servicetitan — Worker entrypoint
// F2: D1 role lookup via resolveAuth (own-DB mcp_roles).
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
import { resolveAuth } from './auth';
import { requireAdminKey } from './routes/admin-guard';
import { auditHealthHandler } from './routes/admin-health-audit';
import { endpointsHandler } from './routes/admin-endpoints';
import { handleWebhook } from './webhook-ingest';
import { withTenantRewrite } from './tenant';

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
    stProxy: 'service-binding',
  });
});

// List roles — requires X-Sync-Key matching env secret.
app.get('/admin/roles', async (c) => {
  const denied = await requireAdminKey(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare('SELECT key_hash, role, owner, note, created_at FROM mcp_roles ORDER BY created_at DESC').all();
  return c.json({ roles: rows.results });
});

// /admin/metrics — tool call summary from audit_log + confirmation_tokens.
// p50/p95/p99 are in the CF Analytics Engine dashboard (MCP_METRICS dataset).
app.get('/admin/metrics', async (c) => {
  const denied = await requireAdminKey(c);
  if (denied) return denied;
  const now = Date.now();
  try {
    const [h1, h24, h168, topTools24h, topErrors1h, byActor24h, writeGate24h] = await Promise.all([
      // 1h summary
      c.env.DB.prepare(
        `SELECT COUNT(*) as calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                AVG(latency_ms) as avg_latency_ms
         FROM audit_log WHERE ts > ?`
      ).bind(now - 3_600_000).first<{ calls: number; errors: number; avg_latency_ms: number }>(),
      // 24h summary
      c.env.DB.prepare(
        `SELECT COUNT(*) as calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                AVG(latency_ms) as avg_latency_ms
         FROM audit_log WHERE ts > ?`
      ).bind(now - 86_400_000).first<{ calls: number; errors: number; avg_latency_ms: number }>(),
      // 7d summary
      c.env.DB.prepare(
        `SELECT COUNT(*) as calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                AVG(latency_ms) as avg_latency_ms
         FROM audit_log WHERE ts > ?`
      ).bind(now - 604_800_000).first<{ calls: number; errors: number; avg_latency_ms: number }>(),
      // top 10 tools last 24h
      c.env.DB.prepare(
        `SELECT operation as tool, COUNT(*) as calls, AVG(latency_ms) as avg_ms
         FROM audit_log WHERE ts > ?
         GROUP BY operation ORDER BY calls DESC LIMIT 10`
      ).bind(now - 86_400_000).all(),
      // top 10 errors last 1h
      c.env.DB.prepare(
        `SELECT source, message, COUNT(*) as count
         FROM error_log WHERE ts > ?
         GROUP BY source, message ORDER BY count DESC LIMIT 10`
      ).bind(now - 3_600_000).all(),
      // calls by actor last 24h
      c.env.DB.prepare(
        `SELECT actor, COUNT(*) as calls
         FROM audit_log WHERE ts > ?
         GROUP BY actor ORDER BY calls DESC LIMIT 10`
      ).bind(now - 86_400_000).all(),
      // write-gate activity last 24h: dryRuns, confirmed, expired
      c.env.DB.prepare(
        `SELECT
           COUNT(*) as dry_runs,
           SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) as confirmed,
           SUM(CASE WHEN expires_at < ? AND consumed_at IS NULL THEN 1 ELSE 0 END) as expired
         FROM confirmation_tokens WHERE issued_at > ?`
      ).bind(now, now - 86_400_000).first<{ dry_runs: number; confirmed: number; expired: number }>(),
    ]);

    const safe_rate = (errors: number, calls: number) =>
      calls > 0 ? Math.round((errors / calls) * 10000) / 100 : 0;

    return c.json({
      period_1h: { ...h1, error_rate_pct: safe_rate(h1?.errors ?? 0, h1?.calls ?? 0) },
      period_24h: { ...h24, error_rate_pct: safe_rate(h24?.errors ?? 0, h24?.calls ?? 0) },
      period_7d: { ...h168, error_rate_pct: safe_rate(h168?.errors ?? 0, h168?.calls ?? 0) },
      top_tools_24h: topTools24h.results,
      errors_1h: topErrors1h.results,
      by_actor_24h: byActor24h.results,
      write_gate_24h: writeGate24h,
      _note: 'p50/p95/p99 latency percentiles available in CF Analytics Engine (MCP_METRICS dataset)',
    });
  } catch (e) {
    return c.json({ error: 'metrics query failed', detail: (e as Error).message }, 500);
  }
});

// /admin/health/audit — last-activity probe so future telemetry-silence is detectable in one curl.
app.get('/admin/health/audit', auditHealthHandler);

// /admin/endpoints — ST endpoint inventory: per-tool stEndpoint descriptors + undeclared list.
app.get('/admin/endpoints', endpointsHandler);

// /webhooks/st — HMAC-verified ST webhook ingest.
app.post('/webhooks/st', (c) => handleWebhook(c.env, c.req.raw));

app.notFound((c) => c.json({ error: 'not found' }, 404));

// ─── CORS for MCP Inspector + remote MCP clients ──────────────
// Inspector at localhost:5173 requires mcp-session-id in both allowed
// request headers AND exposeHeaders for session resumption.
const CORS_METHODS = 'GET, POST, OPTIONS, DELETE';
const CORS_HEADERS = 'content-type, mcp-session-id, authorization, x-sync-key, x-mcp-role, x-actor, x-correlation-id';
const CORS_EXPOSE = 'mcp-session-id';
const CORS_MAX_AGE = 86400;

function isDevEnv(env: Env): boolean {
  return typeof env.MCP_SERVICE_VERSION === 'string' && env.MCP_SERVICE_VERSION.endsWith('-dev');
}

// Origin allowlist — deny by default. Closes the DNS-rebinding gap noted in
// the MCP Streamable HTTP spec. Auth (X-Sync-Key / JWT) gates traffic regardless,
// but a browser context that already holds the bearer should still be limited
// to known caller surfaces.
function isAllowedOrigin(origin: string, env: Env): boolean {
  if (origin === 'https://claude.ai' || origin.endsWith('.claude.ai')) return true;
  if (origin.endsWith('.lpeluso.workers.dev')) return true;
  if (isDevEnv(env) && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

// Resolve the request's Origin against the allowlist. Returns the matched
// origin string for echoing in CORS headers, or null when the request has no
// Origin (server-to-server), or the sentinel 'null' when the origin is denied
// (no real browser origin will match this and the CORS check will fail).
function resolveCorsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  return isAllowedOrigin(origin, env) ? origin : 'null';
}

function buildCorsOptions(request: Request, env: Env) {
  const resolved = resolveCorsOrigin(request, env);
  return {
    // SDK accepts a single string. For server-to-server (no Origin), we still
    // pass a sentinel so the SDK's default fallback of '*' isn't reached.
    origin: resolved ?? 'null',
    methods: CORS_METHODS,
    headers: CORS_HEADERS,
    exposeHeaders: CORS_EXPOSE,
    maxAge: CORS_MAX_AGE,
  };
}

function unauthorizedMcpResponse(request: Request, env: Env): Response {
  const allowOrigin = resolveCorsOrigin(request, env);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers': CORS_HEADERS,
    'access-control-expose-headers': CORS_EXPOSE,
  };
  if (allowOrigin) headers['access-control-allow-origin'] = allowOrigin;
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      message: 'POST /mcp requires Authorization: Bearer <JWT> or X-Sync-Key.',
    }),
    { status: 401, headers }
  );
}

// ─── Per-request McpServer build ──────────────────────────────
// Required per CF docs: post-SDK-1.26.0 a shared global McpServer is a
// known security vuln (cross-request state bleed). Build one per request.
function buildServer(env: Env, execCtx: ExecutionContext, reqCtx: RequestContext): McpServer {
  const server = new McpServer({
    name: 'mcp-servicetitan',
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

    if (!url.pathname.startsWith('/mcp')) {
      return app.fetch(request, env, execCtx);
    }

    // MCP dispatch: require a valid client credential, resolve role, and build
    // a fresh per-request server. OPTIONS must pass through for CORS preflight.
    const auth = request.method === 'OPTIONS'
      ? { authenticated: true, role: 'default' as const, actor: 'preflight' }
      : await resolveAuth(request, env);
    if (!auth.authenticated) {
      return unauthorizedMcpResponse(request, env);
    }
    const reqCtx: RequestContext = { actor: auth.actor, role: auth.role };
    const runtimeEnv = withTenantRewrite(env);

    const server = buildServer(runtimeEnv, execCtx, reqCtx);
    const handler = createMcpHandler(server, {
      route: '/mcp',
      corsOptions: buildCorsOptions(request, runtimeEnv),
    });
    return handler(request, runtimeEnv, execCtx);
  },
};
