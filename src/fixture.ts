/**
 * The test fixture: the accumulator module from `lattice-accumulator-module`,
 * changed only by scheduled operations that realmlib validates and executes.
 *
 * The module package only declares the module and handles its operations; this
 * file registers it, selects its handler for dispatch, and defines the work.
 * realmlib has no direct state-seeding API, so the accumulator's initial value
 * is written by a `set` operation at simulation time 0, scheduled first.
 * Kept separate from the CLI so a later experiment can replace it.
 */

import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, accumulatorModule, applyAccumulatorOperation } from "lattice-accumulator-module";
import { createModuleRegistry, simTime, workItemId } from "realmlib";
import type { ModuleRegistry, OperationHandler, ScheduledWork } from "realmlib";

export { ACCUMULATOR_KEY, ACCUMULATOR_MODULE };
export const INITIAL_VALUE = 1;

/** A new registry accepting the accumulator module's operations. */
export function createFixtureRegistry(): ModuleRegistry {
  const registry = createModuleRegistry();
  registry.register(accumulatorModule);
  return registry;
}

/** The handler the fixture's work is executed with. */
export const applyFixtureOperation: OperationHandler = applyAccumulatorOperation;

function work(id: string, at: number, operation: string, payload: number): ScheduledWork {
  return {
    id: workItemId(id),
    at: simTime(at),
    request: { moduleId: ACCUMULATOR_MODULE, operation, payloadVersion: 1, payload },
  };
}

/** The fixture's work, to be scheduled in this order (which breaks ties at equal times). */
export const FIXTURE_WORK: readonly ScheduledWork[] = [
  work("initialize", 0, "set", INITIAL_VALUE),
  work("t5-add-2", 5, "add", 2),
  work("t5-multiply-3", 5, "multiply", 3),
  work("t12-add-4", 12, "add", 4),
];
