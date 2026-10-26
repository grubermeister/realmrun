/**
 * The viewer's read-only summaries of loaded checkpoints: the reference
 * planet's counts at each saved time, its difference from the baseline, and
 * where the recorded event falls relative to the selected checkpoint.
 */

import { describe, expect, test } from "bun:test";
import { simTime } from "realmlib";
import { DEFAULT_PLANET_CONFIG } from "../src/planetary-fixture.ts";
import { cellShare, compareSnapshots, eventsRelativeTo, latestCheckpointIndex, summarize } from "../viewer/src/metrics.ts";
import { GRID_CELLS, parseSnapshotFile } from "../viewer/src/snapshot-format.ts";
import type { Snapshot } from "../viewer/src/snapshot-format.ts";
import { exportedSnapshotsInMemory } from "./in-memory-reference.ts";

const load = async (until: number) => parseSnapshotFile(await exportedSnapshotsInMemory(DEFAULT_PLANET_CONFIG, simTime(until)));
const bundle = await load(2_000);
const [atZero, at1000, at2000] = bundle.snapshots as [Snapshot, Snapshot, Snapshot];

/** Cells whose saved biome differs, counted directly from the two arrays. */
const biomeDifferences = (before: Snapshot, after: Snapshot): number =>
  before.climate.biome.filter((biome, index) => biome !== after.climate.biome[index]).length;

describe("checkpoint summaries", () => {
  test.each([
    [0, 695, 457, 0],
    [1, 508, 644, 10],
    [2, 508, 644, 10],
  ])("checkpoint %d has %d land and %d ocean cells at sea level %d", (index, land, ocean, seaLevel) => {
    const snapshot = bundle.snapshots[index]!;
    const summary = summarize(snapshot);
    expect([summary.land, summary.ocean]).toEqual([land, ocean]);
    expect(summary.biomes.ocean).toBe(ocean);
    expect(snapshot.terrain.seaLevel).toBe(seaLevel);
    expect(Object.values(summary.biomes).reduce((sum, count) => sum + count, 0)).toBe(GRID_CELLS);
  });

  test("the baseline's biome counts are the ones the console map reports", () => {
    expect(summarize(atZero).biomes).toEqual({ ocean: 457, ice: 204, tundra: 76, desert: 149, grassland: 163, forest: 85, "tropical-forest": 18 });
  });

  test("value ranges and means come straight from the saved arrays", () => {
    const { temperatureC, moisture } = at1000.climate;
    const land = at1000.terrain.elevation.map((elevation) => elevation > at1000.terrain.seaLevel);
    const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const summary = summarize(at1000);
    expect(summary.temperatureC).toEqual({
      min: Math.min(...temperatureC),
      max: Math.max(...temperatureC),
      mean: mean(temperatureC),
      landMean: mean(temperatureC.filter((_, index) => land[index])),
    });
    expect(summary.moisture.max).toBe(100);
    expect(summary.moisture.landMean).toBe(mean(moisture.filter((_, index) => land[index])));
  });

  test("a planet without land has no land means", () => {
    const flooded: Snapshot = { ...atZero, terrain: { ...atZero.terrain, seaLevel: 100 } };
    const summary = summarize(flooded);
    expect([summary.land, summary.ocean]).toEqual([0, GRID_CELLS]);
    expect([summary.temperatureC.landMean, summary.moisture.landMean]).toEqual([null, null]);
  });

  test("shares are of the 1152 raster cells, to one decimal", () => {
    expect([cellShare(457), cellShare(644), cellShare(187), cellShare(0), cellShare(GRID_CELLS)]).toEqual(["39.7%", "55.9%", "16.2%", "0.0%", "100.0%"]);
  });
});

describe("difference from the baseline", () => {
  test("0 → 1000: 187 cells newly flooded, none emerged, and the biome changes the saved arrays show", () => {
    const difference = compareSnapshots(atZero, at1000);
    expect(difference.flooded).toBe(187);
    expect(difference.emerged).toBe(0);
    expect(difference.biomeChanged).toBe(biomeDifferences(atZero, at1000));
    expect(difference.biomeChanged).toBeGreaterThan(187);
    expect(difference.transitions.reduce((sum, entry) => sum + entry.cells, 0)).toBe(difference.biomeChanged);
    // Every newly flooded cell's label changed to ocean, and nothing else became ocean.
    const toOcean = difference.transitions.filter((entry) => entry.to === "ocean");
    expect(toOcean.reduce((sum, entry) => sum + entry.cells, 0)).toBe(187);
    expect(difference.transitions.some((entry) => entry.from === "ocean")).toBe(false);
    for (const { from, to, cells } of difference.transitions) {
      expect(from).not.toBe(to);
      const counted = atZero.climate.biome.filter((biome, index) => biome === from && at1000.climate.biome[index] === to).length;
      expect(cells).toBe(counted);
    }
    expect(difference.transitions.map((entry) => entry.cells)).toEqual(difference.transitions.map((entry) => entry.cells).sort((a, b) => b - a));
  });

  test("0 → 2000 is the same as 0 → 1000, and 1000 → 2000 changes nothing", () => {
    expect(compareSnapshots(atZero, at2000)).toEqual(compareSnapshots(atZero, at1000));
    expect(compareSnapshots(at1000, at2000)).toEqual({ flooded: 0, emerged: 0, biomeChanged: 0, transitions: [] });
  });

  test("0 → 0 has every difference at zero", () => {
    expect(compareSnapshots(atZero, atZero)).toEqual({ flooded: 0, emerged: 0, biomeChanged: 0, transitions: [] });
  });

  test("counts follow the arrays, not the event: a lowered sea level would count as emerged", () => {
    const lowered: Snapshot = { ...atZero, terrain: { ...atZero.terrain, seaLevel: -10 } };
    const difference = compareSnapshots(atZero, lowered);
    expect(difference.flooded).toBe(0);
    expect(difference.emerged).toBe(atZero.terrain.elevation.filter((elevation) => elevation > -10 && elevation <= 0).length);
    expect(difference.biomeChanged).toBe(0);
  });
});

describe("checkpoint selection and recorded events", () => {
  test("the latest saved checkpoint is selected first", async () => {
    expect(latestCheckpointIndex(bundle)).toBe(2);
    expect(latestCheckpointIndex(await load(500))).toBe(1);
    expect(latestCheckpointIndex(await load(0))).toBe(0);
  });

  test("the reference's one event is after the 0 ms checkpoint and reflected at 1000 and 2000", () => {
    const event = { atMs: 1_000, kind: "sea-level-rise", fromSeaLevel: 0, toSeaLevel: 10, consequence: "climate.refresh" };
    expect(eventsRelativeTo(bundle, 0)).toEqual([{ event, reflected: false }] as never);
    expect(eventsRelativeTo(bundle, 1_000)).toEqual([{ event, reflected: true }] as never);
    expect(eventsRelativeTo(bundle, 2_000)).toEqual([{ event, reflected: true }] as never);
  });

  test("a run to 500 shows its two checkpoints and no event at either", async () => {
    const early = await load(500);
    expect(early.snapshots.map((snapshot) => snapshot.atMs)).toEqual([0, 500]);
    for (const snapshot of early.snapshots) expect(eventsRelativeTo(early, snapshot.atMs)).toEqual([]);
    expect(compareSnapshots(early.snapshots[0]!, early.snapshots[1]!)).toEqual({ flooded: 0, emerged: 0, biomeChanged: 0, transitions: [] });
  });

  test("summaries leave the loaded, frozen bundle as it was", async () => {
    const text = await exportedSnapshotsInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000));
    const loaded = parseSnapshotFile(text);
    for (const snapshot of loaded.snapshots) {
      summarize(snapshot);
      compareSnapshots(loaded.snapshots[0]!, snapshot);
      eventsRelativeTo(loaded, snapshot.atMs);
    }
    expect(loaded).toEqual(JSON.parse(text));
  });
});
