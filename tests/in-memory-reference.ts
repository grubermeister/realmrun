/**
 * The scenarios run through realmlib's in-memory core path (in-memory
 * scheduler, state store, and executeInMemoryOperation), the references the
 * PostgreSQL runs must agree with. Both start from empty state with the same work.
 */

import { createInMemoryScheduler, createInMemoryStateStore, executeInMemoryOperation } from "realmlib";
import type { SimTime, StateValue } from "realmlib";
import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, applyFixtureOperation, createFixtureRegistry, FIXTURE_WORK } from "../src/fixture.ts";
import {
  applyPlanetOperation,
  CLIMATE_KEY,
  CLIMATE_MODULE,
  createPlanetRegistry,
  planetWork,
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
