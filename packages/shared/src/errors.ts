import type { ProblemDetails } from "./types/index.js";

export const PROBLEM_TYPES = {
  BAD_REQUEST: "urn:hookrelay:problem:bad-request",
  VALIDATION_ERROR: "urn:hookrelay:problem:validation-error",
  UNAUTHORIZED: "urn:hookrelay:problem:unauthorized",
  FORBIDDEN: "urn:hookrelay:problem:forbidden",
  NOT_FOUND: "urn:hookrelay:problem:not-found",
  CONFLICT: "urn:hookrelay:problem:conflict",
  LAST_ACTIVE_KEY: "urn:hookrelay:problem:last-active-key",
  KEY_LIMIT_REACHED: "urn:hookrelay:problem:key-limit-reached",
  SERVICE_UNAVAILABLE: "urn:hookrelay:problem:service-unavailable",
  ADMIN_DISABLED: "urn:hookrelay:problem:admin-disabled",
  INTERNAL_ERROR: "urn:hookrelay:problem:internal-server-error",
} as const;

export class ProblemError extends Error {
  public readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title);
    this.name = "ProblemError";
    this.problem = problem;
  }
}

export function createProblemDetails(options: {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  invalidParams?: Array<{ name: string; reason: string }>;
  request_id?: string;
  extensions?: Record<string, unknown>;
}): ProblemDetails {
  const {
    type = "about:blank",
    title,
    status,
    detail,
    instance,
    invalidParams,
    request_id,
    extensions = {},
  } = options;

  return {
    type,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
    ...(request_id ? { request_id } : {}),
    ...(invalidParams && invalidParams.length > 0 ? { invalidParams } : {}),
    ...extensions,
  };
}
