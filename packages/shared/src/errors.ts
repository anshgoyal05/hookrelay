import type { ProblemDetails } from "./types/index.js";

export const PROBLEM_TYPES = {
  BAD_REQUEST: "https://hookrelay.dev/problems/bad-request",
  VALIDATION_ERROR: "https://hookrelay.dev/problems/validation-error",
  UNAUTHORIZED: "https://hookrelay.dev/problems/unauthorized",
  FORBIDDEN: "https://hookrelay.dev/problems/forbidden",
  NOT_FOUND: "https://hookrelay.dev/problems/not-found",
  SERVICE_UNAVAILABLE: "https://hookrelay.dev/problems/service-unavailable",
  INTERNAL_ERROR: "https://hookrelay.dev/problems/internal-server-error",
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
  extensions?: Record<string, unknown>;
}): ProblemDetails {
  const {
    type = "about:blank",
    title,
    status,
    detail,
    instance,
    invalidParams,
    extensions = {},
  } = options;

  return {
    type,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
    ...(invalidParams && invalidParams.length > 0 ? { invalidParams } : {}),
    ...extensions,
  };
}
