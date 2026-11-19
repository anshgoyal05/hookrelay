# HookRelay: Agent Rules

## Project
HookRelay is a multi-tenant outbound webhook delivery platform. A tenant's backend
publishes an event once; HookRelay signs it, fans it out to every subscribed customer
endpoint, retries failures, and keeps a searchable, replayable delivery log.

## Architecture invariants (never violate)
1. Delivery guarantee is AT-LEAST-ONCE. Never claim exactly-once. Consumers must be idempotent.
2. Event + outbox row are written in ONE Postgres transaction. Only the outbox relay publishes to RabbitMQ.
3. Postgres is the source of truth. Queues carry only IDs, never full payloads.
4. Secrets (API keys, signing secrets) are never logged. API keys are stored hashed.
5. All outbound HTTP calls: timeout, redirect limit, response-size cap, SSRF protection
   (block private/loopback/link-local/metadata IPs, re-check after DNS resolution).
6. Every tenant-scoped query includes tenant_id. No cross-tenant reads.
7. One slow or failing endpoint must not delay other endpoints or tenants.

## Layout
apps/api, apps/worker, apps/dashboard, packages/shared, infra/, docs/, loadtest/
Docs: docs/HLD.md, docs/LLD.md, docs/adr/NNNN-title.md, docs/RUNBOOK.md

## Code standards
- TypeScript strict mode, no `any` without a comment explaining why.
- Validate all input with zod. Return RFC 7807 problem+json errors.
- Small modules, dependency injection for DB/queue/clock (so tests can fake them).
- Structured JSON logs (pino) with request_id, tenant_id, event_id, delivery_id.
- Every feature ships with tests (vitest). Integration tests use docker compose services.

## Working agreement
- Always produce an implementation plan first and wait for approval on multi-file tasks.
- Do not add dependencies without listing them and the reason in the plan.
- Do not change the architecture invariants without asking me.
- After each task: update docs, list trade-offs made, list what you did NOT do.
- Prefer boring, well-known solutions. Explain any non-obvious choice in 2 to 3 sentences.
- Never run destructive commands (rm -rf outside the repo, docker system prune, git push --force).

## Custom Commands (Workflows)
HookRelay provides project-specific Antigravity workflows in `.agents/workflows/`:
- `/verify`: See [.agents/workflows/verify.md](file://.agents/workflows/verify.md) (Runs lint, typecheck, test suites, and formats failures as `file:line`).
- `/adr`: See [.agents/workflows/adr.md](file://.agents/workflows/adr.md) (Guides drafting a new ADR in `docs/adr/NNNN-<slug>.md`).
- `/day-review`: See [.agents/workflows/day-review.md](file://.agents/workflows/day-review.md) (Audits git diff against architectural invariants, tests, docs, security, and interview questions).
