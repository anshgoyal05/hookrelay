import pg from "pg";
import { Redis } from "ioredis";
import { loadConfig, createLogger, AmqpConnectionManager } from "@hookrelay/shared";
import { buildServer, type AmqpCheckable } from "./server.js";
import type { Logger } from "pino";

const logger = createLogger({ name: "hookrelay-api" });

function createThrottledErrorHandler(log: Logger, clientName: string, throttleMs = 30_000) {
  let lastLoggedAt = 0;
  let suppressedCount = 0;

  return (err: unknown) => {
    const now = Date.now();
    if (now - lastLoggedAt >= throttleMs) {
      log.warn(
        { err: (err as Error)?.message || err, suppressedCount, client: clientName },
        `Redis connection error on ${clientName}${suppressedCount > 0 ? ` (${suppressedCount} duplicate errors suppressed)` : ""}`,
      );
      lastLoggedAt = now;
      suppressedCount = 0;
    } else {
      suppressedCount++;
    }
  };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.fatal({ err }, "Failed to validate configuration. Exiting.");
    process.exit(1);
  }

  logger.info(
    { nodeEnv: config.NODE_ENV, port: config.PORT, pid: process.pid },
    "Initializing HookRelay API",
  );

  // 1. Initialize PostgreSQL pool with error listener on idle clients
  const pgPool = new pg.Pool({
    connectionString: config.DATABASE_URL,
  });
  pgPool.on("error", (err) => {
    logger.warn({ err: (err as Error)?.message }, "PostgreSQL pool client error");
  });

  // 2. Initialize Redis client with throttled error logging (max 1 per 30s)
  const redisClient = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      return Math.min(times * 100, 2000);
    },
  });
  redisClient.on("error", createThrottledErrorHandler(logger, "api-redis", 30_000));
  await redisClient.connect().catch((err) => {
    logger.warn({ err: (err as Error)?.message }, "Redis initial connection deferred/failed");
  });

  // 3. Initialize resilient RabbitMQ connection manager
  const amqpManager = new AmqpConnectionManager({
    url: config.RABBITMQ_URL,
    logger,
  });
  await amqpManager.start();

  const amqpCheckable: AmqpCheckable = {
    isConnected: () => amqpManager.isReady(),
  };

  if (!config.ADMIN_TOKEN || config.ADMIN_TOKEN.length < 32) {
    logger.warn("ADMIN_TOKEN is not set or shorter than 32 characters. All /v1/admin/* endpoints are disabled.");
  }

  const app = buildServer({
    pgPool,
    redisClient,
    amqpConnection: amqpCheckable,
    logger,
    adminToken: config.ADMIN_TOKEN,
    maxActiveKeys: config.MAX_ACTIVE_KEYS_PER_TENANT,
  });

  // Graceful shutdown handling with 10s forced exit timeout
  const shutdown = async (signal: string) => {
    logger.info({ signal, pid: process.pid }, "Shutting down API server gracefully");

    const forceExitTimer = setTimeout(() => {
      logger.fatal({ signal }, "Graceful shutdown timed out (10s), forcing process exit");
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await app.close();
      await pgPool.end().catch((err) => logger.warn({ err: (err as Error)?.message }, "Error closing pgPool"));
      await redisClient.quit().catch(() => {});
      await amqpManager.close().catch(() => {});
      clearTimeout(forceExitTimer);
      logger.info("API server shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info({ port: config.PORT, pid: process.pid }, "HookRelay API listening");
  } catch (err) {
    logger.fatal({ err }, "Failed to start API server");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
