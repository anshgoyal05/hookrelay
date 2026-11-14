import pg from "pg";
import { Redis } from "ioredis";
import amqp from "amqplib";
import { loadConfig, createLogger } from "@hookrelay/shared";
import { buildServer, type AmqpCheckable } from "./server.js";

const logger = createLogger({ name: "hookrelay-api" });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.fatal({ err }, "Failed to validate configuration. Exiting.");
    process.exit(1);
  }

  logger.info({ nodeEnv: config.NODE_ENV, port: config.PORT }, "Initializing HookRelay API");

  // 1. Initialize PostgreSQL pool
  const pgPool = new pg.Pool({
    connectionString: config.DATABASE_URL,
  });

  // 2. Initialize Redis client
  const redisClient = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redisClient.connect().catch((err) => {
    logger.warn({ err }, "Redis initial connection deferred/failed");
  });

  // 3. Initialize RabbitMQ connection
  let isAmqpReady = false;
  let amqpConn: amqp.ChannelModel | null = null;
  try {
    amqpConn = await amqp.connect(config.RABBITMQ_URL);
    isAmqpReady = true;
    amqpConn.on("close", () => {
      isAmqpReady = false;
      logger.warn("RabbitMQ connection closed");
    });
    amqpConn.on("error", (err) => {
      isAmqpReady = false;
      logger.warn({ err }, "RabbitMQ connection error");
    });
  } catch (err) {
    logger.warn({ err }, "RabbitMQ initial connection failed");
  }

  const amqpCheckable: AmqpCheckable = {
    isConnected: () => isAmqpReady,
  };

  const app = buildServer({
    pgPool,
    redisClient,
    amqpConnection: amqpCheckable,
    logger,
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down API server gracefully");
    try {
      await app.close();
      await pgPool.end();
      await redisClient.quit().catch(() => {});
      if (amqpConn) {
        await amqpConn.close().catch(() => {});
      }
      logger.info("API server shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info({ port: config.PORT }, "HookRelay API listening");
  } catch (err) {
    logger.fatal({ err }, "Failed to start API server");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
