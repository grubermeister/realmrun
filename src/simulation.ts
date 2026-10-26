/**
 * Runs a scenario (the accumulator fixture, the planet, or the evolving
 * planet) against a freshly migrated, empty realmlib database: the core
 * initializes storage, schedules and executes the work, and owns the clock.
 * This module only wires the scenario to it and reads the result back, at the
 * end and at any checkpoints on the way.
 */

import { initializePostgresSchedulerStorage, loadPostgresOperationRuntime, simTime } from "realmlib";
import type {
  ModuleId,
  ModuleRegistry,
  OperationHandler,
  PostgresOperationRuntime,
  PostgresQueryable,
  ScheduledWork,
  SimTime,
  StateValue,
} from "realmlib";
import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, applyFixtureOperation, createFixtureRegistry, FIXTURE_WORK } from "./fixture.ts";
import type { PlanetSnapshot } from "./planet-snapshots.ts";
import {
  applyPlanetOperation,
  createPlanetRegistry,
  evolvingPlanetWork,
  planetSnapshotTimes,
  planetWork,
  readPlanetRecords,
} from "./planetary-fixture.ts";
import type { PlanetConfig, PlanetRecords } from "./planetary-fixture.ts";

/** Items per `advanceTo()` call; the loop continues until the target is reached. */
const ADVANCE_BATCH = 1_000;

export interface FixtureResult {
  readonly now: SimTime;
  readonly accumulator: StateValue | undefined;
}

/** The planet's committed clock and records. */
export interface PlanetResult extends PlanetRecords {
  readonly now: SimTime;
}

/** The evolving planet's final committed clock and records, and its checkpoints. */
export interface PlanetEvolutionResult extends PlanetResult {
  /** The committed records at each of {@link planetSnapshotTimes}, ascending; the last is at `now`. */
  readonly snapshots: readonly PlanetSnapshot[];
}

/** The database is not a newly migrated, empty realmlib schema. */
export class DatabaseNotReadyError extends Error {
  override readonly name = "DatabaseNotReadyError";
}

async function firstRow(client: PostgresQueryable, text: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query(text, []);
  return (rows[0] ?? {}) as Record<string, unknown>;
}

async function requireFreshDatabase(client: PostgresQueryable): Promise<void> {
  const schema = await firstRow(client, "SELECT to_regnamespace('realmlib') IS NOT NULL AS present");
  if (schema.present !== true) {
    throw new DatabaseNotReadyError(
      "the realmlib schema does not exist in this database; apply realmlib's migration first (see README)",
    );
  }
  const counts = await firstRow(
    client,
    `SELECT (SELECT count(*) FROM realmlib.runtime_state)::int AS runtime_state,
            (SELECT count(*) FROM realmlib.work_items)::int AS work_items,
            (SELECT count(*) FROM realmlib.state_records)::int AS state_records`,
  );
  const populated = Object.entries(counts).filter(([, n]) => n !== 0);
  if (populated.length > 0) {
    const detail = populated.map(([table, n]) => `realmlib.${table} has ${n} row(s)`).join(", ");
    throw new DatabaseNotReadyError(
      `the database already holds a simulation (${detail}); realmrun only runs against a newly initialized ` +
        "database and will not overwrite it. Drop and recreate the database, then apply the migration again (see README)",
    );
  }
}

/** What a scenario contributes to a run; everything else is shared. */
interface Scenario<R> {
  /** Scheduled in this order. */
  readonly work: readonly ScheduledWork[];
  readonly registry: ModuleRegistry;
  /** Executes each validated request. */
  readonly handler: OperationHandler;
  /** Reads the result from committed state once the target (or a checkpoint) is reached. */
  readonly read: (read: (owner: ModuleId, key: string) => StateValue | undefined) => R;
  /** Simulated times, ascending and none past the target, at which `read` also runs on the way. Default none. */
  readonly checkpoints?: readonly SimTime[];
}

/** The parts of a realmlib operation runtime, PostgreSQL or in-memory, that advancing uses. */
export type AdvancingRuntime = Pick<PostgresOperationRuntime, "scheduler" | "execute" | "read">;

/** One read of committed state, at a checkpoint. */
export interface Checkpoint<R> {
  readonly at: SimTime;
  readonly result: R;
}

/** Advances `runtime` to `target` in bounded batches, executing each due item with `scenario`'s handler. */
async function advance(runtime: AdvancingRuntime, target: SimTime, scenario: Pick<Scenario<unknown>, "registry" | "handler">) {
  let reached = false;
  while (!reached) {
    ({ reachedTarget: reached } = await runtime.scheduler.advanceTo(target, ADVANCE_BATCH, (work) => {
      const outcome = runtime.execute(scenario.registry, work.request, scenario.handler);
      if (!outcome.ok) throw new Error(`work ${work.id} rejected: ${outcome.reason}`);
    }));
  }
}

/**
 * Advances `runtime`, whose work is already scheduled and which may advance
 * (it owns its simulation, if that applies), to each of `scenario.checkpoints`
 * and then to `until`. At each, once every item due by then has completed, it
 * returns what `scenario.read` makes of the committed state. Each read gets
 * its own copies of the records, so later operations cannot change it.
 *
 * @throws {RangeError} if the checkpoints do not ascend strictly or one is past `until`.
 * @throws whatever advancing, executing, or reading throws.
 */
export async function advanceWithCheckpoints<R>(
  runtime: AdvancingRuntime,
  until: SimTime,
  scenario: Pick<Scenario<R>, "registry" | "handler" | "read" | "checkpoints">,
): Promise<{ now: SimTime; result: R; checkpoints: Checkpoint<R>[] }> {
  const target = simTime(until);
  const checkpoints = scenario.checkpoints ?? [];
  checkpoints.forEach((at, index) => {
    if (at > target || (index > 0 && at <= checkpoints[index - 1]!)) {
      throw new RangeError(`checkpoints must ascend strictly and not pass the target ${target}: ${JSON.stringify(checkpoints)}`);
    }
  });
  const read = (owner: ModuleId, key: string) => runtime.read(owner, key);
  const captured: Checkpoint<R>[] = [];
  for (const at of checkpoints) {
    await advance(runtime, at, scenario);
    captured.push({ at, result: scenario.read(read) });
  }
  await advance(runtime, target, scenario);
  return { now: await runtime.scheduler.now(), result: scenario.read(read), checkpoints: captured };
}

/**
 * Initializes `scenario` in `client`'s database, takes driver ownership,
 * advances to `until` (see {@link advanceWithCheckpoints}), and returns the
 * committed clock and what `scenario.read` makes of the committed state, at
 * the end and at each checkpoint.
 *
 * `client` must be one dedicated connection (such as a connected `pg.Client`);
 * the caller opens and ends it. Ownership is released before returning; if
 * that fails, the error propagates and the caller must end the connection.
 */
async function runScenario<R>(
  client: PostgresQueryable,
  until: SimTime,
  scenario: Scenario<R>,
): Promise<{ now: SimTime; result: R; checkpoints: Checkpoint<R>[] }> {
  await requireFreshDatabase(client);
  await initializePostgresSchedulerStorage(client, simTime(0));

  const runtime = await loadPostgresOperationRuntime(client);
  for (const work of scenario.work) {
    const outcome = await runtime.scheduler.schedule(work);
    if (outcome !== "accepted") throw new Error(`scenario work ${work.id} was not newly accepted: ${outcome}`);
  }

  if (!(await runtime.tryAcquireOwnership())) {
    throw new Error("another driver owns this simulation");
  }
  let finished: { now: SimTime; result: R; checkpoints: Checkpoint<R>[] };
  try {
    finished = await advanceWithCheckpoints(runtime, until, scenario);
  } catch (error) {
    // Keep the original error; the caller ends the connection, which drops any lock still held.
    await runtime.releaseOwnership().catch(() => {});
    throw error;
  }
  await runtime.releaseOwnership();
  return finished;
}

/**
 * Runs the accumulator fixture to `until` (see {@link runScenario}) and
 * returns the committed clock and accumulator.
 */
export async function runFixture(client: PostgresQueryable, until: SimTime): Promise<FixtureResult> {
  const { now, result } = await runScenario(client, until, {
    work: FIXTURE_WORK,
    registry: createFixtureRegistry(),
    handler: applyFixtureOperation,
    read: (read) => read(ACCUMULATOR_MODULE, ACCUMULATOR_KEY),
  });
  return { now, accumulator: result };
}

/**
 * Runs the planet scenario for `config` to `until` (see {@link runScenario})
 * and returns the committed clock and both modules' committed records.
 *
 * @throws if either record is missing or invalid after advancing.
 */
export async function runPlanet(client: PostgresQueryable, until: SimTime, config: PlanetConfig): Promise<PlanetResult> {
  const { now, result } = await runScenario(client, until, {
    work: planetWork(config),
    registry: createPlanetRegistry(),
    handler: applyPlanetOperation,
    read: readPlanetRecords,
  });
  return { now, ...result };
}

/**
 * Runs the evolving planet scenario for `config` to `until` (see
 * {@link runScenario}): the static planet's work plus the sea-level rise,
 * whose climate refresh the terrain module emits. Returns the final committed
 * clock and records, and the records at each of {@link planetSnapshotTimes}.
 *
 * @throws if either record is missing or invalid at any checkpoint.
 */
export async function runEvolvingPlanet(
  client: PostgresQueryable,
  until: SimTime,
  config: PlanetConfig,
): Promise<PlanetEvolutionResult> {
  const { now, result, checkpoints } = await runScenario(client, until, {
    work: evolvingPlanetWork(config),
    registry: createPlanetRegistry(),
    handler: applyPlanetOperation,
    read: readPlanetRecords,
    checkpoints: planetSnapshotTimes(until),
  });
  return { now, ...result, snapshots: checkpoints.map(({ at, result: records }) => ({ atMs: at, ...records })) };
}
