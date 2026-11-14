import { createLogger } from "@hookrelay/shared";
import type { Logger } from "pino";

export interface WorkerPgClient {
  query: (text: string) => Promise<unknown>;
  end?: () => Promise<void>;
}

export interface WorkerRedisClient {
  ping: () => Promise<string>;
  quit?: () => Promise<unknown>;
}

export interface WorkerAmqpClient {
  isConnected: () => boolean;
  close?: () => Promise<unknown>;
}

export interface WorkerDependencies {
  pgPool: WorkerPgClient;
  redisClient: WorkerRedisClient;
  amqpConnection: WorkerAmqpClient;
  logger?: Logger;
}

export class WorkerService {
  private readonly pgPool: WorkerPgClient;
  private readonly redisClient: WorkerRedisClient;
  private readonly amqpConnection: WorkerAmqpClient;
  private readonly logger: Logger;
  private isRunning = false;

  constructor(deps: WorkerDependencies) {
    this.pgPool = deps.pgPool;
    this.redisClient = deps.redisClient;
    this.amqpConnection = deps.amqpConnection;
    this.logger = deps.logger ?? createLogger({ name: "hookrelay-worker" });
  }

  public async start(): Promise<void> {
    this.logger.info("Connecting worker dependencies...");

    // 1. Verify PostgreSQL
    await this.pgPool.query("SELECT 1");

    // 2. Verify Redis
    const pong = await this.redisClient.ping();
    if (pong !== "PONG") {
      throw new Error(`Unexpected Redis ping response: ${pong}`);
    }

    // 3. Verify RabbitMQ
    if (!this.amqpConnection.isConnected()) {
      throw new Error("RabbitMQ connection is not established");
    }

    this.isRunning = true;

    // Structured JSON log requirement: "worker_ready"
    this.logger.info(
      {
        service: "worker",
        status: "connected",
        postgres: "ok",
        redis: "ok",
        rabbitmq: "ok",
      },
      "worker_ready",
    );
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.logger.info("Stopping worker service...");

    try {
      if (this.amqpConnection.close) {
        await this.amqpConnection.close();
      }
      if (this.redisClient.quit) {
        await this.redisClient.quit();
      }
      if (this.pgPool.end) {
        await this.pgPool.end();
      }
    } catch (err) {
      this.logger.error({ err }, "Error during worker service shutdown");
    } finally {
      this.isRunning = false;
      this.logger.info("Worker service stopped cleanly");
    }
  }

  public get active(): boolean {
    return this.isRunning;
  }
}
