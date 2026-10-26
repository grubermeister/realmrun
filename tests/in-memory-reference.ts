/**
 * The fixture run through realmlib's in-memory core path (in-memory scheduler,
 * state store, and executeInMemoryOperation), the reference the PostgreSQL
 * run must agree with. Both start from empty state with the same work.
 */

import { createInMemoryScheduler, createInMemoryStateStore, executeInMemoryOperation } from "realmlib";
import type { SimTime, StateValue } from "realmlib";
import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, applyFixtureOperation, createFixtureRegistry, FIXTURE_WORK } from "../src/fixture.ts";

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
