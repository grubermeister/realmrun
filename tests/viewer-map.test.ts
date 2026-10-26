/**
 * The viewer's map layers: raster orientation, which saved array each layer
 * draws, and colour scales that stay fixed across checkpoints.
 */

import { describe, expect, test } from "bun:test";
import { rowLatitude as terrainRowLatitude } from "lattice-terrain-module";
import { simTime } from "realmlib";
import { DEFAULT_PLANET_CONFIG } from "../src/planetary-fixture.ts";
import {
  BIOME_COLORS,
  cellAt,
  cellColor,
  DEFAULT_LAYER,
  LAND_SCALE,
  LAYERS,
  legendFor,
  MOISTURE_SCALE,
  rasterPixels,
  rowLatitude,
  scaleColor,
  scaleRamp,
  TEMPERATURE_SCALE,
  WATER_SCALE,
} from "../viewer/src/map.ts";
import type { LayerId, Rgb } from "../viewer/src/map.ts";
import { BIOMES, GRID_CELLS, GRID_HEIGHT, GRID_WIDTH, parseSnapshotFile } from "../viewer/src/snapshot-format.ts";
import type { Biome, Snapshot } from "../viewer/src/snapshot-format.ts";
import { exportedSnapshotsInMemory } from "./in-memory-reference.ts";

const bundle = parseSnapshotFile(await exportedSnapshotsInMemory(DEFAULT_PLANET_CONFIG, simTime(2_000)));
const [atZero, at1000, at2000] = bundle.snapshots as [Snapshot, Snapshot, Snapshot];
const LAYER_IDS = LAYERS.map((layer) => layer.id);

const pixel = (pixels: Uint8ClampedArray, index: number): number[] => [...pixels.subarray(index * 4, index * 4 + 4)];
const opaque = (color: Rgb): number[] => [...color, 255];

/** A snapshot whose biomes are all ocean but for three marked cells; it need not be a valid planet. */
function marked(marks: Readonly<Record<number, Biome>>): Snapshot {
  return {
    ...atZero,
    climate: { ...atZero.climate, biome: Array.from({ length: GRID_CELLS }, (_, index) => marks[index] ?? "ocean") },
  };
}

describe("orientation and indexing", () => {
  test("one pixel per cell in row-major order: index 0 at the top left (north-west), row 23 at the bottom", () => {
    const northEast = GRID_WIDTH - 1;
    const southWest = (GRID_HEIGHT - 1) * GRID_WIDTH;
    const pixels = rasterPixels(marked({ 0: "ice", [northEast]: "desert", [southWest]: "forest", [GRID_CELLS - 1]: "tundra" }), "biome");
    expect(pixels).toHaveLength(GRID_WIDTH * GRID_HEIGHT * 4);
    // Pixel (x, y) is at offset (y * width + x) * 4 of an ImageData row-major RGBA buffer.
    expect(pixel(pixels, 0 * GRID_WIDTH + 0)).toEqual(opaque(BIOME_COLORS.ice));
    expect(pixel(pixels, 0 * GRID_WIDTH + (GRID_WIDTH - 1))).toEqual(opaque(BIOME_COLORS.desert));
    expect(pixel(pixels, (GRID_HEIGHT - 1) * GRID_WIDTH + 0)).toEqual(opaque(BIOME_COLORS.forest));
    expect(pixel(pixels, (GRID_HEIGHT - 1) * GRID_WIDTH + (GRID_WIDTH - 1))).toEqual(opaque(BIOME_COLORS.tundra));
    expect(pixel(pixels, 1)).toEqual(opaque(BIOME_COLORS.ocean));
  });

  test("columns are drawn once each: column 47 is the last pixel of its row and the next pixel starts the next row at column 0", () => {
    const pixels = rasterPixels(marked({ 47: "desert", 48: "ice" }), "biome");
    expect(pixel(pixels, 47)).toEqual(opaque(BIOME_COLORS.desert));
    expect(pixel(pixels, 48)).toEqual(opaque(BIOME_COLORS.ice));
    // Every layer draws every cell exactly once, in order, with no seam column added.
    for (const layer of LAYER_IDS) {
      const raster = rasterPixels(at1000, layer);
      expect(raster).toHaveLength(GRID_CELLS * 4);
      for (let index = 0; index < GRID_CELLS; index++) expect(pixel(raster, index)).toEqual(opaque(cellColor(at1000, layer, index)));
    }
  });

  test("a point on the drawn map finds its cell at any size, and the left and right edges are columns 0 and 47", () => {
    expect(cellAt(0, 0, 960, 480)).toEqual({ row: 0, column: 0, index: 0 });
    expect(cellAt(959.9, 0, 960, 480)).toEqual({ row: 0, column: 47, index: 47 });
    expect(cellAt(0, 479.9, 960, 480)).toEqual({ row: 23, column: 0, index: 1104 });
    expect(cellAt(960, 480, 960, 480)).toEqual({ row: 23, column: 47, index: 1151 });
    expect(cellAt(-3, -3, 960, 480)).toEqual({ row: 0, column: 0, index: 0 });
    expect(cellAt(20, 10, 96, 48)).toEqual({ row: 5, column: 10, index: 5 * 48 + 10 });
    const columns = new Set(Array.from({ length: 4800 }, (_, x) => cellAt(x / 5, 0, 960, 480).column));
    expect([...columns]).toEqual(Array.from({ length: GRID_WIDTH }, (_, column) => column));
  });

  test("row latitudes match terrain's", () => {
    for (let row = 0; row < GRID_HEIGHT; row++) expect(rowLatitude(row)).toBe(terrainRowLatitude(row));
    expect(rowLatitude(0)).toBe(86.25);
    expect(rowLatitude(23)).toBe(-86.25);
  });
});

describe("layer fidelity", () => {
  test("there are four layers, and a loaded file starts on biomes", () => {
    expect(LAYERS.map((layer) => layer.label)).toEqual(["Terrain / elevation", "Temperature", "Moisture", "Biomes"]);
    expect(DEFAULT_LAYER).toBe("biome");
  });

  test("each layer draws its own saved array of the snapshot it is given", () => {
    for (const snapshot of [atZero, at1000]) {
      const { terrain, climate } = snapshot;
      for (let index = 0; index < GRID_CELLS; index++) {
        const water = terrain.elevation[index]! <= terrain.seaLevel;
        expect(cellColor(snapshot, "terrain", index)).toEqual(scaleColor(water ? WATER_SCALE : LAND_SCALE, terrain.elevation[index]!));
        expect(cellColor(snapshot, "temperature", index)).toEqual(scaleColor(TEMPERATURE_SCALE, climate.temperatureC[index]!));
        expect(cellColor(snapshot, "moisture", index)).toEqual(scaleColor(MOISTURE_SCALE, climate.moisture[index]!));
        expect(cellColor(snapshot, "biome", index)).toEqual(BIOME_COLORS[climate.biome[index]!]);
      }
    }
  });

  test("changing one array changes only the layer drawn from it", () => {
    const reversed = <T>(values: readonly T[]) => [...values].reverse();
    const changes: Record<LayerId, Snapshot> = {
      terrain: { ...at1000, terrain: { ...at1000.terrain, elevation: reversed(at1000.terrain.elevation) } },
      temperature: { ...at1000, climate: { ...at1000.climate, temperatureC: reversed(at1000.climate.temperatureC) } },
      moisture: { ...at1000, climate: { ...at1000.climate, moisture: reversed(at1000.climate.moisture) } },
      biome: { ...at1000, climate: { ...at1000.climate, biome: reversed(at1000.climate.biome) } },
    };
    for (const [changed, snapshot] of Object.entries(changes)) {
      for (const layer of LAYER_IDS) {
        expect(rasterPixels(snapshot, layer).join() === rasterPixels(at1000, layer).join()).toBe(layer !== changed);
      }
    }
  });

  test("terrain follows each checkpoint's sea level: the same elevations draw 187 cells as water after the rise", () => {
    expect(at1000.terrain.elevation).toEqual(atZero.terrain.elevation);
    const before = rasterPixels(atZero, "terrain");
    const after = rasterPixels(at1000, "terrain");
    const changed: number[] = [];
    for (let index = 0; index < GRID_CELLS; index++) if (pixel(before, index).join() !== pixel(after, index).join()) changed.push(index);
    expect(changed).toHaveLength(187);
    for (const index of changed) {
      const elevation = atZero.terrain.elevation[index]!;
      expect(elevation > 0 && elevation <= 10).toBe(true);
      expect(pixel(before, index)).toEqual(opaque(scaleColor(LAND_SCALE, elevation)));
      expect(pixel(after, index)).toEqual(opaque(scaleColor(WATER_SCALE, elevation)));
    }
  });
});

describe("fixed colour scales", () => {
  test("2000 ms draws exactly as 1000 ms on every layer, since nothing changed between them", () => {
    for (const layer of LAYER_IDS) expect(rasterPixels(at2000, layer)).toEqual(rasterPixels(at1000, layer));
  });

  test("one value has one colour across every checkpoint", () => {
    for (const layer of ["temperature", "moisture", "biome"] as const) {
      const colors = new Map<string, string>();
      for (const snapshot of bundle.snapshots) {
        const values = { temperature: snapshot.climate.temperatureC, moisture: snapshot.climate.moisture, biome: snapshot.climate.biome }[layer];
        values.forEach((value, index) => {
          const color = cellColor(snapshot, layer, index).join();
          expect(colors.get(String(value)) ?? color).toBe(color);
          colors.set(String(value), color);
        });
      }
    }
  });

  test("the legend depends on the layer alone", () => {
    expect(legendFor.length).toBe(1);
    for (const layer of LAYER_IDS) expect(legendFor(layer)).toEqual(legendFor(layer));
  });

  test("terrain and moisture scales cover their records' whole ranges; temperature colours stop at ±40 °C", () => {
    expect([WATER_SCALE.stops[0]![0], WATER_SCALE.stops.at(-1)![0]]).toEqual([-100, 100]);
    expect([LAND_SCALE.stops[0]![0], LAND_SCALE.stops.at(-1)![0]]).toEqual([-100, 100]);
    expect([MOISTURE_SCALE.stops[0]![0], MOISTURE_SCALE.stops.at(-1)![0]]).toEqual([0, 100]);
    expect([TEMPERATURE_SCALE.stops[0]![0], TEMPERATURE_SCALE.stops.at(-1)![0]]).toEqual([-40, 40]);
    expect(scaleColor(TEMPERATURE_SCALE, -100)).toEqual(scaleColor(TEMPERATURE_SCALE, -40));
    expect(scaleColor(TEMPERATURE_SCALE, 100)).toEqual(scaleColor(TEMPERATURE_SCALE, 40));
    expect(scaleColor(TEMPERATURE_SCALE, -39)).not.toEqual(scaleColor(TEMPERATURE_SCALE, -40));
    expect(legendFor("temperature").note).toContain("−40 °C");
    expect(scaleColor(MOISTURE_SCALE, 50)).toEqual(MOISTURE_SCALE.stops[1]![1]);
    expect(scaleColor(MOISTURE_SCALE, 25)).toEqual([179, 201, 159]);
  });

  test("water and land never share a colour, at any elevation", () => {
    const water = new Set(Array.from({ length: 201 }, (_, i) => scaleColor(WATER_SCALE, i - 100).join()));
    for (let elevation = -100; elevation <= 100; elevation++) expect(water.has(scaleColor(LAND_SCALE, elevation).join())).toBe(false);
  });

  test("the biome legend names all seven biomes, each with its own colour", () => {
    const legend = legendFor("biome");
    if (legend.kind !== "categories") throw new Error("expected categories");
    expect(legend.categories.map((entry) => entry.label)).toEqual([...BIOMES]);
    expect(new Set(legend.categories.map((entry) => entry.color.join())).size).toBe(7);
  });

  test("a legend ramp runs from its scale's first colour to its last", () => {
    for (const scale of [WATER_SCALE, LAND_SCALE, TEMPERATURE_SCALE, MOISTURE_SCALE]) {
      const ramp = scaleRamp(scale, 201);
      expect(pixel(ramp, 0)).toEqual(opaque(scale.stops[0]![1]));
      expect(pixel(ramp, 200)).toEqual(opaque(scale.stops.at(-1)![1]));
    }
  });
});
