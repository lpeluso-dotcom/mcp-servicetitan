// ============================================================
// env.ts — Typed environment bindings for mcp-servicetitan
// ============================================================

export interface Env {
  // Bindings
  DB: D1Database;
  TAI_STATE: KVNamespace;
  TAYLOR_AI: Fetcher; // Service binding — fetches against the taylor-ai worker
  MCP_METRICS: AnalyticsEngineDataset; // p50/p95/p99 + error-rate timeseries

  // Vars
  MCP_SERVICE_VERSION: string;

  // Secrets
  MCP_SYNC_KEY: string; // For taylor-ai /api/st/read proxy
  SIRO_API_TOKEN: string; // Siro org API token (Bearer auth)
  ST_WEBHOOK_SECRET: string; // ServiceTitan webhook HMAC-SHA256 secret

  // F3 Durable Objects
  ST_RATE_LIMITER: DurableObjectNamespace;
  CUSTOMER_SNAPSHOT_FLIGHT: DurableObjectNamespace;
}
