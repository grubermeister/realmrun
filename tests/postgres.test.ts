import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIMATE_REFRESH_REQUEST, climateRefreshWorkId } from "lattice-terrain-module";
import pg from "pg";
import { initializePostgresSchedulerStorage, loadPostgresOperationRuntime, simTime, WorkIdConflictError } from "realmlib";
import type { ScheduledWork } from "realmlib";
import { buildSnapshotBundle, serializeSnapshotBundle } from "../src/planet-snapshots.ts";
import {
  applyPlanetOperation,
  createPlanetRegistry,
  DEFAULT_PLANET_CONFIG,
  evolvingPlanetWork,
  planetSnapshotTimes,
  readPlanetRecords,
  TERRAIN_MODULE,
} from "../src/planetary-fixture.ts";
import type { PlanetConfig } from "../src/planetary-fixture.ts";
import { renderPlanetMap } from "../src/planetary-map.ts";
import { advanceWithCheckpoints, DatabaseNotReadyError, runEvolvingPlanet, runFixture, runPlanet } from "../src/simulation.ts";
import { runEvolvingPlanetInMemory, runFixtureInMemory, runPlanetInMemory } from "./in-memory-reference.ts";

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

  async function migrate(): Promise<void> {
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
  }

  /** Each test gets a newly migrated, empty schema and its own driver connection. */
  beforeEach(async () => {
    await migrate();
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

  describe("planet scenario through the PostgreSQL operation runtime", () => {
    const committedRows = async () =>
      (
        await observer.query(
          "SELECT module_id, record_key, value::text AS value FROM realmlib.state_records ORDER BY module_id, record_key",
        )
      ).rows.map((r) => ({ module: r.module_id, key: r.record_key, value: JSON.parse(r.value) }));

    const advisoryLocks = async () =>
      (
        await observer.query(`SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      ).rows[0].n;

    test.each([
      [DEFAULT_PLANET_CONFIG, 0],
      [{ seed: 42, seaLevel: 5, meanTempC: 3 } satisfies PlanetConfig, 0],
      [DEFAULT_PLANET_CONFIG, 1_000],
    ])("%j to %d ms matches the in-memory core path and commits both modules' records", async (config, until) => {
      const result = await runPlanet(driver, simTime(until), config);
      const reference = await runPlanetInMemory(config, simTime(until));
      expect(result).toEqual({ now: reference.now, terrain: reference.terrain as never, climate: reference.climate as never });
      expect(result.terrain).toMatchObject({ seed: config.seed, seaLevel: config.seaLevel });
      expect(result.climate).toMatchObject({ meanTempC: config.meanTempC });

      // What committed, seen from another connection: one record per module, each in its own namespace.
      expect(await committedRows()).toEqual([
        { module: "climate", key: "climate", value: reference.climate },
        { module: "terrain", key: "surface", value: reference.terrain },
      ]);
      const state = await observer.query("SELECT now_ms::text AS now FROM realmlib.runtime_state");
      expect(state.rows).toEqual([{ now: String(until) }]);
      const work = await observer.query("SELECT work_id, module_id, at_ms::int AS at, status FROM realmlib.work_items ORDER BY sequence");
      expect(work.rows).toEqual([
        { work_id: "planet-terrain-generate", module_id: "terrain", at: 0, status: "completed" },
        { work_id: "planet-climate-derive", module_id: "climate", at: 0, status: "completed" },
      ]);
      expect(work.rows.map((r) => r.work_id)).toEqual(reference.executed);
      expect(await advisoryLocks()).toBe(0);
    });

    test("an already generated planet is refused and left unchanged", async () => {
      await runPlanet(driver, simTime(0), DEFAULT_PLANET_CONFIG);
      const before = await committedRows();
      await expect(runPlanet(driver, simTime(0), { ...DEFAULT_PLANET_CONFIG, seed: 42 })).rejects.toThrow(DatabaseNotReadyError);
      await expect(runFixture(driver, simTime(0))).rejects.toThrow(DatabaseNotReadyError);
      expect(await committedRows()).toEqual(before);
      expect(await advisoryLocks()).toBe(0);
    });

    test("a database holding the accumulator fixture is refused", async () => {
      await runFixture(driver, simTime(0));
      await expect(runPlanet(driver, simTime(0), DEFAULT_PLANET_CONFIG)).rejects.toThrow("already holds a simulation");
      expect((await committedRows()).map((r) => r.module)).toEqual(["accumulator"]);
    });

    test("the CLI prints the map of the committed planet, identically on a fresh rerun, and differently for another seed", async () => {
      await driver.end();
      const run = async (...args: string[]) => {
        const child = Bun.spawn(["bun", mainPath, "--scenario", "planet", ...args], {
          env: { ...process.env, DATABASE_URL: url },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        return stdout;
      };
      const fresh = async () => {
        await observer.query("DROP SCHEMA realmlib CASCADE");
        migrated = false;
        await migrate();
      };

      const first = await run("--seed", "1729", "--sea-level", "0", "--mean-temp", "15", "--until", "0");
      const reference = await runPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
      const records = readPlanetRecords((owner) => (owner === TERRAIN_MODULE ? reference.terrain : reference.climate));
      expect(first).toBe(`${renderPlanetMap({ ...records, now: reference.now })}\n`);
      expect(first.split("\n").filter((line) => /^[ 0-9]{2}[NS] \|.{48}\|$/.test(line))).toHaveLength(24);

      await fresh();
      expect(await run("--until", "0")).toBe(first); // the defaults are the sample planet

      await fresh();
      const reseeded = await run("--seed", "42", "--until", "0");
      expect(reseeded).not.toBe(first);
      expect(reseeded).toStartWith("Planet: seed 42, sea level 0, mean temperature 15 C\n");
    });
  });

  describe("evolving planet through the PostgreSQL operation runtime", () => {
    const committedRows = async () =>
      (
        await observer.query(
          "SELECT module_id, record_key, value::text AS value FROM realmlib.state_records ORDER BY module_id, record_key",
        )
      ).rows.map((r) => ({ module: r.module_id, key: r.record_key, value: JSON.parse(r.value) }));

    const workRows = async () =>
      (
        await observer.query(
          `SELECT work_id, at_ms::int AS at, sequence::int AS sequence, module_id, operation, payload_version::int AS version,
                  payload::text AS payload, status, completed_at_ms::int AS completed_at
           FROM realmlib.work_items ORDER BY sequence`,
        )
      ).rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

    const advisoryLocks = async () =>
      (
        await observer.query(`SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      ).rows[0].n;

    const generateRow = { work_id: "planet-terrain-generate", at: 0, sequence: 0, module_id: "terrain", operation: "generate" };
    const deriveRow = { work_id: "planet-climate-derive", at: 0, sequence: 1, module_id: "climate", operation: "derive" };
    const raiseRow = { work_id: "planet-terrain-raise-sea-level", at: 1_000, sequence: 2, module_id: "terrain", operation: "raise-sea-level" };

    test.each([
      [DEFAULT_PLANET_CONFIG, 0],
      [DEFAULT_PLANET_CONFIG, 999],
      [DEFAULT_PLANET_CONFIG, 1_000],
      [DEFAULT_PLANET_CONFIG, 2_000],
      [{ seed: 42, seaLevel: 5, meanTempC: 3 } satisfies PlanetConfig, 2_000],
    ])("%j to %d ms matches the in-memory operation runtime at every checkpoint", async (config, until) => {
      const result = await runEvolvingPlanet(driver, simTime(until), config);
      const reference = await runEvolvingPlanetInMemory(config, simTime(until));
      expect(result.snapshots.map((s) => s.atMs)).toEqual(planetSnapshotTimes(simTime(until)) as never);
      expect(result.snapshots).toEqual(reference.snapshots);
      const final = reference.snapshots.at(-1)!;
      expect(result).toMatchObject({ now: simTime(until), terrain: final.terrain, climate: final.climate });
      expect(serializeSnapshotBundle(buildSnapshotBundle(config, result.snapshots))).toBe(
        serializeSnapshotBundle(buildSnapshotBundle(config, reference.snapshots)),
      );

      // What committed, seen from another connection.
      expect(await committedRows()).toEqual([
        { module: "climate", key: "climate", value: final.climate },
        { module: "terrain", key: "surface", value: final.terrain },
      ]);
      const state = await observer.query("SELECT now_ms::text AS now FROM realmlib.runtime_state");
      expect(state.rows).toEqual([{ now: String(until) }]);
      const rows = await workRows();
      if (until < 1_000) {
        expect(rows.map(({ work_id, status }) => [work_id, status])).toEqual([
          ["planet-terrain-generate", "completed"],
          ["planet-climate-derive", "completed"],
          ["planet-terrain-raise-sea-level", "pending"],
        ]);
      } else {
        // The emitted refresh was durably inserted with the rise and then completed at the same time.
        const toSeaLevel = config.seaLevel + 10;
        expect(rows).toEqual([
          { ...generateRow, version: 1, payload: { seed: config.seed, seaLevel: config.seaLevel }, status: "completed", completed_at: 0 },
          { ...deriveRow, version: 1, payload: { meanTempC: config.meanTempC }, status: "completed", completed_at: 0 },
          { ...raiseRow, version: 1, payload: { toSeaLevel }, status: "completed", completed_at: 1_000 },
          {
            work_id: climateRefreshWorkId(1_000, toSeaLevel),
            at: 1_000,
            sequence: 3,
            module_id: "climate",
            operation: "refresh",
            version: 1,
            payload: {},
            status: "completed",
            completed_at: 1_000,
          },
        ]);
        expect(rows.map((r) => ({ id: r.work_id, at: r.at }))).toEqual(reference.executed);
      }
      expect(await advisoryLocks()).toBe(0);
    });

    test("a conflicting emitted work ID rolls back the rise and its emission in PostgreSQL too", async () => {
      await initializePostgresSchedulerStorage(driver, simTime(0));
      const runtime = await loadPostgresOperationRuntime(driver);
      const squatter: ScheduledWork = { id: climateRefreshWorkId(1_000, 10), at: simTime(5_000), request: CLIMATE_REFRESH_REQUEST };
      for (const work of [...evolvingPlanetWork(DEFAULT_PLANET_CONFIG), squatter]) {
        expect(await runtime.scheduler.schedule(work)).toBe("accepted");
      }
      expect(await runtime.tryAcquireOwnership()).toBe(true);
      const scenario = { registry: createPlanetRegistry(), handler: applyPlanetOperation, read: readPlanetRecords };
      await expect(advanceWithCheckpoints(runtime, simTime(1_000), scenario)).rejects.toThrow(WorkIdConflictError);
      await runtime.releaseOwnership();

      const reference = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
      expect(await committedRows()).toEqual([
        { module: "climate", key: "climate", value: reference.snapshots[0]!.climate },
        { module: "terrain", key: "surface", value: reference.snapshots[0]!.terrain },
      ]);
      expect((await workRows()).map(({ work_id, at, status, completed_at }) => [work_id, at, status, completed_at])).toEqual([
        ["planet-terrain-generate", 0, "completed", 0],
        ["planet-climate-derive", 0, "completed", 0],
        ["planet-terrain-raise-sea-level", 1_000, "pending", null],
        [squatter.id, 5_000, "pending", null],
      ]);
      // The established exception: the failed item leaves the clock at its time.
      const state = await observer.query("SELECT now_ms::text AS now FROM realmlib.runtime_state");
      expect(state.rows).toEqual([{ now: "1000" }]);
      expect(await advisoryLocks()).toBe(0);
    });

    test("an already populated database is refused and left unchanged", async () => {
      await runPlanet(driver, simTime(0), DEFAULT_PLANET_CONFIG);
      const before = await committedRows();
      await expect(runEvolvingPlanet(driver, simTime(2_000), DEFAULT_PLANET_CONFIG)).rejects.toThrow(DatabaseNotReadyError);
      expect(await committedRows()).toEqual(before);
      expect(await advisoryLocks()).toBe(0);
    });

    test("the CLI prints the final map and exports byte-identical JSON on a fresh rerun, and none on a failed run", async () => {
      await driver.end();
      const dir = await mkdtemp(join(tmpdir(), "realmrun-export-"));
      const run = async (...args: string[]) => {
        const child = Bun.spawn(["bun", mainPath, "--scenario", "planet-evolve", ...args], {
          cwd: dir,
          env: { ...process.env, DATABASE_URL: url },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
        return { code, stdout, stderr };
      };
      const fresh = async () => {
        await observer.query("DROP SCHEMA realmlib CASCADE");
        migrated = false;
        await migrate();
      };
      const args = ["--seed", "1729", "--sea-level", "0", "--mean-temp", "15", "--until", "2000"];
      try {
        // An existing file is replaced.
        await writeFile(join(dir, "first.json"), "stale");
        const first = await run(...args, "--export-snapshots", "./first.json");
        expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
        const reference = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000));
        const final = reference.snapshots.at(-1)!;
        expect(first.stdout).toBe(`${renderPlanetMap({ ...final, now: reference.now })}\n`);
        expect(first.stdout).toStartWith("Planet: seed 1729, sea level 10, mean temperature 15 C\n");
        expect(first.stdout).toContain("Simulated time: 2000 ms\n");
        expect(first.stdout).toContain("Surface: ocean 644 cells");
        const exported = await Bun.file(join(dir, "first.json")).text();
        expect(exported).toBe(serializeSnapshotBundle(buildSnapshotBundle(DEFAULT_PLANET_CONFIG, reference.snapshots)));
        const bundle = JSON.parse(exported);
        expect(bundle.snapshots.map((s: { atMs: number }) => s.atMs)).toEqual([0, 1_000, 2_000]);
        expect(bundle.events).toHaveLength(1);

        await fresh();
        const second = await run(...args, "--export-snapshots=second.json");
        expect(second.code).toBe(0);
        expect(second.stdout).toBe(first.stdout);
        expect(await Bun.file(join(dir, "second.json")).text()).toBe(exported);

        // Without the flag, nothing is written.
        await fresh();
        expect((await run(...args)).stdout).toBe(first.stdout);

        // The database is now populated, so the run fails and writes nothing.
        const refused = await run(...args, "--export-snapshots", "refused.json");
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain("already holds a simulation");
        expect((await readdir(dir)).sort()).toEqual(["first.json", "second.json"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("a database without the realmlib schema is refused with setup guidance", async () => {
    await observer.query("DROP SCHEMA realmlib CASCADE");
    migrated = false;
    await expect(runFixture(driver, simTime(12))).rejects.toThrow("apply realmlib's migration first");
  });
}
