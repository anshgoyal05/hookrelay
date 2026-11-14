import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AmqpConnectionManager } from "../src/amqp.js";
import { createLogger } from "../src/logger.js";
import type amqp from "amqplib";

const silentLogger = createLogger({ name: "test-amqp", level: "silent" });

class FakeChannel extends EventEmitter {
  public closed = false;
  async close() {
    this.closed = true;
    this.emit("close");
  }
}

class FakeConnection extends EventEmitter {
  public channel = new FakeChannel();
  public closed = false;

  async createChannel(): Promise<amqp.Channel> {
    return this.channel as unknown as amqp.Channel;
  }

  async close() {
    this.closed = true;
    this.emit("close");
  }
}

describe("packages/shared - AmqpConnectionManager", () => {
  it("connects and exposes isReady() === true", async () => {
    const fakeConn = new FakeConnection();
    const connectFn = vi.fn().mockResolvedValue(fakeConn);

    const manager = new AmqpConnectionManager({
      url: "amqp://localhost",
      logger: silentLogger,
      connectFn,
    });

    expect(manager.isReady()).toBe(false);
    await manager.start();

    expect(connectFn).toHaveBeenCalledWith("amqp://localhost");
    expect(manager.isReady()).toBe(true);

    await manager.close();
    expect(manager.isReady()).toBe(false);
  });

  it("handles connection drop and reconnects automatically", async () => {
    let connectCount = 0;
    let currentConn: FakeConnection | null = null;

    const connectFn = vi.fn().mockImplementation(async () => {
      connectCount++;
      currentConn = new FakeConnection();
      return currentConn;
    });

    const manager = new AmqpConnectionManager({
      url: "amqp://localhost",
      logger: silentLogger,
      initialBackoffMs: 20,
      maxBackoffMs: 100,
      jitterRatio: 0,
      connectFn,
    });

    await manager.start();
    expect(manager.isReady()).toBe(true);
    expect(connectCount).toBe(1);

    // Simulate connection drop
    currentConn!.emit("close");
    expect(manager.isReady()).toBe(false);

    // Wait for reconnect timer
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(connectCount).toBe(2);
    expect(manager.isReady()).toBe(true);

    await manager.close();
  });

  it("handles channel error and reconnects", async () => {
    let connectCount = 0;
    let currentConn: FakeConnection | null = null;

    const connectFn = vi.fn().mockImplementation(async () => {
      connectCount++;
      currentConn = new FakeConnection();
      return currentConn;
    });

    const manager = new AmqpConnectionManager({
      url: "amqp://localhost",
      logger: silentLogger,
      initialBackoffMs: 20,
      maxBackoffMs: 100,
      jitterRatio: 0,
      connectFn,
    });

    await manager.start();
    expect(manager.isReady()).toBe(true);

    // Simulate channel error
    currentConn!.channel.emit("error", new Error("Channel exception"));
    expect(manager.isReady()).toBe(false);

    // Wait for reconnect timer
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(connectCount).toBe(2);
    expect(manager.isReady()).toBe(true);

    await manager.close();
  });

  it("close() cancels pending reconnection cleanly", async () => {
    let connectCount = 0;
    const connectFn = vi.fn().mockImplementation(async () => {
      connectCount++;
      if (connectCount === 1) {
        return new FakeConnection();
      }
      throw new Error("Connection refused");
    });

    const manager = new AmqpConnectionManager({
      url: "amqp://localhost",
      logger: silentLogger,
      initialBackoffMs: 50,
      connectFn,
    });

    await manager.start();
    expect(manager.isReady()).toBe(true);

    // Simulate disconnect and immediate close
    const conn = manager.getConnection() as unknown as FakeConnection;
    conn.emit("close");
    expect(manager.isReady()).toBe(false);

    // Immediate close while reconnect is scheduled
    await manager.close();

    // Wait past scheduled timer
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Must NOT have attempted second connect after close
    expect(connectCount).toBe(1);
    expect(manager.isReady()).toBe(false);
  });
});
