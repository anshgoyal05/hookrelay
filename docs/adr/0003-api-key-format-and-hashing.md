# 0003: API Key Format and Hashing Strategy

## Context
HookRelay requires a secure, high-throughput authentication mechanism for tenant API requests. Each inbound request to `POST /events` and management endpoints must be authenticated with minimal latency while protecting keys from unauthorized access, timing attacks, and database compromise.
We need to establish:
1. The structural format and string encoding of the API key (`hr_live_<prefix>_<secret>`).
2. The storage and verification mechanism (hashing vs. encryption, lookup strategy, constant-time equality).

## Options Considered

### Option 1: Base64URL-Encoded Prefix and Secret with Naive Delimiters
- Use standard `base64url` encoding for random bytes.
- Format: `hr_live_<prefix_base64url>_<secret_base64url>`.
- *Pros*: Compact string representation.
- *Cons*: `base64url` character sets contain both `_` and `-`. A naive string split on `_` breaks unpredictably whenever the random prefix or secret contains an underscore. Parsing requires complex fixed-offset slicing that fails if format parameters evolve.

### Option 2: Delimiter-Free Hexadecimal Encoding with SHA-256 Lookup
- Format: `hr_live_<prefix_hex>_<secret_hex>`.
- Characters strictly within `[0-9a-f]`. The prefix is 16 hex characters (8 bytes of entropy, $2^{64}$ space); the secret is 64 hex characters (32 bytes of cryptographically secure entropy, $2^{256}$ space).
- Storage: Database stores `key_prefix` (unique partial index where `revoked_at IS NULL`) and `key_hash` (SHA-256 hex digest of the raw key or secret). Plaintext secrets are never stored or logged (Invariant 4).
- Verification: $O(1)$ database lookup by `key_prefix`, compute SHA-256 of incoming secret, and verify using `crypto.timingSafeEqual`.
- *Pros*:
  - Native to `node:crypto` (`randomBytes(N).toString('hex')`) with zero dependencies.
  - The hex character set can never contain `_`, guaranteeing that `key.split('_')` reliably yields `['hr', 'live', prefix, secret]`.
  - SHA-256 is computationally lightweight ($<1\mu\text{s}$), eliminating CPU bottlenecks in high-throughput webhook ingestion while providing unbreakable brute-force resistance on 256 bits of entropy.
- *Cons*: Slightly longer string representation (89 characters total) compared to base62/base64.

### Option 3: Base62 Alphanumeric Encoding with Argon2 / bcrypt Hashing
- Format: `hr_live_<prefix_base62>_<secret_base62>` using characters `[0-9a-zA-Z]`.
- Storage: Hash the secret using Argon2id or bcrypt.
- *Pros*: More compact than hex; resistant to GPU attacks if low-entropy secrets were used.
- *Cons*:
  - Requires custom Base62 encoding routines or additional external dependencies.
  - Argon2/bcrypt are deliberately slow memory-hard functions (50ms–200ms per check), designed specifically for low-entropy human passwords. Running Argon2 on every inbound API call under 1,000 req/sec would completely exhaust server CPU cores and violate our p95 2.0s latency target.
  - A 256-bit cryptographically random secret has $2^{256}$ entropy, rendering dictionary attacks mathematically impossible without needing a slow KDF.

## Decision
We choose **Option 2: Delimiter-Free Hexadecimal Encoding with SHA-256 Lookup and Timing-Safe Verification**.
- Format: `hr_live_<16_hex_prefix>_<64_hex_secret>` (total length: 89 characters).
- Splitting on `_` is strictly deterministic: `prefix = parts[2]`, `secret = parts[3]`.
- Database lookup: `SELECT id, tenant_id, key_hash, revoked_at FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL`.
- Verification: Compute SHA-256 on the incoming secret, then compare against stored `key_hash` using `crypto.timingSafeEqual`.

## Consequences
- **Positive**: Single-microsecond authentication check, zero external dependencies, robust delimiter splitting, and zero risk of timing-attack leaks.
- **Negative**: Key strings are 89 characters long, which is slightly longer than compact Base62 strings but fully standard for modern API tokens (e.g., Stripe, GitHub).

## What would make us revisit this
- If tenants or internal systems require shorter token lengths, justifying a Base62 encoder.
- If regulatory compliance mandates a NIST-approved slow KDF (e.g. PBKDF2) despite the high entropy of the keys.

## My reasoning
<!-- To be filled in by developer -->
