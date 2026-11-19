import { describe, it, expect } from "vitest";
import {
  loadConfig,
  loadDatabaseConfig,
  loadMigrateConfig,
  ConfigValidationError,
} from "../src/config.js";

describe("packages/shared - config loader", () => {
  describe("loadDatabaseConfig (migrate concern)", () => {
    it("succeeds with ONLY DATABASE_URL provided", () => {
      const config = loadDatabaseConfig({
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
      });
      expect(config.DATABASE_URL).toBe("postgres://postgres:postgres@127.0.0.1:5433/hookrelay");
    });

    it("loadMigrateConfig alias also succeeds with ONLY DATABASE_URL", () => {
      const config = loadMigrateConfig({
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
      });
      expect(config.DATABASE_URL).toBe("postgres://postgres:postgres@127.0.0.1:5433/hookrelay");
    });

    it("fails fast when DATABASE_URL is missing", () => {
      expect(() => loadDatabaseConfig({})).toThrow(ConfigValidationError);
      try {
        loadDatabaseConfig({});
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        const valErr = err as ConfigValidationError;
        expect(valErr.issues.map((i) => i.path[0])).toEqual(["DATABASE_URL"]);
      }
    });
  });

  describe("loadConfig (full app concern)", () => {
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

    it("error message never echoes raw environment variable values", () => {
      try {
        loadConfig({
          DATABASE_URL: "postgres://my-super-secret-password-1234@localhost:5433/db",
          ENCRYPTION_KEY: "short",
        });
      } catch (err) {
        const valErr = err as ConfigValidationError;
        expect(valErr.message).not.toContain("my-super-secret-password-1234");
        expect(valErr.message).toContain("Configuration validation failed:");
      }
    });

    it("loads and applies defaults when all required variables are present", () => {
      const validEnv = {
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
        REDIS_URL: "redis://127.0.0.1:6380",
        RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
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
      expect(config.ADMIN_TOKEN).toBeUndefined();
    });

    it("allows optional ADMIN_TOKEN if >= 32 chars", () => {
      const token = "a".repeat(32);
      const config = loadConfig({
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
        REDIS_URL: "redis://127.0.0.1:6380",
        RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
        ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ADMIN_TOKEN: token,
      });
      expect(config.ADMIN_TOKEN).toBe(token);
    });

    it("rejects ADMIN_TOKEN if shorter than 32 chars", () => {
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
          REDIS_URL: "redis://127.0.0.1:6380",
          RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
          ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          ADMIN_TOKEN: "too-short",
        }),
      ).toThrow(ConfigValidationError);
    });

    it("rejects ALLOW_PRIVATE_TARGETS=true when NODE_ENV is production", () => {
      expect(() =>
        loadConfig({
          NODE_ENV: "production",
          ALLOW_PRIVATE_TARGETS: "true",
          DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
          REDIS_URL: "redis://127.0.0.1:6380",
          RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
          ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }),
      ).toThrow(ConfigValidationError);
    });

    it("rejects placeholder ENCRYPTION_KEY outside test environments", () => {
      const placeholderEnv = {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
        REDIS_URL: "redis://127.0.0.1:6380",
        RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
        ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
      };

      expect(() => loadConfig(placeholderEnv)).toThrow(ConfigValidationError);
    });

    it("accepts placeholder ENCRYPTION_KEY in test environment", () => {
      const placeholderTestEnv = {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
        REDIS_URL: "redis://127.0.0.1:6380",
        RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
        ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
      };

      const config = loadConfig(placeholderTestEnv);
      expect(config.ENCRYPTION_KEY).toBe(placeholderTestEnv.ENCRYPTION_KEY);
    });

    it("fails when an invalid port or log level is provided", () => {
      const invalidEnv = {
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/hookrelay",
        REDIS_URL: "redis://127.0.0.1:6380",
        RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:5673",
        PORT: "not-a-number",
        LOG_LEVEL: "unsupported_level",
      };

      expect(() => loadConfig(invalidEnv)).toThrow(ConfigValidationError);
    });
  });
});
