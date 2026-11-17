import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extracts HTTP route declarations (METHOD /path) from docs/openapi.yaml
 */
function extractOpenApiRoutes(yamlContent: string): Set<string> {
  const routes = new Set<string>();
  const lines = yamlContent.split("\n");
  let inPaths = false;
  let currentPath: string | null = null;

  for (const line of lines) {
    if (line.startsWith("paths:")) {
      inPaths = true;
      continue;
    }
    if (inPaths && line.startsWith("components:")) {
      inPaths = false;
      break;
    }
    if (!inPaths) continue;

    // Matches path header: e.g. "  /v1/endpoints/{id}:"
    const pathMatch = line.match(/^ {2}(\/[a-zA-Z0-9_{}/-]+):/);
    if (pathMatch && pathMatch[1]) {
      currentPath = pathMatch[1];
      continue;
    }

    // Matches HTTP method: e.g. "    get:"
    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete):/);
    if (methodMatch && methodMatch[1] && currentPath) {
      const method = methodMatch[1].toUpperCase();
      routes.add(`${method} ${currentPath}`);
    }
  }

  return routes;
}

describe("docs/openapi.yaml - Route Parity & Completeness", () => {
  it("enforces two-way parity: all registered routes are documented, and all documented routes are registered", async () => {
    // 1. Parse documented routes from docs/openapi.yaml
    const openApiPath = path.resolve(__dirname, "../../../docs/openapi.yaml");
    expect(fs.existsSync(openApiPath), `docs/openapi.yaml must exist at ${openApiPath}`).toBe(true);

    const yamlContent = fs.readFileSync(openApiPath, "utf8");
    const documentedRoutes = extractOpenApiRoutes(yamlContent);
    expect(documentedRoutes.size).toBeGreaterThan(0);

    // 2. Collect all registered routes from Fastify server
    const registeredRoutes = new Set<string>();
    const app = buildServer({
      pgPool: { query: async () => ({ rows: [] }) },
      redisClient: { ping: async () => "PONG" },
      amqpConnection: { isConnected: () => true },
      adminToken: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      onRoute: (routeOptions) => {
        const methods = Array.isArray(routeOptions.method)
          ? routeOptions.method
          : [routeOptions.method];

        for (const m of methods) {
          // Fastify registers internal HEAD routes for GET endpoints and wildcard 404 handlers; filter them out
          if (m !== "HEAD" && routeOptions.url !== "/*") {
            const normalizedPath = routeOptions.url.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
            registeredRoutes.add(`${m.toUpperCase()} ${normalizedPath}`);
          }
        }
      },
    });

    await app.ready();
    await app.close();

    // 3. Direction 1: Every registered route MUST be documented
    const undocumentedRoutes: string[] = [];
    for (const route of registeredRoutes) {
      if (!documentedRoutes.has(route)) {
        undocumentedRoutes.push(route);
      }
    }

    expect(
      undocumentedRoutes,
      `The following registered Fastify routes are missing from docs/openapi.yaml:\n${undocumentedRoutes.join("\n")}`,
    ).toEqual([]);

    // 4. Direction 2: Every documented route MUST be registered on Fastify
    const unimplementedRoutes: string[] = [];
    for (const route of documentedRoutes) {
      if (!registeredRoutes.has(route)) {
        unimplementedRoutes.push(route);
      }
    }

    expect(
      unimplementedRoutes,
      `The following routes documented in docs/openapi.yaml are not registered in the API server:\n${unimplementedRoutes.join("\n")}`,
    ).toEqual([]);
  });
});
