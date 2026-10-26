/**
 * The scenarios run through realmlib's in-memory core path (in-memory
 * scheduler, state store, and executeInMemoryOperation), the references the
 * PostgreSQL runs must agree with. Both start from empty state with the same work.
 *
 * The evolving planet needs the work emitter, which that plain path does not
 * supply, so its reference runs through realmlib's in-memory operation runtime.
 */

import { createInMemoryOperationRuntime, createInMemoryScheduler, createInMemoryStateStore, executeInMemoryOperation } from "realmlib";
import type { InMemoryOperationRuntime, SimTime, StateValue } from "realmlib";
import { buildSnapshotBundle, serializeSnapshotBundle } from "../src/planet-snapshots.ts";
import type { PlanetSnapshot } from "../src/planet-snapshots.ts";
import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, applyFixtureOperation, createFixtureRegistry, FIXTURE_WORK } from "../src/fixture.ts";
import {
  applyPlanetOperation,
  CLIMATE_KEY,
  CLIMATE_MODULE,
  createPlanetRegistry,
  evolvingPlanetWork,
  planetSnapshotTimes,
  planetWork,
  readPlanetRecords,
  TERRAIN_KEY,
  TERRAIN_MODULE,
} from "../src/planetary-fixture.ts";
import type { PlanetConfig } from "../src/planetary-fixture.ts";

export async function runFixtureInMemory(
  until: SimTime,
): Promise<{ now: SimTime; accumulator: StateValue | undefined; executed: string[] }> {
  const registry = createFixtureRegistry();
  const store = createInMemoryStateStore();
  const scheduler = createInMemoryScheduler();
  for (const work of FIXTURE_WORK) await scheduler.schedule(work);
  const executed: string[] = [];
  const result = await scheduler.advanceTo(until, 100, (work) => {
    const outcome = executeInMemoryOperation(registry, store, work.request, applyFixtureOperation);
    if (!outcome.ok) throw new Error(`work ${work.id} rejected: ${outcome.reason}`);
    executed.push(work.id);
  });
  if (!result.reachedTarget) throw new Error("in-memory reference did not reach its target");
  return {
    now: await scheduler.now(),
    accumulator: store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, ACCUMULATOR_KEY),
    executed,
  };
}

/** The planet scenario's work for `config`, in its usual order, run in memory to `until`. */
export async function runPlanetInMemory(
  config: PlanetConfig,
  until: SimTime,
): Promise<{ now: SimTime; terrain: StateValue | undefined; climate: StateValue | undefined; executed: string[] }> {
  const registry = createPlanetRegistry();
  const store = createInMemoryStateStore();
  const scheduler = createInMemoryScheduler();
  for (const work of planetWork(config)) await scheduler.schedule(work);
  const executed: string[] = [];
  const result = await scheduler.advanceTo(until, 100, (work) => {
    const outcome = executeInMemoryOperation(registry, store, work.request, applyPlanetOperation);
    if (!outcome.ok) throw new Error(`work ${work.id} rejected: ${outcome.reason}`);
    executed.push(work.id);
  });
  if (!result.reachedTarget) throw new Error("in-memory reference did not reach its target");
  return {
    now: await scheduler.now(),
    terrain: store.forModule(TERRAIN_MODULE).get(TERRAIN_MODULE, TERRAIN_KEY),
    climate: store.forModule(CLIMATE_MODULE).get(CLIMATE_MODULE, CLIMATE_KEY),
    executed,
  };
}

/**
 * The evolving planet's work for `config`, scheduled in its usual order on a
 * new in-memory operation runtime and run to `until`, reading the committed
 * records at each of `planetSnapshotTimes(until)`. Returns the runtime too, for
 * inspecting its storage, and every executed item in execution order.
 */
export async function runEvolvingPlanetInMemory(
  config: PlanetConfig,
  until: SimTime,
): Promise<{
  runtime: InMemoryOperationRuntime;
  now: SimTime;
  snapshots: PlanetSnapshot[];
  executed: { id: string; at: number }[];
}> {
  const registry = createPlanetRegistry();
  const runtime = createInMemoryOperationRuntime();
  for (const work of evolvingPlanetWork(config)) await runtime.scheduler.schedule(work);
  const executed: { id: string; at: number }[] = [];
  const snapshots: PlanetSnapshot[] = [];
  for (const target of planetSnapshotTimes(until)) {
    const result = await runtime.scheduler.advanceTo(target, 100, (work) => {
      const outcome = runtime.execute(registry, work.request, applyPlanetOperation);
      if (!outcome.ok) throw new Error(`work ${work.id} rejected: ${outcome.reason}`);
      executed.push({ id: work.id, at: work.at });
    });
    if (!result.reachedTarget) throw new Error("in-memory reference did not reach its target");
    snapshots.push({ atMs: target, ...readPlanetRecords((owner, key) => runtime.read(owner, key)) });
  }
  return { runtime, now: await runtime.scheduler.now(), snapshots, executed };
}

/**
 * The text `--export-snapshots` writes for the evolving planet's run of
 * `config` to `until`, built from the in-memory reference run with D1's own
 * bundle builder and serializer.
 */
export async function exportedSnapshotsInMemory(config: PlanetConfig, until: SimTime): Promise<string> {
  const { snapshots } = await runEvolvingPlanetInMemory(config, until);
  return serializeSnapshotBundle(buildSnapshotBundle(config, snapshots));
}
