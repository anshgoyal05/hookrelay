export type ComponentStatus = "ok" | "degraded" | "down";

export interface ReadinessChecks {
  postgres: ComponentStatus;
  redis: ComponentStatus;
  rabbitmq: ComponentStatus;
}

export interface ReadinessResult {
  status: "ready" | "unhealthy";
  checks: ReadinessChecks;
  timestamp: string;
}

export interface LivenessResult {
  status: "ok";
  timestamp: string;
}

/**
 * RFC 7807 Problem Details representation.
 * https://datatracker.ietf.org/doc/html/rfc7807
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  invalidParams?: Array<{
    name: string;
    reason: string;
  }>;
  [key: string]: unknown;
}
