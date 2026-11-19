import { z } from "zod";

/**
 * Note on environment file loading:
 * When using Node's built-in `--env-file` or `--env-file-if-exists` flags, variables
 * defined in the loaded env file will NEVER override variables already set in the shell
 * or parent process environment. Shell-provided variables always take strict precedence.
 */

// 1. Database Configuration (used by migrations, scripts, and runtime)
export const DatabaseConfigSchema = z.object({
  DATABASE_URL: z
    .string({
      required_error: "DATABASE_URL is required (e.g. postgres://user:pass@127.0.0.1:5433/db)",
    })
    .min(1, "DATABASE_URL cannot be empty"),
});

// 2. Migration Configuration (minimal concern: only requires database connection)
export const MigrateConfigSchema = DatabaseConfigSchema;

// 3. Redis Configuration
export const RedisConfigSchema = z.object({
  REDIS_URL: z
    .string({
      required_error: "REDIS_URL is required (e.g. redis://127.0.0.1:6380)",
    })
    .min(1, "REDIS_URL cannot be empty"),
});

// 4. RabbitMQ Configuration
export const RabbitMqConfigSchema = z.object({
  RABBITMQ_URL: z
    .string({
      required_error: "RABBITMQ_URL is required (e.g. amqp://guest:guest@127.0.0.1:5673)",
    })
    .min(1, "RABBITMQ_URL cannot be empty"),
});

// 5. Server Runtime Configuration
export const ServerConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

// 6. Security and Quota Limits Configuration
export const SecurityLimitsConfigSchema = z.object({
  MAX_ACTIVE_KEYS_PER_TENANT: z.coerce.number().int().min(1).default(20),
  ALLOW_PRIVATE_TARGETS: z.coerce.boolean().default(false),
  MAX_ENDPOINTS_PER_TENANT: z.coerce.number().int().min(1).default(50),
  SECRET_ROTATION_GRACE_SECONDS: z.coerce.number().int().min(60).default(86400),
});

// 7. Encryption and Admin Credentials Configuration
export const EncryptionAdminConfigSchema = z.object({
  ADMIN_TOKEN: z
    .string()
    .min(32, "ADMIN_TOKEN must be at least 32 characters if configured")
    .optional(),
  ENCRYPTION_KEY: z
    .string({
      required_error: "ENCRYPTION_KEY is required (generate with: openssl rand -hex 32)",
    })
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"),
});

// Full Application Configuration Schema
export const ConfigSchema = ServerConfigSchema
  .merge(DatabaseConfigSchema)
  .merge(RedisConfigSchema)
  .merge(RabbitMqConfigSchema)
  .merge(SecurityLimitsConfigSchema)
  .merge(EncryptionAdminConfigSchema)
  .refine(
    (data) => !(data.NODE_ENV === "production" && data.ALLOW_PRIVATE_TARGETS === true),
    {
      message: "ALLOW_PRIVATE_TARGETS cannot be enabled when NODE_ENV is 'production'",
      path: ["ALLOW_PRIVATE_TARGETS"],
    },
  )
  .refine(
    (data) => {
      const placeholder = "0000000000000000000000000000000000000000000000000000000000000000";
      if (data.NODE_ENV !== "test" && data.ENCRYPTION_KEY === placeholder) {
        return false;
      }
      return true;
    },
    {
      message: "ENCRYPTION_KEY placeholder cannot be used outside test environments. Generate with: openssl rand -hex 32",
      path: ["ENCRYPTION_KEY"],
    },
  );

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type MigrateConfig = z.infer<typeof MigrateConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type RabbitMqConfig = z.infer<typeof RabbitMqConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type SecurityLimitsConfig = z.infer<typeof SecurityLimitsConfigSchema>;
export type EncryptionAdminConfig = z.infer<typeof EncryptionAdminConfigSchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigValidationError extends Error {
  public readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    // Only format field path and message; never output raw secret values or env contents
    const formattedIssues = issues
      .map((issue) => `  - ${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("\n");
    super(`Configuration validation failed:\n${formattedIssues}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Loads and validates only database configuration.
 * Used by migrations and database maintenance scripts that do not need Redis, RabbitMQ or secrets.
 */
export function loadDatabaseConfig(env: Record<string, string | undefined> = process.env): DatabaseConfig {
  const result = DatabaseConfigSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }
  return result.data;
}

/**
 * Alias for loadDatabaseConfig.
 */
export function loadMigrateConfig(env: Record<string, string | undefined> = process.env): MigrateConfig {
  return loadDatabaseConfig(env);
}

/**
 * Loads and validates full application environment variables.
 * Fails fast with clear actionable error output if any required configuration is missing or invalid.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }
  return result.data;
}
