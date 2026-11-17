# 0005: Endpoint Deletion and Historical Audit Integrity

## Context
When a tenant deletes an endpoint in HookRelay, the database must reconcile two conflicting needs:
1. The tenant wants the endpoint immediately removed from active webhook fan-out, subscription routing, and management dashboard listings.
2. The `deliveries` table holds foreign key references (`endpoint_id`) to the `endpoints` table. If the endpoint is deleted permanently from the database, either foreign key constraints fail, or historical delivery logs, attempt metrics, and compliance audit records are permanently destroyed.

## Options Considered

### Option 1: Hard Delete with `ON DELETE CASCADE`
- Execute `DELETE FROM endpoints WHERE id = $1`, cascading the deletion down to all matching rows in `deliveries` and `delivery_attempts`.
- *Pros*: Frees up disk space immediately.
- *Cons*: **Fatal flaw**: Violates Invariant 1 and core auditability. Destroys all historical evidence of past deliveries to that customer endpoint. A tenant could never prove whether an invoice, alert, or order webhook was dispatched last week.

### Option 2: Reuse Status Column (`status = 'disabled'`)
- Mark the endpoint with `status = 'disabled'` to stop delivery fan-out.
- *Pros*: Zero database schema migration required (already supported in `0001_initial_schema.sql`).
- *Cons*: Ambiguous semantics. Fails to distinguish between an endpoint that the tenant paused/disabled temporarily versus an endpoint that was explicitly deleted and discarded. Prevents clean re-creation of an endpoint pointing to the same URL or using identical naming.

### Option 3: Explicit Soft Delete via `deleted_at TIMESTAMPTZ NULL`
- Introduce a dedicated `deleted_at` timestamp column to `endpoints`.
- Active endpoints have `deleted_at IS NULL`.
- Deletion sets `deleted_at = now()` and sets `status = 'disabled'`.
- Subscriptions belonging to the deleted endpoint are dropped or deactivated.
- Fan-out engine queries filter by `WHERE deleted_at IS NULL AND status = 'active'`.
- All historical `deliveries` and `delivery_attempts` remain intact, pointing to the original endpoint ID with its historical URL and metadata preserved.
- *Pros*: Uncompromised audit trail; clear separation between paused/disabled and deleted states; compatible with partial indexes (`WHERE deleted_at IS NULL`).
- *Cons*: Requires an incremental schema migration (planned as `0003_endpoint_soft_delete.sql`).

## Decision
We choose **Option 3: Explicit Soft Delete via `deleted_at TIMESTAMPTZ NULL`**.
- Deletion will set `deleted_at = now()` and `status = 'disabled'`.
- We will plan and create migration `0003_endpoint_soft_delete.sql` to add `deleted_at TIMESTAMPTZ NULL` to `endpoints` and create a partial index on `(tenant_id, status) WHERE deleted_at IS NULL`.
- We will never edit migrations `0001` or `0002`.

## Consequences
- **Positive**: Complete audit trail preservation, zero data loss, and unambiguous endpoint lifecycles.
- **Negative**: Queries listing active endpoints must include `WHERE deleted_at IS NULL` (enforced via partial index).

## What would make us revisit this
- GDPR/CCPA "Right to be Forgotten" mandates where an endpoint URL containing personal data must be permanently erased. In that scenario, an anonymization job will redact the URL to `https://redacted.invalid` while keeping the row and deliveries intact.

## My reasoning
<!-- To be filled in by developer -->
