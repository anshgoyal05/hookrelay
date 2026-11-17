import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  generateApiKey,
  createProblemDetails,
  PROBLEM_TYPES,
  type LastUsedThrottler,
} from "@hookrelay/shared";
import { createApiKeyAuth } from "../middleware/auth.js";

const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(128, "name cannot exceed 128 characters"),
});

const ApiKeyParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

const RevokeQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
});

export interface ApiKeyRoutesOptions {
  pgPool: Pool;
  throttler: LastUsedThrottler;
  maxActiveKeys?: number;
}

export const apiKeyRoutes: FastifyPluginAsync<ApiKeyRoutesOptions> = async (
  fastify,
  options,
) => {
  const apiKeyAuth = createApiKeyAuth({
    pgPool: options.pgPool,
    throttler: options.throttler,
  });

  const maxActiveKeys = options.maxActiveKeys ?? 20;

  // POST /v1/api-keys - Create a new API key for the authenticated tenant
  fastify.post(
    "/v1/api-keys",
    { preHandler: apiKeyAuth },
    async (request, reply) => {
      const parseResult = CreateApiKeySchema.safeParse(request.body);
      if (!parseResult.success) {
        const problem = createProblemDetails({
          type: PROBLEM_TYPES.VALIDATION_ERROR,
          title: "Validation Error",
          status: 400,
          detail: "Invalid request payload.",
          instance: request.url,
          request_id: request.id,
          invalidParams: parseResult.error.issues.map((i) => ({
            name: i.path.join(".") || "body",
            reason: i.message,
          })),
        });

        return reply
          .type("application/problem+json")
          .status(400)
          .send(problem);
      }

      const { name } = parseResult.data;
      const tenantId = request.tenantId!;

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");

        // Enforce active key cap per tenant
        const activeKeysRes = await client.query(
          "SELECT id FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL FOR UPDATE",
          [tenantId],
        );
        const activeCount = activeKeysRes.rows.length;

        if (activeCount >= maxActiveKeys) {
          await client.query("ROLLBACK");
          const problem = createProblemDetails({
            type: PROBLEM_TYPES.KEY_LIMIT_REACHED,
            title: "Active Key Limit Reached",
            status: 409,
            detail: `Tenant has reached the maximum of ${maxActiveKeys} active API keys.`,
            instance: request.url,
            request_id: request.id,
          });

          return reply
            .type("application/problem+json")
            .status(409)
            .send(problem);
        }

        const keyMaterial = generateApiKey();
        const insertRes = await client.query(
          "INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, created_at",
          [tenantId, name, keyMaterial.prefix, keyMaterial.hash],
        );
        const keyRow = insertRes.rows[0];

        await client.query("COMMIT");

        reply.header("Cache-Control", "no-store");

        return reply.status(201).send({
          id: keyRow.id,
          name: keyRow.name,
          prefix: keyRow.key_prefix,
          key: keyMaterial.key, // RETURNED EXACTLY ONCE
          created_at: keyRow.created_at,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error({ err }, "Failed to create API key");
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // GET /v1/api-keys - List API keys for the authenticated tenant
  fastify.get(
    "/v1/api-keys",
    { preHandler: apiKeyAuth },
    async (request, reply) => {
      const tenantId = request.tenantId!;

      const res = await options.pgPool.query(
        "SELECT id, name, key_prefix AS prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC",
        [tenantId],
      );

      return reply.status(200).send({
        api_keys: res.rows,
      });
    },
  );

  // DELETE /v1/api-keys/:id - Revoke an API key (race-safe last active key guard)
  fastify.delete(
    "/v1/api-keys/:id",
    { preHandler: apiKeyAuth },
    async (request, reply) => {
      const paramsResult = ApiKeyParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        const problem = createProblemDetails({
          type: PROBLEM_TYPES.VALIDATION_ERROR,
          title: "Validation Error",
          status: 400,
          detail: "Invalid route parameters.",
          instance: request.url,
          request_id: request.id,
          invalidParams: paramsResult.error.issues.map((i) => ({
            name: i.path.join(".") || "params",
            reason: i.message,
          })),
        });

        return reply
          .type("application/problem+json")
          .status(400)
          .send(problem);
      }

      const queryResult = RevokeQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        const problem = createProblemDetails({
          type: PROBLEM_TYPES.VALIDATION_ERROR,
          title: "Validation Error",
          status: 400,
          detail: "Invalid query parameters. 'force' must be 'true' or 'false' if provided.",
          instance: request.url,
          request_id: request.id,
          invalidParams: queryResult.error.issues.map((i) => ({
            name: i.path.join(".") || "query",
            reason: i.message,
          })),
        });

        return reply
          .type("application/problem+json")
          .status(400)
          .send(problem);
      }

      const keyId = paramsResult.data.id;
      const isForce = queryResult.data.force === "true";
      const tenantId = request.tenantId!;

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");

        // 1. Lock the tenant row to serialize concurrent key modifications for this tenant without deadlocks
        const tenantLockRes = await client.query(
          "SELECT id FROM tenants WHERE id = $1 FOR UPDATE",
          [tenantId],
        );

        if (tenantLockRes.rows.length === 0) {
          await client.query("ROLLBACK");
          const problem = createProblemDetails({
            type: PROBLEM_TYPES.NOT_FOUND,
            title: "Not Found",
            status: 404,
            detail: "Tenant not found.",
            instance: request.url,
            request_id: request.id,
          });

          return reply
            .type("application/problem+json")
            .status(404)
            .send(problem);
        }

        // 2. Lock the target key row to inspect ownership and current status
        const targetRes = await client.query(
          "SELECT id, tenant_id, revoked_at FROM api_keys WHERE id = $1 FOR UPDATE",
          [keyId],
        );

        if (targetRes.rows.length === 0 || targetRes.rows[0].tenant_id !== tenantId) {
          await client.query("ROLLBACK");
          const problem = createProblemDetails({
            type: PROBLEM_TYPES.NOT_FOUND,
            title: "Not Found",
            status: 404,
            detail: "API key not found.",
            instance: request.url,
            request_id: request.id,
          });

          return reply
            .type("application/problem+json")
            .status(404)
            .send(problem);
        }

        const targetKey = targetRes.rows[0];

        // If already revoked: idempotent return 204 without counting it
        if (targetKey.revoked_at !== null) {
          await client.query(
            "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND tenant_id = $2",
            [keyId, tenantId],
          );
          await client.query("COMMIT");
          return reply.status(204).send();
        }

        // 3. Count active keys for this tenant
        const activeKeysRes = await client.query(
          "SELECT id FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL",
          [tenantId],
        );
        const activeCount = activeKeysRes.rows.length;

        // If this is the last active key and force is not true, prevent lock-out
        if (activeCount <= 1 && !isForce) {
          await client.query("ROLLBACK");
          const problem = createProblemDetails({
            type: PROBLEM_TYPES.LAST_ACTIVE_KEY,
            title: "Cannot Revoke Last Active Key",
            status: 409,
            detail: "Revoking your only active API key will lock you out. Pass ?force=true to confirm.",
            instance: request.url,
            request_id: request.id,
          });

          return reply
            .type("application/problem+json")
            .status(409)
            .send(problem);
        }

        // Revoke the key
        await client.query(
          "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND tenant_id = $2",
          [keyId, tenantId],
        );

        await client.query("COMMIT");
        return reply.status(204).send();
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error({ err, keyId }, "Failed to revoke API key");
        throw err;
      } finally {
        client.release();
      }
    },
  );
};
