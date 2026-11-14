import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { createLogger } from "../logger.js";

/**
 * Advisory lock key for HookRelay schema migrations.
 * Prevents concurrent migration executions across multiple API/Worker pods.
 */
export const MIGRATION_ADVISORY_LOCK_ID = 837261947261;

export interface MigrationClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationChecksumMismatchError extends Error {
  constructor(
    public readonly version: string,
    public readonly name: string,
    public readonly expectedChecksum: string,
    public readonly actualChecksum: string,
  ) {
    super(
      `Migration ${version} (${name}) checksum mismatch! Expected ${expectedChecksum}, but found ${actualChecksum}. The migration file was modified after being applied.`,
    );
    this.name = "MigrationChecksumMismatchError";
  }
}

/**
 * Resolves the absolute path to the migrations directory.
 * Works seamlessly in both:
 *  - Development via tsx (src/db/migrator.ts)
 *  - Production compiled builds (dist/db/migrator.js or dist/src/db/migrator.js)
 *  - Docker containers with custom MIGRATIONS_DIR
 */
export function resolveMigrationsDir(explicitDir?: string): string {
  if (explicitDir && fs.existsSync(explicitDir)) {
    return path.resolve(explicitDir);
  }

  if (process.env.MIGRATIONS_DIR && fs.existsSync(process.env.MIGRATIONS_DIR)) {
    return path.resolve(process.env.MIGRATIONS_DIR);
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  const candidateDirs = [
    path.resolve(currentDir, "../../migrations"),
    path.resolve(currentDir, "../../../migrations"),
    path.resolve(process.cwd(), "packages/shared/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];

  for (const candidate of candidateDirs) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate migrations directory. Checked candidates:\n${candidateDirs.join("\n")}`,
  );
}

/**
 * Reads and hashes all .sql migration files in the migrations directory.
 */
export function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  const fileNames = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  return fileNames.map((fileName) => {
    const filePath = path.join(migrationsDir, fileName);
    const sql = fs.readFileSync(filePath, "utf-8");
    const checksum = crypto.createHash("sha256").update(sql, "utf-8").digest("hex");

    // Expecting format: NNNN_name.sql (e.g. 0001_initial_schema.sql)
    const match = fileName.match(/^(\d+)_(.+)\.sql$/);
    const version = match && match[1] ? match[1] : fileName;
    const name = match && match[2] ? match[2] : fileName;

    return {
      version,
      name,
      filePath,
      checksum,
      sql,
    };
  });
}

/**
 * Executes database migrations using transactional DDL and PostgreSQL advisory locks.
 *
 * NOTE ON CONCURRENTLY INDEXES:
 * PostgreSQL disallows `CREATE INDEX CONCURRENTLY` inside a transaction block (`BEGIN ... COMMIT`).
 * All migrations executed through this runner execute inside atomic transactions to guarantee rollback
 * on failure. When deploying high-traffic production indexes that require `CONCURRENTLY`, they must be
 * executed outside transactional blocks or as part of a dedicated zero-downtime maintenance pipeline.
 */
export async function runMigrations(
  client: MigrationClient,
  options?: {
    migrationsDir?: string;
    logger?: Logger;
  },
): Promise<MigrationResult> {
  const logger = options?.logger ?? createLogger({ name: "hookrelay-migrator" });
  const migrationsDir = resolveMigrationsDir(options?.migrationsDir);
  const migrationFiles = loadMigrationFiles(migrationsDir);

  logger.info({ migrationsDir, count: migrationFiles.length }, "Starting migration run");

  // 1. Acquire PostgreSQL advisory lock
  logger.debug({ lockId: MIGRATION_ADVISORY_LOCK_ID }, "Acquiring migration advisory lock");
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_ID]);

  try {
    // 2. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 3. Fetch already applied migrations
    const res = await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC");
    const appliedRows = res.rows as Array<{ version: string; name: string; checksum: string }>;
    const appliedMap = new Map(appliedRows.map((r) => [r.version, r]));

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    // 4. Validate checksums and execute pending migrations
    for (const migration of migrationFiles) {
      const existing = appliedMap.get(migration.version);

      if (existing) {
        // Edit detection: verify checksum
        if (existing.checksum !== migration.checksum) {
          throw new MigrationChecksumMismatchError(
            migration.version,
            migration.name,
            existing.checksum,
            migration.checksum,
          );
        }
        alreadyApplied.push(migration.version);
        logger.debug({ version: migration.version, name: migration.name }, "Migration already applied");
        continue;
      }

      // Execute migration in an atomic transaction
      logger.info({ version: migration.version, name: migration.name }, "Applying migration");
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        applied.push(migration.version);
        logger.info({ version: migration.version, name: migration.name }, "Migration applied successfully");
      } catch (err) {
        logger.error({ version: migration.version, err }, "Migration failed, rolling back");
        await client.query("ROLLBACK");
        throw err;
      }
    }

    logger.info({ appliedCount: applied.length, alreadyAppliedCount: alreadyApplied.length }, "Migration run complete");
    return { applied, alreadyApplied };
  } finally {
    // Release advisory lock
    logger.debug({ lockId: MIGRATION_ADVISORY_LOCK_ID }, "Releasing migration advisory lock");
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_ID]);
  }
}
