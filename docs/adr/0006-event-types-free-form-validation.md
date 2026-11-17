# 0006: Event Type Modeling and Validation Strategy

## Context
HookRelay matches ingested events to subscriber endpoints based on event types (e.g., `payment.success`, `user.created`). We need to determine how event types are validated, stored, and managed:
1. Should event types be strictly pre-registered in a dedicated `event_types` database table prior to publication?
2. Or should event types be free-form strings validated by a strict regex pattern on ingestion, with subscriptions subscribing directly to event patterns or wildcard (`*`)?

## Options Considered

### Option 1: Mandatory Event Type Registry Table
- Tenants must register every event type via an administrative API before publishing events or creating subscriptions. Ingestion queries `event_types` to verify validity.
- *Pros*: Catalog of approved events; prevents typos (e.g., `user.creatted`).
- *Cons*: Heavy operational friction. Developers publishing events in modern webhook architectures (e.g. Stripe, Svix, GitHub) expect to emit new event types from code without pre-provisioning metadata rows in a separate registry. Adds database read overhead to every ingestion call, degrading throughput.

### Option 2: Free-Form Event Types Validated by Strict Regex Pattern
- Ingestion validates event type strings at runtime using a strict Zod regex pattern:
  `^[a-z0-9]+([._-][a-z0-9]+)*$` (length 1 to 128 characters, lowercase alphanumeric segments delimited by single `.`, `_`, or `-`).
- Subscriptions bind to specific event type strings or wildcard `*`.
- The `event_types` table is not queried during synchronous ingestion.
- *Pros*:
  - Frictionless developer experience matching industry conventions (Stripe, GitHub, AWS EventBridge).
  - Zero database lookup overhead during `POST /events` ingestion.
  - Subscriptions can easily subscribe to specific event types or wildcard (`*`).
- *Cons*: Typos during event publishing will not be rejected if they conform to the regex structure.

### Option 3: Hybrid (Dynamic Cataloging via Free-Form Ingestion)
- Free-form validation on ingestion via regex, with background asynchronous upserts into an `event_types` catalog so the dashboard has an autocompletion list of observed event types.
- *Pros*: Low ingestion latency with good dashboard discovery.
- *Cons*: Additional asynchronous writes; complexity not needed for MVP.

## Decision
We choose **Option 2: Free-Form Event Types Validated by Strict Regex Pattern**.
- Ingestion and subscription endpoints validate event types using:
  `^[a-z0-9]{1,64}(\.[a-z0-9_-]{1,64})*$` (enforced via Zod, max 128 characters).
- Subscriptions store event types directly as validated strings (or `'*'`).
- The existing `event_types` table remains available for optional metadata/descriptions but is not a blocker for ingestion or subscription creation.

## Consequences
- **Positive**: Zero latency penalty on ingestion, high throughput, and developer-friendly event publication.
- **Negative**: Unused or mistyped event names will fan out to 0 subscribers without an explicit error if no subscription matches.

## What would make us revisit this
- If enterprise customers demand strict schema registry governance (e.g., JSON Schema / Protobuf registry) where publishing an unregistered event type must be rejected with `400 Bad Request`.

## My reasoning
<!-- To be filled in by developer -->
