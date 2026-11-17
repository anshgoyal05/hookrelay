import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import { Writable } from "node:stream";
import {
  runMigrations,
  createLogger,
  LastUsedThrottler,
  decryptSigningSecret,
  PROBLEM_TYPES,
} from "@hookrelay/shared";
import { buildServer } from "../src/server.js";

const ADMIN_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0";
const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

describe("apps/api - Endpoint Management API (CRUD & Lifecycle)", () => {
  let mainPool: pg.Pool;
  let testDbName: string;
  let testPool: pg.Pool;
  const capturedLogs: string[] = [];
  let testApp: ReturnType<typeof buildServer>;

  let _tenantAId: string;
  let tenantAApiKey: string;
  let _tenantBId: string;
  let tenantBApiKey: string;

  beforeAll(async () => {
    // 1. Create throwaway database
    const baseConnStr =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/hookrelay";
    const url = new URL(baseConnStr);

    mainPool = new pg.Pool({ connectionString: baseConnStr });
    testDbName = `hookrelay_test_endpoints_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    await mainPool.query(`CREATE DATABASE ${testDbName}`);

    // 2. Connect and run migrations
    url.pathname = `/${testDbName}`;
    testPool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(testPool);

    // 3. Logger stream capturing logs
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs.push(chunk.toString());
        callback();
      },
    });

    const logger = createLogger({ name: "test-endpoints", level: "info" }, logStream);

    const throttler = new LastUsedThrottler({
      redisClient: null,
      db: testPool,
      logger,
      throttleSeconds: 60,
    });

    // 4. Build API server
    testApp = buildServer({
      pgPool: testPool,
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => true },
      logger,
      throttler,
      adminToken: ADMIN_TOKEN,
      encryptionKey: TEST_ENCRYPTION_KEY,
      maxEndpointsPerTenant: 50,
      allowHttp: false,
    });

    // 5. Bootstrap Tenant A and Tenant B
    const bootstrapA = await testApp.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "Tenant A" },
    });
    const parsedA = bootstrapA.json();
    _tenantAId = parsedA.tenant.id;
    tenantAApiKey = parsedA.api_key.key;

    const bootstrapB = await testApp.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "Tenant B" },
    });
    const parsedB = bootstrapB.json();
    _tenantBId = parsedB.tenant.id;
    tenantBApiKey = parsedB.api_key.key;
  });

  afterAll(async () => {
    await testApp.close();
    await testPool.end();
    await mainPool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await mainPool.end();
  });

  describe("1. POST /v1/endpoints (Create)", () => {
    it("creates an endpoint, generates signing secret with whsec_ prefix, and returns 201 with Location header", async () => {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {
          url: "https://example.com/webhook?token=abc123",
          description: "Primary webhook receiver",
          concurrency_limit: 15,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.url).toBe("https://example.com/webhook?token=abc123");
      expect(body.status).toBe("active");
      expect(body.description).toBe("Primary webhook receiver");
      expect(body.concurrency_limit).toBe(15);
      expect(body.version).toBe(1);
      expect(res.headers.location).toBe(`/v1/endpoints/${body.id}`);

      // Secret verification
      expect(body.signing_secret).toMatch(/^whsec_[A-Za-z0-9+/=]{44}$/);

      // Verify DB storage: must be encrypted, must NOT start with whsec_, and must decrypt back with endpointId as AAD
      const dbRow = await testPool.query(
        "SELECT signing_secret FROM endpoints WHERE id = $1",
        [body.id],
      );
      const storedCiphertext = dbRow.rows[0].signing_secret;
      expect(storedCiphertext.startsWith("whsec_")).toBe(false);
      expect(storedCiphertext.startsWith("v1:k1:")).toBe(true);

      const decrypted = decryptSigningSecret(storedCiphertext, TEST_ENCRYPTION_KEY, body.id);
      expect(decrypted).toBe(body.signing_secret);
    });

    it("rejects SSRF destinations (loopback, private, metadata, and single-label)", async () => {
      const targets = [
        "https://127.0.0.1/hook",
        "https://10.0.0.1/hook",
        "https://169.254.169.254/latest/meta-data",
        "https://localhost/hook",
        "https://intranet/hook",
      ];

      for (const badUrl of targets) {
        const res = await testApp.inject({
          method: "POST",
          url: "/v1/endpoints",
          headers: { authorization: `Bearer ${tenantAApiKey}` },
          payload: { url: badUrl },
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.type).toBe(PROBLEM_TYPES.VALIDATION_ERROR);
        expect(body.detail).toContain("URL not permitted");
      }
    });

    it("rejects invalid concurrency limits and invalid parameters", async () => {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {
          url: "https://example.com/hook",
          concurrency_limit: 0, // must be >= 1
        },
      });

      expect(res.statusCode).toBe(400);

      const res2 = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {
          url: "https://example.com/hook",
          concurrency_limit: 101, // must be <= 100
        },
      });

      expect(res2.statusCode).toBe(400);
    });
  });

  describe("2. Tenant Quota Concurrency (Invariant 6 + Quota Limit)", () => {
    it("locks tenant row and strictly enforces 50 endpoint quota under concurrent creates", async () => {
      // First, create a new isolated tenant to test quota accurately
      const bootstrapRes = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: "Quota Tenant" },
      });
      const quotaApiKey = bootstrapRes.json().api_key.key;
      const quotaTenantId = bootstrapRes.json().tenant.id;

      // Seed 45 endpoints directly via DB to start at 45
      for (let i = 0; i < 45; i++) {
        await testPool.query(
          `INSERT INTO endpoints (
            tenant_id, url, signing_secret, status, description, concurrency_limit, version
          ) VALUES ($1, $2, 'v1:k1:test', 'active', 'Seed', 10, 1)`,
          [quotaTenantId, `https://example.com/seed/${i}`],
        );
      }

      // Launch 10 simultaneous parallel creation requests
      const promises = Array.from({ length: 10 }, (_, i) =>
        testApp.inject({
          method: "POST",
          url: "/v1/endpoints",
          headers: { authorization: `Bearer ${quotaApiKey}` },
          payload: { url: `https://example.com/parallel/${i}` },
        }),
      );

      const responses = await Promise.all(promises);
      const successes = responses.filter((r) => r.statusCode === 201);
      const quotaFailures = responses.filter((r) => r.statusCode === 409);

      // Exactly 5 should succeed and 5 should hit 409
      expect(successes.length).toBe(5);
      expect(quotaFailures.length).toBe(5);

      for (const failRes of quotaFailures) {
        const body = failRes.json();
        expect(body.type).toBe("urn:hookrelay:problem:quota-exceeded");
      }

      // Verify total in database is exactly 50
      const countRes = await testPool.query(
        "SELECT count(*)::int AS count FROM endpoints WHERE tenant_id = $1 AND deleted_at IS NULL",
        [quotaTenantId],
      );
      expect(countRes.rows[0].count).toBe(50);
    });
  });

  describe("3. GET /v1/endpoints (List & Keyset Pagination)", () => {
    it("paginates stably with microsecond precision and tie-breaks rows created in the same millisecond", async () => {
      // Create a dedicated tenant for pagination
      const bootstrapRes = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: "Pagination Tenant" },
      });
      const pageApiKey = bootstrapRes.json().api_key.key;
      const pageTenantId = bootstrapRes.json().tenant.id;

      // Insert 6 rows with the EXACT SAME created_at timestamp
      const fixedTime = "2026-11-17 12:00:00.123456+00";
      for (let i = 0; i < 6; i++) {
        await testPool.query(
          `INSERT INTO endpoints (
            tenant_id, url, signing_secret, status, description, concurrency_limit, created_at, version
          ) VALUES ($1, $2, 'v1:k1:test', 'active', $3, 10, $4::timestamptz, 1)`,
          [pageTenantId, `https://example.com/page/${i}`, `Item ${i}`, fixedTime],
        );
      }

      // Page 1: limit 3
      const page1Res = await testApp.inject({
        method: "GET",
        url: "/v1/endpoints?limit=3",
        headers: { authorization: `Bearer ${pageApiKey}` },
      });

      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json();
      expect(page1.data.length).toBe(3);
      expect(page1.pagination.has_more).toBe(true);
      expect(page1.pagination.next_cursor).toBeDefined();

      // Ensure created_at in returned item has microsecond precision (.123456Z)
      expect(page1.data[0].created_at).toMatch(/\.123456Z$/);
      // Ensure secrets are never returned
      expect(page1.data[0].signing_secret).toBeUndefined();

      // Page 2: with cursor
      const page2Res = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints?limit=3&cursor=${encodeURIComponent(page1.pagination.next_cursor)}`,
        headers: { authorization: `Bearer ${pageApiKey}` },
      });

      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json();
      expect(page2.data.length).toBe(3);
      expect(page2.pagination.has_more).toBe(false);

      // Verify no overlap between page 1 and page 2 despite identical timestamps
      const ids1 = new Set(page1.data.map((d: { id: string }) => d.id));
      const ids2 = new Set(page2.data.map((d: { id: string }) => d.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it("returns 400 Problem Details on malformed or garbage cursor", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: "/v1/endpoints?cursor=not-valid-base64-json",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.type).toBe(PROBLEM_TYPES.VALIDATION_ERROR);
    });

    it("filters list by status", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: "/v1/endpoints?status=active",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      for (const ep of body.data) {
        expect(ep.status).toBe("active");
      }
    });
  });

  describe("4. GET /v1/endpoints/:id", () => {
    it("returns endpoint details without secret", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/get-test" },
      });
      const created = createRes.json();

      const getRes = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      expect(getRes.statusCode).toBe(200);
      const body = getRes.json();
      expect(body.id).toBe(created.id);
      expect(body.url).toBe(created.url);
      expect(body.signing_secret).toBeUndefined();
      expect(body.previous_secret).toBeUndefined();
    });

    it("validates :id format and returns 400 on bad UUID (never 500)", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: "/v1/endpoints/not-a-valid-uuid",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.VALIDATION_ERROR);
    });

    it("returns 404 when endpoint does not exist", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
    });
  });

  describe("5. PATCH /v1/endpoints/:id (Optimistic Concurrency & Updates)", () => {
    it("updates fields, re-validates URL, and bumps version", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/patch-test", concurrency_limit: 10 },
      });
      const created = createRes.json();

      const patchRes = await testApp.inject({
        method: "PATCH",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {
          url: "https://example.com/patched-url",
          description: "Updated description",
          concurrency_limit: 25,
        },
      });

      expect(patchRes.statusCode).toBe(200);
      const updated = patchRes.json();
      expect(updated.url).toBe("https://example.com/patched-url");
      expect(updated.description).toBe("Updated description");
      expect(updated.concurrency_limit).toBe(25);
      expect(updated.version).toBe(2);
      expect(updated.signing_secret).toBeUndefined();
    });

    it("rejects empty PATCH body with 400", async () => {
      const res = await testApp.inject({
        method: "PATCH",
        url: `/v1/endpoints/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.VALIDATION_ERROR);
    });

    it("rejects mismatched If-Match and body version with 400", async () => {
      const res = await testApp.inject({
        method: "PATCH",
        url: `/v1/endpoints/${crypto.randomUUID()}`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "if-match": '"1"',
        },
        payload: {
          description: "Testing",
          version: 2, // 1 vs 2 mismatch
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain("do not match");
    });

    it("enforces optimistic concurrency control: returns 409 Conflict on version mismatch", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/concurrency-test" },
      });
      const created = createRes.json();

      // Update with wrong version (expecting 1, passing 99)
      const conflictRes = await testApp.inject({
        method: "PATCH",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {
          description: "Conflict update",
          version: 99,
        },
      });

      expect(conflictRes.statusCode).toBe(409);
      const conflictBody = conflictRes.json();
      expect(conflictBody.type).toBe("urn:hookrelay:problem:conflict");
      expect(conflictBody.detail).toContain("Endpoint version conflict");
    });
  });

  describe("6. POST /v1/endpoints/:id/pause and /resume", () => {
    it("pauses and resumes an endpoint, only bumping version on actual state transition", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/pause-test" },
      });
      const created = createRes.json();
      expect(created.version).toBe(1);

      // 1. Pause: transitions active -> paused (bumps version to 2)
      const pauseRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${created.id}/pause`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(pauseRes.statusCode).toBe(200);
      const paused = pauseRes.json();
      expect(paused.status).toBe("paused");
      expect(paused.version).toBe(2);

      // 2. Pause again: already paused (idempotent, does NOT bump version)
      const pauseAgainRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${created.id}/pause`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(pauseAgainRes.statusCode).toBe(200);
      expect(pauseAgainRes.json().version).toBe(2);

      // 3. Resume: transitions paused -> active (bumps version to 3)
      const resumeRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${created.id}/resume`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(resumeRes.statusCode).toBe(200);
      const resumed = resumeRes.json();
      expect(resumed.status).toBe("active");
      expect(resumed.version).toBe(3);

      // 4. Resume again: already active (idempotent, does NOT bump version)
      const resumeAgainRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${created.id}/resume`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(resumeAgainRes.statusCode).toBe(200);
      expect(resumeAgainRes.json().version).toBe(3);
    });
  });

  describe("7. DELETE /v1/endpoints/:id (Soft Deletion & Secret Scrubbing)", () => {
    it("soft deletes endpoint, scrubs secrets to NULL, removes subscriptions, and returns 404 on repeat", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/delete-test" },
      });
      const created = createRes.json();

      // Seed a subscription
      await testPool.query(
        "INSERT INTO endpoint_subscriptions (endpoint_id, event_type) VALUES ($1, 'payment.created')",
        [created.id],
      );

      // Delete endpoint
      const deleteRes = await testApp.inject({
        method: "DELETE",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify DB row: deleted_at set, status disabled, secrets NULL
      const dbRow = await testPool.query(
        "SELECT deleted_at, status, signing_secret, previous_secret FROM endpoints WHERE id = $1",
        [created.id],
      );
      const row = dbRow.rows[0];
      expect(row.deleted_at).not.toBeNull();
      expect(row.status).toBe("disabled");
      expect(row.signing_secret).toBeNull();
      expect(row.previous_secret).toBeNull();

      // Verify subscriptions deleted
      const subRows = await testPool.query(
        "SELECT count(*)::int AS count FROM endpoint_subscriptions WHERE endpoint_id = $1",
        [created.id],
      );
      expect(subRows.rows[0].count).toBe(0);

      // Repeat DELETE must return 404 (non-idempotent delete)
      const repeatDelete = await testApp.inject({
        method: "DELETE",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(repeatDelete.statusCode).toBe(404);

      // Subsequent GET must return 404
      const getRes = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  describe("8. Tenant Isolation Matrix (Invariant 6)", () => {
    it("prevents Tenant B from accessing or manipulating Tenant A's endpoint on all routes (all return 404)", async () => {
      // Create endpoint under Tenant A
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/tenant-a-private" },
      });
      const epA = createRes.json();

      // 1. Tenant B GET by ID -> 404
      const getRes = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${epA.id}`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
      });
      expect(getRes.statusCode).toBe(404);

      // 2. Tenant B PATCH -> 404
      const patchRes = await testApp.inject({
        method: "PATCH",
        url: `/v1/endpoints/${epA.id}`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
        payload: { description: "Tampered" },
      });
      expect(patchRes.statusCode).toBe(404);

      // 3. Tenant B Pause -> 404
      const pauseRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${epA.id}/pause`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
      });
      expect(pauseRes.statusCode).toBe(404);

      // 4. Tenant B Resume -> 404
      const resumeRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${epA.id}/resume`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
      });
      expect(resumeRes.statusCode).toBe(404);

      // 5. Tenant B DELETE -> 404
      const deleteRes = await testApp.inject({
        method: "DELETE",
        url: `/v1/endpoints/${epA.id}`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
      });
      expect(deleteRes.statusCode).toBe(404);

      // Verify endpoint A is still intact and active
      const checkA = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${epA.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(checkA.statusCode).toBe(200);
      expect(checkA.json().status).toBe("active");
    });
  });

  describe("9. Safe Logging & Secret Leak Scanner", () => {
    it("never logs query parameters (e.g. ?token=abc123) in captured logs", () => {
      const logsCombined = capturedLogs.join("\n");
      expect(logsCombined.includes("token=abc123")).toBe(false);
    });
  });
});
