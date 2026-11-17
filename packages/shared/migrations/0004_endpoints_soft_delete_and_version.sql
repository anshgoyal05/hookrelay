-- Migration: 0004_endpoints_soft_delete_and_version.sql
-- Adds soft deletion, version counter for optimistic concurrency,
-- drops NOT NULL on signing_secret so secrets can be scrubbed on deletion,
-- and adds performance indexes for keyset pagination and active fan-out.

-- 1. Soft delete and version columns
ALTER TABLE endpoints ADD COLUMN deleted_at TIMESTAMPTZ NULL;
ALTER TABLE endpoints ADD COLUMN version INT NOT NULL DEFAULT 1;

-- 2. Allow scrubbing secrets upon deletion
ALTER TABLE endpoints ALTER COLUMN signing_secret DROP NOT NULL;

-- 3. Index for keyset pagination on (created_at DESC, id DESC) under tenant isolation
CREATE INDEX idx_endpoints_tenant_list ON endpoints (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- 4. Partial index for active fan-out worker lookup (Invariant 6 + Invariant 7)
CREATE INDEX idx_endpoints_tenant_active ON endpoints (tenant_id) WHERE deleted_at IS NULL AND status = 'active';
