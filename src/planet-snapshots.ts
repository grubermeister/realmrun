/**
 * The evolving planet's checkpoints as a versioned, viewer-ready JSON bundle
 * (`lattice.planet.snapshots`, format version 1). Pure: it only rearranges
 * committed records it is given, already validated against their modules'
 * contracts, and touches no database or file.
 *
 * The format version covers this envelope only; each record keeps its own
 * module's `schemaVersion`.
 */

import type { ClimateRecord } from "lattice-climate-module";
import { isLand, SURFACE_HEIGHT, SURFACE_WIDTH } from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import type { SimTime } from "realmlib";
import { SEA_LEVEL_CHANGE_AT_MS, SEA_LEVEL_RISE } from "./planetary-fixture.ts";
import type { PlanetConfig, PlanetRecords } from "./planetary-fixture.ts";

export const SNAPSHOT_FORMAT = "lattice.planet.snapshots";
export const SNAPSHOT_FORMAT_VERSION = 1;

/** Both modules' committed records at one simulated time. */
export interface PlanetSnapshot extends PlanetRecords {
  readonly atMs: SimTime;
}

/** The sea-level rise and its climate consequence, both completed. */
export type SeaLevelRiseEvent = {
  readonly atMs: number;
  readonly kind: "sea-level-rise";
  readonly fromSeaLevel: number;
  readonly toSeaLevel: number;
  readonly consequence: "climate.refresh";
};

/** Format version 1 of the bundle. */
export type PlanetSnapshotBundleV1 = {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  readonly scenario: "planet-evolve";
  readonly config: {
    readonly seed: number;
    readonly initialSeaLevel: number;
    readonly meanTempC: number;
    readonly seaLevelRise: typeof SEA_LEVEL_RISE;
    readonly seaLevelChangeAtMs: typeof SEA_LEVEL_CHANGE_AT_MS;
  };
  readonly grid: {
    readonly width: typeof SURFACE_WIDTH;
    readonly height: typeof SURFACE_HEIGHT;
    readonly cellOrder: "row-major";
    readonly rows: "north-to-south";
    readonly wrapsLongitude: true;
  };
  readonly snapshots: readonly { readonly atMs: number; readonly terrain: TerrainRecord; readonly climate: ClimateRecord }[];
  readonly events: readonly SeaLevelRiseEvent[];
};

/** A copy of `terrain` with its fields in the record contract's order. */
const terrainCopy = (terrain: TerrainRecord): TerrainRecord => ({
  schemaVersion: terrain.schemaVersion,
  width: terrain.width,
  height: terrain.height,
  seed: terrain.seed,
  seaLevel: terrain.seaLevel,
  elevation: [...terrain.elevation],
});

/** A copy of `climate` with its fields in the record contract's order. */
const climateCopy = (climate: ClimateRecord): ClimateRecord => ({
  schemaVersion: climate.schemaVersion,
  width: climate.width,
  height: climate.height,
  meanTempC: climate.meanTempC,
  temperatureC: [...climate.temperatureC],
  moisture: [...climate.moisture],
  biome: [...climate.biome],
});

/**
 * The sea-level event shown by `snapshots`, or none if they stop before
 * {@link SEA_LEVEL_CHANGE_AT_MS}. A checkpoint is captured only once every
 * item due by then has completed, so one at that time follows both the rise
 * and the refresh it emitted; the levels come from the committed terrain.
 *
 * @throws if that checkpoint does not show both: a higher sea level than at
 *   time 0, and a climate whose ocean is exactly the new terrain's ocean.
 */
function seaLevelEvents(snapshots: readonly PlanetSnapshot[]): SeaLevelRiseEvent[] {
  const after = snapshots.find((snapshot) => snapshot.atMs === SEA_LEVEL_CHANGE_AT_MS);
  if (after === undefined) return [];
  const before = snapshots[0]!;
  const refreshed = after.climate.biome.every((biome, index) => (biome === "ocean") === !isLand(after.terrain, index));
  if (after.terrain.seaLevel <= before.terrain.seaLevel || !refreshed) {
    throw new Error(`the ${SEA_LEVEL_CHANGE_AT_MS} ms checkpoint does not show a completed sea-level rise and climate refresh`);
  }
  return [
    {
      atMs: SEA_LEVEL_CHANGE_AT_MS,
      kind: "sea-level-rise",
      fromSeaLevel: before.terrain.seaLevel,
      toSeaLevel: after.terrain.seaLevel,
      consequence: "climate.refresh",
    },
  ];
}

/**
 * The bundle for a `planet-evolve` run of `config` that captured `snapshots`.
 * The records are copied, so later changes to either side do not affect the other.
 *
 * @throws if `snapshots` do not start at time 0 and ascend strictly, or (see
 *   {@link seaLevelEvents}) do not show the completed rise they should.
 */
export function buildSnapshotBundle(config: PlanetConfig, snapshots: readonly PlanetSnapshot[]): PlanetSnapshotBundleV1 {
  if (snapshots[0]?.atMs !== 0) throw new Error("snapshots must start at simulated time 0");
  snapshots.forEach((snapshot, index) => {
    if (index > 0 && snapshot.atMs <= snapshots[index - 1]!.atMs) throw new Error("snapshot times must ascend strictly");
  });
  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    scenario: "planet-evolve",
    config: {
      seed: config.seed,
      initialSeaLevel: config.seaLevel,
      meanTempC: config.meanTempC,
      seaLevelRise: SEA_LEVEL_RISE,
      seaLevelChangeAtMs: SEA_LEVEL_CHANGE_AT_MS,
    },
    grid: { width: SURFACE_WIDTH, height: SURFACE_HEIGHT, cellOrder: "row-major", rows: "north-to-south", wrapsLongitude: true },
    snapshots: snapshots.map(({ atMs, terrain, climate }) => ({
      atMs,
      terrain: terrainCopy(terrain),
      climate: climateCopy(climate),
    })),
    events: seaLevelEvents(snapshots),
  };
}

/** `bundle` as the exported file's text: two-space indented JSON and a trailing newline. */
export function serializeSnapshotBundle(bundle: PlanetSnapshotBundleV1): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
