/**
 * The test fixture: one numeric accumulator owned by a single module, changed
 * only by scheduled operations that realmlib validates and executes.
 *
 * realmlib has no direct state-seeding API, so the accumulator's initial value
 * is written by a `set` operation at simulation time 0, scheduled first.
 * Kept separate from the CLI so a later experiment can replace it.
 */

import { createModuleRegistry, moduleId, simTime, workItemId } from "realmlib";
import type { ModuleRegistry, OperationHandler, ScheduledWork } from "realmlib";

export const ACCUMULATOR_MODULE = moduleId("accumulator");
export const ACCUMULATOR_KEY = "value";
export const INITIAL_VALUE = 1;

const isFiniteNumber = (payload: unknown): boolean => typeof payload === "number" && Number.isFinite(payload);

/** A new registry accepting the accumulator module's operations. */
export function createFixtureRegistry(): ModuleRegistry {
  const registry = createModuleRegistry();
  registry.register({
    id: ACCUMULATOR_MODULE,
    operations: [
      { name: "set", version: 1, validatePayload: isFiniteNumber },
      { name: "add", version: 1, validatePayload: isFiniteNumber },
      { name: "multiply", version: 1, validatePayload: isFiniteNumber },
    ],
  });
  return registry;
}

/** Applies one validated accumulator operation through the staged state view. */
export const applyFixtureOperation: OperationHandler = (request, state) => {
  const operand = request.payload as number;
  if (request.operation === "set") {
    state.set(ACCUMULATOR_KEY, operand);
    return;
  }
  const current = state.get(request.moduleId, ACCUMULATOR_KEY);
  if (typeof current !== "number") throw new Error("accumulator is not initialized");
  if (request.operation === "add") state.set(ACCUMULATOR_KEY, current + operand);
  else if (request.operation === "multiply") state.set(ACCUMULATOR_KEY, current * operand);
  else throw new Error(`unhandled operation ${JSON.stringify(request.operation)}`);
};

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
