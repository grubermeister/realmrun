/**
 * The viewer's format-version-1 boundary: genuine D1 exports parse whole and
 * unchanged, and anything else is refused with a message naming the problem.
 */

import { describe, expect, test } from "bun:test";
import * as climate from "lattice-climate-module";
import * as terrain from "lattice-terrain-module";
import { simTime } from "realmlib";
import { SNAPSHOT_FORMAT as D1_FORMAT, SNAPSHOT_FORMAT_VERSION as D1_FORMAT_VERSION, serializeSnapshotBundle } from "../src/planet-snapshots.ts";
import { DEFAULT_PLANET_CONFIG, EVOLVING_SEA_LEVEL_MAX, SEA_LEVEL_CHANGE_AT_MS, SEA_LEVEL_RISE } from "../src/planetary-fixture.ts";
import type { PlanetConfig } from "../src/planetary-fixture.ts";
import * as viewer from "../viewer/src/snapshot-format.ts";
import { parseSnapshotBundle, parseSnapshotFile, SnapshotFormatError } from "../viewer/src/snapshot-format.ts";
import { exportedSnapshotsInMemory } from "./in-memory-reference.ts";

const reference = await exportedSnapshotsInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000));
const earlyReference = await exportedSnapshotsInMemory(DEFAULT_PLANET_CONFIG, simTime(500));

/** Parsed JSON, for tests that reach into it to break it. */
type Json = any;
const fresh = (text = reference): Json => JSON.parse(text);

describe("a genuine D1 export", () => {
  test("parses to exactly the exported records, at checkpoints 0, 1000, and 2000", () => {
    const bundle = parseSnapshotFile(reference);
    expect(bundle).toEqual(fresh());
    expect(bundle.snapshots.map((snapshot) => snapshot.atMs)).toEqual([0, 1_000, 2_000]);
    expect(bundle.events).toEqual([{ atMs: 1_000, kind: "sea-level-rise", fromSeaLevel: 0, toSeaLevel: 10, consequence: "climate.refresh" }]);
    // Nothing added, dropped, or reordered: it serializes back to the same bytes.
    expect(serializeSnapshotBundle(bundle as never)).toBe(reference);
  });

  test("is frozen throughout, so the viewer cannot change what it loaded", () => {
    const bundle = parseSnapshotFile(reference);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.snapshots[1]!.climate.biome)).toBe(true);
    expect(() => {
      (bundle.snapshots[1]!.terrain.elevation as number[])[0] = 0;
    }).toThrow(TypeError);
  });

  test.each([
    [0, [0], 0],
    [500, [0, 500], 0],
    [999, [0, 999], 0],
    [1_000, [0, 1_000], 1],
  ])("--until %d parses with checkpoints %j and %d event(s), nothing invented", async (until, times, events) => {
    const bundle = parseSnapshotFile(await exportedSnapshotsInMemory(DEFAULT_PLANET_CONFIG, simTime(until)));
    expect(bundle.snapshots.map((snapshot) => snapshot.atMs)).toEqual(times);
    expect(bundle.events).toHaveLength(events);
  });

  test.each([
    { seed: 0, seaLevel: -100, meanTempC: -40 },
    { seed: 4_294_967_295, seaLevel: 90, meanTempC: 40 },
    { seed: 42, seaLevel: -30, meanTempC: 3 },
  ] satisfies PlanetConfig[])("%j parses", async (config) => {
    const text = await exportedSnapshotsInMemory(config, simTime(2_000));
    expect(parseSnapshotFile(text)).toEqual(JSON.parse(text));
  });
});

describe("the constants repeated for the browser", () => {
  test("match the modules' and D1's own", () => {
    expect([viewer.SNAPSHOT_FORMAT, viewer.SNAPSHOT_FORMAT_VERSION]).toEqual([D1_FORMAT, D1_FORMAT_VERSION]);
    expect([viewer.GRID_WIDTH, viewer.GRID_HEIGHT, viewer.GRID_CELLS]).toEqual([terrain.SURFACE_WIDTH, terrain.SURFACE_HEIGHT, terrain.SURFACE_CELLS]);
    expect([viewer.TERRAIN_SCHEMA_VERSION, viewer.CLIMATE_SCHEMA_VERSION]).toEqual([terrain.TERRAIN_SCHEMA_VERSION, climate.CLIMATE_SCHEMA_VERSION]);
    expect(viewer.SEED_MAX).toBe(terrain.SEED_MAX);
    expect([viewer.ELEVATION_MIN, viewer.ELEVATION_MAX]).toEqual([terrain.ELEVATION_MIN, terrain.ELEVATION_MAX]);
    expect([viewer.SEA_LEVEL_MIN, viewer.SEA_LEVEL_MAX]).toEqual([terrain.SEA_LEVEL_MIN, terrain.SEA_LEVEL_MAX]);
    expect([viewer.MEAN_TEMP_MIN, viewer.MEAN_TEMP_MAX]).toEqual([climate.MEAN_TEMP_MIN, climate.MEAN_TEMP_MAX]);
    expect([viewer.TEMPERATURE_MIN, viewer.TEMPERATURE_MAX]).toEqual([climate.TEMPERATURE_MIN, climate.TEMPERATURE_MAX]);
    expect([viewer.MOISTURE_MIN, viewer.MOISTURE_MAX]).toEqual([climate.MOISTURE_MIN, climate.MOISTURE_MAX]);
    expect([viewer.SEA_LEVEL_RISE, viewer.SEA_LEVEL_CHANGE_AT_MS]).toEqual([SEA_LEVEL_RISE, SEA_LEVEL_CHANGE_AT_MS]);
    expect(viewer.SEA_LEVEL_MAX - viewer.SEA_LEVEL_RISE).toBe(EVOLVING_SEA_LEVEL_MAX);
    expect(viewer.BIOMES).toEqual(climate.BIOMES);
  });

  test("isWater is the complement of terrain's isLand", () => {
    const { snapshots } = fresh();
    for (const { terrain: record } of snapshots) {
      for (let index = 0; index < viewer.GRID_CELLS; index++) expect(viewer.isWater(record, index)).toBe(!terrain.isLand(record, index));
    }
  });
});

/** The first land and water cells of the reference's time-0 checkpoint. */
const firstCell = (water: boolean): number => fresh().snapshots[0].terrain.elevation.findIndex((e: number) => (e <= 0) === water);

const rejections: [string, (bundle: Json) => void, string | RegExp][] = [
  // Envelope
  ["wrong format", (b) => (b.format = "lattice.planet.snapshot"), 'format must be "lattice.planet.snapshots"'],
  ["format version 2", (b) => (b.formatVersion = 2), "formatVersion must be 1, found 2"],
  ["format version as a string", (b) => (b.formatVersion = "1"), 'formatVersion must be 1, found "1"'],
  ["wrong scenario", (b) => (b.scenario = "planet"), 'scenario must be "planet-evolve"'],
  ["a missing config", (b) => delete b.config, "file.config is missing"],
  ["an unknown envelope field", (b) => (b.extra = true), 'file has an unexpected field "extra"'],
  ["snapshots as an object", (b) => (b.snapshots = {}), "snapshots must be a nonempty array"],
  // Config
  ["a negative seed", (b) => (b.config.seed = -1), "config.seed must be an integer from 0 to 4294967295"],
  ["a fractional seed", (b) => (b.config.seed = 1729.5), "config.seed must be an integer"],
  ["an initial sea level the rise would overflow", (b) => (b.config.initialSeaLevel = 91), "config.initialSeaLevel must be an integer from -100 to 90"],
  ["an out-of-range baseline temperature", (b) => (b.config.meanTempC = 41), "config.meanTempC must be an integer from -40 to 40"],
  ["another rise", (b) => (b.config.seaLevelRise = 5), "config.seaLevelRise must be 10"],
  ["another change time", (b) => (b.config.seaLevelChangeAtMs = 500), "config.seaLevelChangeAtMs must be 1000"],
  ["a wall-clock date in config", (b) => (b.config.date = "2026-10-26"), 'config has an unexpected field "date"'],
  // Grid
  ["a wider grid", (b) => (b.grid.width = 96), "grid.width must be 48, found 96"],
  ["a shorter grid", (b) => (b.grid.height = 12), "grid.height must be 24, found 12"],
  ["column-major cells", (b) => (b.grid.cellOrder = "column-major"), 'grid.cellOrder must be "row-major"'],
  ["south-to-north rows", (b) => (b.grid.rows = "south-to-north"), 'grid.rows must be "north-to-south"'],
  ["no longitude wrap", (b) => (b.grid.wrapsLongitude = false), "grid.wrapsLongitude must be true"],
  ["a missing grid field", (b) => delete b.grid.rows, "grid.rows is missing"],
  // Snapshot times
  ["no snapshots", (b) => (b.snapshots = []), "snapshots must be a nonempty array"],
  ["a first checkpoint after 0", (b) => b.snapshots.shift(), "snapshots[0].atMs must be 0, found 1000"],
  ["a duplicate time", (b) => (b.snapshots[2].atMs = 1_000), "snapshots[2].atMs must be later than the previous checkpoint's 1000, found 1000"],
  ["a descending time", (b) => (b.snapshots[2].atMs = 500), "snapshots[2].atMs must be later than the previous checkpoint's 1000, found 500"],
  ["a negative time", (b) => (b.snapshots[0].atMs = -1), "snapshots[0].atMs must be an integer from 0"],
  ["a fractional time", (b) => (b.snapshots[2].atMs = 1_500.5), "snapshots[2].atMs must be an integer"],
  ["an unsafe time", (b) => (b.snapshots[2].atMs = 2 ** 53), "snapshots[2].atMs must be an integer from 0 to 9007199254740991"],
  ["a time as a string", (b) => (b.snapshots[1].atMs = "1000"), 'snapshots[1].atMs must be an integer from 0 to 9007199254740991, found "1000"'],
  ["an unknown snapshot field", (b) => (b.snapshots[1].wallClock = 0), 'snapshots[1] has an unexpected field "wallClock"'],
  // Record schemas and dimensions
  ["terrain schema version 2", (b) => (b.snapshots[1].terrain.schemaVersion = 2), "snapshots[1].terrain.schemaVersion must be 1, found 2"],
  ["climate schema version 2", (b) => (b.snapshots[2].climate.schemaVersion = 2), "snapshots[2].climate.schemaVersion must be 1, found 2"],
  ["a terrain width of 47", (b) => (b.snapshots[0].terrain.width = 47), "snapshots[0].terrain.width must be 48, found 47"],
  ["a climate height of 23", (b) => (b.snapshots[0].climate.height = 23), "snapshots[0].climate.height must be 24, found 23"],
  ["a missing terrain record", (b) => delete b.snapshots[1].terrain, "snapshots[1].terrain is missing"],
  ["a missing elevation array", (b) => delete b.snapshots[0].terrain.elevation, "snapshots[0].terrain.elevation is missing"],
  ["a missing moisture array", (b) => delete b.snapshots[2].climate.moisture, "snapshots[2].climate.moisture is missing"],
  ["an unknown record field", (b) => (b.snapshots[0].climate.rainfall = []), 'snapshots[0].climate has an unexpected field "rainfall"'],
  // Arrays
  ["1151 elevations", (b) => b.snapshots[0].terrain.elevation.pop(), "snapshots[0].terrain.elevation must have 1152 cells, found 1151"],
  ["1153 temperatures", (b) => b.snapshots[1].climate.temperatureC.push(0), "snapshots[1].climate.temperatureC must have 1152 cells, found 1153"],
  ["1151 biomes", (b) => b.snapshots[1].climate.biome.pop(), "snapshots[1].climate.biome must have 1152 cells, found 1151"],
  ["elevation as an object", (b) => (b.snapshots[0].terrain.elevation = { length: 1152 }), "snapshots[0].terrain.elevation must be an array of 1152 cells"],
  ["a null elevation", (b) => (b.snapshots[0].terrain.elevation[3] = null), "snapshots[0].terrain.elevation[3] must be an integer from -100 to 100, found null"],
  ["an elevation of 101", (b) => (b.snapshots[0].terrain.elevation[5] = 101), "snapshots[0].terrain.elevation[5] must be an integer from -100 to 100, found 101"],
  ["a fractional elevation", (b) => (b.snapshots[0].terrain.elevation[5] = 2.5), "snapshots[0].terrain.elevation[5] must be an integer"],
  ["an elevation as a string", (b) => (b.snapshots[0].terrain.elevation[5] = "3"), 'snapshots[0].terrain.elevation[5] must be an integer from -100 to 100, found "3"'],
  ["a temperature of -101", (b) => (b.snapshots[1].climate.temperatureC[0] = -101), "snapshots[1].climate.temperatureC[0] must be an integer from -100 to 100"],
  ["a moisture of 101", (b) => (b.snapshots[1].climate.moisture[9] = 101), "snapshots[1].climate.moisture[9] must be an integer from 0 to 100, found 101"],
  ["a negative moisture", (b) => (b.snapshots[1].climate.moisture[9] = -1), "snapshots[1].climate.moisture[9] must be an integer from 0 to 100, found -1"],
  ["an unknown biome", (b) => (b.snapshots[2].climate.biome[7] = "swamp"), 'snapshots[2].climate.biome[7] must be one of ocean, ice, tundra, desert, grassland, forest, tropical-forest, found "swamp"'],
  ["a null biome", (b) => (b.snapshots[2].climate.biome[7] = null), "snapshots[2].climate.biome[7] must be one of"],
  ["a terrain seaLevel out of range", (b) => (b.snapshots[0].terrain.seaLevel = 101), "snapshots[0].terrain.seaLevel must be an integer from -100 to 100"],
  // Cross-record consistency
  ["a seed that differs from config", (b) => (b.config.seed = 1730), "snapshots[0].terrain.seed is 1729, but config.seed is 1730"],
  ["a baseline that differs from config", (b) => (b.snapshots[2].climate.meanTempC = 14), "snapshots[2].climate.meanTempC is 14, but config.meanTempC is 15"],
  [
    "ocean on a land cell",
    (b) => (b.snapshots[0].climate.biome[firstCell(false)] = "ocean"),
    new RegExp(`snapshots\\[0\\]\\.climate\\.biome\\[${firstCell(false)}\\] is "ocean", but terrain elevation \\d+ at sea level 0 makes that cell land`),
  ],
  [
    "land biome on a water cell",
    (b) => (b.snapshots[0].climate.biome[firstCell(true)] = "desert"),
    `snapshots[0].climate.biome[${firstCell(true)}] is "desert", but`,
  ],
  ["climate left unrefreshed after the rise", (b) => (b.snapshots[1].climate = b.snapshots[0].climate), /snapshots\[1\]\.climate\.biome\[\d+\] is "[\w-]+", but .* makes that cell water/],
  // Events
  ["no event despite a 1000 ms checkpoint", (b) => (b.events = []), "events must record the sea-level-rise, since there is a checkpoint at 1000 ms"],
  ["events that are not an array", (b) => (b.events = null), "events must be an array"],
  ["another event kind", (b) => (b.events[0].kind = "earthquake"), 'events[0].kind must be "sea-level-rise", found "earthquake"'],
  ["another consequence", (b) => (b.events[0].consequence = "climate.derive"), 'events[0].consequence must be "climate.refresh"'],
  ["an event at 2000", (b) => (b.events[0].atMs = 2_000), "events[0].atMs must be config.seaLevelChangeAtMs, 1000, found 2000"],
  ["an event without its time", (b) => delete b.events[0].atMs, "events[0].atMs is missing"],
  ["an event with a description", (b) => (b.events[0].description = "<b>flood</b>"), 'events[0] has an unexpected field "description"'],
  ["an event from another level", (b) => (b.events[0].fromSeaLevel = 1), "events[0].fromSeaLevel must be 0, found 1"],
  ["an event to another level", (b) => (b.events[0].toSeaLevel = 11), "events[0].toSeaLevel must be 10, found 11"],
  ["two events", (b) => b.events.push({ ...b.events[0] }), "events must hold at most one sea-level-rise, found 2"],
  ["a checkpoint at the old sea level after the rise", (b) => (b.snapshots[2] = { ...b.snapshots[0], atMs: 2_000 }), "snapshots[2].terrain.seaLevel is 0, but the recorded events give 10 at 2000 ms"],
];

describe("anything else is refused", () => {
  test.each(rejections)("%s", (_, mutate, message) => {
    const bundle = fresh();
    mutate(bundle);
    const text = JSON.stringify(bundle);
    expect(() => parseSnapshotFile(text)).toThrow(SnapshotFormatError);
    expect(() => parseSnapshotFile(text)).toThrow(message);
  });

  test("an event in a run that never reached it", () => {
    const bundle = fresh(earlyReference);
    bundle.events = fresh().events;
    expect(() => parseSnapshotBundle(bundle)).toThrow("events[0].atMs refers to 1000 ms, which is not a saved checkpoint");
  });

  test("-0, which JSON can spell but realmrun never writes", () => {
    const text = reference.replace('"initialSeaLevel": 0', '"initialSeaLevel": -0');
    expect(text).not.toBe(reference);
    expect(() => parseSnapshotFile(text)).toThrow("config.initialSeaLevel must be an integer from -100 to 90");
  });

  test.each([
    ["", "file is not valid JSON"],
    ["{", "file is not valid JSON"],
    [reference.slice(0, -100), "file is not valid JSON"],
    ["null", "file must be an object"],
    ["[]", "file must be an object"],
    ['"lattice.planet.snapshots"', "file must be an object"],
    ["{}", "file.format is missing"],
  ])("the text %j", (text, message) => {
    expect(() => parseSnapshotFile(text)).toThrow(SnapshotFormatError);
    expect(() => parseSnapshotFile(text)).toThrow(message);
  });
});
