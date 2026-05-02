-- mcp-servicetitan Analytics Engine SQL queries
-- Dataset: mcp_servicetitan_metrics
-- Run via: curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql"
--   -H "Authorization: Bearer $CF_API_TOKEN_ANALYTICS"
--   --data "<query>"
--
-- AE schema (from obs.ts writeDataPoint calls):
--   blob1  = tool name (operation)
--   blob2  = actor
--   blob3  = status ("ok" | "error")
--   double1 = latency_ms
--   index1  = tool name (indexed, for fast GROUP BY)
--
-- Grafana: add a Cloudflare Analytics Engine datasource with SQL API endpoint.
-- Each query below maps to a named Grafana panel.


-- ============================================================
-- Panel 1: Tool calls per minute, last 6h
-- Purpose: live throughput graph — shows traffic shape, spikes, dead periods
-- Expected shape: timeseries; x=minute bucket, y=call count
-- ============================================================
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' MINUTE) AS minute,
  COUNT() AS calls
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '6' HOUR
GROUP BY minute
ORDER BY minute ASC
FORMAT JSON;


-- ============================================================
-- Panel 2: Error rate %, last 24h, by tool
-- Purpose: surface which tools are failing and at what rate
-- Expected shape: table; tool | total_calls | errors | error_rate_pct
-- ============================================================
SELECT
  blob1 AS tool,
  COUNT() AS total_calls,
  SUM(CASE WHEN blob3 = 'error' THEN 1 ELSE 0 END) AS errors,
  ROUND(100.0 * SUM(CASE WHEN blob3 = 'error' THEN 1 ELSE 0 END) / COUNT(), 2) AS error_rate_pct
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY tool
ORDER BY errors DESC
FORMAT JSON;


-- ============================================================
-- Panel 3: p50 / p95 / p99 latency by tool, last 24h
-- Purpose: identify slow tools before they become partner-demo failures
-- Expected shape: table; tool | calls | p50_ms | p95_ms | p99_ms
-- ============================================================
SELECT
  blob1 AS tool,
  COUNT() AS calls,
  quantile(0.50)(double1) AS p50_ms,
  quantile(0.95)(double1) AS p95_ms,
  quantile(0.99)(double1) AS p99_ms
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY tool
ORDER BY p95_ms DESC
FORMAT JSON;


-- ============================================================
-- Panel 4: Top 10 tools by call volume, last 7d
-- Purpose: understand which tools are getting real usage vs theoretical
-- Expected shape: bar chart; tool | calls_7d
-- ============================================================
SELECT
  blob1 AS tool,
  COUNT() AS calls_7d
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY tool
ORDER BY calls_7d DESC
LIMIT 10
FORMAT JSON;


-- ============================================================
-- Panel 5: Top 10 errors by frequency, last 7d
-- Purpose: identify recurring error patterns for remediation priority
-- Expected shape: table; tool | error_message_prefix | count
-- Note: AE doesn't store full error messages — check D1 error_log for detail
-- ============================================================
SELECT
  blob1 AS tool,
  COUNT() AS error_count
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob3 = 'error'
GROUP BY tool
ORDER BY error_count DESC
LIMIT 10
FORMAT JSON;


-- ============================================================
-- Panel 6: Calls by actor, last 24h
-- Purpose: shows which clients (claude-code, smoke-test, prod) drive traffic
-- Expected shape: pie or bar; actor | calls
-- ============================================================
SELECT
  blob2 AS actor,
  COUNT() AS calls
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY actor
ORDER BY calls DESC
FORMAT JSON;


-- ============================================================
-- Panel 7: Composite fanout latency (customer_snapshot, job_closeout_report), last 24h
-- Purpose: composites fan out to 3-5 ST calls; watch for upstream ST slowdowns
-- Expected shape: timeseries; x=hour bucket, y=avg latency for each composite
-- ============================================================
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
  blob1 AS tool,
  AVG(double1) AS avg_latency_ms,
  quantile(0.95)(double1) AS p95_ms,
  COUNT() AS calls
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob1 IN ('customer_snapshot', 'job_closeout_report')
GROUP BY hour, tool
ORDER BY hour ASC
FORMAT JSON;


-- ============================================================
-- Panel 8: Write-gate activity, last 24h
-- Purpose: verify dryRun→confirm pipeline is healthy; watch for expired tokens
-- Note: AE logs the write gate events; D1 confirmation_tokens has the canonical record
-- Expected shape: stacked bar per hour; dry_runs | confirmed | expired
-- ============================================================
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
  blob3 AS event_type,
  COUNT() AS count
FROM mcp_servicetitan_metrics
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob1 IN ('dryRun', 'confirm', 'expired_token', 'replay_attempt')
GROUP BY hour, event_type
ORDER BY hour ASC
FORMAT JSON;
