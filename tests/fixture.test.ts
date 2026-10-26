import { describe, expect, test } from "bun:test";
import { createInMemoryStateStore, executeInMemoryOperation, simTime } from "realmlib";
import { ACCUMULATOR_MODULE, applyFixtureOperation, createFixtureRegistry, FIXTURE_WORK } from "../src/fixture.ts";
import { runFixtureInMemory } from "./in-memory-reference.ts";

describe("fixture through realmlib's in-memory core path", () => {
  test.each([
    [0, 1],
    [5, 9],
    [12, 13],
    [20, 13],
  ])("--until %d ends at that clock with accumulator %d", async (until, accumulator) => {
    const result = await runFixtureInMemory(simTime(until));
    expect(result.now).toBe(simTime(until));
    expect(result.accumulator).toBe(accumulator);
  });

  test("work at equal times runs in insertion order: add 2 before multiply by 3", async () => {
    expect((await runFixtureInMemory(simTime(5))).executed).toEqual(["initialize", "t5-add-2", "t5-multiply-3"]);
    expect((await runFixtureInMemory(simTime(12))).executed).toEqual([
      "initialize",
      "t5-add-2",
      "t5-multiply-3",
      "t12-add-4",
    ]);
  });

  test("work is scheduled in the table's order and times", () => {
    expect(FIXTURE_WORK.map((w) => [w.at, w.request.operation, w.request.payload])).toEqual([
      [0, "set", 1],
      [5, "add", 2],
      [5, "multiply", 3],
      [12, "add", 4],
    ]);
  });

  test("the registry rejects non-numeric operands and unknown operations", () => {
    const registry = createFixtureRegistry();
    const store = createInMemoryStateStore();
    const base = { moduleId: ACCUMULATOR_MODULE, payloadVersion: 1 };
    expect(executeInMemoryOperation(registry, store, { ...base, operation: "add", payload: "2" }, applyFixtureOperation)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    expect(executeInMemoryOperation(registry, store, { ...base, operation: "divide", payload: 2 }, applyFixtureOperation)).toEqual({
      ok: false,
      reason: "unknown-operation",
    });
  });

  test("arithmetic before initialization fails and commits nothing", () => {
    const registry = createFixtureRegistry();
    const store = createInMemoryStateStore();
    const input = { moduleId: ACCUMULATOR_MODULE, operation: "add", payloadVersion: 1, payload: 2 };
    expect(() => executeInMemoryOperation(registry, store, input, applyFixtureOperation)).toThrow("not initialized");
    expect(store.forModule(ACCUMULATOR_MODULE).get(ACCUMULATOR_MODULE, "value")).toBeUndefined();
  });
});
