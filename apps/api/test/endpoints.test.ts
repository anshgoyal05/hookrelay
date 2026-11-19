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
    const baseConnStr = process.env.DATABASE_URL;
    if (!baseConnStr) {
      throw new Error("DATABASE_URL environment variable is required to run database integration tests");
    }
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

      // 6. Tenant B rotate-secret -> 404
      const rotateRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${epA.id}/rotate-secret`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
      });
      expect(rotateRes.statusCode).toBe(404);

      // 7. Tenant B PUT subscriptions -> 404
      const putSubRes = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${epA.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
        payload: { event_types: ["*"] },
      });
      expect(putSubRes.statusCode).toBe(404);

      // 8. Tenant B GET subscriptions -> 404
      const getSubRes = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${epA.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantBApiKey}` },
      });
      expect(getSubRes.statusCode).toBe(404);

      // Verify endpoint A is still intact and active
      const checkA = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${epA.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(checkA.statusCode).toBe(200);
      expect(checkA.json().status).toBe("active");
    });

    it("returns 404 for soft-deleted endpoints across all management routes", async () => {
      // Create and delete endpoint under Tenant A
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/to-be-deleted" },
      });
      const ep = createRes.json();

      await testApp.inject({
        method: "DELETE",
        url: `/v1/endpoints/${ep.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      // Verify every route returns 404 on soft-deleted endpoint
      const routes = [
        testApp.inject({ method: "GET", url: `/v1/endpoints/${ep.id}`, headers: { authorization: `Bearer ${tenantAApiKey}` } }),
        testApp.inject({ method: "PATCH", url: `/v1/endpoints/${ep.id}`, headers: { authorization: `Bearer ${tenantAApiKey}` }, payload: { description: "Updated" } }),
        testApp.inject({ method: "POST", url: `/v1/endpoints/${ep.id}/pause`, headers: { authorization: `Bearer ${tenantAApiKey}` } }),
        testApp.inject({ method: "POST", url: `/v1/endpoints/${ep.id}/resume`, headers: { authorization: `Bearer ${tenantAApiKey}` } }),
        testApp.inject({ method: "POST", url: `/v1/endpoints/${ep.id}/rotate-secret`, headers: { authorization: `Bearer ${tenantAApiKey}` } }),
        testApp.inject({ method: "PUT", url: `/v1/endpoints/${ep.id}/subscriptions`, headers: { authorization: `Bearer ${tenantAApiKey}` }, payload: { event_types: ["*"] } }),
        testApp.inject({ method: "GET", url: `/v1/endpoints/${ep.id}/subscriptions`, headers: { authorization: `Bearer ${tenantAApiKey}` } }),
        testApp.inject({ method: "DELETE", url: `/v1/endpoints/${ep.id}`, headers: { authorization: `Bearer ${tenantAApiKey}` } }),
      ];

      const results = await Promise.all(routes);
      for (const res of results) {
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe("9. POST /v1/endpoints/:id/rotate-secret (Secret Rotation)", () => {
    it("rotates signing secret once, moves previous secret with expiration, and decrypts accurately", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/rotate-target" },
      });
      const initial = createRes.json();
      const initialSecret = initial.signing_secret;

      // Rotate secret
      const rotateRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${initial.id}/rotate-secret`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      expect(rotateRes.statusCode).toBe(200);
      const rotated = rotateRes.json();
      expect(rotated.endpoint_id).toBe(initial.id);
      expect(rotated.signing_secret).toMatch(/^whsec_[A-Za-z0-9+/=]{44}$/);
      expect(rotated.signing_secret).not.toBe(initialSecret);
      expect(rotated.previous_secret_expires_at).toBeDefined();
      expect(rotated.version).toBe(2);

      // Verify DB storage: current signing_secret is new secret, previous_secret is old secret
      const dbRow = await testPool.query(
        "SELECT signing_secret, previous_secret, previous_secret_expires_at FROM endpoints WHERE id = $1",
        [initial.id],
      );
      const row = dbRow.rows[0];

      const decryptedCurrent = decryptSigningSecret(row.signing_secret, TEST_ENCRYPTION_KEY, initial.id);
      expect(decryptedCurrent).toBe(rotated.signing_secret);

      const decryptedPrevious = decryptSigningSecret(row.previous_secret, TEST_ENCRYPTION_KEY, initial.id);
      expect(decryptedPrevious).toBe(initialSecret);
    });

    it("handles double rotation: rotating twice in a row replaces previous secret and never leaves an expired secret active", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/double-rotate" },
      });
      const ep = createRes.json();
      const secret0 = ep.signing_secret;

      // Rotation 1
      const rot1 = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${ep.id}/rotate-secret`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      const secret1 = rot1.json().signing_secret;

      // Rotation 2 immediately
      const rot2 = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${ep.id}/rotate-secret`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      const secret2 = rot2.json().signing_secret;

      expect(secret2).not.toBe(secret1);
      expect(secret1).not.toBe(secret0);

      // Verify DB row: signing_secret is secret2, previous_secret is secret1 (secret0 is gone)
      const dbRow = await testPool.query(
        "SELECT signing_secret, previous_secret, previous_secret_expires_at FROM endpoints WHERE id = $1",
        [ep.id],
      );
      const row = dbRow.rows[0];

      const decryptedCurrent = decryptSigningSecret(row.signing_secret, TEST_ENCRYPTION_KEY, ep.id);
      expect(decryptedCurrent).toBe(secret2);

      const decryptedPrevious = decryptSigningSecret(row.previous_secret, TEST_ENCRYPTION_KEY, ep.id);
      expect(decryptedPrevious).toBe(secret1);

      // Expiration must be in the future (~24 hours from now)
      const expiresAt = new Date(row.previous_secret_expires_at).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now() + 80_000 * 1000);
    });

    it("serializes concurrent rotations to leave a consistent database state", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/concurrent-rotate" },
      });
      const ep = createRes.json();

      // Launch 5 parallel rotations
      const promises = Array.from({ length: 5 }, () =>
        testApp.inject({
          method: "POST",
          url: `/v1/endpoints/${ep.id}/rotate-secret`,
          headers: { authorization: `Bearer ${tenantAApiKey}` },
        }),
      );

      const responses = await Promise.all(promises);
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.json().signing_secret).toMatch(/^whsec_/);
      }

      // Final version in DB must be exactly 6 (initial version 1 + 5 rotations)
      const dbRow = await testPool.query(
        "SELECT version, signing_secret, previous_secret FROM endpoints WHERE id = $1",
        [ep.id],
      );
      expect(dbRow.rows[0].version).toBe(6);

      // Both signing_secret and previous_secret must decrypt without error
      expect(() => {
        decryptSigningSecret(dbRow.rows[0].signing_secret, TEST_ENCRYPTION_KEY, ep.id);
      }).not.toThrow();
      expect(() => {
        decryptSigningSecret(dbRow.rows[0].previous_secret, TEST_ENCRYPTION_KEY, ep.id);
      }).not.toThrow();
    });
  });

  describe("10. Subscriptions (PUT & GET Atomicity)", () => {
    it("replaces subscription set atomically, supports wildcard, and dedupes types", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/sub-test" },
      });
      const ep = createRes.json();

      // 1. Initial subscription set with duplicate
      const putRes = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: {
          event_types: ["payment.created", "user.signup", "payment.created"],
        },
      });

      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().event_types).toEqual(["payment.created", "user.signup"]);

      // 2. GET subscriptions
      const getRes = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().event_types).toEqual(["payment.created", "user.signup"]);

      // 3. Replace with wildcard '*'
      const wildcardRes = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { event_types: ["*"] },
      });
      expect(wildcardRes.statusCode).toBe(200);
      expect(wildcardRes.json().event_types).toEqual(["*"]);

      // 4. Empty list means receives nothing
      const emptyRes = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { event_types: [] },
      });
      expect(emptyRes.statusCode).toBe(200);
      expect(emptyRes.json().event_types).toEqual([]);

      const getEmpty = await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      expect(getEmpty.json().event_types).toEqual([]);
    });

    it("rejects mixing wildcard '*' with specific event types", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/sub-wildcard-mix" },
      });
      const ep = createRes.json();

      const res = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { event_types: ["*", "payment.created"] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain("Cannot mix wildcard '*' with specific event types");
    });

    it("rejects invalid event type names and overlong names", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/sub-invalid-name" },
      });
      const ep = createRes.json();

      // Uppercase is invalid
      const res1 = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { event_types: ["Payment.Created"] },
      });
      expect(res1.statusCode).toBe(400);

      // Over 128 characters is invalid
      const res2 = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { event_types: ["a".repeat(129)] },
      });
      expect(res2.statusCode).toBe(400);
    });

    it("proves subscription replacement is atomic: failure mid-way preserves the old set intact", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/sub-atomic-fail" },
      });
      const ep = createRes.json();

      // Seed initial subscriptions
      await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${ep.id}/subscriptions`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { event_types: ["initial.event.one", "initial.event.two"] },
      });

      // Temporarily intercept client.query to fail when inserting new subscriptions
      const origConnect = testPool.connect.bind(testPool);
      let shouldFail = true;

      // Support both Promise and Callback signatures of pg.Pool.prototype.connect
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (testPool as any).connect = function (
        cb?: (err: Error | null, client: unknown, release: () => void) => void,
      ) {
        if (cb) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return origConnect((err: Error | null, client: any, release: () => void) => {
            if (err) return cb(err, client, release);
            const origQuery = client.query.bind(client);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client.query = async function (text: unknown, ...args: any[]) {
              if (
                shouldFail &&
                typeof text === "string" &&
                text.startsWith("INSERT INTO endpoint_subscriptions")
              ) {
                shouldFail = false;
                throw new Error("Simulated mid-transaction failure during INSERT");
              }
              return origQuery(text, ...args);
            };
            return cb(null, client, release);
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origConnect().then((client: any) => {
          const origQuery = client.query.bind(client);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client.query = async function (text: unknown, ...args: any[]) {
            if (
              shouldFail &&
              typeof text === "string" &&
              text.startsWith("INSERT INTO endpoint_subscriptions")
            ) {
              shouldFail = false;
              throw new Error("Simulated mid-transaction failure during INSERT");
            }
            return origQuery(text, ...args);
          };
          return client;
        });
      };

      try {
        const failedRes = await testApp.inject({
          method: "PUT",
          url: `/v1/endpoints/${ep.id}/subscriptions`,
          headers: { authorization: `Bearer ${tenantAApiKey}` },
          payload: { event_types: ["new.event.one"] },
        });

        expect(failedRes.statusCode).toBe(500);

        // Verify the initial subscriptions are completely intact
        const getRes = await testApp.inject({
          method: "GET",
          url: `/v1/endpoints/${ep.id}/subscriptions`,
          headers: { authorization: `Bearer ${tenantAApiKey}` },
        });
        expect(getRes.statusCode).toBe(200);
        expect(getRes.json().event_types).toEqual(["initial.event.one", "initial.event.two"]);
      } finally {
        testPool.connect = origConnect;
      }
    });
  });

  describe("11. Safe Logging & Secret Leak Scanner", () => {
    it("never logs query parameters (e.g. ?token=abc123) in captured logs", () => {
      const logsCombined = capturedLogs.join("\n");
      expect(logsCombined.includes("token=abc123")).toBe(false);
    });

    it("ensures captured logs never contain whsec_ or any secret payloads", async () => {
      // Create endpoint and rotate secret while tracking the returned secrets
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/leak-test" },
      });
      const created = createRes.json();
      const secret = created.signing_secret;
      const base64Part = secret.slice("whsec_".length);

      const rotateRes = await testApp.inject({
        method: "POST",
        url: `/v1/endpoints/${created.id}/rotate-secret`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      const rotated = rotateRes.json();
      const rotSecret = rotated.signing_secret;
      const rotBase64Part = rotSecret.slice("whsec_".length);

      // Perform get, patch, pause, resume, list
      await testApp.inject({
        method: "GET",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });
      await testApp.inject({
        method: "PATCH",
        url: `/v1/endpoints/${created.id}`,
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { description: "Clean update" },
      });
      await testApp.inject({
        method: "GET",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
      });

      const logsCombined = capturedLogs.join("\n");
      // Logs must never contain the prefix OR the base64 part
      expect(logsCombined.includes("whsec_")).toBe(false);
      expect(logsCombined.includes(base64Part)).toBe(false);
      expect(logsCombined.includes(rotBase64Part)).toBe(false);
    });

    it("enforces route-level bodyLimit on subscriptions: rejects payloads exceeding 32 KB with HTTP 413", async () => {
      const createRes = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: { authorization: `Bearer ${tenantAApiKey}` },
        payload: { url: "https://example.com/webhook-oversize" },
      });
      const endpoint = createRes.json();

      // Generate a payload exceeding 32 KB (~45 KB of JSON)
      const oversizedPayload = {
        event_types: Array.from({ length: 1500 }, (_, i) => `order.created.event.${i}`),
      };
      const jsonString = JSON.stringify(oversizedPayload);
      expect(Buffer.byteLength(jsonString)).toBeGreaterThan(32768);

      const res = await testApp.inject({
        method: "PUT",
        url: `/v1/endpoints/${endpoint.id}/subscriptions`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
        },
        payload: jsonString,
      });

      expect(res.statusCode).toBe(413);
    });

    it("enforces global default bodyLimit (64 KB): rejects general endpoint bodies exceeding 64 KB with HTTP 413", async () => {
      const hugeDescription = "x".repeat(70000);
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/endpoints",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          url: "https://example.com/webhook",
          description: hugeDescription,
        }),
      });

      expect(res.statusCode).toBe(413);
    });
  });
});
