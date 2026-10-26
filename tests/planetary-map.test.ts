import { describe, expect, test } from "bun:test";
import { BIOMES } from "lattice-climate-module";
import type { ClimateRecord } from "lattice-climate-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { simTime } from "realmlib";
import { DEFAULT_PLANET_CONFIG, readPlanetRecords, TERRAIN_MODULE } from "../src/planetary-fixture.ts";
import type { PlanetConfig } from "../src/planetary-fixture.ts";
import { BIOME_SYMBOLS, renderPlanetMap } from "../src/planetary-map.ts";
import { runPlanetInMemory } from "./in-memory-reference.ts";

async function render(config: PlanetConfig = DEFAULT_PLANET_CONFIG, until = 0): Promise<string> {
  const run = await runPlanetInMemory(config, simTime(until));
  const records = readPlanetRecords((owner) => (owner === TERRAIN_MODULE ? run.terrain : run.climate));
  return renderPlanetMap({ ...records, now: run.now });
}

const mapRows = (output: string): string[] =>
  output.split("\n").flatMap((line) => line.match(/^[ 0-9]{2}[NS] \|(.*)\|$/)?.slice(1) ?? []);

describe("renderPlanetMap", () => {
  test("prints a header with the inputs, dimensions, and clock from the records", async () => {
    const lines = (await render({ seed: 42, seaLevel: -5, meanTempC: 3 }, 250)).split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "Planet: seed 42, sea level -5, mean temperature 3 C",
      "Grid: 48 x 24 cells, rows north to south, columns wrap east-west",
      "Simulated time: 250 ms",
    ]);
  });

  test("prints a full 48 x 24 map of biome symbols, north to south", async () => {
    const output = await render();
    const rows = mapRows(output);
    expect(rows).toHaveLength(24);
    const symbols = new Set(Object.values(BIOME_SYMBOLS));
    for (const row of rows) {
      expect(row).toHaveLength(48);
      for (const symbol of row) expect(symbols.has(symbol)).toBe(true);
    }
    expect(output).toContain("86N |");
    expect(output).toContain(" 4S |");
    expect(output).toContain("86S |");
    expect(output).toMatch(/^[ -~\n]*$/); // ASCII only
  });

  test("lists every biome once with its symbol, and the counts add up", async () => {
    const output = await render();
    const counts = BIOMES.map((biome) => {
      const line = output.split("\n").find((l) => l.startsWith(`${BIOME_SYMBOLS[biome]} ${biome.replace("-", " ")} `));
      expect(line).toBeDefined();
      return Number(line!.trim().split(/\s+/).at(-2));
    });
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1152);
    const surface = output.match(/^Surface: ocean (\d+) cells \([0-9.]+%\), land (\d+) cells \([0-9.]+%\)$/m);
    expect(surface).not.toBeNull();
    expect(Number(surface![1])).toBe(counts[0]!);
    expect(Number(surface![1]) + Number(surface![2])).toBe(1152);
    // Each symbol on the map is counted.
    const onMap = mapRows(output).join("");
    BIOMES.forEach((biome, i) => expect([...onMap].filter((c) => c === BIOME_SYMBOLS[biome]).length).toBe(counts[i]!));
  });

  test("symbols are distinct", () => {
    expect(new Set(Object.values(BIOME_SYMBOLS)).size).toBe(BIOMES.length);
  });

  test("is deterministic, and changing the seed changes the map", async () => {
    expect(await render()).toBe(await render());
    expect(mapRows(await render({ ...DEFAULT_PLANET_CONFIG, seed: 42 }))).not.toEqual(mapRows(await render()));
  });

  test("renders exactly what the records say", () => {
    const terrain: TerrainRecord = { schemaVersion: 1, width: 48, height: 24, seed: 9, seaLevel: 0, elevation: Array(1152).fill(-1) };
    const climate: ClimateRecord = {
      schemaVersion: 1,
      width: 48,
      height: 24,
      meanTempC: 15,
      temperatureC: Array(1152).fill(15),
      moisture: Array(1152).fill(100),
      biome: Array(1152).fill("ocean"),
    };
    const output = renderPlanetMap({ terrain, climate, now: simTime(0) });
    expect(mapRows(output)).toEqual(Array(24).fill("~".repeat(48)));
    expect(output).toContain("Surface: ocean 1152 cells (100.0%), land 0 cells (0.0%)");
  });
});
