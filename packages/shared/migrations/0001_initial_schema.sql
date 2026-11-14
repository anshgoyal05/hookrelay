-- HookRelay Initial Schema
-- Invariant 1: AT-LEAST-ONCE delivery guarantee.
-- Invariant 2: Event + outbox row in ONE Postgres transaction.
-- Invariant 3: Postgres is source of truth; queues carry IDs only.
-- Invariant 4: Secrets never logged; API keys stored hashed.
-- Invariant 6: Strict tenant isolation (all tenant data scoped with tenant_id).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Tenants
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. API Keys
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix VARCHAR(16) NOT NULL UNIQUE,
    key_hash VARCHAR(64) NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for API key authentication by prefix (O(1) active key lookup)
CREATE INDEX idx_api_keys_lookup ON api_keys (key_prefix) WHERE revoked_at IS NULL;

-- Index for tenant-scoped API key management
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);

-- 3. Endpoints (Customer webhook destinations)
CREATE TABLE endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    previous_secret TEXT NULL,
    previous_secret_expires_at TIMESTAMPTZ NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
    description TEXT,
    concurrency_limit INT NOT NULL DEFAULT 10 CHECK (concurrency_limit > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for retrieving a tenant's active endpoints during fan-out
CREATE INDEX idx_endpoints_tenant_status ON endpoints (tenant_id, status);

-- 4. Event Types
CREATE TABLE event_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_types_tenant_name UNIQUE (tenant_id, name)
);

-- 5. Endpoint Subscriptions
CREATE TABLE endpoint_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    event_type VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_endpoint_subscriptions UNIQUE (endpoint_id, event_type)
);

-- Index for fan-out matching: find all endpoints subscribed to a specific event type or wildcard '*'
CREATE INDEX idx_endpoint_subscriptions_match ON endpoint_subscriptions (event_type, endpoint_id);

-- 6. Events
-- Note: raw_payload stores the exact byte sequence received over HTTP for cryptographic HMAC signing (ADR 0002).
-- payload stores parsed JSONB for JSON operations and querying.
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type VARCHAR(128) NOT NULL,
    raw_payload TEXT NOT NULL,
    payload JSONB NOT NULL,
    idempotency_key VARCHAR(255) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_events_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

-- Index for tenant-scoped event inspection / debugging queries
CREATE INDEX idx_events_tenant_created ON events (tenant_id, created_at DESC);

-- 7. Outbox (Transactional Outbox Pattern)
-- Written in the SAME transaction as events. Only the outbox relay publishes to RabbitMQ (Invariant 2).
CREATE TABLE outbox (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ NULL
);

-- Partial index for high-speed polling of pending outbox events (WHERE published_at IS NULL)
CREATE INDEX idx_outbox_unpublished ON outbox (created_at ASC) WHERE published_at IS NULL;

-- 8. Deliveries (State of a single event dispatched to a single endpoint)
CREATE TABLE deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'dead')),
    attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NULL,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_deliveries_event_endpoint UNIQUE (event_id, endpoint_id)
);

-- Index for: "list a tenant's deliveries by status and time"
CREATE INDEX idx_deliveries_tenant_status_created ON deliveries (tenant_id, status, created_at DESC);

-- Index for: worker retry poller finding failed deliveries due for redelivery
CREATE INDEX idx_deliveries_due_retry ON deliveries (next_attempt_at ASC) WHERE status = 'failed';

-- 9. Delivery Attempts (Declaratively partitioned by month)
CREATE TABLE delivery_attempts (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    attempt_no INT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT NOT NULL,
    http_status INT NULL,
    error TEXT NULL,
    response_snippet VARCHAR(1024) NULL CHECK (octet_length(response_snippet) <= 1024),
    CONSTRAINT pk_delivery_attempts PRIMARY KEY (id, started_at),
    CONSTRAINT uq_delivery_attempts_attempt UNIQUE (delivery_id, attempt_no, started_at)
) PARTITION BY RANGE (started_at);

-- Local indexes across each partition for target queries:
-- 1) List attempts for a delivery:
CREATE INDEX idx_delivery_attempts_delivery_order ON delivery_attempts (delivery_id, attempt_no ASC);

-- 2) Tenant-scoped audit/metrics queries:
CREATE INDEX idx_delivery_attempts_tenant_time ON delivery_attempts (tenant_id, started_at DESC);

-- Function to dynamically create monthly partitions without hardcoded dates
CREATE OR REPLACE FUNCTION create_attempts_partition(target_month TIMESTAMPTZ)
RETURNS TEXT AS $$
DECLARE
    start_ts TIMESTAMPTZ := date_trunc('month', target_month);
    end_ts TIMESTAMPTZ := start_ts + INTERVAL '1 month';
    partition_name TEXT := 'delivery_attempts_' || to_char(start_ts, 'YYYY_MM');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF delivery_attempts FOR VALUES FROM (%L) TO (%L);',
        partition_name,
        start_ts,
        end_ts
    );
    RETURN partition_name;
END;
$$ LANGUAGE plpgsql;

-- Pre-create partitions for the current month and the next 3 months
SELECT create_attempts_partition(now() + (n || ' months')::interval)
FROM generate_series(0, 3) AS n;
