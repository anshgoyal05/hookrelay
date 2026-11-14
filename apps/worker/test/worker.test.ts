import { describe, it, expect, vi } from "vitest";
import { WorkerService, type WorkerDependencies } from "../src/worker.js";
import { createLogger } from "@hookrelay/shared";

describe("apps/worker - WorkerService Lifecycle", () => {
  it("starts successfully, connects to all dependencies, and becomes active", async () => {
    const infoSpy = vi.fn();
    const mockLogger = {
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    } as unknown as ReturnType<typeof createLogger>;

    const deps: WorkerDependencies = {
      pgPool: { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn().mockResolvedValue(undefined) },
      redisClient: { ping: vi.fn().mockResolvedValue("PONG"), quit: vi.fn().mockResolvedValue("OK") },
      amqpConnection: { isConnected: vi.fn().mockReturnValue(true), close: vi.fn().mockResolvedValue(undefined) },
      logger: mockLogger,
    };

    const worker = new WorkerService(deps);
    await worker.start();

    expect(worker.active).toBe(true);
    expect(deps.pgPool.query).toHaveBeenCalledWith("SELECT 1");
    expect(deps.redisClient.ping).toHaveBeenCalled();
    expect(deps.amqpConnection.isConnected).toHaveBeenCalled();

    // Verify structured "worker_ready" log
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "worker",
        status: "connected",
        postgres: "ok",
        redis: "ok",
        rabbitmq: "ok",
      }),
      "worker_ready",
    );

    // Stop worker and check cleanup
    await worker.stop();
    expect(worker.active).toBe(false);
    expect(deps.amqpConnection.close).toHaveBeenCalled();
    expect(deps.redisClient.quit).toHaveBeenCalled();
    expect(deps.pgPool.end).toHaveBeenCalled();
  });

  it("fails to start if RabbitMQ connection is down", async () => {
    const deps: WorkerDependencies = {
      pgPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      redisClient: { ping: vi.fn().mockResolvedValue("PONG") },
      amqpConnection: { isConnected: vi.fn().mockReturnValue(false) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() } as unknown as ReturnType<typeof createLogger>,
    };

    const worker = new WorkerService(deps);
    await expect(worker.start()).rejects.toThrow("RabbitMQ connection is not established");
    expect(worker.active).toBe(false);
  });

  it("fails to start if PostgreSQL query throws", async () => {
    const deps: WorkerDependencies = {
      pgPool: {
        query: vi.fn().mockRejectedValue(new Error("Connection timeout")),
      },
      redisClient: { ping: vi.fn().mockResolvedValue("PONG") },
      amqpConnection: { isConnected: vi.fn().mockReturnValue(true) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() } as unknown as ReturnType<typeof createLogger>,
    };

    const worker = new WorkerService(deps);
    await expect(worker.start()).rejects.toThrow("Connection timeout");
    expect(worker.active).toBe(false);
  });
});
