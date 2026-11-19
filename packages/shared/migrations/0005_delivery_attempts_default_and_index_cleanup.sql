-- Migration 0005: Delivery attempts default partition, monitoring view, and index cleanup
--
-- 1. Default partition for delivery_attempts:
-- Catches any attempts whose started_at timestamp falls outside pre-created monthly partition bounds
-- (e.g. historical backfills, out-of-order retries, or clock skew).
CREATE TABLE IF NOT EXISTS delivery_attempts_default
  PARTITION OF delivery_attempts DEFAULT;

-- 2. Monitoring view for the default partition:
-- Alerts operators if unpartitioned attempts land here.
-- Reports total count, oldest started_at, and newest started_at.
CREATE OR REPLACE VIEW view_delivery_attempts_default_monitor AS
SELECT
  count(*)::bigint AS row_count,
  min(started_at)  AS oldest_started_at,
  max(started_at)  AS newest_started_at
FROM delivery_attempts_default;

-- 3. Drop redundant partial index idx_api_keys_lookup:
-- The unique constraint index `api_keys_key_prefix_key` ON (key_prefix) already enforces uniqueness
-- and provides direct single-row index lookups by prefix. A secondary partial index on
-- (key_prefix) WHERE revoked_at IS NULL provides zero performance benefit and wastes write I/O.
DROP INDEX IF EXISTS idx_api_keys_lookup;
