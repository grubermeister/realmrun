/**
 * Renders the planet scenario's committed records as a monospaced ASCII biome
 * map with a short header and summary. Pure: it reads only its arguments, has
 * no simulation authority, and touches no database.
 */

import { BIOMES } from "lattice-climate-module";
import type { Biome } from "lattice-climate-module";
import { isLand, rowLatitude, SURFACE_CELLS } from "lattice-terrain-module";
import type { SimTime } from "realmlib";
import type { PlanetRecords } from "./planetary-fixture.ts";

/** One map character per biome. */
export const BIOME_SYMBOLS: Readonly<Record<Biome, string>> = {
  ocean: "~",
  ice: "*",
  tundra: "-",
  desert: ".",
  grassland: '"',
  forest: "t",
  "tropical-forest": "T",
};

const percent = (count: number): string => `${((count * 100) / SURFACE_CELLS).toFixed(1)}%`.padStart(6);

/** `86N`, ` 4S`, …: a row's latitude rounded to whole degrees. */
const latitudeLabel = (row: number): string => {
  const latitude = rowLatitude(row);
  return `${String(Math.round(Math.abs(latitude))).padStart(2)}${latitude > 0 ? "N" : "S"}`;
};

/** The map and summary, as lines without a trailing newline. */
export function renderPlanetMap(records: PlanetRecords & { readonly now: SimTime }): string {
  const { terrain, climate, now } = records;
  const border = `    +${"-".repeat(terrain.width)}+`;
  const lines = [
    `Planet: seed ${terrain.seed}, sea level ${terrain.seaLevel}, mean temperature ${climate.meanTempC} C`,
    `Grid: ${terrain.width} x ${terrain.height} cells, rows north to south, columns wrap east-west`,
    `Simulated time: ${now} ms`,
    "",
    border,
  ];
  for (let row = 0; row < terrain.height; row++) {
    const cells = climate.biome.slice(row * terrain.width, (row + 1) * terrain.width);
    lines.push(`${latitudeLabel(row)} |${cells.map((biome) => BIOME_SYMBOLS[biome]).join("")}|`);
  }
  lines.push(border, "");

  let land = 0;
  for (let index = 0; index < SURFACE_CELLS; index++) if (isLand(terrain, index)) land++;
  const counts = new Map<Biome, number>(BIOMES.map((biome) => [biome, 0]));
  for (const biome of climate.biome) counts.set(biome, counts.get(biome)! + 1);

  lines.push(
    `Surface: ocean ${SURFACE_CELLS - land} cells (${percent(SURFACE_CELLS - land).trim()}), land ${land} cells (${percent(land).trim()})`,
    "",
    "  Biome            Cells  Share",
  );
  for (const biome of BIOMES) {
    const count = counts.get(biome)!;
    lines.push(`${BIOME_SYMBOLS[biome]} ${biome.replace("-", " ").padEnd(16)} ${String(count).padStart(5)} ${percent(count)}`);
  }
  return lines.join("\n");
}
