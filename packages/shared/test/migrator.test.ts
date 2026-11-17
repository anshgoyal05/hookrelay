import { describe, it, expect, vi } from "vitest";
import {
  runMigrations,
  MigrationChecksumMismatchError,
  MIGRATION_ADVISORY_LOCK_ID,
  type MigrationClient,
} from "../src/db/migrator.js";
import { createLogger } from "../src/logger.js";

const silentLogger = createLogger({ name: "test-migrator", level: "silent" });

describe("packages/shared - Database Migration Runner", () => {
  it("fresh DB: applies all pending migrations in order within a transaction", async () => {
    const executedQueries: string[] = [];
    const migrationsTable: Array<{ version: string; name: string; checksum: string }> = [];

    const mockClient: MigrationClient = {
      query: async (sql: string, params?: unknown[]) => {
        executedQueries.push(sql.trim());

        if (sql.includes("SELECT version, name, checksum FROM schema_migrations")) {
          return { rows: [...migrationsTable] };
        }

        if (sql.includes("INSERT INTO schema_migrations")) {
          const [version, name, checksum] = params as [string, string, string];
          migrationsTable.push({ version, name, checksum });
          return { rows: [] };
        }

        return { rows: [] };
      },
    };

    const result = await runMigrations(mockClient, { logger: silentLogger });

    expect(result.applied).toContain("0001");
    expect(result.alreadyApplied.length).toBe(0);
    expect(migrationsTable.length).toBeGreaterThan(0);
    expect(migrationsTable[0]?.version).toBe("0001");

    // Verify advisory lock was acquired and released
    expect(executedQueries).toContain("SELECT pg_advisory_lock($1)");
    expect(executedQueries).toContain("SELECT pg_advisory_unlock($1)");

    // Verify transaction boundaries
    const beginIndex = executedQueries.indexOf("BEGIN");
    const commitIndex = executedQueries.indexOf("COMMIT");
    expect(beginIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(beginIndex);
  });

  it("idempotent re-run: skips migrations that have already been applied", async () => {
    const executedQueries: string[] = [];
    const recordedRows: Array<{ version: string; name: string; checksum: string }> = [];

    const firstClient: MigrationClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO schema_migrations")) {
          const [version, name, checksum] = params as [string, string, string];
          recordedRows.push({ version, name, checksum });
        }
        return { rows: [] };
      },
    };
    await runMigrations(firstClient, { logger: silentLogger });

    // Second run: mock DB already has the migrations recorded
    const secondClient: MigrationClient = {
      query: async (sql: string) => {
        executedQueries.push(sql.trim());
        if (sql.includes("SELECT version, name, checksum FROM schema_migrations")) {
          return {
            rows: [...recordedRows],
          };
        }
        return { rows: [] };
      },
    };

    const result = await runMigrations(secondClient, { logger: silentLogger });

    expect(result.applied.length).toBe(0);
    expect(result.alreadyApplied).toContain("0001");
    // Verify no migration transaction was opened
    expect(executedQueries).not.toContain("BEGIN");
    expect(executedQueries).not.toContain("COMMIT");
  });

  it("rollback on failure: rolls back transaction if migration SQL fails", async () => {
    const executedQueries: string[] = [];
    const migrationsTable: Array<{ version: string; name: string; checksum: string }> = [];

    const mockClient: MigrationClient = {
      query: async (sql: string) => {
        executedQueries.push(sql.trim());

        if (sql.includes("SELECT version, name, checksum FROM schema_migrations")) {
          return { rows: [] };
        }

        // Simulate failure on executing migration DDL
        if (sql.includes("CREATE TABLE") && !sql.includes("schema_migrations")) {
          throw new Error("Syntax error in DDL");
        }

        return { rows: [] };
      },
    };

    await expect(runMigrations(mockClient, { logger: silentLogger })).rejects.toThrow(
      "Syntax error in DDL",
    );

    // Verify ROLLBACK was executed
    expect(executedQueries).toContain("ROLLBACK");
    // Verify migration was NOT committed to schema_migrations
    expect(migrationsTable.length).toBe(0);
    // Verify lock was still released
    expect(executedQueries).toContain("SELECT pg_advisory_unlock($1)");
  });

  it("concurrent runners: acquires and releases advisory lock with correct lock ID", async () => {
    const lockSpy = vi.fn();
    const unlockSpy = vi.fn();

    const mockClient: MigrationClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("pg_advisory_lock")) {
          lockSpy(params?.[0]);
          return { rows: [] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          unlockSpy(params?.[0]);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    await runMigrations(mockClient, { logger: silentLogger });

    expect(lockSpy).toHaveBeenCalledWith(MIGRATION_ADVISORY_LOCK_ID);
    expect(unlockSpy).toHaveBeenCalledWith(MIGRATION_ADVISORY_LOCK_ID);
  });

  it("edit detection: throws MigrationChecksumMismatchError if migration file was altered", async () => {
    const mockClient: MigrationClient = {
      query: async (sql: string) => {
        if (sql.includes("SELECT version, name, checksum FROM schema_migrations")) {
          return {
            rows: [
              {
                version: "0001",
                name: "initial_schema",
                checksum: "tampered_fake_checksum_0000000000000000000000000000",
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    await expect(runMigrations(mockClient, { logger: silentLogger })).rejects.toThrow(
      MigrationChecksumMismatchError,
    );
  });
});
