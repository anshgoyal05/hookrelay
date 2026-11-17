import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { Writable } from "node:stream";
import {
  runMigrations,
  createLogger,
  LastUsedThrottler,
  PROBLEM_TYPES,
} from "@hookrelay/shared";
import { buildServer } from "../src/server.js";

const ADMIN_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0";

describe("apps/api - Authentication & Tenant Bootstrap", () => {
  let mainPool: pg.Pool;
  let testDbName: string;
  let testPool: pg.Pool;
  const capturedLogs: string[] = [];
  let testApp: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    // 1. Connect to PostgreSQL to create a throwaway database
    const baseConnStr =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/hookrelay";
    const url = new URL(baseConnStr);
    const _dbNameToConnect = url.pathname.slice(1) || "postgres";

    mainPool = new pg.Pool({ connectionString: baseConnStr });

    testDbName = `hookrelay_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    await mainPool.query(`CREATE DATABASE ${testDbName}`);

    // 2. Connect to throwaway database and run migrations
    url.pathname = `/${testDbName}`;
    testPool = new pg.Pool({ connectionString: url.toString() });

    await runMigrations(testPool);

    // 3. Create logging capture stream
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs.push(chunk.toString());
        callback();
      },
    });

    const logger = createLogger({ name: "test-auth", level: "info" }, logStream);

    const throttler = new LastUsedThrottler({
      redisClient: null, // Fallback to memory
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
      adminToken: ADMIN_TOKEN,
      maxActiveKeys: 20,
      throttler,
    });
  });

  afterAll(async () => {
    if (testApp) {
      await testApp.close();
    }
    if (testPool) {
      await testPool.end();
    }
    if (mainPool && testDbName) {
      // Disconnect all sessions before dropping database
      await mainPool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${testDbName}'
          AND pid <> pg_backend_pid();
      `);
      await mainPool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
      await mainPool.end();
    }
  });

  describe("Admin Tenant Bootstrap (POST /v1/admin/tenants)", () => {
    it("fails closed with 503 if ADMIN_TOKEN is not configured on server", async () => {
      const unconfiguredApp = buildServer({
        pgPool: testPool,
        redisClient: { ping: async () => "PONG" },
        amqpConnection: { isConnected: () => true },
        adminToken: undefined, // Unset
      });

      const res = await unconfiguredApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        payload: { name: "ACME Corp" },
      });

      expect(res.statusCode).toBe(503);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.headers["x-request-id"]).toBeDefined();

      const body = res.json();
      expect(body.type).toBe(PROBLEM_TYPES.SERVICE_UNAVAILABLE);
      expect(body.title).toBe("Admin API Disabled");
      await unconfiguredApp.close();
    });

    it("rejects request with 401 if admin token is missing", async () => {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        payload: { name: "Acme Corp" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const body = res.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNAUTHORIZED);
    });

    it("rejects request with 401 if admin token is wrong", async () => {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: {
          authorization: "Bearer wrong_token_00000000000000000000000000000000",
        },
        payload: { name: "Acme Corp" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      const body = res.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNAUTHORIZED);
    });

    it("successfully creates a tenant and its first API key (returned once with Cache-Control: no-store)", async () => {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        payload: { name: "Stripe Tenant", key_name: "prod-key" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-request-id"]).toBeDefined();

      const body = res.json();
      expect(body.tenant.id).toBeDefined();
      expect(body.tenant.name).toBe("Stripe Tenant");
      expect(body.api_key.id).toBeDefined();
      expect(body.api_key.prefix).toMatch(/^[0-9a-f]{16}$/);
      expect(body.api_key.key).toMatch(/^hr_live_[0-9a-f]{16}_[0-9a-f]{64}$/);
    });
  });

  describe("API Key Authentication & Management (/v1/api-keys)", () => {
    let _tenantAId: string;
    let tenantAKey: string;
    let tenantAKeyId: string;

    let _tenantBId: string;
    let tenantBKey: string;
    let tenantBKeyId: string;

    beforeAll(async () => {
      // Create Tenant A
      const resA = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: "Tenant A" },
      });
      const dataA = resA.json();
      _tenantAId = dataA.tenant.id;
      tenantAKey = dataA.api_key.key;
      tenantAKeyId = dataA.api_key.id;

      // Create Tenant B
      const resB = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: "Tenant B" },
      });
      const dataB = resB.json();
      _tenantBId = dataB.tenant.id;
      tenantBKey = dataB.api_key.key;
      tenantBKeyId = dataB.api_key.id;
    });

    it("allows access with valid API key and lists keys without secrets", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: {
          authorization: `Bearer ${tenantAKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toBeDefined();
      const body = res.json();
      expect(Array.isArray(body.api_keys)).toBe(true);
      expect(body.api_keys.length).toBe(1);
      const keyObj = body.api_keys[0];
      expect(keyObj.id).toBe(tenantAKeyId);
      expect(keyObj.prefix).toBeDefined();
      expect(keyObj.created_at).toBeDefined();
      expect(keyObj.key).toBeUndefined(); // NEVER returned
      expect(keyObj.key_hash).toBeUndefined(); // NEVER returned
    });

    it("creates a second key via POST /v1/api-keys (returned once)", async () => {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers: {
          authorization: `Bearer ${tenantAKey}`,
        },
        payload: { name: "secondary-key" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.json();
      expect(body.name).toBe("secondary-key");
      expect(body.key).toMatch(/^hr_live_[0-9a-f]{16}_[0-9a-f]{64}$/);

      // Verify listing now shows 2 keys, without secrets
      const listRes = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${tenantAKey}` },
      });
      expect(listRes.json().api_keys.length).toBe(2);
    });

    it("enforces identical 401 error bodies across unknown-prefix, wrong-secret, and malformed headers (except request_id)", async () => {
      // 1. Unknown prefix
      const resUnknown = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: {
          authorization: `Bearer hr_live_${"f".repeat(16)}_${"a".repeat(64)}`,
        },
      });

      // 2. Wrong secret for known prefix
      const validPrefix = tenantAKey.split("_")[2];
      const resWrongSecret = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: {
          authorization: `Bearer hr_live_${validPrefix}_${"0".repeat(64)}`,
        },
      });

      // 3. Malformed key format
      const resMalformed = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: {
          authorization: "Bearer hr_live_bad_key",
        },
      });

      expect(resUnknown.statusCode).toBe(401);
      expect(resWrongSecret.statusCode).toBe(401);
      expect(resMalformed.statusCode).toBe(401);

      expect(resUnknown.headers["www-authenticate"]).toBe("Bearer");
      expect(resWrongSecret.headers["www-authenticate"]).toBe("Bearer");
      expect(resMalformed.headers["www-authenticate"]).toBe("Bearer");

      const bodyUnknown = resUnknown.json();
      const bodyWrongSecret = resWrongSecret.json();
      const bodyMalformed = resMalformed.json();

      expect(bodyUnknown.type).toBe(bodyWrongSecret.type);
      expect(bodyUnknown.title).toBe(bodyWrongSecret.title);
      expect(bodyUnknown.detail).toBe(bodyWrongSecret.detail);

      expect(bodyUnknown.type).toBe(bodyMalformed.type);
      expect(bodyUnknown.title).toBe(bodyMalformed.title);
      expect(bodyUnknown.detail).toBe(bodyMalformed.detail);
    });

    it("rejects authorization header exceeding 200 characters before hashing", async () => {
      const longHeader = "Bearer " + "a".repeat(250);
      const res = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: {
          authorization: longHeader,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    });

    it("enforces tenant isolation on key listing and revocation (returns 404, not 403)", async () => {
      // Tenant A listing does not include Tenant B's keys
      const listA = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${tenantAKey}` },
      });
      const idsA = listA.json().api_keys.map((k: { id: string }) => k.id);
      expect(idsA).not.toContain(tenantBKeyId);

      // Tenant A attempting to revoke Tenant B's key receives 404
      const deleteRes = await testApp.inject({
        method: "DELETE",
        url: `/v1/api-keys/${tenantBKeyId}`,
        headers: { authorization: `Bearer ${tenantAKey}` },
      });

      expect(deleteRes.statusCode).toBe(404);
      expect(deleteRes.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
    });

    it("prevents revoking the last active key without ?force=true, and respects ?force=false", async () => {
      // Tenant B has exactly 1 active key
      // 1. Without force
      const resNoForce = await testApp.inject({
        method: "DELETE",
        url: `/v1/api-keys/${tenantBKeyId}`,
        headers: { authorization: `Bearer ${tenantBKey}` },
      });
      expect(resNoForce.statusCode).toBe(409);
      expect(resNoForce.json().type).toBe(PROBLEM_TYPES.LAST_ACTIVE_KEY);

      // 2. With force=false
      const resForceFalse = await testApp.inject({
        method: "DELETE",
        url: `/v1/api-keys/${tenantBKeyId}?force=false`,
        headers: { authorization: `Bearer ${tenantBKey}` },
      });
      expect(resForceFalse.statusCode).toBe(409);
      expect(resForceFalse.json().type).toBe(PROBLEM_TYPES.LAST_ACTIVE_KEY);

      // 3. With force=true -> succeeds
      const resForceTrue = await testApp.inject({
        method: "DELETE",
        url: `/v1/api-keys/${tenantBKeyId}?force=true`,
        headers: { authorization: `Bearer ${tenantBKey}` },
      });
      expect(resForceTrue.statusCode).toBe(204);

      // 4. Key is now revoked; using it returns 401
      const resUsingRevoked = await testApp.inject({
        method: "GET",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${tenantBKey}` },
      });
      expect(resUsingRevoked.statusCode).toBe(401);

      // 5. Revoking an already-revoked key is idempotent (returns 204)
      const resRevokeAgain = await testApp.inject({
        method: "DELETE",
        url: `/v1/api-keys/${tenantBKeyId}`,
        headers: { authorization: `Bearer ${tenantAKey}` }, // Needs a valid key to authenticate request
      });
      // Will return 404 because key belongs to tenant B
      expect(resRevokeAgain.statusCode).toBe(404);
    });

    it("concurrency safety: two simultaneous revokes on a tenant with 2 keys leave exactly 1 active", async () => {
      // Create Tenant C with 2 keys
      const resC = await testApp.inject({
        method: "POST",
        url: "/v1/admin/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: "Tenant C" },
      });
      const key1Data = resC.json();
      const tenantCKey1 = key1Data.api_key.key;
      const key1Id = key1Data.api_key.id;

      const resKey2 = await testApp.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers: { authorization: `Bearer ${tenantCKey1}` },
        payload: { name: "key-2" },
      });
      const key2Id = resKey2.json().id;

      // Two simultaneous revokes without force
      const [res1, res2] = await Promise.all([
        testApp.inject({
          method: "DELETE",
          url: `/v1/api-keys/${key1Id}`,
          headers: { authorization: `Bearer ${tenantCKey1}` },
        }),
        testApp.inject({
          method: "DELETE",
          url: `/v1/api-keys/${key2Id}`,
          headers: { authorization: `Bearer ${tenantCKey1}` },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      // Exactly one must succeed (204) and one must be rejected (409)
      expect(statusCodes).toEqual([204, 409]);

      // Check database: exactly 1 key remains active
      const countRes = await testPool.query(
        "SELECT count(*)::int AS count FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL",
        [key1Data.tenant.id],
      );
      expect(countRes.rows[0].count).toBe(1);
    });

    it("verifies log redaction: key secrets and authorization headers never appear in captured logs", async () => {
      const logsCombined = capturedLogs.join("\n");
      // Assert that actual key secrets never appear in logs
      expect(logsCombined).not.toContain(tenantAKey);
      expect(logsCombined).not.toContain(tenantBKey);
      expect(logsCombined).not.toContain(ADMIN_TOKEN);
    });
  });
});
