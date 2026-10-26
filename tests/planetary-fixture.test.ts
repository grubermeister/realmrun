import { describe, expect, test } from "bun:test";
import { parseClimateRecord } from "lattice-climate-module";
import { parseTerrainRecord } from "lattice-terrain-module";
import { createInMemoryScheduler, createInMemoryStateStore, executeInMemoryOperation, moduleId, simTime } from "realmlib";
import type { ScheduledWork } from "realmlib";
import {
  applyPlanetOperation,
  CLIMATE_KEY,
  CLIMATE_MODULE,
  climateWork,
  createPlanetRegistry,
  DEFAULT_PLANET_CONFIG,
  planetWork,
  readPlanetRecords,
  TERRAIN_KEY,
  TERRAIN_MODULE,
  terrainWork,
} from "../src/planetary-fixture.ts";
import { runPlanetInMemory } from "./in-memory-reference.ts";

/** Runs `work`, scheduled in the given order, through the in-memory scheduler and the planet's dispatch. */
async function runInOrder(work: readonly ScheduledWork[], until = simTime(0)) {
  const registry = createPlanetRegistry();
  const store = createInMemoryStateStore();
  const scheduler = createInMemoryScheduler();
  for (const item of work) expect(await scheduler.schedule(item)).toBe("accepted");
  const executed: string[] = [];
  const advance = scheduler.advanceTo(until, 100, (item) => {
    const outcome = executeInMemoryOperation(registry, store, item.request, applyPlanetOperation);
    if (!outcome.ok) throw new Error(`work ${item.id} rejected: ${outcome.reason}`);
    executed.push(item.id);
  });
  return { store, scheduler, executed, advance };
}

describe("planet scenario through realmlib's in-memory core path", () => {
  test("terrain then climate are scheduled once each at time 0, in that order", () => {
    expect(planetWork(DEFAULT_PLANET_CONFIG)).toEqual([
      {
        id: "planet-terrain-generate",
        at: 0,
        request: { moduleId: TERRAIN_MODULE, operation: "generate", payloadVersion: 1, payload: { seed: 1729, seaLevel: 0 } },
      },
      {
        id: "planet-climate-derive",
        at: 0,
        request: { moduleId: CLIMATE_MODULE, operation: "derive", payloadVersion: 1, payload: { meanTempC: 15 } },
      },
    ] as unknown as ScheduledWork[]);
  });

  test("both items run at the same time, in insertion order, and commit both records", async () => {
    const { store, scheduler, executed, advance } = await runInOrder(planetWork(DEFAULT_PLANET_CONFIG));
    expect(await advance).toEqual({ now: simTime(0), executed: 2, reachedTarget: true });
    expect(executed).toEqual(["planet-terrain-generate", "planet-climate-derive"]);
    expect(await scheduler.pendingCount()).toBe(0);
    const records = readPlanetRecords((owner, key) => store.forModule(owner).get(owner, key));
    expect(records.terrain).toMatchObject({ seed: 1729, seaLevel: 0 });
    expect(records.climate).toMatchObject({ meanTempC: 15 });
  });

  test("the result is deterministic and matches the shared in-memory reference", async () => {
    const first = await runPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
    const second = await runPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
    expect(second).toEqual(first);
    expect(first.executed).toEqual(["planet-terrain-generate", "planet-climate-derive"]);
    expect(parseTerrainRecord(first.terrain)).toBeDefined();
    expect(parseClimateRecord(first.climate)).toBeDefined();
  });

  test("a later target only moves the clock: nothing recurs", async () => {
    const atZero = await runPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
    const later = await runPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(60_000));
    expect(later).toEqual({ ...atZero, now: simTime(60_000) });
  });

  test("climate consumes committed terrain: scheduled first, it fails and stays pending", async () => {
    const config = DEFAULT_PLANET_CONFIG;
    const { store, scheduler, executed, advance } = await runInOrder([climateWork(config), terrainWork(config)]);
    await expect(advance).rejects.toThrow("terrain surface has not been generated");
    expect(executed).toEqual([]);
    expect(store.forModule(CLIMATE_MODULE).get(CLIMATE_MODULE, CLIMATE_KEY)).toBeUndefined();
    expect(store.forModule(TERRAIN_MODULE).get(TERRAIN_MODULE, TERRAIN_KEY)).toBeUndefined();
    // The failed item stays pending at the head of the queue, with the clock at its time.
    expect(await scheduler.pendingCount()).toBe(2);
    expect(await scheduler.now()).toBe(simTime(0));
    await expect(scheduler.advanceTo(simTime(0), 100, (item) => {
      executeInMemoryOperation(createPlanetRegistry(), store, item.request, applyPlanetOperation);
    })).rejects.toThrow("terrain surface has not been generated");
    expect(await scheduler.pendingCount()).toBe(2);
  });

  test("different inputs change the committed records", async () => {
    const base = await runPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
    const reseeded = await runPlanetInMemory({ ...DEFAULT_PLANET_CONFIG, seed: 42 }, simTime(0));
    const colder = await runPlanetInMemory({ ...DEFAULT_PLANET_CONFIG, meanTempC: 0 }, simTime(0));
    expect(reseeded.terrain).not.toEqual(base.terrain);
    expect(reseeded.climate).not.toEqual(base.climate);
    expect(colder.terrain).toEqual(base.terrain);
    expect(colder.climate).not.toEqual(base.climate);
  });

  test("dispatch is by the validated module ID; requests for other modules never reach a handler", () => {
    const registry = createPlanetRegistry();
    const store = createInMemoryStateStore();
    const stray = { moduleId: moduleId("accumulator"), operation: "set", payloadVersion: 1, payload: 1 };
    expect(executeInMemoryOperation(registry, store, stray, applyPlanetOperation)).toEqual({ ok: false, reason: "unknown-module" });
    // Even a request the registry accepted for some unrelated module is refused by the dispatch.
    expect(() => applyPlanetOperation(stray, store.forModule(stray.moduleId))).toThrow("no handler for module");
  });
});
