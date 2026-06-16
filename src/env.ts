// ============================================================
// env.ts — Typed environment bindings for mcp-servicetitan
// ============================================================

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  // Bindings
  DB: D1Database;
  PROXY_STATE: KVNamespace;
  ST_PROXY: Fetcher; // Service binding — fetches against the servicetitan-proxy worker
  MCP_METRICS: AnalyticsEngineDataset; // p50/p95/p99 + error-rate timeseries

  // Phase-2 OAuth hardening (QUA) — Claude Desktop connector via Cloudflare Access (SaaS-OIDC) → M365.
  OAUTH_KV: KVNamespace; // workers-oauth-provider store (clients/grants/tokens) + login:<state>
  ACCESS_CLIENT_ID: string; // Access SaaS-OIDC client id (var)
  ACCESS_CLIENT_SECRET: string; // Access SaaS-OIDC client secret (secret)
  ACCESS_ISSUER: string; // …/cdn-cgi/access/sso/oidc/<client_id> (var); endpoints derived
  ALLOWED_EMAILS?: string; // in-worker allow-list re-checked in /callback (var)
  SELF_ORIGIN?: string; // pinned callback origin, not the spoofable request Host (var)
  OAUTH_PROVIDER: OAuthHelpers; // injected by the provider before defaultHandler runs

  // Vars
  MCP_SERVICE_VERSION: string;
  ST_TENANT_ID: string;
  MCP_LOCKDOWN?: string; // "true" → server enters lockdown / read-only mode (v1.5.2)

  // Secrets
  MCP_SYNC_KEY: string; // For servicetitan-proxy /api/st/read proxy
  SIRO_API_TOKEN: string; // Siro org API token (Bearer auth)
  ST_WEBHOOK_SECRET: string; // ServiceTitan webhook HMAC-SHA256 secret
  JWT_SECRET: string; // JWT signing secret for dual-mode auth

  // F3 Durable Objects
  ST_RATE_LIMITER: DurableObjectNamespace;
  CUSTOMER_SNAPSHOT_FLIGHT: DurableObjectNamespace;
}
