import fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  createLogger,
  createProblemDetails,
  PROBLEM_TYPES,
  LastUsedThrottler,
  type ReadinessChecks,
  type ReadinessResult,
  type LivenessResult,
} from "@hookrelay/shared";
import type { Logger } from "pino";
import { adminRoutes } from "./routes/admin.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { endpointRoutes } from "./routes/endpoints.js";

export interface PgCheckable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  connect?: () => Promise<{
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }>;
}

export interface RedisCheckable {
  ping: () => Promise<string>;
  status?: string;
}

export type RedisClientType = Redis | RedisCheckable;

export interface AmqpCheckable {
  isConnected: () => boolean;
}

export interface ApiDependencies {
  pgPool: PgCheckable;
  redisClient: RedisClientType;
  amqpConnection: AmqpCheckable;
  logger?: Logger;
  adminToken?: string;
  maxActiveKeys?: number;
  throttler?: LastUsedThrottler;
  encryptionKey?: string;
  maxEndpointsPerTenant?: number;
  secretRotationGraceSeconds?: number;
  allowHttp?: boolean;
  allowPrivateTargets?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRoute?: (routeOptions: any) => void;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Readiness check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildServer(dependencies: ApiDependencies) {
  const logger = dependencies.logger ?? createLogger({ name: "hookrelay-api" });

  const throttler =
    dependencies.throttler ??
    new LastUsedThrottler({
      redisClient: dependencies.redisClient as unknown as Redis,
      db: dependencies.pgPool,
      logger,
      throttleSeconds: 60,
    });

  const app = fastify({
    genReqId: (req) => {
      const headerReqId = req.headers["x-request-id"];
      return typeof headerReqId === "string" ? headerReqId : randomUUID();
    },
    loggerInstance: logger,
    // 64 KB default request body limit to protect against unbounded parser allocations.
    // Note: Day 3 POST /v1/events route will override this at route level with its 256 KB payload cap.
    bodyLimit: 65536,
  });

  if (dependencies.onRoute) {
    app.addHook("onRoute", dependencies.onRoute);
  }

  // Inject X-Request-Id header on all responses
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // RFC 7807 error handler
  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");

    const errObj = error as { statusCode?: number; name?: string; message?: string; validation?: unknown[] };
    const status =
      typeof errObj.statusCode === "number" && errObj.statusCode >= 400
        ? errObj.statusCode
        : 500;

    const problem = createProblemDetails({
      type:
        status === 400
          ? PROBLEM_TYPES.BAD_REQUEST
          : status === 404
            ? PROBLEM_TYPES.NOT_FOUND
            : PROBLEM_TYPES.INTERNAL_ERROR,
      title: errObj.name || "Internal Server Error",
      status,
      detail: errObj.message || "An unexpected error occurred",
      instance: request.url,
      request_id: request.id,
    });

    reply.type("application/problem+json").status(status).send(problem);
  });

  // GET /healthz - Liveness probe
  app.get("/healthz", async (_request, reply) => {
    const result: LivenessResult = {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
    return reply.status(200).send(result);
  });

  // GET /readyz - Readiness probe (checks Postgres, Redis, RabbitMQ)
  app.get("/readyz", async (request, reply) => {
    const checks: ReadinessChecks = {
      postgres: "down",
      redis: "down",
      rabbitmq: "down",
    };

    // 1. Check PostgreSQL (with 2s timeout)
    try {
      await withTimeout(dependencies.pgPool.query("SELECT 1"), 2000);
      checks.postgres = "ok";
    } catch (err) {
      request.log.warn({ err: (err as Error)?.message }, "Postgres readiness check failed");
    }

    // 2. Check Redis (with 2s timeout)
    try {
      const pong = await withTimeout(dependencies.redisClient.ping(), 2000);
      if (pong === "PONG") {
        checks.redis = "ok";
      }
    } catch (err) {
      request.log.warn({ err: (err as Error)?.message }, "Redis readiness check failed");
    }

    // 3. Check RabbitMQ (with 2s timeout)
    try {
      const isConnected = await withTimeout(
        Promise.resolve(dependencies.amqpConnection.isConnected()),
        2000,
      );
      if (isConnected) {
        checks.rabbitmq = "ok";
      }
    } catch (err) {
      request.log.warn({ err: (err as Error)?.message }, "RabbitMQ readiness check failed");
    }

    const isAllReady =
      checks.postgres === "ok" && checks.redis === "ok" && checks.rabbitmq === "ok";

    if (!isAllReady) {
      const problem = createProblemDetails({
        type: PROBLEM_TYPES.SERVICE_UNAVAILABLE,
        title: "Service Unavailable",
        status: 503,
        detail: "One or more required infrastructure dependencies are not ready",
        instance: request.url,
        request_id: request.id,
        extensions: {
          checks,
          timestamp: new Date().toISOString(),
        },
      });

      return reply.type("application/problem+json").status(503).send(problem);
    }

    const response: ReadinessResult = {
      status: "ready",
      checks,
      timestamp: new Date().toISOString(),
    };

    return reply.status(200).send(response);
  });

  // Register Admin and API Key routes
  app.register(adminRoutes, {
    pgPool: dependencies.pgPool as Pool,
    adminToken: dependencies.adminToken,
  });

  app.register(apiKeyRoutes, {
    pgPool: dependencies.pgPool as Pool,
    throttler,
    maxActiveKeys: dependencies.maxActiveKeys,
  });

  app.register(endpointRoutes, {
    pgPool: dependencies.pgPool as Pool,
    throttler,
    encryptionKey:
      dependencies.encryptionKey ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    maxEndpointsPerTenant: dependencies.maxEndpointsPerTenant,
    secretRotationGraceSeconds: dependencies.secretRotationGraceSeconds,
    allowHttp: dependencies.allowHttp,
    allowPrivateTargets: dependencies.allowPrivateTargets,
  });

  return app;
}
