# 0001: Monorepo Skeleton and Technology Stack

## Context
HookRelay is a multi-tenant outbound webhook delivery platform requiring high-throughput event ingestion, transactional outbox publishing, message queuing, worker dispatching, and audit logging. We need to choose the repository structure, language runtime, web framework, queuing system, and development tooling that allow seamless code sharing (types, schemas, logger) while maintaining strict process boundaries between API ingestion and background delivery workers.

## Options Considered
1. **Multi-Repo Architecture**:
   - Separate standalone git repositories for `api`, `worker`, and a published npm package for shared libraries.
   - *Pros*: Completely independent deployment lifecycles and CI pipelines.
   - *Cons*: High friction for synchronized changes across domain types, outbox schemas, and shared config; requires publishing shared packages to an internal registry during active early development.
2. **Single Monolithic Node Process**:
   - Single unified application executing both the Fastify HTTP server and background consumer queues within the same process.
   - *Pros*: Simplest operational model initially.
   - *Cons*: Violates process isolation invariants; memory leaks or CPU spikes during delivery spikes could degrade API ingestion; scaling HTTP ingestion independently of worker dispatching becomes impossible.
3. **npm Workspaces Monorepo with TypeScript & Distinct Application Boundaries**:
   - Single repository with `apps/api` (Fastify), `apps/worker` (standalone Node process), and `packages/shared` (types, zod schemas, config, logger) using native npm workspaces and TypeScript project references.
   - *Pros*: Zero external registry overhead for shared types/schemas; strict compile-time checking; independent deployable binaries; lightweight tooling with zero proprietary monorepo lock-in.
   - *Cons*: Monorepo CI pipelines must test multiple workspaces (mitigated by fast Vitest test runners and TypeScript project references).

## Decision
We choose **Option 3: npm Workspaces Monorepo with TypeScript & Distinct Application Boundaries**.
- Core stack: Fastify for `apps/api`, standalone Node process for `apps/worker`, PostgreSQL 16 (source of truth + transactional outbox), Redis 7 (rate limiting / idempotency keys), RabbitMQ 3 (job queuing), Pino (structured logging with secret redaction), Zod (schema validation), Vitest (fast testing).
- Local development leverages `tsx` for fast iteration without compilation overhead, while production builds strictly rely on `tsc -b` compiled JavaScript.

## Consequences
- **Positive**: Strict type safety across the entire pipeline. Easy sharing of Zod validation schemas and domain models between API and Worker. Clear separation of ingestion latency from outbound network I/O.
- **Negative**: Requires maintaining workspace build references and ensuring Docker build contexts package the shared workspace dependencies properly.

## What would make us revisit this
- If repository size and commit frequency increase to where monolithic CI builds become a bottleneck, justifying migration to dedicated Turborepo / Nx remote caching or service decoupling.
- If team boundaries require separate access controls per service.

## My reasoning
<!-- To be filled in by developer -->
