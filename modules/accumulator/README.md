# lattice-accumulator-module

A portable [`realmlib`](../../../realmlib) simulation module: a single numeric
accumulator. It is a private local package inside realmrun for now, written so
it can move to its own repository without changing what it exports.

## State and operations

The module `accumulator` owns one record, `value`, holding a number. Every
operation is at payload version 1 and takes a finite number as its payload;
anything else is rejected by the registry as `invalid-payload`.

| Operation  | Effect                                  |
|------------|-----------------------------------------|
| `set`      | `value` becomes the payload             |
| `add`      | `value` becomes `value + payload`       |
| `multiply` | `value` becomes `value * payload`       |

`add` and `multiply` throw `accumulator is not initialized` if `value` is not a
number yet (no `set` has committed); realmlib then commits nothing. Results are
stored as-is, so one that is not a valid realmlib state value (such as an
overflow to `Infinity`) makes the write throw and realmlib commits nothing.

## Exports

Import everything from the package root, `lattice-accumulator-module`:

| Export                      | Type                          | What it is                          |
|-----------------------------|-------------------------------|-------------------------------------|
| `accumulatorModule`         | `ModuleDefinition` (realmlib) | The module ID and its operations    |
| `applyAccumulatorOperation` | `OperationHandler` (realmlib) | The handler for all its operations  |
| `ACCUMULATOR_MODULE`        | `ModuleId` (realmlib)         | `"accumulator"`, the owning module  |
| `ACCUMULATOR_KEY`           | `string`                      | `"value"`, the key of its record    |

## Using it

The consumer owns registration, scheduling, and dispatch. Registering the
definition only lets the registry validate requests; the consumer must still
pass the handler each time it executes one:

```ts
import { accumulatorModule, applyAccumulatorOperation, ACCUMULATOR_KEY, ACCUMULATOR_MODULE } from "lattice-accumulator-module";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation } from "realmlib";

const registry = createModuleRegistry();
registry.register(accumulatorModule);

const store = createInMemoryStateStore();
const request = { moduleId: ACCUMULATOR_MODULE, operation: "set", payloadVersion: 1, payload: 1 };
executeInMemoryOperation(registry, store, request, applyAccumulatorOperation);
store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, ACCUMULATOR_KEY); // 1
```

With realmlib's PostgreSQL runtime, pass the same handler to
`runtime.execute(registry, request, applyAccumulatorOperation)` from the
scheduler's `advanceTo()` callback.

Importing the package is inert: it does not register itself, touch any state or
database, schedule work, read the environment, or start anything. It depends
only on `realmlib`'s package root and on no particular host; realmrun is one
consumer of it, not a requirement.
