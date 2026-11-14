# 0002: Webhook Payload Byte Preservation for Cryptographic Signing

## Context
HookRelay receives webhook events from customer backends over HTTP, verifies/signs them using HMAC-SHA256 with the destination endpoint's shared secret, and delivers them to customer endpoints.
Subscribers verify the payload signature by computing `HMAC-SHA256(secret, raw_body)` and comparing it against the header signature.

A critical hazard arises if HookRelay parses incoming JSON payloads and stores them solely as PostgreSQL `JSONB`:
- `JSONB` is a decomposed binary format that normalizes JSON representations: it discards insignificant whitespace, strips duplicate keys, reorders object keys alphabetically, and normalizes floating point representations (e.g. `1.0` becomes `1`).
- If HookRelay re-serializes `JSONB` to string prior to computing the HMAC signature, the resulting byte sequence will not match what the publisher submitted or what the subscriber expects if forwarded verbatim.
- Even if HookRelay serializes the `JSONB` and sends that re-serialized body on the wire, subtle floating point formatting, Unicode escape variations, or key order can trigger signature verification failures in subscriber SDKs expecting byte-exact transport.

## Options Considered
1. **Mandate Canonical JSON (RFC 8785 / JCS) on Ingestion and Delivery**:
   - Parse JSON on ingress, serialize to RFC 8785 canonical format, sign and transmit the canonical bytes.
   - *Pros*: Single deterministic representation across all systems.
   - *Cons*: High CPU overhead on every event; forces every customer and third-party webhook destination to implement RFC 8785 canonicalization before verifying signatures, breaking drop-in compatibility with standard HMAC webhook receivers (e.g., Stripe/GitHub-style signature verification).
2. **Store Only Plain Text / Raw Bytes (No JSONB)**:
   - Store incoming payload as a single `raw_payload TEXT` or `BYTEA` column.
   - *Pros*: Guaranteed byte fidelity; zero normalization issues.
   - *Cons*: Disables PostgreSQL server-side JSON querying, JSON schema checks, payload inspection in dashboards, and indexing on nested properties.
3. **Dual Representation: Immutable Raw Payload and Queryable JSONB**:
   - Store both `raw_payload TEXT NOT NULL` (the exact byte sequence read directly from the HTTP request body) and `payload JSONB NOT NULL` (parsed JSON) in the `events` table.
   - Cryptographic signing always signs the UTF-8 bytes of `raw_payload`, and outbound delivery sends `raw_payload` directly on the wire.
   - *Pros*: 100% byte fidelity for signing and transmission. Fastify and Postgres retain full querying, filtering, and inspection capabilities over `payload JSONB`. Standard drop-in HMAC verification works seamlessly with any standard webhook consumer.
   - *Cons*: Additional storage overhead for storing both text and binary JSON. (Mitigated: PostgreSQL compresses large TOAST columns automatically).

## Decision
We choose **Option 3: Dual Representation (Immutable Raw Payload and Queryable JSONB)**.
- `apps/api` captures the exact raw HTTP request body string during ingestion and stores it in `events.raw_payload`.
- `apps/api` validates the JSON structure with Zod and stores the parsed representation in `events.payload` (`JSONB`).
- `apps/worker` signs and transmits `raw_payload` verbatim.

## Consequences
- **Positive**: Signature verification never fails due to whitespace, key ordering, or number representation differences. Consumers can use standard HMAC SHA-256 verification without specialized JSON canonicalization.
- **Negative**: Increased disk footprint per event. For typical event payloads (<10 KB), the storage cost is negligible compared to the reliability of delivery and verification.

## What would make us revisit this
- If event payload sizes average in the tens of megabytes, creating significant database storage bloat that warrants offloading raw payloads to blob storage (e.g. S3) with pre-signed URLs.

## My reasoning
<!-- To be filled in by developer -->
