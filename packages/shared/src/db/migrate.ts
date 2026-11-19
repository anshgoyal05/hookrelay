import pg from "pg";
import { loadDatabaseConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { runMigrations } from "./migrator.js";

const logger = createLogger({ name: "hookrelay-migrate-cli" });

async function main(): Promise<void> {
  const config = loadDatabaseConfig();

  logger.info("Connecting to PostgreSQL to run migrations...");
  const client = new pg.Client({
    connectionString: config.DATABASE_URL,
  });

  await client.connect();

  try {
    const result = await runMigrations(client, { logger });
    logger.info(
      {
        appliedCount: result.applied.length,
        alreadyAppliedCount: result.alreadyApplied.length,
      },
      "Migrations completed successfully",
    );
    await client.end();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, "Migration process encountered an error");
    await client.end().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error during migration");
  process.exit(1);
});
