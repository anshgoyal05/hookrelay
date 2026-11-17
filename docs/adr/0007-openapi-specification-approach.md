# 0007: OpenAPI Specification Approach

## Context
HookRelay exposes REST APIs for tenant administration, API key management, endpoint registration, and event publishing. We need to maintain an accurate OpenAPI 3.1 specification for API consumers, dashboard integrations, and documentation generation. We must decide whether to hand-author the specification or generate it programmatically using a library.

## Options Considered

### Option 1: Hand-Authored `docs/openapi.yaml`
- Author the OpenAPI 3.1 document directly in YAML.
- *Pros*: Zero external dependencies, full control over descriptions, examples, and RFC 7807 problem details representations.
- *Cons*: Risk of specification drift from runtime Zod schemas if not validated by automated assertions in CI.

### Option 2: Derive via `@asteasolutions/zod-to-openapi`
- Programmatically generate the OpenAPI document from extended Zod schemas.
- *Pros*: Single source of truth for runtime validation and documentation.
- *Cons*: Introduces a new third-party dependency into the monorepo.

### Option 3: Fastify Swagger Plugin (`@fastify/swagger` + `@fastify/swagger-ui`)
- Fastify official plugins serving dynamic documentation and Swagger UI at runtime.
- *Pros*: Interactive Swagger UI directly hosted on the API server.
- *Cons*: Adds ~3.6 MB of dependencies and assets to the production runtime binary.

## Decision
We choose **Option 1: Hand-Authored `docs/openapi.yaml`**.
- Eliminates unnecessary external dependencies and keeps our build pipeline fast and lightweight.
- CI tests validate that all exposed routes and response models conform to the OpenAPI specification.

## Consequences
- **Positive**: Zero new dependencies, zero runtime bloat, portable spec file.
- **Negative**: Route schema additions require manually updating `docs/openapi.yaml`.

## What would make us revisit this
- If the endpoint count grows to dozens of resources where manual synchronization becomes error-prone.

## My reasoning
<!-- To be filled in by developer -->
