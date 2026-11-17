-- Add last_used_at to api_keys table for usage tracking
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NULL;
