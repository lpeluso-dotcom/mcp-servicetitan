// ============================================================
// env.ts — Typed environment bindings for mcp-servicetitan
// ============================================================

export interface Env {
  // Bindings
  DB: D1Database;
  TAI_STATE: KVNamespace;
  TAYLOR_AI: Fetcher; // Service binding — fetches against the taylor-ai worker

  // Vars
  MCP_SERVICE_VERSION: string;

  // Secrets
  MCP_SYNC_KEY: string;  // For taylor-ai /api/st/read proxy
  SIRO_API_TOKEN: string; // Siro org API token (Bearer auth), used for v1 read endpoints
}
