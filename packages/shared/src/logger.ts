import pino from "pino";

export interface LogContext {
  request_id?: string;
  tenant_id?: string;
  event_id?: string;
  delivery_id?: string;
  [key: string]: unknown;
}

/**
 * Creates a structured JSON Pino logger.
 * Invariant 4: Secrets (API keys, signing secrets) are NEVER logged.
 * Pino redaction is enforced at the logger configuration level.
 */
export function createLogger(
  options?: {
    name?: string;
    level?: string;
    bindings?: LogContext;
  },
  destination?: pino.DestinationStream,
): pino.Logger {
  const { name = "hookrelay", level = process.env.LOG_LEVEL || "info", bindings = {} } =
    options || {};

  const pinoOpts: pino.LoggerOptions = {
    name,
    level,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "api_key",
        "*.api_key",
        "api_key.key",
        "*.api_key.key",
        "key",
        "*.key",
        "secret",
        "*.secret",
        "signingSecret",
        "*.signingSecret",
        "password",
        "*.password",
        "authorization",
        "headers.authorization",
        "headers['authorization']",
        "*.authorization",
        "req.headers.authorization",
        "req.headers['authorization']",
        "*.req.headers.authorization",
        "adminToken",
        "*.adminToken",
        "ADMIN_TOKEN",
      ],
      censor: "[REDACTED]",
    },
    base: bindings,
  };

  return destination ? pino(pinoOpts, destination) : pino(pinoOpts);
}
