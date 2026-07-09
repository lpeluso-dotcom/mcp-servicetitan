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
import { registerPrompts } from './prompts/index';
import { registerResultResource } from './resources/results';
import { resolveAuth, verifyConnectorToken } from './auth';
import { requireAdminKey } from './routes/admin-guard';
import { auditHealthHandler } from './routes/admin-health-audit';
import { unackedErrorsHandler } from './routes/admin-errors';
import { endpointsHandler, endpointsCoverageHandler } from './routes/admin-endpoints';
import { handleWebhook } from './webhook-ingest';
import { createOAuthProvider, handleOAuthRoute } from './oauth';

// Durable Object classes must be exported from the worker entry point.
export { StRateLimiter } from './durable/st-rate-limiter';
export { CustomerSnapshotSingleflight } from './durable/customer-snapshot-flight';

// ─── Hono app for non-MCP routes ──────────────────────────────
const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  const lockdown = c.env.MCP_LOCKDOWN === 'true';
  return c.json({
    ok: true,
    service: 'mcp-servicetitan',
    version: c.env.MCP_SERVICE_VERSION,
    toolCount: TOOLS.length,
    tools: TOOLS.map((t) => t.name),
    transport: 'agents-sdk createMcpHandler (Streamable HTTP)',
    stProxy: 'service-binding',
    lockdown,
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
// /admin/errors/unacked — error_log rows in a recent window + `alert` flag, so a monitor
// can fire when prod tools start failing (the gap that hid the tenant-404s).
app.get('/admin/errors/unacked', unackedErrorsHandler);

// /admin/endpoints — ST endpoint inventory: per-tool stEndpoint descriptors + undeclared list.
app.get('/admin/endpoints', endpointsHandler);

// /admin/endpoints/coverage — pass/fail gate. 200 when every non-exempt tool
// declares stEndpoint; 422 when any non-exempt tool is missing one. Wired
// into scripts/preflight.sh so a new tool can't ship without a descriptor.
app.get('/admin/endpoints/coverage', endpointsCoverageHandler);

// /webhooks/st — HMAC-verified ST webhook ingest.
app.post('/webhooks/st', (c) => handleWebhook(c.env, c.req.raw));

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

function unauthorizedMcpResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      message: 'POST /mcp requires Authorization: Bearer <JWT> or X-Sync-Key.',
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': CORS_OPTIONS.origin,
        'access-control-allow-methods': CORS_OPTIONS.methods,
        'access-control-allow-headers': CORS_OPTIONS.headers,
        'access-control-expose-headers': CORS_OPTIONS.exposeHeaders,
      },
    }
  );
}

// The finance/ops "skill" delivered inline to a read-only Desktop connector (Jessica Hunt).
// Claude Desktop can't load Claude Code skills, so this context ships in the MCP `instructions`.
const READONLY_INSTRUCTIONS = [
  'You are a READ-ONLY ServiceTitan reporting assistant for Quality Service Company (QSC), an',
  'HVAC / electrical / plumbing contractor (ServiceTitan tenant 431848990). Only read/lookup',
  'tools are available — there is NO way to create, change, book, or delete anything in',
  'ServiceTitan from this connector. If asked to make a change, explain that this is read-only.',
  '',
  'WHAT YOU CAN PULL (live ServiceTitan):',
  '- Customers & jobs: find_customer, get_customer, get_customer_locations, list_customer_jobs,',
  '  get_job, list_jobs_today, get_job_appointments, customer_snapshot.',
  '- Money/AR: get_invoice, list_invoices_job, get_invoice_balance, list_unpaid_invoices.',
  '- Estimates: list_estimates_job, get_estimate, assigned_vs_sold_estimate_audit.',
  '- Dispatch & capacity: get_capacity, list_technicians_available, get_technician_shifts,',
  '  dispatch_pro_utilization_list, tech_drive_time_summary.',
  '- Memberships: list_memberships_active, list_memberships_expiring.',
  '- Job costing & margin: job_cost_actuals, margin_audit, job_closeout_report.',
  '- Payroll/timesheets: payroll_* tools. Opportunities: opportunities_list, opportunity_get.',
  '- Reporting passthrough: st_run_report. Pricebook lookups: search_pricebook_*.',
  '',
  'IMPORTANT NOTES:',
  '- Dynamic pricing: a pricebook item with a 0/blank price is NOT free — QSC prices',
  '  dynamically at invoice time. Never report a pricebook item as "unpriced".',
  '- For company-wide financials (revenue by division, P&L, A/R aging from QuickBooks), prefer',
  "  the separate QSC Finance & Ops (Woz) connector — it's the conformed warehouse + QBO.",
  '- Prefer the composite tools (customer_snapshot, job_closeout_report, margin_audit) over many',
  '  small calls when answering a broad question.',
].join('\n');

// ─── Per-request McpServer build ──────────────────────────────
// Required per CF docs: post-SDK-1.26.0 a shared global McpServer is a
// known security vuln (cross-request state bleed). Build one per request.
// Exported (in addition to being used internally below) so the protocol-level
// integration test can drive a real McpServer through an in-memory MCP client
// without duplicating the registration wiring. See src/__tests__/mcp-protocol.test.ts.
export function buildServer(env: Env, execCtx: ExecutionContext, reqCtx: RequestContext): McpServer {
  // The read-only connector (Jessica) gets a branded name + inline instructions; every other
  // caller keeps the historical surface unchanged.
  const readonly = reqCtx.role === 'readonly';
  const server = new McpServer(
    {
      name: readonly ? 'QSC ServiceTitan (read-only)' : 'mcp-servicetitan',
      version: env.MCP_SERVICE_VERSION,
    },
    readonly ? { instructions: READONLY_INSTRUCTIONS } : undefined,
  );
  const visible = toolsForRole(reqCtx.role);
  for (const tool of visible) {
    registerTool(server, tool, env, execCtx, reqCtx);
  }
  registerPrompts(server);
  registerResultResource(server, env);
  return server;
}

// Plain 401 for the connector route — deliberately NO www-authenticate header (a challenge
// would make Claude attempt an OAuth flow). CORS headers included so claude.ai surfaces the
// error rather than a CORS failure. The token is never echoed or logged.
function unauthorizedConnectorResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized', message: 'invalid or expired connector token' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': CORS_OPTIONS.origin,
        'access-control-allow-methods': CORS_OPTIONS.methods,
        'access-control-allow-headers': CORS_OPTIONS.headers,
        'access-control-expose-headers': CORS_OPTIONS.exposeHeaders,
      },
    }
  );
}

// ─── Export ───────────────────────────────────────────────────
// defaultHandler for the OAuthProvider: the worker's existing router. The provider serves
// /.well-known/oauth-authorization-server + /token + /register and Bearer-gates /mcp-oauth via the
// apiHandler; every other path (Hono /health|/admin|/webhooks, keyed /mcp, disabled /c/<token>/mcp)
// falls through here unchanged.
async function defaultFetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── OAuth upstream dance (/authorize + /callback), federated to Cloudflare Access (M365). ──
    // Must run BEFORE the Hono fallthrough (which would 404 these). The provider advertises these
    // endpoints; they're implemented in src/oauth.ts.
    const oauthRoute = await handleOAuthRoute(request, env, url);
    if (oauthRoute) return oauthRoute;

    // ── /c/<token>/mcp — Claude Desktop custom-connector entry (QUA, Jessica Hunt, READ-ONLY). ──
    // Desktop's connector UI accepts only a URL (no custom header), so the secret lives in the URL
    // path and IS the credential. A valid token resolves to its role (Jessica = 'readonly', which
    // registers ZERO write tools) and dispatches through the SAME per-request McpServer flow after
    // rewriting the path to /mcp (the SDK handler is bound to that route). Invalid/expired token →
    // plain 401 with NO www-authenticate (so Claude does not attempt OAuth). Token is never logged.
    const connMatch = url.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/mcp$/);
    if (connMatch) {
      let reqCtx: RequestContext;
      if (request.method === 'OPTIONS') {
        reqCtx = { actor: 'preflight', role: 'readonly' };
      } else {
        const conn = await verifyConnectorToken(connMatch[1], env);
        if (!conn) return unauthorizedConnectorResponse();
        reqCtx = { actor: conn.owner, role: conn.role };
      }
      const runtimeEnv = env; // tenant placeholder resolution is done at each data-helper call site (readST/stRead/write-factory)
      const server = buildServer(runtimeEnv, execCtx, reqCtx);
      const handler = createMcpHandler(server, { route: '/mcp', corsOptions: CORS_OPTIONS });
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = '/mcp';
      return handler(new Request(rewrittenUrl.toString(), request), runtimeEnv, execCtx);
    }

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
      return unauthorizedMcpResponse();
    }
    const reqCtx: RequestContext = { actor: auth.actor, role: auth.role };
    const runtimeEnv = env; // tenant placeholder resolution is done at each data-helper call site (readST/stRead/write-factory)

    const server = buildServer(runtimeEnv, execCtx, reqCtx);
    const handler = createMcpHandler(server, {
      route: '/mcp',
      corsOptions: CORS_OPTIONS,
    });
    return handler(request, runtimeEnv, execCtx);
}

// ─── apiHandler: OAuth-Bearer-gated READ-ONLY MCP on /mcp-oauth (Phase-2) ──────────────────────
// The OAuthProvider validated the downstream token before this runs and set the authenticated
// identity on ctx.props. OAuth callers are always 'readonly' (the grant is only ever minted for an
// allow-listed user in /callback). route MUST equal apiRoute ('/mcp-oauth') or the transport 404s.
const oauthApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props?: { email?: string } }).props;
    const reqCtx: RequestContext = { actor: props?.email ?? 'oauth', role: 'readonly' };
    const runtimeEnv = env; // tenant placeholder resolution is done at each data-helper call site (readST/stRead/write-factory)
    const server = buildServer(runtimeEnv, ctx, reqCtx);
    const handler = createMcpHandler(server, { route: '/mcp-oauth', corsOptions: CORS_OPTIONS });
    return handler(request, runtimeEnv, ctx);
  },
};

// ─── Default export (Phase-2 OAuth) ───────────────────────────────────────────────────────────
// Delegate ONLY fetch to the provider; the named Durable Object exports above are independent and
// preserved. (Do NOT `export default new OAuthProvider(...)` — that form drops named exports.)
const oauthProvider = createOAuthProvider(defaultFetch, oauthApiHandler);

export default {
  fetch: oauthProvider.fetch.bind(oauthProvider),
} satisfies ExportedHandler<Env>;
