/**
 * The map layers: which saved array each one draws, the fixed colour scale it
 * uses, and the RGBA raster for a snapshot. Pure and DOM-free; the page puts
 * the raster on a canvas one pixel per cell and scales it without smoothing.
 *
 * Every scale is fixed in advance and the legend takes no snapshot, so one
 * value always has one colour, whichever checkpoint or file it comes from.
 */

import { BIOMES, GRID_CELLS, GRID_HEIGHT, GRID_WIDTH, isWater } from "./snapshot-format.ts";
import type { Biome, Snapshot } from "./snapshot-format.ts";

export const LAYERS = [
  { id: "terrain", label: "Terrain / elevation" },
  { id: "temperature", label: "Temperature" },
  { id: "moisture", label: "Moisture" },
  { id: "biome", label: "Biomes" },
] as const;
export type LayerId = (typeof LAYERS)[number]["id"];

/** The layer shown after a file loads: biomes show both the coastline and the climate's response to it. */
export const DEFAULT_LAYER: LayerId = "biome";

export type Rgb = readonly [number, number, number];

/** A piecewise-linear colour scale; values outside its stops take the nearest end's colour. */
export interface Scale {
  readonly label: string;
  readonly unit: string;
  readonly stops: readonly (readonly [value: number, color: Rgb])[];
}

const hex = (code: string): Rgb => [parseInt(code.slice(1, 3), 16), parseInt(code.slice(3, 5), 16), parseInt(code.slice(5, 7), 16)];

/** Terrain at or below the checkpoint's sea level, shaded by its saved elevation. */
export const WATER_SCALE: Scale = {
  label: "Water (elevation ≤ sea level)",
  unit: "elevation units",
  stops: [
    [-100, hex("#0b2557")],
    [-30, hex("#1f5a96")],
    [0, hex("#4f8fc2")],
    [100, hex("#a9d3ee")],
  ],
};

/** Terrain above the checkpoint's sea level, shaded by its saved elevation. */
export const LAND_SCALE: Scale = {
  label: "Land (elevation > sea level)",
  unit: "elevation units",
  stops: [
    [-100, hex("#2f6e3b")],
    [0, hex("#6f9a4a")],
    [30, hex("#b8a66a")],
    [60, hex("#8a6a45")],
    [100, hex("#f4f1ea")],
  ],
};

/** Saved temperatures span −100 to 100 °C; the colours stop at ±40, so colder or hotter cells take the end colours. */
export const TEMPERATURE_SCALE: Scale = {
  label: "Temperature",
  unit: "°C",
  stops: [
    [-40, hex("#2c3e9e")],
    [-10, hex("#7fb2e5")],
    [0, hex("#f2f2f2")],
    [20, hex("#f4a259")],
    [40, hex("#a5161b")],
  ],
};

export const MOISTURE_SCALE: Scale = {
  label: "Moisture",
  unit: "index",
  stops: [
    [0, hex("#e6d3a3")],
    [50, hex("#7fbf9b")],
    [100, hex("#12497c")],
  ],
};

export const BIOME_COLORS: Readonly<Record<Biome, Rgb>> = {
  ocean: hex("#2b5f9e"),
  ice: hex("#eef3f7"),
  tundra: hex("#97a39a"),
  desert: hex("#e3c770"),
  grassland: hex("#a6c95a"),
  forest: hex("#3f7f3a"),
  "tropical-forest": hex("#0f5240"),
};

/** The colour of `value` on `scale`. */
export function scaleColor(scale: Scale, value: number): Rgb {
  const { stops } = scale;
  if (value <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [high, highColor] = stops[i]!;
    if (value <= high) {
      const [low, lowColor] = stops[i - 1]!;
      const t = (value - low) / (high - low);
      return [0, 1, 2].map((c) => Math.round(lowColor[c]! + (highColor[c]! - lowColor[c]!) * t)) as unknown as Rgb;
    }
  }
  return stops.at(-1)![1];
}

/** The colour of the cell at row-major `index` of `snapshot` on `layer`, from that snapshot's saved records only. */
export function cellColor(snapshot: Snapshot, layer: LayerId, index: number): Rgb {
  const { terrain, climate } = snapshot;
  switch (layer) {
    case "terrain":
      return scaleColor(isWater(terrain, index) ? WATER_SCALE : LAND_SCALE, terrain.elevation[index]!);
    case "temperature":
      return scaleColor(TEMPERATURE_SCALE, climate.temperatureC[index]!);
    case "moisture":
      return scaleColor(MOISTURE_SCALE, climate.moisture[index]!);
    case "biome":
      return BIOME_COLORS[climate.biome[index]!];
  }
}

/**
 * `snapshot` on `layer` as {@link GRID_WIDTH} × {@link GRID_HEIGHT} opaque RGBA
 * pixels, one per cell in the records' own order: pixel (x, y) is cell
 * `y * width + x`, so row 0 (north) is the top row and the columns run around
 * the planet once, with no seam column repeated.
 */
export function rasterPixels(snapshot: Snapshot, layer: LayerId): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(GRID_CELLS * 4);
  for (let index = 0; index < GRID_CELLS; index++) {
    const [r, g, b] = cellColor(snapshot, layer, index);
    pixels.set([r, g, b, 255], index * 4);
  }
  return pixels;
}

/** The cell under a point `x`, `y` pixels into a map drawn `width` × `height` pixels large. */
export function cellAt(x: number, y: number, width: number, height: number): { row: number; column: number; index: number } {
  const clampTo = (value: number, size: number) => Math.min(size - 1, Math.max(0, value));
  const column = clampTo(Math.floor((x / width) * GRID_WIDTH), GRID_WIDTH);
  const row = clampTo(Math.floor((y / height) * GRID_HEIGHT), GRID_HEIGHT);
  return { row, column, index: row * GRID_WIDTH + column };
}

/** The latitude of the centre of `row`, in degrees, positive north: 86.25 for row 0, −86.25 for row 23. */
export const rowLatitude = (row: number): number => 90 - (row + 0.5) * (180 / GRID_HEIGHT);

export type Legend =
  | { readonly kind: "scales"; readonly scales: readonly Scale[]; readonly note: string }
  | { readonly kind: "categories"; readonly categories: readonly { readonly label: Biome; readonly color: Rgb }[]; readonly note: string };

/** What `layer`'s colours mean. It takes no snapshot: the legend is the same for every checkpoint. */
export function legendFor(layer: LayerId): Legend {
  switch (layer) {
    case "terrain":
      return {
        kind: "scales",
        scales: [WATER_SCALE, LAND_SCALE],
        note: "Saved terrain.elevation, split by that checkpoint's terrain.seaLevel: the same elevation is drawn as water once the sea rises above it.",
      };
    case "temperature":
      return {
        kind: "scales",
        scales: [TEMPERATURE_SCALE],
        note: "Saved climate.temperatureC. Cells at or below −40 °C take the −40 colour; cells at or above 40 °C take the 40 colour.",
      };
    case "moisture":
      return { kind: "scales", scales: [MOISTURE_SCALE], note: "Saved climate.moisture, a 0–100 index; ocean cells are always 100." };
    case "biome":
      return {
        kind: "categories",
        categories: BIOMES.map((label) => ({ label, color: BIOME_COLORS[label] })),
        note: "Saved climate.biome labels.",
      };
  }
}

/** `scale` sampled at `width` evenly spaced values across its stops, as one row of RGBA pixels for a legend bar. */
export function scaleRamp(scale: Scale, width: number): Uint8ClampedArray<ArrayBuffer> {
  const low = scale.stops[0]![0];
  const high = scale.stops.at(-1)![0];
  const pixels = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const [r, g, b] = scaleColor(scale, low + ((high - low) * x) / (width - 1));
    pixels.set([r, g, b, 255], x * 4);
  }
  return pixels;
}
