# HookRelay: Load Testing

## 1. Objectives
The HookRelay load testing harness evaluates end-to-end performance and latency under burst and sustained conditions:
- **Ingestion Throughput**: Validate ingestion of 10,000+ events/sec on `POST /events`.
- **Relay & Dispatch Latency**: Measure time from outbox record insertion to customer endpoint delivery (p50, p95, p99).
- **Isolation Verification**: Verify that a degraded or stalled mock subscriber endpoint (simulating 10s latency or 500 error storms) does not increase delivery latencies for other subscribers or tenants (Invariant 7).
- **Queue Backpressure**: Verify RabbitMQ queue depth stability under traffic spikes.

## 2. Methodology & Tooling
- **K6 / Autocannon**: Generates synthetic multi-tenant event batches with valid HMAC headers.
- **Mock Webhook Receiver**: High-concurrency HTTP sink recording incoming request timestamps and validating HMAC signatures.
- **Metrics Tracked**:
  - Ingestion response latency (`apps/api`)
  - Outbox relay lag (PostgreSQL `outbox` table creation time vs. published time)
  - Delivery roundtrip time (from event publication to HTTP response acknowledgement)
