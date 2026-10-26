/**
 * The accumulator simulation module: one numeric record, `value`, owned by the
 * `accumulator` module and changed only by its `set`, `add`, and `multiply`
 * operations.
 *
 * This package declares the module and handles its operations; it does not
 * register itself, schedule work, or choose when operations run. A consumer
 * registers {@link accumulatorModule} with realmlib's `createModuleRegistry()`
 * and passes {@link applyAccumulatorOperation} as the handler for each request.
 * Importing it has no side effects.
 */

import { moduleId } from "realmlib";
import type { ModuleDefinition, OperationHandler } from "realmlib";

/** The module's ID, under which it owns its state. */
export const ACCUMULATOR_MODULE = moduleId("accumulator");

/** The key of the module's one record: the accumulator's current number. */
export const ACCUMULATOR_KEY = "value";

const isFiniteNumber = (payload: unknown): boolean => typeof payload === "number" && Number.isFinite(payload);

/** The module's operations, each at payload version 1 with a finite-number payload. */
export const accumulatorModule: ModuleDefinition = {
  id: ACCUMULATOR_MODULE,
  operations: [
    { name: "set", version: 1, validatePayload: isFiniteNumber },
    { name: "add", version: 1, validatePayload: isFiniteNumber },
    { name: "multiply", version: 1, validatePayload: isFiniteNumber },
  ],
};

/**
 * Applies one validated accumulator operation through the staged state view.
 * `add` and `multiply` throw if the accumulator has not been `set`.
 */
export const applyAccumulatorOperation: OperationHandler = (request, state) => {
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
