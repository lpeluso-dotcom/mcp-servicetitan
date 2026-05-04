-- ============================================================
-- Migration 0001 — mcp_cache
-- Shared read-through cache for internal MCP modules.
-- Lives on the configured ServiceTitan proxy D1.
--
-- Apply via:
--   mcp__cloudflare__d1_database_query on each DB
-- (token lacks D1:Edit so `wrangler d1 execute` won't work)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_cache (
  ns          TEXT NOT NULL,      -- namespace, e.g. "servicetitan:customers"
  k           TEXT NOT NULL,      -- key within the namespace
  value       TEXT NOT NULL,      -- JSON payload
  expires_at  INTEGER NOT NULL,   -- unix ms
  PRIMARY KEY (ns, k)
);

CREATE INDEX IF NOT EXISTS idx_mcp_cache_expires ON mcp_cache(expires_at);
