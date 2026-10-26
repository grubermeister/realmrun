/**
 * Consumes `lattice-climate-module` the way any host would: by package name,
 * through realmlib's public API only, with terrain's committed record as its
 * only input.
 */

import { describe, expect, test } from "bun:test";
import {
  applyClimateOperation,
  BIOMES,
  CLIMATE_KEY,
  CLIMATE_MODULE,
  CLIMATE_SCHEMA_VERSION,
  climateModule,
  parseClimateRecord,
} from "lattice-climate-module";
import type { ClimateRecord } from "lattice-climate-module";
import {
  applyTerrainOperation,
  CLIMATE_REFRESH_REQUEST,
  isLand,
  rowLatitude,
  SURFACE_CELLS,
  SURFACE_WIDTH,
  TERRAIN_KEY,
  TERRAIN_MODULE,
  terrainModule,
} from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation, moduleId } from "realmlib";
import type { InMemoryStateStore, ModuleId, OperationHandler, StateValue } from "realmlib";

const SEED = 1729;

function setup() {
  const registry = createModuleRegistry();
  registry.register(terrainModule);
  registry.register(climateModule);
  return { registry, store: createInMemoryStateStore() };
}

const derive = (meanTempC: unknown, payloadVersion = 1) => ({
  moduleId: CLIMATE_MODULE,
  operation: "derive",
  payloadVersion,
  payload: { meanTempC },
});

const generate = (seed = SEED, seaLevel = 0) => ({
  moduleId: TERRAIN_MODULE,
  operation: "generate",
  payloadVersion: 1,
  payload: { seed, seaLevel },
});

const read = (store: InMemoryStateStore, owner: ModuleId, key: string) => store.forModule(owner).get(owner, key);
const terrainOf = (store: InMemoryStateStore) => read(store, TERRAIN_MODULE, TERRAIN_KEY) as TerrainRecord | undefined;
const climateOf = (store: InMemoryStateStore) => read(store, CLIMATE_MODULE, CLIMATE_KEY) as ClimateRecord | undefined;

/** A fresh store holding committed terrain and, if `meanTempC` is given, climate. */
function planet(meanTempC?: number, seed = SEED, seaLevel = 0) {
  const { registry, store } = setup();
  expect(executeInMemoryOperation(registry, store, generate(seed, seaLevel), applyTerrainOperation).ok).toBe(true);
  if (meanTempC !== undefined) {
    expect(executeInMemoryOperation(registry, store, derive(meanTempC), applyClimateOperation).ok).toBe(true);
  }
  return { registry, store };
}

/** Every number in `value` is a finite, non-negative-zero integer, and it has no undefined, functions, or class instances. */
function expectPlainState(value: StateValue): void {
  if (typeof value === "number") {
    expect(Number.isInteger(value) && !Object.is(value, -0)).toBe(true);
  } else if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
    value.forEach(expectPlainState);
  } else if (typeof value === "object" && value !== null) {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    Object.values(value).forEach(expectPlainState);
  } else {
    expect(["string", "boolean"].includes(typeof value) || value === null).toBe(true);
  }
}

describe("lattice-climate-module consumed independently", () => {
  test("declares the climate module with derive and refresh at version 1", () => {
    expect(climateModule.id).toBe(CLIMATE_MODULE);
    expect(CLIMATE_MODULE).toBe(moduleId("climate"));
    expect(CLIMATE_KEY).toBe("climate");
    expect(climateModule.operations.map((o) => [o.name, o.version])).toEqual([
      ["derive", 1],
      ["refresh", 1],
    ]);
  });

  test("refresh is at the address terrain's raise-sea-level emits", () => {
    const { registry } = setup();
    expect(registry.validate(CLIMATE_REFRESH_REQUEST)).toEqual({ ok: true, request: CLIMATE_REFRESH_REQUEST });
  });

  test("the registry accepts valid payloads and rejects invalid ones", () => {
    const { registry } = setup();
    for (const t of [-40, 0, 15, 40]) expect(registry.validate(derive(t)).ok).toBe(true);
    for (const t of [-41, 41, 1.5, -0, "15", null, Number.NaN]) {
      expect(registry.validate(derive(t))).toEqual({ ok: false, reason: "invalid-payload" });
    }
    for (const payload of [15, null, [], {}, { meanTempC: 15, elevation: [] }]) {
      expect(registry.validate({ ...derive(0), payload })).toEqual({ ok: false, reason: "invalid-payload" });
    }
    expect(registry.validate(derive(15, 2))).toEqual({ ok: false, reason: "unsupported-version" });
  });

  test("derive reads terrain through state.get() and writes only its own record", () => {
    const { registry, store } = planet();
    const terrainBefore = terrainOf(store);
    const calls: string[] = [];
    // Observes the real staged view the realmlib core passes in; changes nothing.
    const observed: OperationHandler = (request, state) =>
      applyClimateOperation(request, {
        get: (owner, key) => (calls.push(`get ${owner}/${key}`), state.get(owner, key)),
        set: (key, value) => (calls.push(`set ${key}`), state.set(key, value)),
        delete: (key) => (calls.push(`delete ${key}`), state.delete(key)),
      });
    expect(executeInMemoryOperation(registry, store, derive(15), observed).ok).toBe(true);
    expect(calls).toEqual(["get terrain/surface", "set climate"]);
    expect(terrainOf(store)).toEqual(terrainBefore!);
    expect(read(store, CLIMATE_MODULE, TERRAIN_KEY)).toBeUndefined();
    expect(read(store, TERRAIN_MODULE, CLIMATE_KEY)).toBeUndefined();
  });

  test("derive before terrain is generated fails and commits nothing", () => {
    const { registry, store } = setup();
    expect(() => executeInMemoryOperation(registry, store, derive(15), applyClimateOperation)).toThrow(
      "terrain surface has not been generated",
    );
    expect(climateOf(store)).toBeUndefined();
  });

  describe("a malformed or unsupported terrain record fails without partial changes", () => {
    const valid = terrainOf(planet().store)!;
    test.each([
      ["a newer schema version", { ...valid, schemaVersion: 2 }],
      ["the wrong number of cells", { ...valid, elevation: valid.elevation.slice(0, 100) }],
      ["an out-of-range elevation", { ...valid, elevation: valid.elevation.map(() => 1000) }],
      ["other dimensions", { ...valid, width: 96 }],
      ["a bare array", valid.elevation],
      ["null", null],
    ])("%s", (_, corrupt) => {
      const { registry, store } = planet(15);
      const climateBefore = climateOf(store);
      store.forModule(TERRAIN_MODULE).set(TERRAIN_KEY, corrupt as StateValue);
      expect(() => executeInMemoryOperation(registry, store, derive(-5), applyClimateOperation)).toThrow("Invalid terrain record");
      // The earlier climate record is still committed, untouched.
      expect(climateOf(store)).toEqual(climateBefore!);
    });
  });

  test("the climate record has the agreed schema, 1152 cells, and valid state values", () => {
    const climate = climateOf(planet(15).store)!;
    expect(parseClimateRecord(climate)).toEqual(climate);
    expect(Object.keys(climate)).toEqual(["schemaVersion", "width", "height", "meanTempC", "temperatureC", "moisture", "biome"]);
    expect(climate).toMatchObject({ schemaVersion: CLIMATE_SCHEMA_VERSION, width: 48, height: 24, meanTempC: 15 });
    for (const field of ["temperatureC", "moisture", "biome"] as const) expect(climate[field]).toHaveLength(SURFACE_CELLS);
    expectPlainState(climate);
    expect(JSON.parse(JSON.stringify(climate))).toEqual(climate);
  });

  test("ocean biome cells are exactly terrain's non-land cells", () => {
    const { store } = planet(15);
    const terrain = terrainOf(store)!;
    const climate = climateOf(store)!;
    climate.biome.forEach((biome, index) => expect(biome === "ocean").toBe(!isLand(terrain, index)));
  });

  test("the sample has several biomes and plausible latitude dependence", () => {
    const climate = climateOf(planet(15).store)!;
    const present = new Set(climate.biome);
    expect(present.size).toBeGreaterThanOrEqual(4);
    for (const biome of present) expect(BIOMES).toContain(biome);

    const rowMean = (row: number) =>
      climate.temperatureC.slice(row * SURFACE_WIDTH, (row + 1) * SURFACE_WIDTH).reduce((x, y) => x + y, 0) / SURFACE_WIDTH;
    expect(rowMean(0)).toBeLessThan(rowMean(11) - 20);
    expect(rowMean(23)).toBeLessThan(rowMean(12) - 20);
    climate.biome.forEach((biome, index) => {
      const latitude = Math.abs(rowLatitude(Math.floor(index / SURFACE_WIDTH)));
      if (biome === "tropical-forest") expect(latitude).toBeLessThan(30);
    });
    // Ice is far more common near the poles than near the equator.
    const iceIn = (rows: number[]) =>
      rows.reduce((n, row) => n + climate.biome.slice(row * 48, row * 48 + 48).filter((b) => b === "ice").length, 0);
    expect(iceIn([0, 1, 22, 23])).toBeGreaterThan(iceIn([10, 11, 12, 13]) + 20);
  });

  test("changing the baseline temperature changes temperatures and biomes", () => {
    const warm = climateOf(planet(15).store)!;
    const cold = climateOf(planet(0).store)!;
    expect(cold.temperatureC).not.toEqual(warm.temperatureC);
    expect(cold.biome).not.toEqual(warm.biome);
    warm.temperatureC.forEach((t, index) => expect(cold.temperatureC[index]!).toBeLessThanOrEqual(t));
    const count = (record: ClimateRecord, biome: string) => record.biome.filter((b) => b === biome).length;
    expect(count(cold, "ice")).toBeGreaterThan(count(warm, "ice"));
  });

  test("derive is deterministic and follows terrain's seed", () => {
    expect(climateOf(planet(15).store)).toEqual(climateOf(planet(15).store)!);
    expect(climateOf(planet(15, 42).store)!.biome).not.toEqual(climateOf(planet(15).store)!.biome);
  });

  test.each([
    [-40, -100],
    [-40, 100],
    [40, -100],
    [40, 100],
  ])("extreme inputs (mean %d, sea level %d) stay within the record's bounds", (meanTempC, seaLevel) => {
    const climate = climateOf(planet(meanTempC, SEED, seaLevel).store)!;
    expect(parseClimateRecord(climate)).toEqual(climate);
  });

  test("a misrouted request throws and commits nothing", () => {
    const { store } = planet();
    const registry = createModuleRegistry();
    const other = moduleId("other");
    registry.register({ id: other, operations: [{ name: "derive", version: 1, validatePayload: () => true }] });
    const input = { moduleId: other, operation: "derive", payloadVersion: 1, payload: { meanTempC: 15 } };
    expect(() => executeInMemoryOperation(registry, store, input, applyClimateOperation)).toThrow("climate handler received");
    expect(read(store, other, CLIMATE_KEY)).toBeUndefined();
  });

  describe("refresh", () => {
    const refresh = (payload: unknown, payloadVersion = 1) => ({
      moduleId: CLIMATE_MODULE,
      operation: "refresh",
      payloadVersion,
      payload,
    });

    /** Replaces the committed terrain with the same surface at `seaLevel`, as terrain's raise-sea-level would. */
    function flood(store: InMemoryStateStore, seaLevel: number): TerrainRecord {
      const raised = { ...terrainOf(store)!, seaLevel };
      store.forModule(TERRAIN_MODULE).set(TERRAIN_KEY, raised);
      return raised;
    }

    test("the registry accepts exactly {}", () => {
      const { registry } = setup();
      expect(registry.validate(refresh({})).ok).toBe(true);
      for (const payload of [undefined, null, 0, [], { meanTempC: 15 }, { force: true }]) {
        expect(registry.validate(refresh(payload))).toEqual({ ok: false, reason: "invalid-payload" });
      }
      expect(registry.validate(refresh({}, 2))).toEqual({ ok: false, reason: "unsupported-version" });
    });

    test("re-derives from the new committed terrain, keeping the prior baseline, and writes only its own record", () => {
      const { registry, store } = planet(-3);
      const before = climateOf(store)!;
      const terrain = flood(store, 10);
      const calls: string[] = [];
      const observed: OperationHandler = (request, state) =>
        applyClimateOperation(request, {
          get: (owner, key) => (calls.push(`get ${owner}/${key}`), state.get(owner, key)),
          set: (key, value) => (calls.push(`set ${key}`), state.set(key, value)),
          delete: (key) => (calls.push(`delete ${key}`), state.delete(key)),
        });
      expect(executeInMemoryOperation(registry, store, refresh({}), observed).ok).toBe(true);
      expect(calls).toEqual(["get climate/climate", "get terrain/surface", "set climate"]);
      expect(terrainOf(store)).toEqual(terrain);

      const after = climateOf(store)!;
      expect(after.meanTempC).toBe(-3);
      expect(after.biome).not.toEqual(before.biome);
      after.biome.forEach((biome, index) => expect(biome === "ocean").toBe(!isLand(terrain, index)));
      // The same result as deriving afresh with that baseline from the flooded terrain.
      expect(after).toEqual(climateOf(planet(-3, SEED, 10).store)!);
    });

    test("fails without changes if climate has not been derived", () => {
      const { registry, store } = planet();
      expect(() => executeInMemoryOperation(registry, store, refresh({}), applyClimateOperation)).toThrow(
        "climate has not been derived",
      );
      expect(climateOf(store)).toBeUndefined();
    });

    test("fails without changes if terrain has not been generated", () => {
      const { registry, store } = setup();
      const climate = climateOf(planet(15).store)!;
      store.forModule(CLIMATE_MODULE).set(CLIMATE_KEY, climate);
      expect(() => executeInMemoryOperation(registry, store, refresh({}), applyClimateOperation)).toThrow(
        "terrain surface has not been generated",
      );
      expect(climateOf(store)).toEqual(climate);
    });

    test.each([
      ["climate", "a newer schema version", (c: ClimateRecord) => ({ ...c, schemaVersion: 2 }), "Invalid climate record"],
      ["climate", "an out-of-range baseline", (c: ClimateRecord) => ({ ...c, meanTempC: 99 }), "Invalid climate record"],
      ["terrain", "a newer schema version", (t: TerrainRecord) => ({ ...t, schemaVersion: 2 }), "Invalid terrain record"],
    ] as const)("an invalid %s record (%s) fails without changes", (which, _, corrupt, message) => {
      const { registry, store } = planet(15);
      if (which === "climate") store.forModule(CLIMATE_MODULE).set(CLIMATE_KEY, corrupt(climateOf(store)! as never) as StateValue);
      else store.forModule(TERRAIN_MODULE).set(TERRAIN_KEY, corrupt(terrainOf(store)! as never) as StateValue);
      const climateBefore = climateOf(store);
      expect(() => executeInMemoryOperation(registry, store, refresh({}), applyClimateOperation)).toThrow(message);
      expect(climateOf(store)).toEqual(climateBefore!);
    });

    test("a misrouted request throws and commits nothing", () => {
      const { store } = planet(15);
      const registry = createModuleRegistry();
      const other = moduleId("other");
      registry.register({ id: other, operations: [{ name: "refresh", version: 1, validatePayload: () => true }] });
      const input = { moduleId: other, operation: "refresh", payloadVersion: 1, payload: {} };
      expect(() => executeInMemoryOperation(registry, store, input, applyClimateOperation)).toThrow("climate handler received");
      expect(read(store, other, CLIMATE_KEY)).toBeUndefined();
    });
  });

  describe("parseClimateRecord", () => {
    const valid = climateOf(planet(15).store)!;
    test.each([
      ["missing", undefined],
      ["a newer schema version", { ...valid, schemaVersion: 2 }],
      ["an extra field", { ...valid, extra: 1 }],
      ["an unknown biome", { ...valid, biome: ["swamp", ...valid.biome.slice(1)] }],
      ["moisture out of range", { ...valid, moisture: [101, ...valid.moisture.slice(1)] }],
      ["too few temperatures", { ...valid, temperatureC: valid.temperatureC.slice(1) }],
    ])("rejects %s", (_, value) => {
      expect(() => parseClimateRecord(value)).toThrow(TypeError);
    });
  });

  test("the package's source imports only realmlib and terrain's public contract", async () => {
    const source = await Bun.file(Bun.resolveSync("lattice-climate-module", import.meta.dir)).text();
    const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(["realmlib", "lattice-terrain-module"]));
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date|process\.env/);
  });
});
