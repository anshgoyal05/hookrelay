import type { FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import {
  parseApiKey,
  verifyApiKeySecret,
  performDummyComparison,
  verifyAdminToken,
  createProblemDetails,
  PROBLEM_TYPES,
  type LastUsedThrottler,
} from "@hookrelay/shared";
import crypto from "node:crypto";

export interface AuthMiddlewareOptions {
  pgPool: Pool;
  adminToken?: string;
  throttler: LastUsedThrottler;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId?: string;
    keyId?: string;
  }
}

/**
 * Creates admin token preHandler.
 * Fails closed if ADMIN_TOKEN is not configured or shorter than 32 characters.
 */
export function createAdminAuth(options: { adminToken?: string }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Fail closed: if ADMIN_TOKEN is unset or invalid, return 503 Service Unavailable
    if (!options.adminToken || options.adminToken.length < 32) {
      const problem = createProblemDetails({
        type: PROBLEM_TYPES.SERVICE_UNAVAILABLE,
        title: "Admin API Disabled",
        status: 503,
        detail: "ADMIN_TOKEN is not configured on this server.",
        instance: request.url,
        request_id: request.id,
      });

      return reply
        .type("application/problem+json")
        .status(503)
        .send(problem);
    }

    const authHeader = request.headers.authorization;
    if (
      !authHeader ||
      authHeader.length > 200 ||
      !authHeader.startsWith("Bearer ")
    ) {
      reply.header("WWW-Authenticate", "Bearer");
      const problem = createProblemDetails({
        type: PROBLEM_TYPES.UNAUTHORIZED,
        title: "Unauthorized",
        status: 401,
        detail: "Invalid or missing bearer token.",
        instance: request.url,
        request_id: request.id,
      });

      return reply
        .type("application/problem+json")
        .status(401)
        .send(problem);
    }

    const token = authHeader.slice(7).trim();
    const isValid = verifyAdminToken(token, options.adminToken);

    if (!isValid) {
      reply.header("WWW-Authenticate", "Bearer");
      const problem = createProblemDetails({
        type: PROBLEM_TYPES.UNAUTHORIZED,
        title: "Unauthorized",
        status: 401,
        detail: "Invalid or missing bearer token.",
        instance: request.url,
        request_id: request.id,
      });

      return reply
        .type("application/problem+json")
        .status(401)
        .send(problem);
    }
  };
}

/**
 * Creates tenant API key preHandler.
 * Enforces timing attack mitigations by performing dummy hash comparisons on unknown prefixes.
 * Returns identical RFC 7807 401 error representations for any authentication failure.
 */
export function createApiKeyAuth(options: {
  pgPool: Pool;
  throttler: LastUsedThrottler;
}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const send401 = () => {
      reply.header("WWW-Authenticate", "Bearer");
      const problem = createProblemDetails({
        type: PROBLEM_TYPES.UNAUTHORIZED,
        title: "Unauthorized",
        status: 401,
        detail: "Invalid or revoked API key.",
        instance: request.url,
        request_id: request.id,
      });

      return reply
        .type("application/problem+json")
        .status(401)
        .send(problem);
    };

    const authHeader = request.headers.authorization;

    // Reject missing, overlength (> 200 chars), or non-Bearer headers before parsing or hashing
    if (
      !authHeader ||
      authHeader.length > 200 ||
      !authHeader.startsWith("Bearer ")
    ) {
      return send401();
    }

    const rawKey = authHeader.slice(7).trim();
    const parsed = parseApiKey(rawKey);

    if (!parsed.valid) {
      // Do dummy work designed to avoid obvious timing differences
      const dummyBuffer = crypto.createHash("sha256").update(rawKey).digest();
      performDummyComparison(dummyBuffer);
      return send401();
    }

    try {
      const res = await options.pgPool.query(
        "SELECT id, tenant_id, key_hash, revoked_at FROM api_keys WHERE key_prefix = $1",
        [parsed.prefix],
      );

      if (res.rows.length === 0) {
        // Unknown prefix: perform dummy constant-time comparison
        performDummyComparison(parsed.hashBuffer);
        return send401();
      }

      const row = res.rows[0] as {
        id: string;
        tenant_id: string;
        key_hash: string;
        revoked_at: Date | null;
      };

      const isMatch = verifyApiKeySecret(row.key_hash, parsed.hashBuffer);

      if (!isMatch || row.revoked_at !== null) {
        return send401();
      }

      // Valid API key
      request.tenantId = row.tenant_id;
      request.keyId = row.id;

      // Record key usage asynchronously (throttled)
      options.throttler.recordUsage(row.id);
    } catch (err) {
      request.log.error({ err }, "Database error during API key authentication");
      const problem = createProblemDetails({
        type: PROBLEM_TYPES.INTERNAL_ERROR,
        title: "Internal Server Error",
        status: 500,
        detail: "Authentication verification encountered an internal error.",
        instance: request.url,
        request_id: request.id,
      });

      return reply
        .type("application/problem+json")
        .status(500)
        .send(problem);
    }
  };
}
