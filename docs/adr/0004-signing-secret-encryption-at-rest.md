# 0004: Endpoint Signing Secret Encryption at Rest

## Context
HookRelay signs outbound webhook payloads using HMAC-SHA256 with an endpoint-specific shared secret. Unlike API keys (which are only verified upon receipt and can therefore be stored as one-way cryptographic hashes), outbound signing requires HookRelay workers to access the plaintext signing secret in memory to compute the signature header.
However, storing signing secrets in plaintext inside the PostgreSQL `endpoints` table creates severe exposure if database backups, read replicas, or snapshot volumes are ever compromised (violating the spirit of Invariant 4). We must establish a secure encryption-at-rest model.

## Options Considered

### Option 1: Plaintext Storage in PostgreSQL
- Store raw signing secrets directly in `endpoints.signing_secret` and `endpoints.previous_secret`.
- *Pros*: Zero operational overhead, simplest implementation.
- *Cons*: Any database dump, SQL injection read vulnerability, or unencrypted backup permanently exposes all tenant signing secrets, allowing attackers to forge arbitrary webhook signatures.

### Option 2: Application-Layer Encryption at Rest via AES-256-GCM (`ENCRYPTION_KEY` via `node:crypto`)
- HookRelay encrypts secrets at the application layer prior to database insertion using AES-256-GCM.
- Encryption key: Provided via `ENCRYPTION_KEY` environment variable (32-byte / 256-bit hexadecimal key).
- Storage format: `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>` stored in the existing `TEXT` columns (`signing_secret` and `previous_secret`).
- Cryptographic mechanism: Uses native `node:crypto` with a unique 12-byte initialization vector (IV) generated per write and a 16-byte authentication tag verifying data integrity.
- *Pros*:
  - Secrets in database dumps and logs are completely encrypted; compromised DB snapshots leak zero usable secrets.
  - Zero external dependencies or network hops; uses native Node.js crypto primitives.
  - Sub-millisecond in-memory encryption and decryption, introducing negligible latency to worker delivery pipelines.
  - Compatible with existing `TEXT` column definitions in migration `0001_initial_schema.sql` without requiring a schema change.
- *Cons*:
  - Master key is stored in the environment; master key rotation requires re-encrypting rows.

### Option 3: External Key Management Service (AWS KMS / GCP Cloud KMS / HashiCorp Vault)
- Envelope encryption or direct KMS encryption calls for every secret creation and retrieval.
- *Pros*: Hardware Security Module (HSM) backing, centralized IAM policies, automatic key rotation.
- *Cons*:
  - Adds external network roundtrips to every webhook delivery dispatch or endpoint read, directly threatening the p95 2.0s latency target.
  - Introduces cloud provider vendor lock-in or heavyweight local infrastructure dependencies (Vault), violating the boring MVP principle.

## Decision
We choose **Option 2: Application-Layer Encryption at Rest via AES-256-GCM (`ENCRYPTION_KEY` via `node:crypto`)**.
- Secrets are encrypted before SQL insertion and decrypted after database read within `packages/shared`.
- Stored as `v1:<iv>:<tag>:<ciphertext>` in the existing `TEXT` columns (`signing_secret`, `previous_secret`).
- Requires adding `ENCRYPTION_KEY` to the Zod config schema and `.env.example`.

## Consequences
- **Positive**: Complete protection against database snapshot leaks and SQL injection dumps with zero external network overhead and zero new dependencies.
- **Negative**: Key rotation requires an offline re-encryption script if `ENCRYPTION_KEY` changes.

## What would make us revisit this
- Enterprise compliance requirements specifically mandating FIPS 140-2 Level 3 HSM hardware or centralized multi-region cloud KMS key management.

## My reasoning
<!-- To be filled in by developer -->
