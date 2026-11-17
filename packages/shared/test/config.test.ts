import { describe, it, expect } from "vitest";
import { loadConfig, ConfigValidationError } from "../src/config.js";

describe("packages/shared - config loader", () => {
  it("fails fast when required environment variables are missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigValidationError);

    try {
      loadConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationError = err as ConfigValidationError;
      const missingKeys = validationError.issues.map((i) => i.path[0]);
      expect(missingKeys).toContain("DATABASE_URL");
      expect(missingKeys).toContain("REDIS_URL");
      expect(missingKeys).toContain("RABBITMQ_URL");
      expect(missingKeys).toContain("ENCRYPTION_KEY");
    }
  });

  it("loads and applies defaults when all required variables are present", () => {
    const validEnv = {
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hookrelay",
      REDIS_URL: "redis://localhost:6379",
      RABBITMQ_URL: "amqp://guest:guest@localhost:5672",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };

    const config = loadConfig(validEnv);

    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.REDIS_URL).toBe(validEnv.REDIS_URL);
    expect(config.RABBITMQ_URL).toBe(validEnv.RABBITMQ_URL);
    expect(config.ENCRYPTION_KEY).toBe(validEnv.ENCRYPTION_KEY);
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.MAX_ENDPOINTS_PER_TENANT).toBe(50);
    expect(config.SECRET_ROTATION_GRACE_SECONDS).toBe(86400);
  });

  it("rejects placeholder ENCRYPTION_KEY outside test environments", () => {
    const placeholderEnv = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hookrelay",
      REDIS_URL: "redis://localhost:6379",
      RABBITMQ_URL: "amqp://guest:guest@localhost:5672",
      ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    expect(() => loadConfig(placeholderEnv)).toThrow(ConfigValidationError);
  });

  it("accepts placeholder ENCRYPTION_KEY in test environment", () => {
    const placeholderTestEnv = {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hookrelay",
      REDIS_URL: "redis://localhost:6379",
      RABBITMQ_URL: "amqp://guest:guest@localhost:5672",
      ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const config = loadConfig(placeholderTestEnv);
    expect(config.ENCRYPTION_KEY).toBe(placeholderTestEnv.ENCRYPTION_KEY);
  });

  it("fails when an invalid port or log level is provided", () => {
    const invalidEnv = {
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hookrelay",
      REDIS_URL: "redis://localhost:6379",
      RABBITMQ_URL: "amqp://guest:guest@localhost:5672",
      PORT: "not-a-number",
      LOG_LEVEL: "unsupported_level",
    };

    expect(() => loadConfig(invalidEnv)).toThrow(ConfigValidationError);
  });
});
