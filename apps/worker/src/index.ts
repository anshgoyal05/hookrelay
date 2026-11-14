import pg from "pg";
import { Redis } from "ioredis";
import { loadConfig, createLogger, AmqpConnectionManager } from "@hookrelay/shared";
import { WorkerService, type WorkerAmqpClient } from "./worker.js";
import type { Logger } from "pino";

const logger = createLogger({ name: "hookrelay-worker" });

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
    { nodeEnv: config.NODE_ENV, pid: process.pid },
    "Initializing HookRelay Worker process",
  );

  // 1. PostgreSQL pool with error listener
  const pgPool = new pg.Pool({
    connectionString: config.DATABASE_URL,
  });
  pgPool.on("error", (err) => {
    logger.warn({ err: (err as Error)?.message }, "PostgreSQL pool client error in worker");
  });

  // 2. Redis client with throttled error logging
  const redisClient = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      return Math.min(times * 100, 2000);
    },
  });
  redisClient.on("error", createThrottledErrorHandler(logger, "worker-redis", 30_000));
  await redisClient.connect().catch((err) => {
    logger.warn({ err: (err as Error)?.message }, "Redis worker initial connection deferred/failed");
  });

  // 3. Resilient RabbitMQ connection manager
  const amqpManager = new AmqpConnectionManager({
    url: config.RABBITMQ_URL,
    logger,
  });
  await amqpManager.start();

  const amqpClient: WorkerAmqpClient = {
    isConnected: () => amqpManager.isReady(),
    close: async () => amqpManager.close(),
  };

  const worker = new WorkerService({
    pgPool,
    redisClient,
    amqpConnection: amqpClient,
    logger,
  });

  // Graceful shutdown handling with 10s forced exit timeout
  const shutdown = async (signal: string) => {
    logger.info({ signal, pid: process.pid }, "Shutting down worker gracefully");

    const forceExitTimer = setTimeout(() => {
      logger.fatal({ signal }, "Graceful worker shutdown timed out (10s), forcing process exit");
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await worker.stop();
      clearTimeout(forceExitTimer);
      logger.info("Worker shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error({ err }, "Error during worker graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.start();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal worker startup error");
  process.exit(1);
});
