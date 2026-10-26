/**
 * `bun run db:reset`: recreates the database named by `DATABASE_URL` as a new,
 * empty UTF8 database with realmlib's schema applied, ready for one
 * `bun run start`. Everything already in that database is destroyed.
 *
 * As a guard against pointing it at the wrong database, it only touches
 * databases whose names start with `realmrun_`. It connects to the server's
 * `postgres` database to drop and create it, and fails rather than
 * disconnecting anyone if the database is in use.
 */

import { join } from "node:path";
import pg from "pg";

const MIGRATION_PATH = join(import.meta.dir, "..", "node_modules", "realmlib", "migrations", "001_initial_persistence.sql");

/** Names this script may drop: `realmrun_` and then letters, digits, or underscores, so they never need escaping. */
const DEV_DATABASE_NAME = /^realmrun_[A-Za-z0-9_]+$/;

/**
 * The database named by `connectionString`, and a connection string for the
 * same server's `postgres` maintenance database.
 *
 * @throws if the URL names no database, or one this script may not drop.
 */
export function devDatabase(connectionString: string): { name: string; maintenanceUrl: string } {
  const url = new URL(connectionString);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`DATABASE_URL must be a postgresql:// URL, received ${JSON.stringify(url.protocol)}`);
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!DEV_DATABASE_NAME.test(name)) {
    throw new Error(
      `refusing to reset database ${JSON.stringify(name)}: only databases named realmrun_<letters, digits, or _> are reset`,
    );
  }
  url.pathname = "/postgres";
  return { name, maintenanceUrl: url.href };
}

async function withClient<T>(connectionString: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  // Connection failures surface through the active query; keep the event from crashing the process.
  client.on("error", () => {});
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Drops and recreates the database named by `connectionString`, then applies realmlib's migration in one transaction. */
export async function resetDevDatabase(connectionString: string): Promise<string> {
  const { name, maintenanceUrl } = devDatabase(connectionString);
  const migration = await Bun.file(MIGRATION_PATH).text();
  await withClient(maintenanceUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  });
  await withClient(connectionString, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(migration);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
  return name;
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("db:reset: DATABASE_URL is not set; point it at the realmrun_dev database (see README)");
    process.exitCode = 1;
  } else {
    try {
      const name = await resetDevDatabase(connectionString);
      console.log(`Recreated ${name} with an empty realmlib schema; ready for one run.`);
    } catch (error) {
      console.error(`db:reset: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
