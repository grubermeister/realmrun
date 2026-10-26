/**
 * Consumes `lattice-terrain-module` the way any host would: by package name,
 * through realmlib's public API only, without realmrun's scenario wiring.
 */

import { describe, expect, test } from "bun:test";
import {
  applyTerrainOperation,
  CLIMATE_REFRESH_REQUEST,
  climateRefreshWorkId,
  ELEVATION_MAX,
  ELEVATION_MIN,
  isLand,
  parseTerrainRecord,
  rowLatitude,
  SURFACE_CELLS,
  SURFACE_HEIGHT,
  SURFACE_WIDTH,
  TERRAIN_KEY,
  TERRAIN_MODULE,
  TERRAIN_SCHEMA_VERSION,
  terrainModule,
} from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation, moduleId, simTime } from "realmlib";
import type { InMemoryStateStore, OperationHandler, ScheduledWork, WorkEmitter } from "realmlib";

/** The documented sample seeds; both give land and ocean at sea level 0. */
const SEED = 1729;
const OTHER_SEED = 42;

function setup() {
  const registry = createModuleRegistry();
  registry.register(terrainModule);
  return { registry, store: createInMemoryStateStore() };
}

const request = (payload: unknown, operation = "generate", payloadVersion = 1) => ({
  moduleId: TERRAIN_MODULE,
  operation,
  payloadVersion,
  payload,
});

const committed = (store: InMemoryStateStore) => store.forModule(TERRAIN_MODULE).get(TERRAIN_MODULE, TERRAIN_KEY);

/** Generates a surface in a fresh store and returns the committed record. */
function generate(seed: number, seaLevel = 0): TerrainRecord {
  const { registry, store } = setup();
  expect(executeInMemoryOperation(registry, store, request({ seed, seaLevel }), applyTerrainOperation).ok).toBe(true);
  return parseTerrainRecord(committed(store));
}

const landCount = (terrain: TerrainRecord): number =>
  terrain.elevation.filter((_, index) => isLand(terrain, index)).length;

const at = (terrain: TerrainRecord, row: number, column: number): number => terrain.elevation[row * SURFACE_WIDTH + column]!;

/** Mean absolute elevation difference between each cell and its eastern neighbour in column `column + 1`. */
const meanEastStep = (terrain: TerrainRecord, column: number): number => {
  let sum = 0;
  for (let row = 0; row < SURFACE_HEIGHT; row++) {
    sum += Math.abs(at(terrain, row, column) - at(terrain, row, (column + 1) % SURFACE_WIDTH));
  }
  return sum / SURFACE_HEIGHT;
};

/** Sizes of 4-connected land regions, wrapping east–west, largest first. */
function landRegions(terrain: TerrainRecord): number[] {
  const seen = new Set<number>();
  const sizes: number[] = [];
  for (let start = 0; start < SURFACE_CELLS; start++) {
    if (seen.has(start) || !isLand(terrain, start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      size++;
      const row = Math.floor(index / SURFACE_WIDTH);
      const column = index % SURFACE_WIDTH;
      const neighbours = [
        row * SURFACE_WIDTH + ((column + 1) % SURFACE_WIDTH),
        row * SURFACE_WIDTH + ((column + SURFACE_WIDTH - 1) % SURFACE_WIDTH),
        ...(row > 0 ? [index - SURFACE_WIDTH] : []),
        ...(row < SURFACE_HEIGHT - 1 ? [index + SURFACE_WIDTH] : []),
      ];
      for (const next of neighbours) {
        if (!seen.has(next) && isLand(terrain, next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    sizes.push(size);
  }
  return sizes.sort((x, y) => y - x);
}

describe("lattice-terrain-module consumed independently", () => {
  test("declares the terrain module with generate and raise-sea-level at version 1", () => {
    expect(terrainModule.id).toBe(TERRAIN_MODULE);
    expect(TERRAIN_MODULE).toBe(moduleId("terrain"));
    expect(TERRAIN_KEY).toBe("surface");
    expect(terrainModule.operations.map((o) => [o.name, o.version])).toEqual([
      ["generate", 1],
      ["raise-sea-level", 1],
    ]);
  });

  test("the registry accepts valid payloads and rejects invalid ones", () => {
    const { registry } = setup();
    for (const payload of [{ seed: 0, seaLevel: 0 }, { seed: 0xffff_ffff, seaLevel: -100 }, { seed: 1729, seaLevel: 100 }]) {
      expect(registry.validate(request(payload))).toEqual({ ok: true, request: request(payload) });
    }
    for (const payload of [
      undefined,
      null,
      1729,
      [1729, 0],
      {},
      { seed: 1729 },
      { seaLevel: 0 },
      { seed: 1729, seaLevel: 0, extra: 1 },
      { seed: -1, seaLevel: 0 },
      { seed: 2 ** 32, seaLevel: 0 },
      { seed: 1.5, seaLevel: 0 },
      { seed: "1729", seaLevel: 0 },
      { seed: Number.NaN, seaLevel: 0 },
      { seed: 1729, seaLevel: -101 },
      { seed: 1729, seaLevel: 101 },
      { seed: 1729, seaLevel: -0 },
      { seed: 1729, seaLevel: 0.5 },
    ]) {
      expect(registry.validate(request(payload))).toEqual({ ok: false, reason: "invalid-payload" });
    }
    expect(registry.validate(request({ seed: 1, seaLevel: 0 }, "erode"))).toEqual({ ok: false, reason: "unknown-operation" });
    expect(registry.validate(request({ seed: 1, seaLevel: 0 }, "generate", 2))).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
  });

  test("invalid requests are rejected without changing state", () => {
    const { registry, store } = setup();
    expect(executeInMemoryOperation(registry, store, request({ seed: -1, seaLevel: 0 }), applyTerrainOperation)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    expect(committed(store)).toBeUndefined();

    executeInMemoryOperation(registry, store, request({ seed: SEED, seaLevel: 0 }), applyTerrainOperation);
    const before = committed(store);
    expect(executeInMemoryOperation(registry, store, request({ seed: OTHER_SEED, seaLevel: 999 }), applyTerrainOperation)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    expect(committed(store)).toEqual(before!);
  });

  test("generate writes one record of the agreed shape, and only in terrain's namespace", () => {
    const terrain = generate(SEED);
    expect(Object.keys(terrain)).toEqual(["schemaVersion", "width", "height", "seed", "seaLevel", "elevation"]);
    expect(terrain).toMatchObject({ schemaVersion: TERRAIN_SCHEMA_VERSION, width: 48, height: 24, seed: SEED, seaLevel: 0 });
    expect(terrain.elevation).toHaveLength(48 * 24);
    for (const cell of terrain.elevation) {
      expect(Number.isInteger(cell) && !Object.is(cell, -0) && cell >= ELEVATION_MIN && cell <= ELEVATION_MAX).toBe(true);
    }
    // The record survives JSON unchanged, as PostgreSQL's json column will store it.
    expect(JSON.parse(JSON.stringify(terrain))).toEqual(terrain);
  });

  test("the same inputs in independent runs give deeply equal records", () => {
    expect(generate(SEED)).toEqual(generate(SEED));
    expect(generate(OTHER_SEED, 7)).toEqual(generate(OTHER_SEED, 7));
  });

  test("different seeds give different elevations", () => {
    expect(generate(SEED).elevation).not.toEqual(generate(OTHER_SEED).elevation);
    expect(generate(SEED).elevation).not.toEqual(generate(SEED + 1).elevation);
  });

  test.each([SEED, OTHER_SEED])("seed %d at sea level 0 has both land and ocean", (seed) => {
    const land = landCount(generate(seed));
    expect(land).toBeGreaterThan(SURFACE_CELLS / 10);
    expect(land).toBeLessThan((SURFACE_CELLS * 9) / 10);
  });

  test.each([SEED, OTHER_SEED])("seed %d forms contiguous regions rather than per-cell static", (seed) => {
    const terrain = generate(seed);
    // Neighbouring cells differ far less than cells chosen far apart.
    let neighbourSum = 0;
    let distantSum = 0;
    for (let index = 0; index < SURFACE_CELLS; index++) {
      const row = Math.floor(index / SURFACE_WIDTH);
      const column = index % SURFACE_WIDTH;
      neighbourSum += Math.abs(terrain.elevation[index]! - at(terrain, row, (column + 1) % SURFACE_WIDTH));
      distantSum += Math.abs(terrain.elevation[index]! - at(terrain, (row + 12) % SURFACE_HEIGHT, (column + 24) % SURFACE_WIDTH));
    }
    expect(neighbourSum).toBeLessThan(distantSum / 4);
    // Most land belongs to a few large regions.
    const regions = landRegions(terrain);
    expect(regions[0]!).toBeGreaterThan(100);
    expect(regions.slice(0, 3).reduce((x, y) => x + y, 0)).toBeGreaterThan(landCount(terrain) * 0.8);
  });

  test.each([SEED, OTHER_SEED, 7, 123_456])("seed %d wraps at the dateline without a seam", (seed) => {
    const terrain = generate(seed);
    const steps = Array.from({ length: SURFACE_WIDTH }, (_, column) => meanEastStep(terrain, column));
    const typical = steps.reduce((x, y) => x + y, 0) / SURFACE_WIDTH;
    // Column 47 to column 0 is an ordinary step, no larger than the largest elsewhere.
    expect(steps[SURFACE_WIDTH - 1]!).toBeLessThanOrEqual(Math.max(...steps.slice(0, -1)));
    expect(steps[SURFACE_WIDTH - 1]!).toBeLessThan(typical * 3);
  });

  test("raising the sea level with the same seed never adds land, and removes some", () => {
    const counts = [-20, 0, 20].map((seaLevel) => landCount(generate(SEED, seaLevel)));
    expect(counts[0]!).toBeGreaterThan(counts[1]!);
    expect(counts[1]!).toBeGreaterThan(counts[2]!);
    // The sea level is a threshold: the elevations themselves do not change.
    expect(generate(SEED, 20).elevation).toEqual(generate(SEED, 0).elevation);
  });

  test("rows run from north to south in 7.5-degree steps", () => {
    expect(rowLatitude(0)).toBe(86.25);
    expect(rowLatitude(11)).toBe(3.75);
    expect(rowLatitude(12)).toBe(-3.75);
    expect(rowLatitude(SURFACE_HEIGHT - 1)).toBe(-86.25);
  });

  test("a misrouted request throws and commits nothing", () => {
    const registry = createModuleRegistry();
    const other = moduleId("other");
    registry.register({ id: other, operations: [{ name: "generate", version: 1, validatePayload: () => true }] });
    const store = createInMemoryStateStore();
    const input = { moduleId: other, operation: "generate", payloadVersion: 1, payload: { seed: 1, seaLevel: 0 } };
    expect(() => executeInMemoryOperation(registry, store, input, applyTerrainOperation)).toThrow("terrain handler received");
    expect(store.forModule(other).get(other, TERRAIN_KEY)).toBeUndefined();
  });

  describe("raise-sea-level", () => {
    const raise = (payload: unknown, payloadVersion = 1) => request(payload, "raise-sea-level", payloadVersion);

    /** An emitter like the one a realmlib operation runtime supplies, recording what is emitted. */
    function recordingEmitter(now = 1_000) {
      const emitted: ScheduledWork[] = [];
      const emitter: WorkEmitter = { now: simTime(now), emit: (work) => void emitted.push(work) };
      return { emitter, emitted };
    }

    /** The terrain handler, given `emitter` as realmlib's operation runtimes would. */
    const withEmitter = (emitter: WorkEmitter): OperationHandler => (req, state, random) =>
      applyTerrainOperation(req, state, random, emitter);

    /** A fresh store with a generated surface at `seaLevel`. */
    function generated(seaLevel = 0) {
      const { registry, store } = setup();
      expect(executeInMemoryOperation(registry, store, request({ seed: SEED, seaLevel }), applyTerrainOperation).ok).toBe(true);
      return { registry, store };
    }

    test("the registry accepts exactly { toSeaLevel } with an integer in range", () => {
      const { registry } = setup();
      for (const toSeaLevel of [-100, 0, 10, 100]) expect(registry.validate(raise({ toSeaLevel })).ok).toBe(true);
      for (const payload of [
        undefined,
        null,
        10,
        [10],
        {},
        { seaLevel: 10 },
        { toSeaLevel: 10, extra: 1 },
        { toSeaLevel: -0 },
        { toSeaLevel: 1.5 },
        { toSeaLevel: "10" },
        { toSeaLevel: Number.NaN },
        { toSeaLevel: 101 },
        { toSeaLevel: -101 },
      ]) {
        expect(registry.validate(raise(payload))).toEqual({ ok: false, reason: "invalid-payload" });
      }
      expect(registry.validate(raise({ toSeaLevel: 10 }, 2))).toEqual({ ok: false, reason: "unsupported-version" });
    });

    test("replaces only the sea level of terrain's own record and emits one climate refresh at the same time", () => {
      const { registry, store } = generated();
      const before = parseTerrainRecord(committed(store));
      const { emitter, emitted } = recordingEmitter();
      const calls: string[] = [];
      const observed: OperationHandler = (req, state, random) =>
        withEmitter(emitter)(
          req,
          {
            get: (owner, key) => (calls.push(`get ${owner}/${key}`), state.get(owner, key)),
            set: (key, value) => (calls.push(`set ${key}`), state.set(key, value)),
            delete: (key) => (calls.push(`delete ${key}`), state.delete(key)),
          },
          random,
        );
      expect(executeInMemoryOperation(registry, store, raise({ toSeaLevel: 10 }), observed).ok).toBe(true);
      expect(calls).toEqual(["get terrain/surface", "set surface"]);

      const after = parseTerrainRecord(committed(store));
      expect(after).toEqual({ ...before, seaLevel: 10 });
      expect(Object.keys(after)).toEqual(Object.keys(before));
      expect(landCount(after)).toBeLessThan(landCount(before));

      expect(emitted).toEqual([
        {
          id: climateRefreshWorkId(1_000, 10),
          at: simTime(1_000),
          request: { moduleId: moduleId("climate"), operation: "refresh", payloadVersion: 1, payload: {} },
        },
      ]);
      expect(emitted[0]!.id).toBe("terrain-climate-refresh-1000-10" as never);
      expect(emitted[0]!.request).toEqual(CLIMATE_REFRESH_REQUEST);
    });

    test("the emitted work ID depends only on the simulated time and target level", () => {
      expect(climateRefreshWorkId(1_000, 10)).toBe(climateRefreshWorkId(1_000, 10));
      expect(climateRefreshWorkId(1_000, 10)).not.toBe(climateRefreshWorkId(2_000, 10));
      expect(climateRefreshWorkId(1_000, 10)).not.toBe(climateRefreshWorkId(1_000, 11));
    });

    test("fails without changes or emission if no surface has been generated", () => {
      const { registry, store } = setup();
      const { emitter, emitted } = recordingEmitter();
      expect(() => executeInMemoryOperation(registry, store, raise({ toSeaLevel: 10 }), withEmitter(emitter))).toThrow(
        "terrain surface has not been generated",
      );
      expect(committed(store)).toBeUndefined();
      expect(emitted).toEqual([]);
    });

    test("fails without changes or emission if the committed surface is invalid", () => {
      const { registry, store } = generated();
      const corrupt = { ...parseTerrainRecord(committed(store)), schemaVersion: 2 };
      store.forModule(TERRAIN_MODULE).set(TERRAIN_KEY, corrupt);
      const { emitter, emitted } = recordingEmitter();
      expect(() => executeInMemoryOperation(registry, store, raise({ toSeaLevel: 10 }), withEmitter(emitter))).toThrow(
        "Invalid terrain record",
      );
      expect(committed(store)).toEqual(corrupt);
      expect(emitted).toEqual([]);
    });

    test.each([0, -5])("refuses to move the sea level from 0 to %d: it can only rise", (toSeaLevel) => {
      const { registry, store } = generated();
      const before = committed(store);
      const { emitter, emitted } = recordingEmitter();
      expect(() => executeInMemoryOperation(registry, store, raise({ toSeaLevel }), withEmitter(emitter))).toThrow(
        "sea level can only rise",
      );
      expect(committed(store)).toEqual(before!);
      expect(emitted).toEqual([]);
    });

    test("refuses to run without a work emitter, as through the plain execution helper", () => {
      const { registry, store } = generated();
      const before = committed(store);
      expect(() => executeInMemoryOperation(registry, store, raise({ toSeaLevel: 10 }), applyTerrainOperation)).toThrow(
        "needs a work emitter",
      );
      expect(committed(store)).toEqual(before!);
    });

    test("a misrouted request throws and commits nothing", () => {
      const registry = createModuleRegistry();
      const other = moduleId("other");
      registry.register({ id: other, operations: [{ name: "raise-sea-level", version: 1, validatePayload: () => true }] });
      const { store } = generated();
      const { emitter, emitted } = recordingEmitter();
      const input = { moduleId: other, operation: "raise-sea-level", payloadVersion: 1, payload: { toSeaLevel: 10 } };
      expect(() => executeInMemoryOperation(registry, store, input, withEmitter(emitter))).toThrow("terrain handler received");
      expect(store.forModule(other).get(other, TERRAIN_KEY)).toBeUndefined();
      expect(parseTerrainRecord(committed(store)).seaLevel).toBe(0);
      expect(emitted).toEqual([]);
    });
  });

  describe("parseTerrainRecord", () => {
    const valid = generate(SEED);

    test("accepts a generated record", () => {
      expect(parseTerrainRecord(valid)).toEqual(valid);
    });

    test.each([
      ["missing", undefined],
      ["null", null],
      ["an array", []],
      ["a newer schema version", { ...valid, schemaVersion: 2 }],
      ["no schema version", (({ schemaVersion: _, ...rest }) => rest)(valid)],
      ["an extra field", { ...valid, extra: true }],
      ["other dimensions", { ...valid, width: 24, height: 48 }],
      ["a negative seed", { ...valid, seed: -1 }],
      ["a sea level out of range", { ...valid, seaLevel: 500 }],
      ["too few cells", { ...valid, elevation: valid.elevation.slice(1) }],
      ["an elevation out of range", { ...valid, elevation: [101, ...valid.elevation.slice(1)] }],
      ["a fractional elevation", { ...valid, elevation: [0.5, ...valid.elevation.slice(1)] }],
      ["a string elevation", { ...valid, elevation: ["0", ...valid.elevation.slice(1)] }],
    ])("rejects %s", (_, value) => {
      expect(() => parseTerrainRecord(value)).toThrow(TypeError);
    });
  });

  test("the package's source imports only realmlib", async () => {
    const source = await Bun.file(Bun.resolveSync("lattice-terrain-module", import.meta.dir)).text();
    const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(["realmlib"]));
  });

  test("the package's source does not use Math.random or the wall clock", async () => {
    const source = await Bun.file(Bun.resolveSync("lattice-terrain-module", import.meta.dir)).text();
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|process\.env/);
  });
});
