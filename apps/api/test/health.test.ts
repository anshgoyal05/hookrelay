import { describe, it, expect } from "vitest";
import { buildServer, type ApiDependencies } from "../src/server.js";
import { createLogger, PROBLEM_TYPES } from "@hookrelay/shared";

const testLogger = createLogger({ name: "test-api", level: "silent" });

describe("apps/api - Health & Readiness Endpoints", () => {
  it("GET /healthz returns 200 OK with liveness status", async () => {
    const deps: ApiDependencies = {
      pgPool: { query: async () => ({ rows: [] }) },
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => true },
      logger: testLogger,
    };

    const app = buildServer(deps);
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    await app.close();
  });

  it("GET /readyz returns 200 OK when all infrastructure dependencies are ready", async () => {
    const deps: ApiDependencies = {
      pgPool: { query: async () => ({ rows: [] }) },
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => true },
      logger: testLogger,
    };

    const app = buildServer(deps);
    const response = await app.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body.checks).toEqual({
      postgres: "ok",
      redis: "ok",
      rabbitmq: "ok",
    });
    await app.close();
  });

  it("GET /readyz returns 503 Service Unavailable (RFC 7807) when Postgres fails", async () => {
    const deps: ApiDependencies = {
      pgPool: {
        query: async () => {
          throw new Error("Connection refused");
        },
      },
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => true },
      logger: testLogger,
    };

    const app = buildServer(deps);
    const response = await app.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("application/problem+json");

    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.SERVICE_UNAVAILABLE);
    expect(body.status).toBe(503);
    expect(body.checks.postgres).toBe("down");
    expect(body.checks.redis).toBe("ok");
    expect(body.checks.rabbitmq).toBe("ok");
    await app.close();
  });

  it("GET /readyz returns 503 Service Unavailable when Redis fails", async () => {
    const deps: ApiDependencies = {
      pgPool: { query: async () => ({ rows: [] }) },
      redisClient: {
        ping: async () => {
          throw new Error("Redis timeout");
        },
      },
      amqpConnection: { isConnected: () => true },
      logger: testLogger,
    };

    const app = buildServer(deps);
    const response = await app.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.redis).toBe("down");
    expect(body.checks.rabbitmq).toBe("ok");
    await app.close();
  });

  it("GET /readyz returns 503 Service Unavailable when RabbitMQ fails", async () => {
    const deps: ApiDependencies = {
      pgPool: { query: async () => ({ rows: [] }) },
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => false },
      logger: testLogger,
    };

    const app = buildServer(deps);
    const response = await app.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.redis).toBe("ok");
    expect(body.checks.rabbitmq).toBe("down");
    await app.close();
  });
});
