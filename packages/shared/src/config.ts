import { z } from "zod";

export const ConfigSchema = z.object({
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
});

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
