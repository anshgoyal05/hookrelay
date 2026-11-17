import { z } from "zod";

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    DATABASE_URL: z
      .string({
        required_error: "DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/db)",
      })
      .min(1, "DATABASE_URL cannot be empty"),
    REDIS_URL: z
      .string({
        required_error: "REDIS_URL is required (e.g. redis://localhost:6379)",
      })
      .min(1, "REDIS_URL cannot be empty"),
    RABBITMQ_URL: z
      .string({
        required_error: "RABBITMQ_URL is required (e.g. amqp://guest:guest@localhost:5672)",
      })
      .min(1, "RABBITMQ_URL cannot be empty"),
    ADMIN_TOKEN: z
      .string()
      .min(32, "ADMIN_TOKEN must be at least 32 characters if configured")
      .optional(),
    MAX_ACTIVE_KEYS_PER_TENANT: z.coerce.number().int().min(1).default(20),
    ALLOW_PRIVATE_TARGETS: z.coerce.boolean().default(false),
    ENCRYPTION_KEY: z
      .string({
        required_error: "ENCRYPTION_KEY is required (generate with: openssl rand -hex 32)",
      })
      .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"),
    MAX_ENDPOINTS_PER_TENANT: z.coerce.number().int().min(1).default(50),
    SECRET_ROTATION_GRACE_SECONDS: z.coerce.number().int().min(60).default(86400),
  })
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

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigValidationError extends Error {
  public readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    const formattedIssues = issues
      .map((issue) => `  - ${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("\n");
    super(`Configuration validation failed:\n${formattedIssues}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Loads and validates environment variables.
 * Fails fast with clear actionable error output if any configuration is missing or invalid.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }

  return result.data;
}
