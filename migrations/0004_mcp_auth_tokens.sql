-- ─── Connector tokens (QUA — Jessica Hunt, Claude Desktop) ───────────────────
-- URL-path tokens for the /c/<token>/mcp custom-connector route. Claude Desktop's
-- connector UI accepts only a URL (no header), so the token in the URL IS the
-- credential. token_hash: SHA-256 of the token value, hex-encoded — never store
-- the raw token. role is constrained to the non-write connector roles; the worker
-- further floors anything unexpected to 'readonly'. expires_at: epoch ms, NULL =
-- no expiry. Revoke a token by DELETEing its row.
CREATE TABLE IF NOT EXISTS mcp_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('readonly', 'default')),
  owner TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  note TEXT
);
