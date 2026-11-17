import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface DatabaseWriter {
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}

export interface ThrottlerOptions {
  redisClient?: Redis | null;
  db: DatabaseWriter;
  logger?: Logger;
  throttleSeconds?: number;
  maxMemoryEntries?: number;
}

export class LastUsedThrottler {
  private readonly redis?: Redis | null;
  private readonly db: DatabaseWriter;
  private readonly logger?: Logger;
  private readonly throttleSeconds: number;
  private readonly maxMemoryEntries: number;

  private memoryCache = new Map<string, number>();
  private lastRedisErrorLog = 0;

  constructor(options: ThrottlerOptions) {
    this.redis = options.redisClient;
    this.db = options.db;
    this.logger = options.logger;
    this.throttleSeconds = options.throttleSeconds ?? 60;
    this.maxMemoryEntries = options.maxMemoryEntries ?? 5000;
  }

  /**
   * Records key usage, throttled to at most once per minute per key.
   * Swallows any Redis failures, logs them throttled, and falls back to a bounded in-memory cache.
   */
  public recordUsage(keyId: string): void {
    if (this.redis && this.redis.status === "ready") {
      this.recordViaRedis(keyId);
    } else {
      this.recordViaMemory(keyId);
    }
  }

  private recordViaRedis(keyId: string): void {
    const redisKey = `key_last_used:${keyId}`;
    this.redis!
      .set(redisKey, "1", "EX", this.throttleSeconds, "NX")
      .then((res) => {
        if (res === "OK") {
          this.triggerDatabaseUpdate(keyId);
        }
      })
      .catch((err) => {
        this.logRedisErrorThrottled(err);
        this.recordViaMemory(keyId);
      });
  }

  private recordViaMemory(keyId: string): void {
    const now = Date.now();
    const lastTime = this.memoryCache.get(keyId);

    if (lastTime && now - lastTime < this.throttleSeconds * 1000) {
      return;
    }

    // Sweep if cache is getting too large
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      this.sweepMemoryCache(now);
    }

    this.memoryCache.set(keyId, now);
    this.triggerDatabaseUpdate(keyId);
  }

  private sweepMemoryCache(now: number): void {
    const expirationMs = this.throttleSeconds * 1000;
    for (const [id, timestamp] of this.memoryCache.entries()) {
      if (now - timestamp > expirationMs) {
        this.memoryCache.delete(id);
      }
    }
  }

  private triggerDatabaseUpdate(keyId: string): void {
    this.db
      .query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [keyId])
      .catch((err) => {
        this.logger?.warn({ err: (err as Error)?.message, keyId }, "Failed to update last_used_at");
      });
  }

  private logRedisErrorThrottled(err: unknown): void {
    const now = Date.now();
    if (now - this.lastRedisErrorLog >= 30_000) {
      this.lastRedisErrorLog = now;
      this.logger?.warn(
        { err: (err as Error)?.message || err },
        "Redis error in last_used_at throttle; falling back to in-memory cache",
      );
    }
  }

  public get memoryCacheSize(): number {
    return this.memoryCache.size;
  }
}
