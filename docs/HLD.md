# HookRelay: High-Level Design (HLD)

## 1. Problem Statement
Modern distributed platforms require event-driven outbound webhook systems to notify customer and partner services of business events (e.g., payments, account updates, shipments). However, implementing outbound webhooks directly inside application monoliths or microservices introduces severe architectural risks:

1. **Dual-Write Vulnerability & Event Loss:** Storing an internal business change in a relational database while simultaneously publishing an HTTP request or queue message leads to partial failure states (database commits but network publish fails, or vice versa).
2. **Head-of-Line (HoL) Blocking:** External subscriber endpoints have wildly unpredictable latencies and availability. A single slow subscriber (e.g., lingering for 15 seconds before timing out) can exhaust application thread and connection pools, degrading core business transactions and stalling deliveries to healthy subscribers.
3. **Security & Server-Side Request Forgery (SSRF):** Allowing arbitrary tenant-configured webhook URLs opens internal infrastructure, cloud metadata endpoints (`169.254.169.254`), and loopback addresses to SSRF, private network scanning, and DNS rebinding attacks.
4. **Delivery Guarantees & Duplicate Management:** Over unreliable public networks, network timeouts leave publishers uncertain whether a destination received an event. Without disciplined at-least-once delivery, cryptographic signing, and consumer idempotency guidelines, data inconsistency and duplicate processing bugs proliferate.
5. **Observability & Operational Burden:** Tenants and their customers require granular, searchable, replayable delivery logs with status codes, latency timings, and error snippets without burdening core application databases.

HookRelay solves these challenges as a dedicated, multi-tenant outbound webhook engine. A tenant backend publishes an event once; HookRelay durably records it, cryptographically signs it, fans it out to all subscribed endpoints, isolates traffic, handles automated retries with backoff, and maintains a searchable audit log.

---

## 2. Requirements

### Functional Requirements
- **Event Ingestion:** High-throughput, authenticated endpoint (`POST /events`) validating tenant API keys, payloads, and optional idempotency keys.
- **Subscription Fan-Out:** Automatic matching and routing of ingested events to all active subscriber endpoints by exact event type or wildcard (`*`).
- **Cryptographic Signing:** Standardized HMAC-SHA256 signature computation over verbatim wire bytes, delivered via HTTP headers, with zero-downtime secret rotation support.
- **Reliable Dispatch & Tiered Retries:** At-least-once delivery guarantee with automated exponential backoff and randomized jitter across tiered retry queues.
- **Dead-Letter Queue (DLQ) & Manual Replay:** Unrecoverable deliveries transition to `dead`; tenants can trigger manual replay via API or dashboard.
- **Delivery Audit Log:** Searchable log of deliveries and attempts containing HTTP status, latency, error details, and truncated response snippets.
- **Tenant Isolation:** Every tenant's subscriptions, secrets, deliveries, and query boundaries are strictly isolated.

### Non-Functional Requirements
- **Latency Target:** p95 first-attempt dispatch latency $\le 2.0\text{ seconds}$ from HTTP ingestion acknowledgment to initial external HTTP call.
- **Availability:** $99.95\%$ uptime for the ingestion API (`apps/api`).
- **Durability:** Zero event loss once `POST /events` returns `202 Accepted` / `201 Created`. Events and outbox entries are committed to PostgreSQL WAL before acknowledgment.
- **Security:** Strict SSRF protection on all outbound requests (pre- and post-DNS resolution validation), zero-secret logging, and hashed API key storage.
- **Isolation (No HoL Blocking):** A completely degraded or stalled endpoint must never slow down deliveries to other endpoints or tenants.

---

## 3. Back-of-the-Envelope Capacity Estimation

### Given Parameters
- **Active Tenants:** $100$
- **Daily Ingestion Volume:** $10,000,000\text{ events/day}$
- **Average Fan-Out Factor:** $3\text{ endpoints per event}$
- **Total Deliveries/Day:** $10\text{M} \times 3 = 30,000,000\text{ deliveries/day}$
- **Latency Target:** First-attempt p95 delivery latency $\le 2.0\text{s}$

### Explicit Assumptions (Unmeasured Model Inputs)
> [!NOTE] Unmeasured Assumptions
> - **Peak Concentration Ratio (70% in 8-hour window):** We assume 70% of daily event volume arrives within an 8-hour peak business window (28,800 seconds). This 70% fraction and 8-hour window are unmeasured assumptions.
> - **Payload Size:** Average raw JSON payload size is $2\text{ KB}$; maximum allowed payload size is $256\text{ KB}$ (Day 3 events route).
> - **Retry Overhead Rate (12.5% of deliveries):** We assume retry attempts equal 12.5% of total deliveries (e.g. 5% failure rate averaging 2.5 attempts before terminal success or dead-lettering, generating 3.75M retries/day across 30M deliveries). This 12.5% retry rate is an unmeasured assumption.
> - **External Endpoint Latency:** External destination servers respond with a p50 latency of $250\text{ms}$ and p95 latency of $1,500\text{ms}$. Hard outbound timeout is capped at $5.0\text{s}$.

### Calculated Throughput & Derivation (820 req/s Peak)
The peak dispatch capacity of HookRelay is derived directly from the parameters and assumptions above:
1. **Total Daily Deliveries:**
   $$10\text{M events/day} \times \text{fan-out } 3 = 30\text{M deliveries/day}$$
2. **Peak Ingestion Rate:**
   Assuming 70% of daily traffic arrives within an 8-hour peak window ($28,800\text{ s}$):
   $$\frac{7\text{M events}}{28,800\text{ s}} \approx 243\text{ events/s}$$
3. **Peak First-Attempt Dispatch Rate:**
   $$243\text{ events/s} \times \text{fan-out } 3 = 729\text{ first attempts/s}$$
4. **Peak Retry Rate:**
   Retries are assumed at 12.5% of deliveries ($3.75\text{M retries/day}$). Assuming 70% of retries also execute within the peak window:
   $$\frac{3.75\text{M} \times 0.70}{28,800\text{ s}} = \frac{2,625,000}{28,800\text{ s}} \approx 91.1\text{ retries/s} \approx \text{about } 91\text{/s}$$
5. **Total Peak Outbound Delivery Throughput:**
   $$729\text{ first attempts/s} + 91\text{ retries/s} \approx \text{about } 820\text{/s (HTTP req/s)}$$

During peak load, HookRelay must sustain approximately **820 outbound HTTP req/s** across its worker pool while transitioning delivery lifecycle rows (`deliveries` status: `pending` $\to$ `in_flight` $\to$ `succeeded` / `failed` / `dead`, with `next_attempt_at` backoff scheduling).

### Network Bandwidth
- **Inbound Ingestion Bandwidth:**
  - Peak: $243\text{ events/sec} \times 2\text{ KB} \approx 486\text{ KB/s} \approx 3.9\text{ Mbps}$
- **Outbound Delivery Bandwidth:**
  - Peak: $820\text{ requests/sec} \times 2\text{ KB} \approx 1.64\text{ MB/s} \approx 13.1\text{ Mbps}$
  - *Result:* Bandwidth requirements are modest and easily sustained by standard cloud network interfaces.

### Storage Capacity (PostgreSQL 16)
- **`events` Table:**
  - Row size: UUIDs ($32\text{B}$) + type ($32\text{B}$) + raw payload ($2\text{ KB}$) + parsed JSONB ($1.2\text{ KB}$ compressed) + timestamps/idempotency key ($64\text{B}$) + overhead $\approx 3.4\text{ KB/row}$.
  - Daily: $10\text{M} \times 3.4\text{ KB} \approx 34\text{ GB/day}$.
- **`outbox` Table:**
  - Ephemeral rows; deleted or marked published within $<500\text{ms}$. Steady-state size is $<50\text{ MB}$.
- **`deliveries` Table:**
  - Row size: IDs ($64\text{B}$) + status/timestamps ($64\text{B}$) + error metadata ($128\text{B}$) $\approx 256\text{ B/row}$.
  - Daily: $30\text{M} \times 256\text{ B} \approx 7.68\text{ GB/day}$.
- **`delivery_attempts` Table (Monthly Partitioned):**
  - Row size: IDs/attempt_no ($48\text{B}$) + timings/status ($32\text{B}$) + response snippet ($256\text{B}$ avg) $\approx 336\text{ B/row}$.
  - Daily: $33.75\text{M} \times 336\text{ B} \approx 11.34\text{ GB/day}$.
- **Indexes & WAL Overhead:** $\approx 30\%$ of table data $\approx 16\text{ GB/day}$.
- **Total Storage Inflow:** $\approx 69\text{ GB/day} \approx 2.07\text{ TB/month}$.
- **Retention Strategy:** `delivery_attempts` partitions and raw `events` older than 90 days are purged or offloaded to object storage, capping steady-state operational database size at $\approx 6.2\text{ TB}$.

### Worker Sizing & Concurrency (Little's Law)
Using Little's Law ($L = \lambda \times W$):
- At peak dispatch rate $\lambda = 820\text{ req/sec}$ and average endpoint latency $W = 0.5\text{sec}$:
  $$L = 820 \times 0.5 = 410\text{ concurrent outbound HTTP sockets}$$
- Under degraded conditions where slow endpoints average $W = 2.0\text{sec}$:
  $$L = 820 \times 2.0 = 1,640\text{ concurrent outbound HTTP sockets}$$
- A Node.js worker pool of 4–8 worker instances (each comfortably maintaining 250–400 non-blocking event-loop HTTP connections with `undici`/`http.Agent`) easily handles peak concurrency with ample headroom.

---

## 4. System Architecture & Component Diagram

HookRelay decouples the synchronous ingestion path from asynchronous fan-out and delivery using the Transactional Outbox pattern and message queues.

```mermaid
flowchart TD
    subgraph Ingestion ["Ingestion Layer"]
        TB["Tenant Backend"] -->|"POST /events (API Key)"| API["apps/api (Fastify)"]
    end

    subgraph Storage ["Durable Storage (PostgreSQL 16)"]
        PG_EVENTS[("events")]
        PG_OUTBOX[("outbox")]
        PG_DELIVERIES[("deliveries")]
        PG_ATTEMPTS[("delivery_attempts (Partitioned)")]
    end

    subgraph Relay ["Outbox Relay Engine"]
        API -->|"1. Atomically writes event + outbox"| PG_EVENTS
        API -.->|"1. Atomically writes event + outbox"| PG_OUTBOX
        RELAY["apps/worker (Outbox Relay)"] -->|"2. Polls outbox (SKIP LOCKED)"| PG_OUTBOX
    end

    subgraph MessageBroker ["RabbitMQ 3 Cluster"]
        EX_FANOUT["Exchange: events.fanout"]
        Q_FANOUT["Queue: event.fanout.jobs"]
        EX_DELIVERY["Exchange: deliveries.direct"]
        Q_IMM["Queue: delivery.immediate"]
        Q_RETRY1["Queue: delivery.retry.1m (TTL)"]
        Q_RETRY2["Queue: delivery.retry.15m (TTL)"]
        Q_DLQ["Queue: delivery.dlq"]
    end

    subgraph Dispatch ["Worker Dispatch Engine"]
        CONSUMER["Fan-Out Consumer"]
        WORKER["Delivery Workers (SSRF Guard + Signer)"]
        REDIS[("Redis 7 (Rate Limits & Concurrency)")]
    end

    subgraph External ["External Destinations"]
        DEST1["Customer Endpoint A"]
        DEST2["Customer Endpoint B (Slow/Failing)"]
    end

    subgraph DashboardApp ["Management & Inspection"]
        DASH["apps/dashboard"] -->|"Query logs & trigger replay"| API
    end

    RELAY -->|"3. Publishes event_id only"| EX_FANOUT
    EX_FANOUT --> Q_FANOUT
    Q_FANOUT --> CONSUMER
    CONSUMER -->|"4. Resolves subscriptions & creates deliveries"| PG_DELIVERIES
    CONSUMER -->|"5. Publishes delivery_id"| EX_DELIVERY

    EX_DELIVERY --> Q_IMM
    Q_IMM --> WORKER
    WORKER <-->|"Check endpoint concurrency"| REDIS
    WORKER -->|"Reads raw payload & secret"| PG_EVENTS
    WORKER -->|"Outbound POST (SSRF Guarded)"| DEST1
    WORKER -.->|"Outbound POST (Isolated)"| DEST2

    WORKER -->|"Logs attempt"| PG_ATTEMPTS
    WORKER -->|"Updates status"| PG_DELIVERIES
    WORKER -->|"Failed: Route to retry tier"| Q_RETRY1
    Q_RETRY1 -.->|"After TTL"| EX_DELIVERY
    Q_RETRY2 -.->|"Exhausted retries"| Q_DLQ

    API -->|"Reads delivery logs"| PG_DELIVERIES
```

---

## 5. Event Lifecycle Sequence Diagram

The complete lifecycle from event ingestion to delivery and retry:

```mermaid
sequenceDiagram
    autonumber
    participant TB as Tenant Backend
    participant API as apps/api
    participant PG as PostgreSQL 16
    participant OR as Outbox Relay
    participant RMQ as RabbitMQ
    participant FC as Fan-Out Consumer
    participant DW as Delivery Worker
    participant EP as Customer Endpoint

    Note over TB,API: Ingestion Phase (Synchronous)
    TB->>API: POST /events (Payload, Idempotency-Key, API Key)
    API->>API: Authenticate API Key via SHA-256 Prefix Index
    API->>API: Validate payload schema (Zod)
    API->>PG: BEGIN TRANSACTION
    API->>PG: INSERT INTO events (raw_payload, payload, idempotency_key)
    API->>PG: INSERT INTO outbox (event_id)
    API->>PG: COMMIT
    API-->>TB: 202 Accepted { "event_id": "evt_123" }

    Note over OR,RMQ: Relay Phase (Asynchronous)
    loop Every 50ms
        OR->>PG: SELECT event_id FROM outbox WHERE published_at IS NULL LIMIT 500 FOR UPDATE SKIP LOCKED
        OR->>RMQ: BasicPublish (Exchange: events.fanout, RoutingKey: event_id)
        OR->>PG: UPDATE outbox SET published_at = now() WHERE event_id IN (...)
    end

    Note over RMQ,FC: Fan-Out Phase
    RMQ->>FC: Deliver job (event_id)
    FC->>PG: SELECT endpoint_id FROM endpoint_subscriptions WHERE event_type = event.type
    FC->>PG: INSERT INTO deliveries (event_id, endpoint_id, status='pending')
    FC->>RMQ: BasicPublish (Exchange: deliveries.direct, payload: delivery_id)
    FC-->>RMQ: BasicAck

    Note over RMQ,EP: Dispatch & Execution Phase
    RMQ->>DW: Deliver job (delivery_id)
    DW->>PG: SELECT event.raw_payload, endpoint.url, endpoint.signing_secret FROM deliveries ...
    DW->>DW: Verify SSRF (resolve DNS, check IP against private/loopback/metadata blocks)
    DW->>DW: Compute HMAC-SHA256 signature on exact raw_payload bytes
    DW->>EP: POST url (Headers: Hookrelay-Signature, Body: raw_payload)
    alt Endpoint Responds 200 OK (< 2.0s)
        EP-->>DW: 200 OK
        DW->>PG: INSERT INTO delivery_attempts (status=200, duration_ms)
        DW->>PG: UPDATE deliveries SET status='succeeded'
        DW-->>RMQ: BasicAck
    else Endpoint Fails (500 Error / Timeout)
        EP-->>DW: 500 Internal Server Error (or Timeout)
        DW->>PG: INSERT INTO delivery_attempts (status=500, error)
        DW->>PG: UPDATE deliveries SET status='failed', next_attempt_at=now() + 60s
        DW->>RMQ: BasicPublish (Queue: delivery.retry.1m, payload: delivery_id)
        DW-->>RMQ: BasicAck
    end
```

---

## 6. Failure Modes & Resilience Matrix

| Failed Component | Immediate Impact | Detection Mechanism | System Behavior & Self-Healing | Data Loss Risk |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL Down** | Ingestion API rejects incoming events (`503 Service Unavailable`). Outbox relay and workers pause. | `/readyz` probe fails; database connection pool healthcheck triggers alerts. | Fastify rejects traffic cleanly with RFC 7807 problem details; tenants retry client-side using idempotency keys. On DB recovery, outbox relay resumes processing unprocessed rows. | **Zero**. In-flight transactions rollback cleanly. |
| **RabbitMQ Down** | Ingestion API continues accepting events and writing to Postgres `events` + `outbox`. Relay and delivery paused. | Heartbeat disconnect; RabbitMQ healthcheck (`rabbitmq-diagnostics ping`) fails. | Outbox buffer absorbs incoming load in PostgreSQL. Queues do not lose messages (durable exchanges + persistent messages). When RabbitMQ recovers, relay drains the backlog. | **Zero**. PostgreSQL is the single source of truth. |
| **Redis Down** | Concurrency limiting and temporary rate limits degrade to local in-memory fallback limits or bypass. | Redis `PING` timeout in `/readyz` and worker lifecycle. | System fails open or applies static in-memory concurrency bounds per worker node. Webhook delivery continues. | **Zero**. Redis stores ephemeral state only. |
| **Outbox Relay Process Crashes** | Ingestion proceeds normally; queue publishing pauses; delivery lag increases. | Process supervisor (systemd / Kubernetes pod liveness) detects crash; queue depth metrics drop. | Supervisor restarts relay process. On reboot, relay queries `outbox WHERE published_at IS NULL` and resumes publishing without missing events. | **Zero**. Uncommitted rows remain in PostgreSQL. |
| **Delivery Worker Node Crashes Mid-HTTP Call** | An in-flight webhook HTTP call is cut off or unacknowledged in RabbitMQ. | Node unresponsiveness; RabbitMQ consumer channel closes; un-acked message re-queued. | RabbitMQ redelivers `delivery_id` to another active worker. The new worker fetches the delivery, re-executes, and completes the attempt (Invariant 1: At-least-once). | **Zero**. Destination endpoint handles duplicate idempotently via HMAC signature and delivery ID. |
| **Subscriber Endpoint Down or Slow (e.g. 10s latency)** | Single destination endpoint fails or stalls. | Worker socket timeout ($5\text{s}$ cap); non-2xx status code recorded in `delivery_attempts`. | Endpoint concurrency limiter in Redis caps concurrent calls to that endpoint. Outbound call aborts at timeout, releasing the socket. Failed delivery moves to tiered retry queue. Other endpoints are unaffected (Invariant 7). | **Zero**. Retries execute exponentially up to max attempts. |
| **Malicious / Internal Destination URL (SSRF)** | Attacker registers webhook destination targeting internal IP (`169.254.169.254`, `10.0.0.1`, `localhost`). | SSRF validator parses DNS A/AAAA records before socket connection. | Outbound call is aborted before socket connection; delivery marked `failed` with error `BLOCKED_SSRF_IP`; attempt logged with 0ms duration. | **Zero**. Internal network never receives packet. |

---

## 7. What We Deliberately Do Not Build
To keep HookRelay robust, secure, and focused on its core mission, the following features are explicitly out of scope:

1. **Inbound Webhook Proxying:** HookRelay is strictly an **outbound** webhook platform. We do not provide ingress endpoints to receive webhooks from third-party services (e.g., Stripe, Shopify) on behalf of tenants.
2. **"Exactly-Once" Delivery Guarantees:** Network unreliability makes exactly-once delivery physically impossible without two-phase commit on public HTTP endpoints. We guarantee **at-least-once** delivery and provide idempotency headers and unique delivery IDs for consumer deduplication.
3. **Arbitrary In-Flight Payload Transformations:** We do not evaluate arbitrary JavaScript, Lua, or jq expressions to transform payloads per endpoint. Events are delivered with the exact raw byte sequence published by the tenant (preserving cryptographic signature integrity).
4. **Synchronous Direct Dispatch:** Ingestion never dispatches HTTP calls synchronously within the `POST /events` request cycle. Doing so couples ingestion latency to external network conditions and violates Invariant 7.
5. **Long-Term Cold Data Warehousing:** HookRelay is not a permanent data lake. Partitioned delivery logs older than 90 days are pruned or archived. Customers requiring multi-year compliance audits should stream delivery logs to cold storage (e.g., S3, BigQuery) via log export pipelines.
6. **Bespoke SDK Code Generators:** We do not build or maintain client SDK generators. Standard HTTP clients and cryptographic HMAC libraries readily verify HookRelay deliveries in any programming language.

---

## 8. Authentication Architecture & Token Lifecycle

HookRelay enforces strict tenant-scoped authentication across all management and ingestion endpoints (Invariant 6):

### Authentication Sequence Diagram
```mermaid
sequenceDiagram
    autonumber
    actor Client as Tenant Backend / Dashboard
    participant API as Fastify API (apps/api)
    participant Auth as authMiddleware
    participant PG as PostgreSQL (api_keys)
    participant Redis as Redis (LastUsed Cache)

    Client->>API: HTTP Request (Authorization: Bearer hr_live_<prefix>_<secret>)
    API->>Auth: Validate Authorization header
    alt Header Missing, Overlength, or Malformed Prefix
        Auth->>Auth: Perform dummy SHA-256 comparison (Timing Defense)
        Auth-->>Client: 401 Unauthorized (urn:hookrelay:problem:unauthorized)
    else Structured Key Header Valid
        Auth->>PG: SELECT id, tenant_id, key_hash, revoked_at FROM api_keys WHERE key_prefix = $1
        alt Prefix Unknown (0 Rows)
            Auth->>Auth: Perform dummy constant-time comparison (Timing Defense)
            Auth-->>Client: 401 Unauthorized (urn:hookrelay:problem:unauthorized)
        else Prefix Found in DB
            Auth->>Auth: crypto.timingSafeEqual(key_hash, sha256(secret))
            alt Hash Mismatch or revoked_at IS NOT NULL
                Auth-->>Client: 401 Unauthorized (urn:hookrelay:problem:unauthorized)
            else Valid, Active Key
                Auth->>Auth: Attach request.tenantId and request.keyId
                Auth->)Redis: Asynchronously update last_used_at (Throttled to <= 1/min)
                Auth->>API: Proceed to tenant-scoped route handler
                API-->>Client: 200/201/204 Success Response
            end
        end
    end
```

### Key Lifecycle
1. **Bootstrap Generation:** The root tenant and initial key are generated via `POST /v1/admin/tenants` (guarded by `ADMIN_TOKEN`).
2. **Tenant Key Provisioning:** Tenants create additional keys via `POST /v1/api-keys`. High-entropy 256-bit secrets are generated with `hr_live_<16_hex_prefix>_<64_hex_secret>`. The plaintext secret is displayed strictly **once** and never stored.
3. **Storage & Verification:** The 16-hex prefix is indexed for $O(1)$ lookups; the secret is stored exclusively as a SHA-256 hash. Authentication uses `crypto.timingSafeEqual`.
4. **Throttled Usage Tracking:** To avoid database write exhaustion on every API tick, `last_used_at` updates are cached in Redis and throttled to at most once per minute per key.
5. **Revocation & Anti-Lockout Guard:** Keys are soft-revoked via `DELETE /v1/api-keys/:id` (`revoked_at = now()`). A tenant cannot revoke its last remaining active key without explicitly providing `?force=true`, evaluated in an atomic transaction locking the tenant row.

---

## 9. Endpoint Resource Model & Secret Management

### Resource Model
- **Endpoint:** Represents a subscriber webhook destination URL.
  - Fields: `id` (UUID), `tenant_id` (UUID), `url` (normalized HTTPS/HTTP href), `status` (`active`, `paused`, `disabled`), `description`, `concurrency_limit` (1–100), `version` (optimistic locking counter), `created_at`, `updated_at`, `deleted_at`.
- **Signing Secrets:**
  - Format: `whsec_` + 32 random bytes in base64.
  - Encryption at Rest: AES-256-GCM using `ENCRYPTION_KEY` from the environment.
  - Additional Authenticated Data (AAD): The endpoint UUID is bound as GCM AAD, preventing cross-row ciphertext substitution.
  - Storage format: `v1:k1:<iv_hex>:<tag_hex>:<ciphertext_hex>`.
- **Zero-Downtime Secret Rotation:**
  - `POST /v1/endpoints/:id/rotate-secret` generates a new active secret returned once.
  - The previous secret is retained in `previous_secret` with a configurable expiration window (`previous_secret_expires_at`, default 24h).
  - Outbound delivery workers (Day 4) sign with both active and unexpired previous secrets during rotation windows.
  - Rapid double-rotations overwrite the intermediate previous secret and refresh the expiration; no expired secret is ever retained.
- **Subscriptions:**
  - Managed via `PUT /v1/endpoints/:id/subscriptions` as an atomic set replacement.
  - Supports validated free-form event types (`^[a-z0-9]{1,64}(\.[a-z0-9_-]{1,64})*$`) or wildcard (`*`). Wildcards cannot be mixed with specific event types.

---

## 10. Known Limitations

1. **Forward-Only Keyset Pagination:** Keyset cursor pagination on endpoints operates strictly forward (`ORDER BY created_at DESC, id DESC`). Bidirectional or backward cursor traversal is not implemented.
2. **Opaque Keyset Cursors:** Cursors encode `{ createdAt: string, id: string }` with microsecond precision directly from PostgreSQL. Modifying or decoding/re-encoding cursors client-side will trigger a validation error.
3. **Irreversible Soft Deletion:** Deleting an endpoint (`DELETE /v1/endpoints/:id`) permanently disables delivery, scrubs all stored signing secrets to `NULL`, and drops subscriptions. Soft-deleted endpoints cannot be reactivated; a new endpoint must be created.
4. **Single Previous Secret Window:** Secret rotation supports exactly one previous active secret during the grace window. If a tenant executes two rotations in rapid succession, only the latest previous secret remains valid.
5. **Advisory Registration-Time URL Validation:** URL validation at endpoint registration defends against immediate misconfigurations and initial SSRF attempts. However, due to DNS rebinding and TTL expiry, connect-time validation in delivery workers (Day 4) is mandatory.
6. **Usage Timestamp Granularity:** Because `last_used_at` updates for API keys are throttled to once per minute via Redis/memory, recorded timestamps reflect approximate activity windows rather than exact per-request arrival times.
