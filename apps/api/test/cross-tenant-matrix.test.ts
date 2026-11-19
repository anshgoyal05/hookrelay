import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import {
  runMigrations,
  createLogger,
} from "@hookrelay/shared";
import { buildServer } from "../src/server.js";

const ADMIN_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0";
const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

describe("apps/api - 25 Cross-Tenant & Security Access Attempts Matrix", () => {
  let mainPool: pg.Pool;
  let testDbName: string;
  let testPool: pg.Pool;
  let testApp: ReturnType<typeof buildServer>;

  let tenantAApiKey: string;
  let tenantBApiKey: string;
  let endpointAId: string;
  let keyA2Id: string;
  let revokedKeyA: string;

  beforeAll(async () => {
    const baseConnStr = process.env.DATABASE_URL;
    if (!baseConnStr) {
      throw new Error("DATABASE_URL environment variable is required to run database integration tests");
    }
    const url = new URL(baseConnStr);

    mainPool = new pg.Pool({ connectionString: baseConnStr });
    testDbName = `hookrelay_test_crosstenant_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    await mainPool.query(`CREATE DATABASE ${testDbName}`);

    url.pathname = `/${testDbName}`;
    testPool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(testPool);

    const logger = createLogger({ name: "test-cross-tenant", level: "error" });

    testApp = buildServer({
      pgPool: testPool,
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => true },
      logger,
      adminToken: ADMIN_TOKEN,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    // 1. Bootstrap Tenant A
    const resA = await testApp.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "Tenant A" },
    });
    tenantAApiKey = resA.json().api_key.key;

    // 2. Bootstrap Tenant B
    const resB = await testApp.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "Tenant B" },
    });
    tenantBApiKey = resB.json().api_key.key;

    // 3. Under Tenant A: Create second API Key
    const keyA2Res = await testApp.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { authorization: `Bearer ${tenantAApiKey}` },
      payload: { name: "Secondary Key A" },
    });
    keyA2Id = keyA2Res.json().id;

    // 4. Under Tenant A: Create a third key and revoke it
    const keyA3Res = await testApp.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { authorization: `Bearer ${tenantAApiKey}` },
      payload: { name: "To Revoke Key A" },
    });
    revokedKeyA = keyA3Res.json().key;
    await testApp.inject({
      method: "DELETE",
      url: `/v1/api-keys/${keyA3Res.json().id}`,
      headers: { authorization: `Bearer ${tenantAApiKey}` },
    });

    // 5. Under Tenant A: Create Endpoint
    const epRes = await testApp.inject({
      method: "POST",
      url: "/v1/endpoints",
      headers: { authorization: `Bearer ${tenantAApiKey}` },
      payload: {
        url: "https://example.com/tenant-a/webhook",
        description: "Tenant A Private Endpoint",
        concurrency_limit: 10,
      },
    });
    endpointAId = epRes.json().id;

    // 6. Under Tenant A: Seed Subscriptions
    await testApp.inject({
      method: "PUT",
      url: `/v1/endpoints/${endpointAId}/subscriptions`,
      headers: { authorization: `Bearer ${tenantAApiKey}` },
      payload: { event_types: ["order.placed", "order.shipped"] },
    });
  });

  afterAll(async () => {
    await testApp.close();
    await testPool.end();
    await mainPool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await mainPool.end();
  });

  it("executes 25 cross-tenant requests and asserts each returns 404 or 401", async () => {
    const bogusKey = "hr_live_000000000000_00000000000000000000000000000000";

    const testCases: Array<{
      id: number;
      name: string;
      method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
      url: string;
      auth?: string;
      payload?: Record<string, unknown>;
      expectedStatus: 404 | 401;
    }> = [
      // 1-15: Cross-tenant isolation (Tenant B authenticated, targeting Tenant A resources) -> must all be 404
      {
        id: 1,
        name: "Tenant B attempts DELETE on Tenant A's API key",
        method: "DELETE",
        url: `/v1/api-keys/${keyA2Id}`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 2,
        name: "Tenant B attempts forced DELETE on Tenant A's API key",
        method: "DELETE",
        url: `/v1/api-keys/${keyA2Id}?force=true`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 3,
        name: "Tenant B attempts GET on Tenant A's endpoint",
        method: "GET",
        url: `/v1/endpoints/${endpointAId}`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 4,
        name: "Tenant B attempts PATCH URL on Tenant A's endpoint",
        method: "PATCH",
        url: `/v1/endpoints/${endpointAId}`,
        auth: tenantBApiKey,
        payload: { url: "https://evil.com/hook" },
        expectedStatus: 404,
      },
      {
        id: 5,
        name: "Tenant B attempts PATCH description on Tenant A's endpoint",
        method: "PATCH",
        url: `/v1/endpoints/${endpointAId}`,
        auth: tenantBApiKey,
        payload: { description: "Compromised" },
        expectedStatus: 404,
      },
      {
        id: 6,
        name: "Tenant B attempts PATCH concurrency on Tenant A's endpoint",
        method: "PATCH",
        url: `/v1/endpoints/${endpointAId}`,
        auth: tenantBApiKey,
        payload: { concurrency_limit: 1 },
        expectedStatus: 404,
      },
      {
        id: 7,
        name: "Tenant B attempts POST pause on Tenant A's endpoint",
        method: "POST",
        url: `/v1/endpoints/${endpointAId}/pause`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 8,
        name: "Tenant B attempts POST resume on Tenant A's endpoint",
        method: "POST",
        url: `/v1/endpoints/${endpointAId}/resume`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 9,
        name: "Tenant B attempts POST rotate-secret on Tenant A's endpoint",
        method: "POST",
        url: `/v1/endpoints/${endpointAId}/rotate-secret`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 10,
        name: "Tenant B attempts GET subscriptions on Tenant A's endpoint",
        method: "GET",
        url: `/v1/endpoints/${endpointAId}/subscriptions`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 11,
        name: "Tenant B attempts PUT subscriptions (wildcard) on Tenant A's endpoint",
        method: "PUT",
        url: `/v1/endpoints/${endpointAId}/subscriptions`,
        auth: tenantBApiKey,
        payload: { event_types: ["*"] },
        expectedStatus: 404,
      },
      {
        id: 12,
        name: "Tenant B attempts PUT subscriptions (specific) on Tenant A's endpoint",
        method: "PUT",
        url: `/v1/endpoints/${endpointAId}/subscriptions`,
        auth: tenantBApiKey,
        payload: { event_types: ["user.created"] },
        expectedStatus: 404,
      },
      {
        id: 13,
        name: "Tenant B attempts PUT subscriptions (empty) on Tenant A's endpoint",
        method: "PUT",
        url: `/v1/endpoints/${endpointAId}/subscriptions`,
        auth: tenantBApiKey,
        payload: { event_types: [] },
        expectedStatus: 404,
      },
      {
        id: 14,
        name: "Tenant B attempts DELETE on Tenant A's endpoint",
        method: "DELETE",
        url: `/v1/endpoints/${endpointAId}`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },
      {
        id: 15,
        name: "Tenant B attempts repeat DELETE on Tenant A's endpoint",
        method: "DELETE",
        url: `/v1/endpoints/${endpointAId}`,
        auth: tenantBApiKey,
        expectedStatus: 404,
      },

      // 16-23: Unauthenticated calls (No Authorization header) -> must all be 401
      {
        id: 16,
        name: "Unauthenticated GET /v1/endpoints/:id",
        method: "GET",
        url: `/v1/endpoints/${endpointAId}`,
        expectedStatus: 401,
      },
      {
        id: 17,
        name: "Unauthenticated PATCH /v1/endpoints/:id",
        method: "PATCH",
        url: `/v1/endpoints/${endpointAId}`,
        payload: { description: "Unauth" },
        expectedStatus: 401,
      },
      {
        id: 18,
        name: "Unauthenticated POST /v1/endpoints/:id/pause",
        method: "POST",
        url: `/v1/endpoints/${endpointAId}/pause`,
        expectedStatus: 401,
      },
      {
        id: 19,
        name: "Unauthenticated POST /v1/endpoints/:id/resume",
        method: "POST",
        url: `/v1/endpoints/${endpointAId}/resume`,
        expectedStatus: 401,
      },
      {
        id: 20,
        name: "Unauthenticated POST /v1/endpoints/:id/rotate-secret",
        method: "POST",
        url: `/v1/endpoints/${endpointAId}/rotate-secret`,
        expectedStatus: 401,
      },
      {
        id: 21,
        name: "Unauthenticated GET /v1/endpoints/:id/subscriptions",
        method: "GET",
        url: `/v1/endpoints/${endpointAId}/subscriptions`,
        expectedStatus: 401,
      },
      {
        id: 22,
        name: "Unauthenticated PUT /v1/endpoints/:id/subscriptions",
        method: "PUT",
        url: `/v1/endpoints/${endpointAId}/subscriptions`,
        payload: { event_types: ["*"] },
        expectedStatus: 401,
      },
      {
        id: 23,
        name: "Unauthenticated DELETE /v1/endpoints/:id",
        method: "DELETE",
        url: `/v1/endpoints/${endpointAId}`,
        expectedStatus: 401,
      },

      // 24-25: Invalid or Revoked Authentication Credentials -> must all be 401
      {
        id: 24,
        name: "GET /v1/endpoints/:id with invalid non-existent API key",
        method: "GET",
        url: `/v1/endpoints/${endpointAId}`,
        auth: bogusKey,
        expectedStatus: 401,
      },
      {
        id: 25,
        name: "GET /v1/endpoints/:id with revoked API key",
        method: "GET",
        url: `/v1/endpoints/${endpointAId}`,
        auth: revokedKeyA,
        expectedStatus: 401,
      },
    ];

    expect(testCases.length).toBe(25);

    const resultsSummary: string[] = [];

    for (const tc of testCases) {
      const headers: Record<string, string> = {};
      if (tc.auth) {
        headers.authorization = `Bearer ${tc.auth}`;
      }

      const res = await testApp.inject({
        method: tc.method,
        url: tc.url,
        headers,
        payload: tc.payload,
      });

      expect(
        res.statusCode,
        `Test Case #${tc.id} [${tc.name}]: expected ${tc.expectedStatus}, got ${res.statusCode}`,
      ).toBe(tc.expectedStatus);

      resultsSummary.push(
        `#${String(tc.id).padStart(2, "0")}: [${tc.method.padEnd(6)}] ${tc.url.padEnd(45)} -> ${res.statusCode} OK (Expected: ${tc.expectedStatus}) | ${tc.name}`,
      );
    }

    console.log("\n=================== 25 CROSS-TENANT RESULTS MATRIX ===================");
    console.log(resultsSummary.join("\n"));
    console.log("=======================================================================\n");
  });
});
