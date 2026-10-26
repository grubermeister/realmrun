/**
 * Consumes `lattice-accumulator-module` the way any host would: by package
 * name, through realmlib's public API only, without realmrun's fixture or
 * runtime wiring.
 */

import { describe, expect, test } from "bun:test";
import { ACCUMULATOR_KEY, ACCUMULATOR_MODULE, accumulatorModule, applyAccumulatorOperation } from "lattice-accumulator-module";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation } from "realmlib";

function setup() {
  const registry = createModuleRegistry();
  registry.register(accumulatorModule);
  return { registry, store: createInMemoryStateStore() };
}

const request = (operation: string, payload: unknown, payloadVersion = 1) => ({
  moduleId: ACCUMULATOR_MODULE,
  operation,
  payloadVersion,
  payload,
});

describe("lattice-accumulator-module consumed independently", () => {
  test("declares the accumulator module with set, add, and multiply at version 1", () => {
    expect(accumulatorModule.id).toBe(ACCUMULATOR_MODULE);
    expect(accumulatorModule.operations.map((o) => [o.name, o.version])).toEqual([
      ["set", 1],
      ["add", 1],
      ["multiply", 1],
    ]);
  });

  test("the registry accepts valid requests and rejects invalid ones", () => {
    const { registry } = setup();
    expect(registry.validate(request("add", 2))).toEqual({ ok: true, request: request("add", 2) });
    expect(registry.validate(request("add", "2"))).toEqual({ ok: false, reason: "invalid-payload" });
    expect(registry.validate(request("set", Number.NaN))).toEqual({ ok: false, reason: "invalid-payload" });
    expect(registry.validate(request("multiply", Infinity))).toEqual({ ok: false, reason: "invalid-payload" });
    expect(registry.validate(request("divide", 2))).toEqual({ ok: false, reason: "unknown-operation" });
    expect(registry.validate(request("add", 2, 2))).toEqual({ ok: false, reason: "unsupported-version" });
  });

  test("executes set and later operations through the exported handler", () => {
    const { registry, store } = setup();
    for (const [operation, operand] of [
      ["set", 1],
      ["add", 2],
      ["multiply", 3],
      ["add", 4],
    ] as const) {
      expect(executeInMemoryOperation(registry, store, request(operation, operand), applyAccumulatorOperation).ok).toBe(true);
    }
    expect(store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, ACCUMULATOR_KEY)).toBe(13);
  });

  test("a rejected request leaves state unchanged", () => {
    const { registry, store } = setup();
    executeInMemoryOperation(registry, store, request("set", 5), applyAccumulatorOperation);
    expect(executeInMemoryOperation(registry, store, request("add", "1"), applyAccumulatorOperation)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    expect(store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, ACCUMULATOR_KEY)).toBe(5);
  });

  test("arithmetic before initialization throws and commits nothing", () => {
    const { registry, store } = setup();
    for (const operation of ["add", "multiply"]) {
      expect(() => executeInMemoryOperation(registry, store, request(operation, 2), applyAccumulatorOperation)).toThrow(
        "accumulator is not initialized",
      );
      expect(store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, ACCUMULATOR_KEY)).toBeUndefined();
    }
  });

  test("a result that is not a valid state value throws and commits nothing", () => {
    const { registry, store } = setup();
    executeInMemoryOperation(registry, store, request("set", Number.MAX_VALUE), applyAccumulatorOperation);
    expect(() => executeInMemoryOperation(registry, store, request("multiply", 2), applyAccumulatorOperation)).toThrow(
      "non-finite number",
    );
    expect(store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, ACCUMULATOR_KEY)).toBe(Number.MAX_VALUE);
  });

  test("the package's source imports only realmlib", async () => {
    const source = await Bun.file(Bun.resolveSync("lattice-accumulator-module", import.meta.dir)).text();
    const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(["realmlib"]));
  });
});
