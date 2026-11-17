import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  validateEndpointUrl,
  generateSigningSecret,
  encryptSigningSecret,
  createProblemDetails,
  PROBLEM_TYPES,
  type LastUsedThrottler,
} from "@hookrelay/shared";
import { createApiKeyAuth } from "../middleware/auth.js";

// Extended URN problem types
export const ENDPOINT_PROBLEM_TYPES = {
  ...PROBLEM_TYPES,
  QUOTA_EXCEEDED: "urn:hookrelay:problem:quota-exceeded",
  OPTIMISTIC_LOCK_CONFLICT: "urn:hookrelay:problem:conflict",
} as const;

// Parameter Schemas
const EndpointParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

// Create Schema
const CreateEndpointSchema = z.object({
  url: z.string().min(1, "url is required"),
  description: z.string().trim().max(500, "description cannot exceed 500 characters").optional(),
  concurrency_limit: z.coerce.number().int().min(1).max(100).default(10),
});

// Keyset Cursor Schema
const KeysetCursorSchema = z.object({
  createdAt: z.string().min(1, "createdAt is required"),
  id: z.string().uuid("id must be a valid UUID"),
});

// List Query Schema
const ListEndpointsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  status: z.enum(["active", "paused", "disabled"]).optional(),
});

// Patch Schema
const PatchEndpointSchema = z
  .object({
    url: z.string().min(1).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    concurrency_limit: z.coerce.number().int().min(1).max(100).optional(),
    version: z.coerce.number().int().min(1).optional(),
  })
  .refine(
    (data) =>
      data.url !== undefined ||
      data.description !== undefined ||
      data.concurrency_limit !== undefined,
    {
      message: "At least one mutable field (url, description, concurrency_limit) must be provided",
    },
  );

export interface EndpointRoutesOptions {
  pgPool: Pool;
  throttler: LastUsedThrottler;
  encryptionKey: string;
  maxEndpointsPerTenant?: number;
  secretRotationGraceSeconds?: number;
  allowHttp?: boolean;
  allowPrivateTargets?: boolean;
}

function sendValidationError(
  request: FastifyRequest,
  reply: FastifyReply,
  detail: string,
  issues?: z.ZodIssue[],
) {
  const problem = createProblemDetails({
    type: ENDPOINT_PROBLEM_TYPES.VALIDATION_ERROR,
    title: "Validation Error",
    status: 400,
    detail,
    instance: request.url,
    request_id: request.id,
    invalidParams: issues?.map((i) => ({
      name: i.path.join(".") || "field",
      reason: i.message,
    })),
  });

  return reply.type("application/problem+json").status(400).send(problem);
}

function sendNotFound(request: FastifyRequest, reply: FastifyReply, detail = "Endpoint not found.") {
  const problem = createProblemDetails({
    type: ENDPOINT_PROBLEM_TYPES.NOT_FOUND,
    title: "Not Found",
    status: 404,
    detail,
    instance: request.url,
    request_id: request.id,
  });

  return reply.type("application/problem+json").status(404).send(problem);
}

export const endpointRoutes: FastifyPluginAsync<EndpointRoutesOptions> = async (
  fastify,
  options,
) => {
  const apiKeyAuth = createApiKeyAuth({
    pgPool: options.pgPool,
    throttler: options.throttler,
  });

  const maxEndpoints = options.maxEndpointsPerTenant ?? 50;

  // 1. POST /v1/endpoints - Create endpoint
  fastify.post(
    "/v1/endpoints",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodyResult = CreateEndpointSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(request, reply, "Invalid request payload.", bodyResult.error.issues);
      }

      const { url: rawUrl, description, concurrency_limit } = bodyResult.data;
      const tenantId = request.tenantId!;

      // Validate URL safety and SSRF
      const urlCheck = await validateEndpointUrl(rawUrl, {
        allowHttp: options.allowHttp ?? false,
        allowPrivateTargets: options.allowPrivateTargets ?? false,
      });

      if (!urlCheck.isValid) {
        return sendValidationError(request, reply, "URL not permitted: " + urlCheck.reason);
      }

      const normalizedUrl = urlCheck.url;
      const parsedHost = new URL(normalizedUrl).host;
      const endpointId = randomUUID();
      const rawSigningSecret = generateSigningSecret();
      const encryptedSecret = encryptSigningSecret(
        rawSigningSecret,
        options.encryptionKey,
        endpointId,
      );

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");

        // Serialize tenant writes and check active endpoint quota
        await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);

        const countRes = await client.query(
          "SELECT count(*)::int AS count FROM endpoints WHERE tenant_id = $1 AND deleted_at IS NULL",
          [tenantId],
        );
        const activeCount = countRes.rows[0]?.count ?? 0;

        if (activeCount >= maxEndpoints) {
          await client.query("ROLLBACK");
          const problem = createProblemDetails({
            type: ENDPOINT_PROBLEM_TYPES.QUOTA_EXCEEDED,
            title: "Endpoint Limit Reached",
            status: 409,
            detail: `Tenant has reached the maximum allowed active endpoints (${maxEndpoints}).`,
            instance: request.url,
            request_id: request.id,
          });
          return reply.type("application/problem+json").status(409).send(problem);
        }

        const insertRes = await client.query(
          `INSERT INTO endpoints (
            id, tenant_id, url, signing_secret, status, description, concurrency_limit, version
          ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1)
          RETURNING
            id, tenant_id, url, status, description, concurrency_limit,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
            version`,
          [endpointId, tenantId, normalizedUrl, encryptedSecret, description ?? null, concurrency_limit],
        );

        await client.query("COMMIT");

        // Log endpoint id and hostname only (never query params or tokens)
        request.log.info({ endpoint_id: endpointId, host: parsedHost }, "Endpoint created successfully");

        const row = insertRes.rows[0];
        reply.header("Location", `/v1/endpoints/${row.id}`);

        return reply.status(201).send({
          id: row.id,
          url: row.url,
          status: row.status,
          description: row.description,
          concurrency_limit: row.concurrency_limit,
          signing_secret: rawSigningSecret, // returned strictly once
          created_at: row.created_at,
          updated_at: row.updated_at,
          version: row.version,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error({ err }, "Database error creating endpoint");
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // 2. GET /v1/endpoints - List endpoints with keyset pagination
  fastify.get(
    "/v1/endpoints",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const queryResult = ListEndpointsQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return sendValidationError(request, reply, "Invalid query parameters.", queryResult.error.issues);
      }

      const { limit, cursor, status } = queryResult.data;
      const tenantId = request.tenantId!;

      let cursorCreatedAt: string | undefined;
      let cursorId: string | undefined;

      if (cursor) {
        try {
          const decoded = Buffer.from(cursor, "base64").toString("utf8");
          const parsedCursor = JSON.parse(decoded);
          const validated = KeysetCursorSchema.safeParse(parsedCursor);
          if (!validated.success) {
            return sendValidationError(request, reply, "Invalid pagination cursor.", validated.error.issues);
          }
          cursorCreatedAt = validated.data.createdAt;
          cursorId = validated.data.id;
        } catch {
          return sendValidationError(request, reply, "Malformed pagination cursor.");
        }
      }

      const queryParams: unknown[] = [tenantId];
      let sql = `
        SELECT
          id, url, status, description, concurrency_limit,
          to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
          to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
          version
        FROM endpoints
        WHERE tenant_id = $1 AND deleted_at IS NULL
      `;

      if (status) {
        queryParams.push(status);
        sql += ` AND status = $${queryParams.length}`;
      }

      if (cursorCreatedAt && cursorId) {
        queryParams.push(cursorCreatedAt, cursorId);
        const idxTime = queryParams.length - 1;
        const idxId = queryParams.length;
        sql += ` AND (created_at, id) < ($${idxTime}::timestamptz, $${idxId}::uuid)`;
      }

      queryParams.push(limit + 1);
      sql += ` ORDER BY created_at DESC, id DESC LIMIT $${queryParams.length}`;

      const res = await options.pgPool.query(sql, queryParams);
      const rows = res.rows as Array<{
        id: string;
        url: string;
        status: string;
        description: string | null;
        concurrency_limit: number;
        created_at: string;
        updated_at: string;
        version: number;
      }>;

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;

      let nextCursor: string | null = null;
      if (hasMore && data.length > 0) {
        const lastRow = data[data.length - 1]!;
        nextCursor = Buffer.from(
          JSON.stringify({ createdAt: lastRow.created_at, id: lastRow.id }),
          "utf8",
        ).toString("base64");
      }

      return reply.status(200).send({
        data,
        pagination: {
          limit,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      });
    },
  );

  // 3. GET /v1/endpoints/:id - Get endpoint by ID
  fastify.get(
    "/v1/endpoints/:id",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = EndpointParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(request, reply, "Invalid endpoint ID.", paramsResult.error.issues);
      }

      const { id } = paramsResult.data;
      const tenantId = request.tenantId!;

      const res = await options.pgPool.query(
        `SELECT
          id, url, status, description, concurrency_limit,
          to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
          to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
          version
        FROM endpoints
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId],
      );

      if (res.rows.length === 0) {
        return sendNotFound(request, reply);
      }

      return reply.status(200).send(res.rows[0]);
    },
  );

  // 4. PATCH /v1/endpoints/:id - Update endpoint
  fastify.patch(
    "/v1/endpoints/:id",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = EndpointParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(request, reply, "Invalid endpoint ID.", paramsResult.error.issues);
      }

      const bodyResult = PatchEndpointSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return sendValidationError(request, reply, "Invalid request payload.", bodyResult.error.issues);
      }

      const { id } = paramsResult.data;
      const tenantId = request.tenantId!;
      const { url: rawUrl, description, concurrency_limit, version: bodyVersion } = bodyResult.data;

      // Check If-Match header
      const ifMatchHeader = request.headers["if-match"];
      let ifMatchVersion: number | undefined;
      if (ifMatchHeader) {
        const cleaned = ifMatchHeader.replace(/^"|"$/g, "").trim();
        const num = Number(cleaned);
        if (isNaN(num) || num < 1) {
          return sendValidationError(request, reply, "Invalid If-Match header value.");
        }
        ifMatchVersion = num;
      }

      if (
        ifMatchVersion !== undefined &&
        bodyVersion !== undefined &&
        ifMatchVersion !== bodyVersion
      ) {
        return sendValidationError(
          request,
          reply,
          "Mismatched version: If-Match header and body version do not match.",
        );
      }

      const expectedVersion = bodyVersion ?? ifMatchVersion;

      let normalizedUrl: string | undefined;
      if (rawUrl !== undefined) {
        const urlCheck = await validateEndpointUrl(rawUrl, {
          allowHttp: options.allowHttp ?? false,
          allowPrivateTargets: options.allowPrivateTargets ?? false,
        });
        if (!urlCheck.isValid) {
          return sendValidationError(request, reply, "URL not permitted: " + urlCheck.reason);
        }
        normalizedUrl = urlCheck.url;
      }

      const setClauses: string[] = ["updated_at = now()", "version = version + 1"];
      const updateParams: unknown[] = [id, tenantId];

      if (normalizedUrl !== undefined) {
        updateParams.push(normalizedUrl);
        setClauses.push(`url = $${updateParams.length}`);
      }

      if (description !== undefined) {
        updateParams.push(description);
        setClauses.push(`description = $${updateParams.length}`);
      }

      if (concurrency_limit !== undefined) {
        updateParams.push(concurrency_limit);
        setClauses.push(`concurrency_limit = $${updateParams.length}`);
      }

      let sql = `
        UPDATE endpoints
        SET ${setClauses.join(", ")}
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      `;

      if (expectedVersion !== undefined) {
        updateParams.push(expectedVersion);
        sql += ` AND version = $${updateParams.length}`;
      }

      sql += ` RETURNING
        id, url, status, description, concurrency_limit,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
        to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
        version`;

      const updateRes = await options.pgPool.query(sql, updateParams);

      if (updateRes.rows.length === 0) {
        // Distinguish between 404 (endpoint missing) and 409 (optimistic concurrency conflict)
        const checkRes = await options.pgPool.query(
          "SELECT version FROM endpoints WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
          [id, tenantId],
        );

        if (checkRes.rows.length === 0) {
          return sendNotFound(request, reply);
        }

        const currentVersion = checkRes.rows[0]?.version;
        const problem = createProblemDetails({
          type: ENDPOINT_PROBLEM_TYPES.OPTIMISTIC_LOCK_CONFLICT,
          title: "Conflict",
          status: 409,
          detail: `Endpoint version conflict. Current version is ${currentVersion}, but expected ${expectedVersion}.`,
          instance: request.url,
          request_id: request.id,
          extensions: { current_version: currentVersion },
        });

        return reply.type("application/problem+json").status(409).send(problem);
      }

      const updatedRow = updateRes.rows[0];
      const host = new URL(updatedRow.url).host;
      request.log.info({ endpoint_id: updatedRow.id, host }, "Endpoint updated successfully");

      return reply.status(200).send(updatedRow);
    },
  );

  // 5. POST /v1/endpoints/:id/pause - Pause endpoint
  fastify.post(
    "/v1/endpoints/:id/pause",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = EndpointParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(request, reply, "Invalid endpoint ID.", paramsResult.error.issues);
      }

      const { id } = paramsResult.data;
      const tenantId = request.tenantId!;

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT
            id, url, status, description, concurrency_limit,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
            version
          FROM endpoints
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [id, tenantId],
        );

        if (existing.rows.length === 0) {
          await client.query("ROLLBACK");
          return sendNotFound(request, reply);
        }

        const row = existing.rows[0];
        // Only bump version and updated_at if status actually changes
        if (row.status === "paused") {
          await client.query("COMMIT");
          return reply.status(200).send(row);
        }

        const updateRes = await client.query(
          `UPDATE endpoints
          SET status = 'paused', updated_at = now(), version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          RETURNING
            id, url, status, description, concurrency_limit,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
            version`,
          [id, tenantId],
        );

        await client.query("COMMIT");
        return reply.status(200).send(updateRes.rows[0]);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // 6. POST /v1/endpoints/:id/resume - Resume endpoint
  fastify.post(
    "/v1/endpoints/:id/resume",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = EndpointParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(request, reply, "Invalid endpoint ID.", paramsResult.error.issues);
      }

      const { id } = paramsResult.data;
      const tenantId = request.tenantId!;

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT
            id, url, status, description, concurrency_limit,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
            version
          FROM endpoints
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [id, tenantId],
        );

        if (existing.rows.length === 0) {
          await client.query("ROLLBACK");
          return sendNotFound(request, reply);
        }

        const row = existing.rows[0];
        // Only bump version and updated_at if status actually changes
        if (row.status === "active") {
          await client.query("COMMIT");
          return reply.status(200).send(row);
        }

        const updateRes = await client.query(
          `UPDATE endpoints
          SET status = 'active', updated_at = now(), version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          RETURNING
            id, url, status, description, concurrency_limit,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
            to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
            version`,
          [id, tenantId],
        );

        await client.query("COMMIT");
        return reply.status(200).send(updateRes.rows[0]);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // 7. DELETE /v1/endpoints/:id - Soft delete endpoint
  fastify.delete(
    "/v1/endpoints/:id",
    { preHandler: apiKeyAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = EndpointParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return sendValidationError(request, reply, "Invalid endpoint ID.", paramsResult.error.issues);
      }

      const { id } = paramsResult.data;
      const tenantId = request.tenantId!;

      const client = await options.pgPool.connect();
      try {
        await client.query("BEGIN");

        // Soft delete endpoint and scrub secrets
        const deleteRes = await client.query(
          `UPDATE endpoints
          SET
            deleted_at = now(),
            status = 'disabled',
            signing_secret = NULL,
            previous_secret = NULL,
            previous_secret_expires_at = NULL,
            updated_at = now(),
            version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          RETURNING id`,
          [id, tenantId],
        );

        if (deleteRes.rows.length === 0) {
          await client.query("ROLLBACK");
          // Non-idempotent delete: return 404 on repeat
          return sendNotFound(request, reply);
        }

        // Scrub active subscriptions for the deleted endpoint
        await client.query(
          "DELETE FROM endpoint_subscriptions WHERE endpoint_id = $1",
          [id],
        );

        await client.query("COMMIT");

        request.log.info({ endpoint_id: id }, "Endpoint soft-deleted and secrets scrubbed");
        return reply.status(204).send();
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );
};
