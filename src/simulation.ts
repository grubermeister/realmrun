/**
 * Runs the fixture against a freshly migrated, empty realmlib database: the
 * core initializes storage, schedules and executes the work, and owns the
 * clock. This module only wires the fixture to it and reads the result back.
 */

import { initializePostgresSchedulerStorage, loadPostgresOperationRuntime, simTime } from "realmlib";
import type { PostgresQueryable, SimTime, StateValue } from "realmlib";
import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, applyFixtureOperation, createFixtureRegistry, FIXTURE_WORK } from "./fixture.ts";

/** Items per `advanceTo()` call; the loop continues until the target is reached. */
const ADVANCE_BATCH = 1_000;

export interface FixtureResult {
  readonly now: SimTime;
  readonly accumulator: StateValue | undefined;
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

/**
 * Initializes the fixture in `client`'s database, takes driver ownership,
 * advances to `until`, and returns the committed clock and accumulator.
 *
 * `client` must be one dedicated connection (such as a connected `pg.Client`);
 * the caller opens and ends it. Ownership is released before returning; if
 * that fails, the error propagates and the caller must end the connection.
 */
export async function runFixture(client: PostgresQueryable, until: SimTime): Promise<FixtureResult> {
  const target = simTime(until);
  await requireFreshDatabase(client);
  await initializePostgresSchedulerStorage(client, simTime(0));

  const runtime = await loadPostgresOperationRuntime(client);
  for (const work of FIXTURE_WORK) {
    const outcome = await runtime.scheduler.schedule(work);
    if (outcome !== "accepted") throw new Error(`fixture work ${work.id} was not newly accepted: ${outcome}`);
  }

  if (!(await runtime.tryAcquireOwnership())) {
    throw new Error("another driver owns this simulation");
  }
  let result: FixtureResult;
  try {
    const registry = createFixtureRegistry();
    let reached = false;
    while (!reached) {
      ({ reachedTarget: reached } = await runtime.scheduler.advanceTo(target, ADVANCE_BATCH, (work) => {
        const outcome = runtime.execute(registry, work.request, applyFixtureOperation);
        if (!outcome.ok) throw new Error(`work ${work.id} rejected: ${outcome.reason}`);
      }));
    }
    result = {
      now: await runtime.scheduler.now(),
      accumulator: runtime.read(ACCUMULATOR_MODULE, ACCUMULATOR_KEY),
    };
  } catch (error) {
    // Keep the original error; the caller ends the connection, which drops any lock still held.
    await runtime.releaseOwnership().catch(() => {});
    throw error;
  }
  await runtime.releaseOwnership();
  return result;
}
