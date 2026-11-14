import fastify from "fastify";
import { randomUUID } from "node:crypto";
import {
  createLogger,
  createProblemDetails,
  PROBLEM_TYPES,
  type ReadinessChecks,
  type ReadinessResult,
  type LivenessResult,
} from "@hookrelay/shared";
import type { Logger } from "pino";

export interface PgCheckable {
  query: (text: string) => Promise<unknown>;
}

export interface RedisCheckable {
  ping: () => Promise<string>;
}

export interface AmqpCheckable {
  isConnected: () => boolean;
}

export interface ApiDependencies {
  pgPool: PgCheckable;
  redisClient: RedisCheckable;
  amqpConnection: AmqpCheckable;
  logger?: Logger;
}

export function buildServer(dependencies: ApiDependencies) {
  const logger = dependencies.logger ?? createLogger({ name: "hookrelay-api" });

  const app = fastify({
    genReqId: (req) => {
      const headerReqId = req.headers["x-request-id"];
      return typeof headerReqId === "string" ? headerReqId : randomUUID();
    },
    loggerInstance: logger,
  });

  // RFC 7807 error handler
  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");

    const errObj = error as { statusCode?: number; name?: string; message?: string };
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

    // 1. Check PostgreSQL
    try {
      await dependencies.pgPool.query("SELECT 1");
      checks.postgres = "ok";
    } catch (err) {
      request.log.warn({ err }, "Postgres readiness check failed");
    }

    // 2. Check Redis
    try {
      const pong = await dependencies.redisClient.ping();
      if (pong === "PONG") {
        checks.redis = "ok";
      }
    } catch (err) {
      request.log.warn({ err }, "Redis readiness check failed");
    }

    // 3. Check RabbitMQ
    try {
      if (dependencies.amqpConnection.isConnected()) {
        checks.rabbitmq = "ok";
      }
    } catch (err) {
      request.log.warn({ err }, "RabbitMQ readiness check failed");
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

  return app;
}
