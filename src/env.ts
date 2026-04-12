// ============================================================
// env.ts — Typed environment bindings for mcp-servicetitan
// ============================================================

export interface Env {
  // Bindings
  DB: D1Database;
  TAI_STATE: KVNamespace;

  // Vars
  TAYLOR_AI_URL: string;
  MCP_SERVICE_VERSION: string;

  // Secrets
  MCP_SYNC_KEY: string;
}
