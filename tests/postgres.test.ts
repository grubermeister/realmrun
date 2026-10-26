import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import pg from "pg";
import { simTime } from "realmlib";
import { DatabaseNotReadyError, runFixture } from "../src/simulation.ts";
import { runFixtureInMemory } from "./in-memory-reference.ts";

// Opt-in: runs only against a separate, disposable database named by this variable.
const databaseUrl = process.env.REALMRUN_TEST_DATABASE_URL;
const migrationPath = join(import.meta.dir, "..", "node_modules", "realmlib", "migrations", "001_initial_persistence.sql");
const mainPath = join(import.meta.dir, "..", "src", "main.ts");

if (!databaseUrl) {
  test.skip("PostgreSQL fixture run NOT RUN: set REALMRUN_TEST_DATABASE_URL to a disposable database", () => {});
} else {
  definePostgresTests(databaseUrl);
}

function definePostgresTests(url: string): void {
  const observer = new pg.Client({ connectionString: url });
  let driver: pg.Client;
  let migrated = false;

  beforeAll(async () => {
    await observer.connect();
    const { rows } = await observer.query("SELECT to_regnamespace('realmlib') IS NOT NULL AS present");
    if (rows[0].present) {
      throw new Error("refusing to run: schema realmlib already exists; use a separate disposable database");
    }
  });

  /** Each test gets a newly migrated, empty schema and its own driver connection. */
  beforeEach(async () => {
    const migration = await Bun.file(migrationPath).text();
    await observer.query("BEGIN");
    try {
      await observer.query(migration);
      await observer.query("COMMIT");
    } catch (error) {
      await observer.query("ROLLBACK");
      throw error;
    }
    migrated = true;
    driver = new pg.Client({ connectionString: url });
    driver.on("error", () => {});
    await driver.connect();
  });

  afterEach(async () => {
    await driver.end().catch(() => {});
    if (migrated) await observer.query("DROP SCHEMA realmlib CASCADE");
    migrated = false;
  });

  afterAll(async () => {
    await observer.end();
  });

  describe("fixture through the PostgreSQL operation runtime", () => {
    test.each([
      [0, 1],
      [5, 9],
      [12, 13],
      [20, 13],
    ])("--until %d matches the expected table and the in-memory core path", async (until, accumulator) => {
      const result = await runFixture(driver, simTime(until));
      expect(result).toEqual({ now: simTime(until), accumulator });
      const reference = await runFixtureInMemory(simTime(until));
      expect(result).toEqual({ now: reference.now, accumulator: reference.accumulator });

      // What committed, seen from another connection; ownership was released.
      const state = await observer.query("SELECT now_ms::text AS now FROM realmlib.runtime_state");
      expect(state.rows).toEqual([{ now: String(until) }]);
      const completed = await observer.query(
        "SELECT work_id FROM realmlib.work_items WHERE status = 'completed' ORDER BY sequence",
      );
      expect(completed.rows.map((r) => r.work_id)).toEqual(reference.executed);
      const locks = await observer.query(`SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      expect(locks.rows[0].n).toBe(0);
    });

    test("an already populated database is refused and left unchanged", async () => {
      await runFixture(driver, simTime(5));
      await expect(runFixture(driver, simTime(12))).rejects.toThrow(DatabaseNotReadyError);
      const state = await observer.query("SELECT now_ms::text AS now FROM realmlib.runtime_state");
      expect(state.rows).toEqual([{ now: "5" }]);
    });

    test("stray state records alone also count as populated", async () => {
      await observer.query(`INSERT INTO realmlib.state_records VALUES ('accumulator', 'value', '100')`);
      await expect(runFixture(driver, simTime(12))).rejects.toThrow("state_records has 1 row(s)");
    });

    test("the CLI prints the committed clock and accumulator", async () => {
      await driver.end();
      const child = Bun.spawn(["bun", mainPath, "--until", "12"], {
        env: { ...process.env, DATABASE_URL: url },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toBe("Simulated time: 12 ms\nAccumulator: 13\n");
    });
  });

  test("a database without the realmlib schema is refused with setup guidance", async () => {
    await observer.query("DROP SCHEMA realmlib CASCADE");
    migrated = false;
    await expect(runFixture(driver, simTime(12))).rejects.toThrow("apply realmlib's migration first");
  });
}
