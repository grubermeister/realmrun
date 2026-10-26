/**
 * Read-only summaries of loaded snapshots: counts, ranges, the difference
 * between two checkpoints, and where the recorded events fall relative to the
 * selected one. Pure: everything is computed from the saved arrays and nothing
 * is written back.
 *
 * Shares are of raster cells. The equirectangular grid is not equal-area, so
 * they are not shares of the planet's surface.
 */

import { BIOMES, GRID_CELLS, isWater } from "./snapshot-format.ts";
import type { Biome, SeaLevelRiseEvent, Snapshot, SnapshotBundle } from "./snapshot-format.ts";

/** `count` as a percentage of the raster's cells, to one decimal: `"39.7%"`. */
export const cellShare = (count: number): string => `${((count * 100) / GRID_CELLS).toFixed(1)}%`;

export interface ValueSummary {
  readonly min: number;
  readonly max: number;
  /** Over every cell. */
  readonly mean: number;
  /** Over land cells only, or `null` if there are none. */
  readonly landMean: number | null;
}

export interface SnapshotSummary {
  readonly land: number;
  readonly ocean: number;
  readonly biomes: Readonly<Record<Biome, number>>;
  readonly temperatureC: ValueSummary;
  readonly moisture: ValueSummary;
}

function summarizeValues(values: readonly number[], land: readonly boolean[]): ValueSummary {
  let landSum = 0;
  let landCount = 0;
  values.forEach((value, index) => {
    if (land[index]) {
      landSum += value;
      landCount++;
    }
  });
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    landMean: landCount === 0 ? null : landSum / landCount,
  };
}

/** Counts and value ranges of one checkpoint. Land and ocean follow terrain's sea level; biome counts are the saved labels. */
export function summarize(snapshot: Snapshot): SnapshotSummary {
  const land = snapshot.terrain.elevation.map((_, index) => !isWater(snapshot.terrain, index));
  const landCount = land.filter(Boolean).length;
  const biomes = Object.fromEntries(BIOMES.map((biome) => [biome, 0])) as Record<Biome, number>;
  for (const biome of snapshot.climate.biome) biomes[biome]++;
  return {
    land: landCount,
    ocean: GRID_CELLS - landCount,
    biomes,
    temperatureC: summarizeValues(snapshot.climate.temperatureC, land),
    moisture: summarizeValues(snapshot.climate.moisture, land),
  };
}

export interface Difference {
  /** Land in `before`, water in `after`. */
  readonly flooded: number;
  /** Water in `before`, land in `after`. */
  readonly emerged: number;
  /** Cells whose saved biome label differs. */
  readonly biomeChanged: number;
  /** Each from → to biome change and how many cells made it, most frequent first. */
  readonly transitions: readonly { readonly from: Biome; readonly to: Biome; readonly cells: number }[];
}

/** How `after` differs from `before`, cell by cell. */
export function compareSnapshots(before: Snapshot, after: Snapshot): Difference {
  let flooded = 0;
  let emerged = 0;
  const transitions = new Map<string, { from: Biome; to: Biome; cells: number }>();
  for (let index = 0; index < GRID_CELLS; index++) {
    const wasWater = isWater(before.terrain, index);
    const nowWater = isWater(after.terrain, index);
    if (!wasWater && nowWater) flooded++;
    if (wasWater && !nowWater) emerged++;
    const from = before.climate.biome[index]!;
    const to = after.climate.biome[index]!;
    if (from !== to) {
      const key = `${from}>${to}`;
      const entry = transitions.get(key) ?? { from, to, cells: 0 };
      entry.cells++;
      transitions.set(key, entry);
    }
  }
  const sorted = [...transitions.values()].sort(
    (a, b) => b.cells - a.cells || BIOMES.indexOf(a.from) - BIOMES.indexOf(b.from) || BIOMES.indexOf(a.to) - BIOMES.indexOf(b.to),
  );
  return { flooded, emerged, biomeChanged: sorted.reduce((sum, entry) => sum + entry.cells, 0), transitions: sorted };
}

/** The checkpoint selected when a file loads: the latest one saved. */
export const latestCheckpointIndex = (bundle: SnapshotBundle): number => bundle.snapshots.length - 1;

/**
 * Each recorded event, as saved, and whether the checkpoint at `selectedAtMs`
 * already reflects it (it was captured at or after the event) or the event
 * lies after it.
 */
export function eventsRelativeTo(
  bundle: SnapshotBundle,
  selectedAtMs: number,
): readonly { readonly event: SeaLevelRiseEvent; readonly reflected: boolean }[] {
  return bundle.events.map((event) => ({ event, reflected: event.atMs <= selectedAtMs }));
}
