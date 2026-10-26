/**
 * The evolving planet through realmlib's in-memory operation runtime: one
 * host-scheduled terrain change whose climate consequence terrain emits, the
 * checkpoints captured on the way, and the exported snapshot bundle.
 */

import { describe, expect, test } from "bun:test";
import { BIOMES } from "lattice-climate-module";
import { CLIMATE_REFRESH_REQUEST, climateRefreshWorkId, isLand, SURFACE_CELLS } from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { createInMemoryOperationRuntime, simTime, WorkIdConflictError } from "realmlib";
import type { ScheduledWork } from "realmlib";
import { buildSnapshotBundle, serializeSnapshotBundle } from "../src/planet-snapshots.ts";
import type { PlanetSnapshot } from "../src/planet-snapshots.ts";
import {
  applyPlanetOperation,
  CLIMATE_MODULE,
  createPlanetRegistry,
  DEFAULT_PLANET_CONFIG,
  evolvingPlanetWork,
  planetSnapshotTimes,
  planetWork,
  readPlanetRecords,
  SEA_LEVEL_CHANGE_AT_MS,
  seaLevelRiseWork,
  TERRAIN_MODULE,
} from "../src/planetary-fixture.ts";
import type { PlanetConfig } from "../src/planetary-fixture.ts";
import { advanceWithCheckpoints } from "../src/simulation.ts";
import { runEvolvingPlanetInMemory } from "./in-memory-reference.ts";

const EMITTED_ID = "terrain-climate-refresh-1000-10";

const landCount = (terrain: TerrainRecord): number => terrain.elevation.filter((_, index) => isLand(terrain, index)).length;
const oceanCount = (terrain: TerrainRecord): number => SURFACE_CELLS - landCount(terrain);
const byTime = (snapshots: readonly PlanetSnapshot[], atMs: number) => snapshots.find((s) => s.atMs === atMs)!;

/** A new in-memory operation runtime with `work` scheduled, in order. */
async function scheduled(work: readonly ScheduledWork[]) {
  const runtime = createInMemoryOperationRuntime();
  for (const item of work) expect(await runtime.scheduler.schedule(item)).toBe("accepted");
  return runtime;
}

/** The evolving scenario's arguments for the runner's checkpoint-aware advance. */
const evolving = (until: number) => ({
  registry: createPlanetRegistry(),
  handler: applyPlanetOperation,
  read: readPlanetRecords,
  checkpoints: planetSnapshotTimes(simTime(until)),
});

describe("the evolving planet's work", () => {
  test("three items are host-scheduled: generate and derive at 0, then the sea-level rise at 1000", () => {
    expect(evolvingPlanetWork(DEFAULT_PLANET_CONFIG)).toEqual([
      ...planetWork(DEFAULT_PLANET_CONFIG),
      {
        id: "planet-terrain-raise-sea-level",
        at: 1_000,
        request: { moduleId: TERRAIN_MODULE, operation: "raise-sea-level", payloadVersion: 1, payload: { toSeaLevel: 10 } },
      },
    ] as unknown as ScheduledWork[]);
    expect(seaLevelRiseWork({ ...DEFAULT_PLANET_CONFIG, seaLevel: -7 }).request.payload).toEqual({ toSeaLevel: 3 });
    // The static scenario keeps its two items.
    expect(planetWork(DEFAULT_PLANET_CONFIG).map((work) => work.id as string)).toEqual([
      "planet-terrain-generate",
      "planet-climate-derive",
    ]);
  });

  test.each([
    [0, [0]],
    [500, [0, 500]],
    [999, [0, 999]],
    [1_000, [0, 1_000]],
    [2_000, [0, 1_000, 2_000]],
  ])("--until %d captures snapshots at %j", (until, times) => {
    expect(planetSnapshotTimes(simTime(until))).toEqual(times.map((time) => simTime(time)));
  });
});

describe("cause and consequence through realmlib's in-memory operation runtime", () => {
  test("three scheduled items complete as four: the climate refresh was emitted by terrain, not scheduled", async () => {
    const initial = evolvingPlanetWork(DEFAULT_PLANET_CONFIG).map((work) => work.id as string);
    expect(initial).not.toContain(EMITTED_ID);

    const { runtime, executed } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(1_000));
    expect(executed).toEqual([
      { id: "planet-terrain-generate", at: 0 },
      { id: "planet-climate-derive", at: 0 },
      { id: "planet-terrain-raise-sea-level", at: 1_000 },
      { id: EMITTED_ID, at: 1_000 },
    ]);
    expect(await runtime.scheduler.pendingCount()).toBe(0);

    // The emitted item was stored after the three scheduled ones, then completed.
    const record = await runtime.storage.readWork(climateRefreshWorkId(1_000, 10));
    expect(record).toEqual({
      status: "completed",
      work: { id: EMITTED_ID, at: 1_000, sequence: 3, request: { ...CLIMATE_REFRESH_REQUEST, moduleId: CLIMATE_MODULE } },
    } as never);
  });

  test("before 1000 the original planet stands; at 1000 both changes are committed; afterwards nothing changes", async () => {
    const early = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(999));
    expect(early.snapshots.map((s) => s.atMs)).toEqual([0, 999] as never);
    expect(early.executed.map((e) => e.id)).toEqual(["planet-terrain-generate", "planet-climate-derive"]);
    const [atZero, at999] = early.snapshots;
    expect(at999).toEqual({ ...atZero!, atMs: simTime(999) });
    expect(atZero!.terrain.seaLevel).toBe(0);
    expect(await early.runtime.storage.readWorkIdStatus(seaLevelRiseWork(DEFAULT_PLANET_CONFIG).id)).toBe("pending");
    expect(await early.runtime.storage.readWorkIdStatus(climateRefreshWorkId(1_000, 10))).toBeUndefined();

    const late = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000));
    expect(late.snapshots.map((s) => s.atMs)).toEqual([0, 1_000, 2_000] as never);
    expect(byTime(late.snapshots, 0)).toEqual(atZero!);
    const at1000 = byTime(late.snapshots, 1_000);
    expect(at1000.terrain.seaLevel).toBe(10);
    at1000.climate.biome.forEach((biome, index) => expect(biome === "ocean").toBe(!isLand(at1000.terrain, index)));
    expect(byTime(late.snapshots, 2_000)).toEqual({ ...at1000, atMs: simTime(2_000) });
    expect(late.now).toBe(simTime(2_000));
  });

  test("the reference planet floods from 695/457 to 508/644 land/ocean cells; only sea level and climate change", async () => {
    const { snapshots } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(1_000));
    const before = byTime(snapshots, 0);
    const after = byTime(snapshots, 1_000);
    expect([landCount(before.terrain), oceanCount(before.terrain)]).toEqual([695, 457]);
    expect([landCount(after.terrain), oceanCount(after.terrain)]).toEqual([508, 644]);
    expect(after.climate.biome.filter((b) => b === "ocean")).toHaveLength(644);

    expect(after.terrain).toEqual({ ...before.terrain, seaLevel: 10 });
    expect(after.terrain.elevation).toEqual(before.terrain.elevation);
    expect(after.terrain.seed).toBe(1729);
    expect(after.climate.meanTempC).toBe(15);
    expect(after.climate.biome).not.toEqual(before.climate.biome);
  });

  test.each([
    { seed: 42, seaLevel: 5, meanTempC: 3 },
    { seed: 7, seaLevel: -100, meanTempC: -40 },
    { seed: 4_294_967_295, seaLevel: 90, meanTempC: 40 },
  ] satisfies PlanetConfig[])("%j is deterministic and only ever floods", async (config) => {
    const first = await runEvolvingPlanetInMemory(config, simTime(2_000));
    const second = await runEvolvingPlanetInMemory(config, simTime(2_000));
    expect(second.snapshots).toEqual(first.snapshots);
    expect(second.executed).toEqual(first.executed);
    const before = byTime(first.snapshots, 0);
    const after = byTime(first.snapshots, 1_000);
    expect(after.terrain.seaLevel).toBe(config.seaLevel + 10);
    expect(oceanCount(after.terrain)).toBeGreaterThanOrEqual(oceanCount(before.terrain));
    expect(after.climate.meanTempC).toBe(config.meanTempC);
  });

  test("a conflicting emitted work ID rolls back the cause and its emission", async () => {
    // Different work already stored under the ID terrain will emit.
    const squatter: ScheduledWork = { id: climateRefreshWorkId(1_000, 10), at: simTime(5_000), request: CLIMATE_REFRESH_REQUEST };
    const runtime = await scheduled([...evolvingPlanetWork(DEFAULT_PLANET_CONFIG), squatter]);
    const advance = advanceWithCheckpoints(runtime, simTime(1_000), evolving(1_000));
    await expect(advance).rejects.toThrow(WorkIdConflictError);

    // The sea-level rise is still pending, with the clock at its time; nothing of it committed.
    expect(await runtime.storage.readWorkIdStatus(seaLevelRiseWork(DEFAULT_PLANET_CONFIG).id)).toBe("pending");
    expect(await runtime.scheduler.now()).toBe(simTime(1_000));
    const records = readPlanetRecords((owner, key) => runtime.read(owner, key));
    expect(records.terrain.seaLevel).toBe(0);
    const reference = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
    expect(records).toEqual({ terrain: reference.snapshots[0]!.terrain, climate: reference.snapshots[0]!.climate });
    // The squatter is untouched and no refresh receipt exists.
    expect(await runtime.storage.readWork(squatter.id)).toMatchObject({ status: "pending", work: { at: 5_000, sequence: 3 } });
    expect(await runtime.scheduler.pendingCount()).toBe(2);
  });
});

describe("checkpoints captured by the runner", () => {
  test("match the reference, and later operations do not change earlier ones", async () => {
    const runtime = await scheduled(evolvingPlanetWork(DEFAULT_PLANET_CONFIG));
    const { now, result, checkpoints } = await advanceWithCheckpoints(runtime, simTime(2_000), evolving(2_000));
    const reference = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000));
    expect(now).toBe(simTime(2_000));
    expect(checkpoints.map(({ at, result: records }) => ({ atMs: at, ...records }))).toEqual(reference.snapshots);
    expect(result).toEqual(checkpoints.at(-1)!.result);

    // Each read has its own copies: the first checkpoint still shows the planet before the rise.
    const [first, second, third] = checkpoints;
    expect(first!.result.terrain.seaLevel).toBe(0);
    expect(oceanCount(first!.result.terrain)).toBe(457);
    expect(second!.result.terrain).not.toBe(third!.result.terrain);
    expect(third!.result.climate.biome).not.toBe(result.climate.biome);
    const original = result.climate.biome[0];
    (third!.result.climate.biome as string[])[0] = "swamp";
    expect(result.climate.biome[0]).toBe(original!);
    expect(runtime.read(CLIMATE_MODULE, "climate")).toEqual(result.climate);
  });

  test("never capture a time beyond the target", async () => {
    for (const until of [0, 500, 999]) {
      const runtime = await scheduled(evolvingPlanetWork(DEFAULT_PLANET_CONFIG));
      const { now, checkpoints } = await advanceWithCheckpoints(runtime, simTime(until), evolving(until));
      expect(now).toBe(simTime(until));
      expect(checkpoints.every(({ at }) => at <= until)).toBe(true);
      expect(checkpoints.every(({ result }) => result.terrain.seaLevel === 0)).toBe(true);
    }
  });

  test.each([
    [[0, 0], 10],
    [[5, 3], 10],
    [[0, 11], 10],
  ])("checkpoints %j for target %d are refused before anything runs", async (times, until) => {
    const runtime = await scheduled(evolvingPlanetWork(DEFAULT_PLANET_CONFIG));
    const scenario = { ...evolving(until), checkpoints: times.map((time) => simTime(time)) };
    await expect(advanceWithCheckpoints(runtime, simTime(until), scenario)).rejects.toThrow(RangeError);
    expect(await runtime.scheduler.pendingCount()).toBe(3);
  });
});

describe("the snapshot bundle (format version 1)", () => {
  test("has the agreed envelope and serializes each committed record whole", async () => {
    const { snapshots } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000));
    const bundle = buildSnapshotBundle(DEFAULT_PLANET_CONFIG, snapshots);
    expect(Object.keys(bundle)).toEqual(["format", "formatVersion", "scenario", "config", "grid", "snapshots", "events"]);
    expect(bundle.format).toBe("lattice.planet.snapshots");
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.scenario).toBe("planet-evolve");
    expect(bundle.config).toEqual({ seed: 1729, initialSeaLevel: 0, meanTempC: 15, seaLevelRise: 10, seaLevelChangeAtMs: 1_000 });
    expect(Object.keys(bundle.config)).toEqual(["seed", "initialSeaLevel", "meanTempC", "seaLevelRise", "seaLevelChangeAtMs"]);
    expect(bundle.grid).toEqual({ width: 48, height: 24, cellOrder: "row-major", rows: "north-to-south", wrapsLongitude: true });
    expect(bundle.snapshots.map((s) => s.atMs)).toEqual([0, 1_000, 2_000]);
    expect(bundle.snapshots).toEqual(snapshots.map(({ atMs, terrain, climate }) => ({ atMs, terrain, climate })));
    for (const { terrain, climate } of bundle.snapshots) {
      expect(Object.keys(terrain)).toEqual(["schemaVersion", "width", "height", "seed", "seaLevel", "elevation"]);
      expect(Object.keys(climate)).toEqual(["schemaVersion", "width", "height", "meanTempC", "temperatureC", "moisture", "biome"]);
      expect([terrain.schemaVersion, climate.schemaVersion]).toEqual([1, 1]);
      for (const cells of [terrain.elevation, climate.temperatureC, climate.moisture, climate.biome]) {
        expect(cells).toHaveLength(48 * 24);
      }
      for (const biome of climate.biome) expect(BIOMES).toContain(biome);
    }
    expect(bundle.events).toEqual([
      { atMs: 1_000, kind: "sea-level-rise", fromSeaLevel: 0, toSeaLevel: 10, consequence: "climate.refresh" },
    ]);
  });

  test.each([0, 500, 999])("--until %d has no event and no snapshot past it", async (until) => {
    const { snapshots } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(until));
    const bundle = buildSnapshotBundle(DEFAULT_PLANET_CONFIG, snapshots);
    expect(bundle.events).toEqual([]);
    expect(bundle.snapshots.map((s) => s.atMs)).toEqual([...new Set([0, until])]);
  });

  test("--until 1000 has its event and ends there", async () => {
    const { snapshots } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(1_000));
    const bundle = buildSnapshotBundle(DEFAULT_PLANET_CONFIG, snapshots);
    expect(bundle.snapshots.map((s) => s.atMs)).toEqual([0, 1_000]);
    expect(bundle.events).toHaveLength(1);
  });

  test("the event's levels come from committed terrain", async () => {
    const config = { seed: 42, seaLevel: -30, meanTempC: 3 };
    const { snapshots } = await runEvolvingPlanetInMemory(config, simTime(1_000));
    expect(buildSnapshotBundle(config, snapshots).events).toEqual([
      { atMs: 1_000, kind: "sea-level-rise", fromSeaLevel: -30, toSeaLevel: -20, consequence: "climate.refresh" },
    ]);
  });

  test("a 1000 ms checkpoint without the completed rise and refresh is refused", async () => {
    const { snapshots } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(1_000));
    const [before, after] = snapshots as [PlanetSnapshot, PlanetSnapshot];
    const unrefreshed = { ...after, climate: before.climate };
    const unraised = { ...before, atMs: after.atMs };
    expect(() => buildSnapshotBundle(DEFAULT_PLANET_CONFIG, [before, unrefreshed])).toThrow("does not show a completed");
    expect(() => buildSnapshotBundle(DEFAULT_PLANET_CONFIG, [before, unraised])).toThrow("does not show a completed");
    expect(() => buildSnapshotBundle(DEFAULT_PLANET_CONFIG, [after])).toThrow("start at simulated time 0");
    expect(() => buildSnapshotBundle(DEFAULT_PLANET_CONFIG, [before, before])).toThrow("ascend strictly");
  });

  test("copies the records it is given", async () => {
    const { snapshots } = await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(0));
    const bundle = buildSnapshotBundle(DEFAULT_PLANET_CONFIG, snapshots);
    (bundle.snapshots[0]!.terrain.elevation as number[])[0] = 99;
    expect(snapshots[0]!.terrain.elevation[0]).not.toBe(99);
  });

  test("serializes to the same bytes on independent runs: plain JSON with a trailing newline", async () => {
    const text = async () =>
      serializeSnapshotBundle(
        buildSnapshotBundle(DEFAULT_PLANET_CONFIG, (await runEvolvingPlanetInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000))).snapshots),
      );
    const first = await text();
    expect(await text()).toBe(first);
    expect(first).toEndWith("}\n");
    expect(first).toStartWith('{\n  "format": "lattice.planet.snapshots",\n  "formatVersion": 1,\n');
    const parsed = JSON.parse(first);
    expect(serializeSnapshotBundle(parsed)).toBe(first);
    expect(first).not.toMatch(/realmrun_|postgres|\/home\/|T\d\d:\d\d/);
  });
});
