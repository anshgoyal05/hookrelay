# Known Limitations & Deferred Engineering Tasks

This document tracks known architectural limitations, unverified runtime paths, and deferred production engineering tasks as of Day 2.5.

---

### 1. Production Dockerfile
- **Status**: Deferred to Day 6/Productionization.
- **Description**: The repository currently provides `infra/docker-compose.yml` to spin up dependencies (PostgreSQL 16, Redis 7, RabbitMQ 3) for local development and integration tests. Standalone production multi-stage `Dockerfile` definitions for `apps/api` and `apps/worker` have not yet been authored.
- **Mitigation**: Local development runs via `npm run dev:api` and `npm run dev:worker` using `tsx`. Production builds are typechecked via `tsc -b`.

---

### 2. Docker & Compiled Migration Execution Path
- **Status**: Partially Verified.
- **Description**: Database migrations (`packages/shared/src/db/migrate.ts`) are currently executed via `tsx --env-file-if-exists=.env packages/shared/src/db/migrate.ts`. While `tsc -b` compiles the migration runner to `dist/db/migrate.js`, executing the compiled runner inside an isolated container without development tooling has not yet been established as a standalone release-phase job.

---

### 3. Documentation & Diagram Tooling
- **Status**: Informational.
- **Description**: Architecture and schema diagrams in `docs/HLD.md` and `docs/LLD.md` are authored using Mermaid (`erDiagram`, `flowchart`, `sequenceDiagram`). These diagrams are manually validated during documentation review and rendered by GitHub/markdown viewers, but are not machine-validated or linted by a headless CLI (such as `@mermaid-js/mermaid-cli`) in the CI pipeline. Syntax regressions can only be caught during visual inspection.

---

### 4. Registration-Time SSRF Validation is Advisory Only
- **Status**: By Design (Architectural Invariant 5).
- **Description**: Validating endpoint URLs during registration (`POST /v1/endpoints` and `PATCH /v1/endpoints/:id`) using `validateEndpointUrl` is strictly **advisory**. It rejects obvious private IP ranges, loopback hosts, sensitive ports, and invalid URL schemes to provide fast UX feedback.
- **Threat**: DNS Rebinding. An attacker can register a domain resolving to a valid public IP during registration, but configure their authoritative nameserver with a 0-second TTL to return `169.254.169.254` (cloud metadata) or `127.0.0.1` upon subsequent lookups.
- **Requirement**: Invariant 5 mandates that the Day 4 outbound delivery client MUST re-resolve DNS immediately prior to socket connection and validate the target IP against `isAddressAllowed` on every outbound HTTP request.

---

### 5. Zod Collection Parsing & Memory Consumption (GHSA-mrhx-c7xc-m3w5)
- **Status**: Mitigated via Fastify Ingestion Body Limits.
- **Description**: In Zod 3.x, schema parsing on collections (e.g. `z.array(ItemSchema).max(N)`) evaluates elements sequentially and allocates error objects before evaluating `.max(N)`. Submitting large arrays of invalid items could cause elevated memory consumption.
- **Mitigation**: Fastify enforces strict HTTP body limits: a global default `bodyLimit` of 64 KB (65,536 bytes) and a route-level `bodyLimit` of 32 KB (32,768 bytes) on `PUT /v1/endpoints/:id/subscriptions`. Oversized payloads are aborted by Fastify with HTTP 413 Payload Too Large before JSON parsing or Zod schema validation ever executes.
