import pg from "pg";
import { Redis } from "ioredis";
import amqp from "amqplib";
import { loadConfig, createLogger } from "@hookrelay/shared";
import { WorkerService, type WorkerAmqpClient } from "./worker.js";

const logger = createLogger({ name: "hookrelay-worker" });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.fatal({ err }, "Failed to validate configuration. Exiting.");
    process.exit(1);
  }

  logger.info({ nodeEnv: config.NODE_ENV }, "Initializing HookRelay Worker process");

  // 1. PostgreSQL pool
  const pgPool = new pg.Pool({
    connectionString: config.DATABASE_URL,
  });

  // 2. Redis client
  const redisClient = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redisClient.connect();

  // 3. RabbitMQ connection
  let isAmqpConnected = false;
  const amqpConn = await amqp.connect(config.RABBITMQ_URL);
  isAmqpConnected = true;

  amqpConn.on("close", () => {
    isAmqpConnected = false;
    logger.warn("RabbitMQ connection closed");
  });
  amqpConn.on("error", (err) => {
    isAmqpConnected = false;
    logger.error({ err }, "RabbitMQ connection error");
  });

  const amqpClient: WorkerAmqpClient = {
    isConnected: () => isAmqpConnected,
    close: async () => amqpConn.close(),
  };

  const worker = new WorkerService({
    pgPool,
    redisClient,
    amqpConnection: amqpClient,
    logger,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down worker gracefully");
    await worker.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.start();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal worker startup error");
  process.exit(1);
});
