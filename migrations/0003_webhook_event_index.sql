-- 0003_webhook_event_index.sql
-- Adds index on webhook_events.event_type so type-filtered queries (e.g.
-- "all jobCompleted events from last 24h") don't full-scan the table.
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON webhook_events (event_type, received_at);
