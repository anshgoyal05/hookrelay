import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  generateApiKey,
  createProblemDetails,
  PROBLEM_TYPES,
} from "@hookrelay/shared";
import { createAdminAuth } from "../middleware/auth.js";

const CreateTenantSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(128, "name cannot exceed 128 characters"),
  key_name: z
    .string()
    .trim()
    .min(1, "key_name cannot be empty")
    .max(128, "key_name cannot exceed 128 characters")
    .optional(),
});

export interface AdminRoutesOptions {
  pgPool: Pool;
  adminToken?: string;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
  fastify,
  options,
) => {
  const adminAuth = createAdminAuth({ adminToken: options.adminToken });

  // POST /v1/admin/tenants - Bootstrap tenant and first API key
  fastify.post(
    "/v1/admin/tenants",
    { preHandler: adminAuth },
    async (request, reply) => {
      const parseResult = CreateTenantSchema.safeParse(request.body);
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

      const { name, key_name } = parseResult.data;
      const initialKeyName = key_name || "default";

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");

        // 1. Create Tenant
        const tenantRes = await client.query(
          "INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at",
          [name],
        );
        const tenant = tenantRes.rows[0];

        // 2. Generate and Insert First API Key
        const keyMaterial = generateApiKey();
        const keyRes = await client.query(
          "INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, created_at",
          [tenant.id, initialKeyName, keyMaterial.prefix, keyMaterial.hash],
        );
        const keyRow = keyRes.rows[0];

        await client.query("COMMIT");

        // Cache-Control: no-store on responses containing key material
        reply.header("Cache-Control", "no-store");

        return reply.status(201).send({
          tenant: {
            id: tenant.id,
            name: tenant.name,
            created_at: tenant.created_at,
          },
          api_key: {
            id: keyRow.id,
            name: keyRow.name,
            prefix: keyRow.key_prefix,
            key: keyMaterial.key, // RETURNED EXACTLY ONCE
            created_at: keyRow.created_at,
          },
        });
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error({ err }, "Failed to create tenant and initial API key");
        throw err;
      } finally {
        client.release();
      }
    },
  );
};
