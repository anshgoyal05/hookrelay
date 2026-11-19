# 0008: Database Schema Migration Tooling

## Context
HookRelay relies on PostgreSQL 16 as its single source of truth (Architecture Invariant 2 and 3). The schema uses advanced PostgreSQL-specific features including declarative monthly range partitioning (`delivery_attempts`), partial indexes (`idx_outbox_unpublished`, `idx_deliveries_due_retry`, `idx_endpoints_tenant_active`), foreign keys across tenant-scoped tables, and a transactional schema tracking table. We need a migration execution tool to apply ordered schema changes reliably across local development, automated CI workflows, and multi-instance production environments without data corruption or deployment race conditions.

## Options Considered

1. **In-House Minimal SQL Runner (`migrator.ts`)**:
   - A lightweight (~150 LOC) TypeScript script in `packages/shared/src/db/` that reads raw SQL migration files (`NNNN_name.sql`), acquires an atomic PostgreSQL session advisory lock (`pg_advisory_lock`), checks SHA-256 checksums recorded in a `schema_migrations` table, and executes each new migration inside an atomic `BEGIN ... COMMIT` transaction.
   - *Pros*:
     - Zero external dependencies beyond the existing `pg` driver; no maintenance overhead or third-party supply chain risks.
     - Direct raw SQL execution: full native support for PostgreSQL 16 declarative range partitioning syntax, monitoring views, custom PL/pgSQL functions, and partial indexes without framework impedance.
     - Tamper-evident: SHA-256 checksum validation ensures historically applied migrations cannot be modified after commit.
     - Fast startup and minimal footprint: can be invoked with minimal configuration (only `DATABASE_URL`).
   - *Cons*:
     - No automatic generation of "down" / rollback scripts (mitigated by forward-only migrations and point-in-time recovery for disaster scenarios).
     - Does not provide an interactive visual CLI for generating migrations.

2. **`node-pg-migrate`**:
   - Established standalone Node.js migration framework specifically built for PostgreSQL.
   - *Pros*:
     - Supports both raw SQL files and programmatic JavaScript/TypeScript migration scripts.
     - Built-in CLI commands, automatic rollback tracking, and programmable up/down steps.
   - *Cons*:
     - Introduces additional external dependencies and CLI runtime wrappers.
     - Custom PostgreSQL declarative partitioning statements (`PARTITION BY RANGE`, `PARTITION OF`) still require raw SQL strings within JS migration functions, negating the value of the programmatic DSL.
     - Requires its own configuration format and environment loading mechanisms.

3. **Full-Featured ORM Migration Framework (Prisma / Drizzle Kit / TypeORM)**:
   - Full Object-Relational Mapping schema management tools that derive migrations from declarative schema definition files.
   - *Pros*:
     - Generates schema diffs automatically from TypeScript or schema models.
     - Generates client-side TypeScript types directly from models.
   - *Cons*:
     - Substantial dependency weight and framework lock-in.
     - Weak or awkward abstraction support for PostgreSQL declarative partitioning, partitioned views, custom advisory locks, and complex partial indexes.
     - High risk of generating naive DDL that locks busy production tables unexpectedly.

## Decision
We choose **Option 1: In-House Minimal SQL Runner (`migrator.ts`)**.

- Migrations are authored as numbered plain SQL files in `packages/shared/migrations/` (`0001_initial_schema.sql`, etc.).
- Execution is serialized using a dedicated PostgreSQL advisory lock (`MIGRATION_ADVISORY_LOCK_ID = 837261947261`), preventing concurrent race conditions when multiple containers boot simultaneously.
- Checksums are verified against `schema_migrations` prior to running any new files; tampering with historical files fails fast with `MigrationChecksumMismatchError`.
- Migration numbering uses 4-digit prefixes (`0001`, `0003`, `0004`, `0005`); migration `0002` is intentionally unused and reserved/skipped.

## Consequences
- **Positive**: Complete control over Postgres-specific DDL syntax. Zero external package overhead. Deterministic transaction boundaries and tamper protection.
- **Negative**: Developers must write raw SQL migrations manually. Rollbacks must be handled through explicit forward-compensating migrations (`0006_...`) rather than automated `down` scripts.

## What would make us revisit this
- If the development team expands and requires automated schema diff generation across many feature branches.
- If HookRelay is adapted to support multi-database engines beyond PostgreSQL (contrary to our current architectural commitment to PostgreSQL 16).

## My reasoning
<!-- To be filled in by developer -->
