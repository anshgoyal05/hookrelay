import amqp from "amqplib";
import type { Logger } from "pino";
import { createLogger } from "./logger.js";

export interface AmqpConnectionManagerOptions {
  url: string;
  logger?: Logger;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  jitterRatio?: number;
  connectFn?: (url: string) => Promise<amqp.ChannelModel>;
}

/**
 * Resilient RabbitMQ connection and channel manager.
 * Features:
 * - Exponential backoff with randomized jitter
 * - Resets backoff on successful connection
 * - Listens for both connection and channel errors/closes
 * - Allows only one reconnect loop at a time
 * - Safe close() during active reconnection
 * - Clean state exposure via isReady()
 */
export class AmqpConnectionManager {
  private readonly url: string;
  private readonly logger: Logger;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly jitterRatio: number;
  private readonly connectFn: (url: string) => Promise<amqp.ChannelModel>;

  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private isConnected = false;
  private isClosing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private currentBackoffMs: number;

  constructor(options: AmqpConnectionManagerOptions) {
    this.url = options.url;
    this.logger = options.logger ?? createLogger({ name: "amqp-manager" });
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 5000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.connectFn = options.connectFn ?? ((url: string) => amqp.connect(url));
    this.currentBackoffMs = this.initialBackoffMs;
  }

  public async start(): Promise<void> {
    if (this.isClosing) return;
    await this.connect();
  }

  public isReady(): boolean {
    return this.isConnected && !this.isClosing && this.connection !== null;
  }

  public getConnection(): amqp.ChannelModel | null {
    return this.connection;
  }

  public getChannel(): amqp.Channel | null {
    return this.channel;
  }

  public async close(): Promise<void> {
    this.isClosing = true;
    this.isConnected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;

    if (this.channel) {
      try {
        await this.channel.close();
      } catch {
        // Ignore close error during teardown
      }
      this.channel = null;
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // Ignore close error during teardown
      }
      this.connection = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.isClosing) return;

    try {
      this.logger.debug("Attempting to connect to RabbitMQ...");
      const conn = await this.connectFn(this.url);
      this.connection = conn;

      conn.on("error", (err) => {
        if (!this.isClosing) {
          this.logger.warn({ err: err?.message || err }, "RabbitMQ connection error");
          this.handleDisconnect();
        }
      });

      conn.on("close", () => {
        if (!this.isClosing) {
          this.logger.warn("RabbitMQ connection closed");
          this.handleDisconnect();
        }
      });

      try {
        const ch = await conn.createChannel();
        this.channel = ch;

        ch.on("error", (err) => {
          if (!this.isClosing) {
            this.logger.warn({ err: err?.message || err }, "RabbitMQ channel error");
            this.handleDisconnect();
          }
        });

        ch.on("close", () => {
          if (!this.isClosing && this.isConnected) {
            this.logger.warn("RabbitMQ channel closed");
            this.handleDisconnect();
          }
        });
      } catch (chErr) {
        this.logger.warn(
          { err: (chErr as Error)?.message },
          "Failed to open AMQP channel on connection",
        );
        this.handleDisconnect();
        return;
      }

      this.isConnected = true;
      this.currentBackoffMs = this.initialBackoffMs; // Reset backoff on success
      this.isReconnecting = false;
      this.logger.info("RabbitMQ connection and channel established successfully");
    } catch (err) {
      this.logger.warn(
        { err: (err as Error)?.message },
        "RabbitMQ connection attempt failed",
      );
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    this.isConnected = false;
    this.connection = null;
    this.channel = null;

    if (this.isClosing || this.isReconnecting) {
      return; // Allow only one reconnect loop at a time
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isClosing || this.isReconnecting) return;
    this.isReconnecting = true;

    // Apply backoff + jitter
    const jitter = (Math.random() * 2 - 1) * this.jitterRatio * this.currentBackoffMs;
    const delay = Math.max(50, Math.floor(this.currentBackoffMs + jitter));

    this.logger.info({ delayMs: delay }, "Scheduling RabbitMQ reconnection");

    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * this.backoffMultiplier,
      this.maxBackoffMs,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isClosing) {
        this.isReconnecting = false;
        return;
      }
      this.isReconnecting = false;
      await this.connect();
    }, delay);
  }
}
