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
import { registerCatalogResources } from './resources/catalogs';
import { resolveAuth } from './auth';
import { requireAdminKey } from './routes/admin-guard';
import { auditHealthHandler } from './routes/admin-health-audit';
import { unackedErrorsHandler } from './routes/admin-errors';
import { endpointsHandler, endpointsCoverageHandler } from './routes/admin-endpoints';
import { handleWebhook } from './webhook-ingest';
import { createOAuthProvider, handleOAuthRoute } from './oauth';

// Durable Object classes must be exported from the worker entry point.
export { StRateLimiter } from './durable/st-rate-limiter';
export { CustomerSnapshotSingleflight } from './durable/customer-snapshot-flight';
export { PricebookEmbedWorkflow } from './workflows/pricebook-embed';

// ─── Hono app for non-MCP routes ──────────────────────────────
const app = new Hono<{ Bindings: Env }>();

export function healthPayload(env: Env): Record<string, unknown> {
  return {
    ok: true,
    service: 'mcp-servicetitan',
    version: env.MCP_SERVICE_VERSION,
    // Derived at deploy time from the checked-out commit. Unlike
    // MCP_SERVICE_VERSION (a hand-edited literal that has not moved across
    // ~10 deploys) this cannot drift from what is actually running.
    commit: env.GIT_SHA || 'unknown',
    toolCount: TOOLS.length,
    // tool NAMES intentionally omitted (QUA-519): unauthenticated enumeration
    // aids targeting. Full per-tool inventory lives on admin-gated /admin/endpoints.
    transport: 'agents-sdk createMcpHandler (Streamable HTTP)',
    stProxy: 'service-binding',
    lockdown: env.MCP_LOCKDOWN === 'true',
  };
}

app.get('/health', (c) => c.json(healthPayload(c.env)));

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
// Browser-enforced only: non-browser clients (Claude Desktop/Code, Dawn,
// server-side MCP clients) send no Origin and ignore ACAO. The allowlist
// reflects known browser surfaces; anything else gets the claude.ai value,
// which the requesting page cannot match — the browser blocks the read.
// QUA-519 hardening (was origin:'*').
const ALLOWED_BROWSER_ORIGINS: ReadonlySet<string> = new Set([
  'https://claude.ai',
  'https://claude.com',
  'http://localhost:5173',   // MCP Inspector (vite dev UI)
  'http://127.0.0.1:5173',
  'http://localhost:6274',   // MCP Inspector ≥0.13 default UI port
  'http://127.0.0.1:6274',
]);

export function corsOriginFor(request: Request): string {
  const origin = request.headers.get('origin');
  return origin && ALLOWED_BROWSER_ORIGINS.has(origin) ? origin : 'https://claude.ai';
}

const CORS_BASE = {
  methods: 'GET, POST, OPTIONS, DELETE',
  headers: 'content-type, mcp-session-id, authorization, x-sync-key, x-mcp-role, x-actor, x-correlation-id',
  exposeHeaders: 'mcp-session-id',
  maxAge: 86400,
};

export function corsOptionsFor(request: Request) {
  return { ...CORS_BASE, origin: corsOriginFor(request) };
}

function unauthorizedMcpResponse(request: Request): Response {
  const corsOptions = corsOptionsFor(request);
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      message: 'POST /mcp requires Authorization: Bearer <JWT> or X-Sync-Key.',
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': corsOptions.origin,
        'access-control-allow-methods': corsOptions.methods,
        'access-control-allow-headers': corsOptions.headers,
        'access-control-expose-headers': corsOptions.exposeHeaders,
        // ACAO is now per-request-reflected (not '*') — tell any intermediary
        // cache the response varies by Origin so one origin's reflected value
        // is never served to another (final-review finding, QUA-519).
        vary: 'origin',
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
  '- Memberships: list_memberships_active, list_memberships_expiring, list_recurring_service_events. Recurring service mutations require dryRun confirmation; marking events also changes job invoice items.',
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
  registerPrompts(server, env);
  registerResultResource(server, env);
  registerCatalogResources(server, env);
  return server;
}

// ─── Export ───────────────────────────────────────────────────
// defaultHandler for the OAuthProvider: the worker's existing router. The provider serves
// /.well-known/oauth-authorization-server + /token + /register and Bearer-gates /mcp-oauth via the
// apiHandler; every other path (Hono /health|/admin|/webhooks, keyed /mcp) falls through here
// unchanged. `/c/<token>/mcp` was DELETED 2026-08-01 (QUA-1117) — see the note at its old site.
async function defaultFetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── OAuth upstream dance (/authorize + /callback + /approve), federated to Cloudflare Access
    // (M365). Must run BEFORE the Hono fallthrough (which would 404 these). The provider advertises
    // these endpoints; they're implemented in src/oauth.ts.
    //
    // /approve is the consent gate (audit S-1) and is deliberately reachable without a sync key —
    // a browser has to render it mid-flow. It is not an open door: the parked grant is addressed
    // by an unguessable approve:<uuid> KV entry that is single-use and expires in LOGIN_TTL, and
    // the email allow-list is re-checked before completeAuthorization is called.
    const oauthRoute = await handleOAuthRoute(request, env, url);
    if (oauthRoute) return oauthRoute;

    // ── /c/<token>/mcp — DELETED 2026-08-01 (QUA-1117 item 3). ──
    // This was the Claude Desktop custom-connector entry: Desktop's UI accepts only a URL, so the
    // secret lived in the path and WAS the credential. It is gone rather than secret-gated, and
    // the distinction matters. The route stayed compiled and reachable, disabled only by an unset
    // secret — the 2026-08-01 audit probed it and got 401, not 404, on both this worker and
    // qsc-hopper. Worse, a URL token carried its OWN role: a row minted role:'default' reached all
    // 24 write tools, so the read-only guarantee the connector existed to provide could be
    // bypassed by whoever minted the token. A credential in a URL also lands in browser history,
    // proxy logs and referrer headers, none of which the worker controls.
    //
    // There is no replacement path here: use the header-authenticated /mcp door, or /mcp-oauth,
    // both of which resolve role from a credential the caller cannot choose.
    //
    // Falls through to Hono below (the path does not start with /mcp) → 404, which is what
    // scripts/probe-connector-guards.sh section 1 asserts.
    //
    // The D1 table `mcp_auth_tokens` (migration 0004) is deliberately LEFT IN PLACE — dropping a
    // prod D1 table needs an R2 backup and Luke's approval per protected-modules.md. Nothing reads
    // it now; removing it is a separate, gated cleanup.

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
      return unauthorizedMcpResponse(request);
    }
    const reqCtx: RequestContext = { actor: auth.actor, role: auth.role };
    const runtimeEnv = env; // tenant placeholder resolution is done at each data-helper call site (readST/stRead/write-factory)

    const server = buildServer(runtimeEnv, execCtx, reqCtx);
    const handler = createMcpHandler(server, {
      route: '/mcp',
      corsOptions: corsOptionsFor(request),
    });
    return handler(request, runtimeEnv, execCtx);
}

// ─── apiHandler: OAuth-Bearer-gated READ-ONLY MCP on /mcp-oauth (Phase-2) ──────────────────────
// The OAuthProvider validated the downstream token before this runs and set the authenticated
// identity on ctx.props. OAuth callers are always 'readonly' (the grant is only ever minted for an
// allow-listed user in /callback). route MUST equal apiRoute ('/mcp-oauth') or the transport 404s.
// This handler never routes through resolveAuth, so MCP_LOCKDOWN never touches it directly — it
// relies on toolsForRole() filtering 'readonly' identically to 'lockdown' (src/tools/index.ts).
// If that equivalence ever changes, this hardcoded 'readonly' would silently stop being covered
// by the incident switch — keep the two roles' tool filters identical, or gate this path too.
const oauthApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props?: { email?: string } }).props;
    const reqCtx: RequestContext = { actor: props?.email ?? 'oauth', role: 'readonly' };
    const runtimeEnv = env; // tenant placeholder resolution is done at each data-helper call site (readST/stRead/write-factory)
    const server = buildServer(runtimeEnv, ctx, reqCtx);
    const handler = createMcpHandler(server, { route: '/mcp-oauth', corsOptions: corsOptionsFor(request) });
    return handler(request, runtimeEnv, ctx);
  },
};

// ─── Cron: kick the pricebook embedding-refresh Workflow (daily 10:00 UTC) ──────
// Overlap guard: skip if the last instance is still running. Instance id in KV.
async function scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const KEY = 'embed_workflow:last_instance';
  try {
    const lastId = await env.PROXY_STATE.get(KEY);
    if (lastId) {
      const prev = await env.EMBED_WORKFLOW.get(lastId).catch(() => null);
      const status = prev ? await prev.status().catch(() => null) : null;
      // Only proceed if the previous instance is in a terminal state.
      // Any non-terminal state (running, queued, waiting, paused, waitingForPause) → skip.
      if (status && !['complete', 'errored', 'terminated', 'unknown'].includes(status.status as any)) {
        return; // still working
      }
    }
    const inst = await env.EMBED_WORKFLOW.create();
    await env.PROXY_STATE.put(KEY, inst.id, { expirationTtl: 60 * 60 * 24 * 2 });
  } catch (err) {
    console.error('[scheduled] embed workflow kick failed:', err);
  }
}

// ─── Default export (Phase-2 OAuth) ───────────────────────────────────────────────────────────
// Delegate ONLY fetch to the provider; the named Durable Object exports above are independent and
// preserved. (Do NOT `export default new OAuthProvider(...)` — that form drops named exports.)
const oauthProvider = createOAuthProvider(defaultFetch, oauthApiHandler);

export default {
  fetch: oauthProvider.fetch.bind(oauthProvider),
  scheduled,
} satisfies ExportedHandler<Env>;
