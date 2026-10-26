/**
 * The climate simulation module: a toy climatology derived from the terrain
 * module's committed `surface` record, owned by the `climate` module as its
 * `climate` record and written only by its `derive` operation.
 *
 * `derive` reads terrain through realmlib's staged state view, never through a
 * copy in its payload, and writes only its own record. Its rules are simple,
 * explicitly approximate functions of latitude, elevation, and distance from
 * the ocean, meant for testing module architecture rather than describing any
 * real climate.
 *
 * This package depends on `lattice-terrain-module` only for that module's
 * public, read-only record contract. It does not register itself, schedule
 * work, or choose when operations run. Importing it has no side effects.
 */

import {
  isLand,
  parseTerrainRecord,
  rowLatitude,
  SURFACE_CELLS,
  SURFACE_HEIGHT,
  SURFACE_WIDTH,
  TERRAIN_KEY,
  TERRAIN_MODULE,
} from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { moduleId } from "realmlib";
import type { ModuleDefinition, OperationHandler } from "realmlib";

/** The module's ID, under which it owns its state. */
export const CLIMATE_MODULE = moduleId("climate");

/** The key of the module's one record, a {@link ClimateRecord}. */
export const CLIMATE_KEY = "climate";

/** The version of the {@link ClimateRecord} shape this package writes and accepts. */
export const CLIMATE_SCHEMA_VERSION = 1;

/** Inclusive bounds of `meanTempC`, in degrees Celsius. */
export const MEAN_TEMP_MIN = -40;
export const MEAN_TEMP_MAX = 40;

/** Inclusive bounds of every cell temperature, in degrees Celsius; derived values are clamped to them. */
export const TEMPERATURE_MIN = -100;
export const TEMPERATURE_MAX = 100;

/** Inclusive bounds of every cell's moisture index. */
export const MOISTURE_MIN = 0;
export const MOISTURE_MAX = 100;

/** Every biome, in a fixed order. `"ocean"` is exactly the cells terrain reports as not land. */
export const BIOMES = ["ocean", "ice", "tundra", "desert", "grassland", "forest", "tropical-forest"] as const;
export type Biome = (typeof BIOMES)[number];

/**
 * The `climate` module's `climate` record, at {@link CLIMATE_SCHEMA_VERSION}.
 * Arrays are row-major over terrain's raster.
 * (A type alias, not an interface, so it is assignable to realmlib's `StateValue`.)
 */
export type ClimateRecord = {
  readonly schemaVersion: typeof CLIMATE_SCHEMA_VERSION;
  readonly width: typeof SURFACE_WIDTH;
  readonly height: typeof SURFACE_HEIGHT;
  /** The baseline the temperatures were derived with. */
  readonly meanTempC: number;
  /** {@link SURFACE_CELLS} integers in [{@link TEMPERATURE_MIN}, {@link TEMPERATURE_MAX}]. */
  readonly temperatureC: readonly number[];
  /** {@link SURFACE_CELLS} integers in [{@link MOISTURE_MIN}, {@link MOISTURE_MAX}]. */
  readonly moisture: readonly number[];
  /** {@link SURFACE_CELLS} entries of {@link BIOMES}. */
  readonly biome: readonly Biome[];
};

/** The payload of `derive`, at payload version 1. */
export interface ClimateDeriveParams {
  /** An integer in [{@link MEAN_TEMP_MIN}, {@link MEAN_TEMP_MAX}]. */
  readonly meanTempC: number;
}

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && !Object.is(value, -0) && (value as number) >= min && (value as number) <= max;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` has exactly the own keys `keys`. */
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

function isDeriveParams(payload: unknown): boolean {
  return (
    isPlainRecord(payload) && hasExactKeys(payload, ["meanTempC"]) && isIntegerIn(payload.meanTempC, MEAN_TEMP_MIN, MEAN_TEMP_MAX)
  );
}

/** The module's one operation, `derive`, at payload version 1 with a {@link ClimateDeriveParams} payload. */
export const climateModule: ModuleDefinition = {
  id: CLIMATE_MODULE,
  operations: [{ name: "derive", version: 1, validatePayload: isDeriveParams }],
};

/**
 * Checks that `value` is a {@link ClimateRecord} this package can read and
 * returns it typed.
 *
 * @throws {TypeError} naming the first problem found.
 */
export function parseClimateRecord(value: unknown): ClimateRecord {
  const fail = (problem: string): never => {
    throw new TypeError(`Invalid climate record: ${problem}`);
  };
  if (!isPlainRecord(value)) return fail("not an object");
  if (value.schemaVersion !== CLIMATE_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (expected ${CLIMATE_SCHEMA_VERSION})`);
  }
  if (!hasExactKeys(value, ["schemaVersion", "width", "height", "meanTempC", "temperatureC", "moisture", "biome"])) {
    fail(`unexpected fields ${JSON.stringify(Object.keys(value))}`);
  }
  if (value.width !== SURFACE_WIDTH || value.height !== SURFACE_HEIGHT) {
    fail(`dimensions ${JSON.stringify(value.width)} x ${JSON.stringify(value.height)} (expected ${SURFACE_WIDTH} x ${SURFACE_HEIGHT})`);
  }
  if (!isIntegerIn(value.meanTempC, MEAN_TEMP_MIN, MEAN_TEMP_MAX)) fail("meanTempC is out of range");
  const cells = (field: string, valid: (cell: unknown) => boolean): void => {
    const array = value[field];
    if (!Array.isArray(array) || array.length !== SURFACE_CELLS) fail(`${field} must be an array of ${SURFACE_CELLS} cells`);
    (array as unknown[]).forEach((cell, index) => {
      if (!valid(cell)) fail(`${field}[${index}] is out of range`);
    });
  };
  cells("temperatureC", (cell) => isIntegerIn(cell, TEMPERATURE_MIN, TEMPERATURE_MAX));
  cells("moisture", (cell) => isIntegerIn(cell, MOISTURE_MIN, MOISTURE_MAX));
  cells("biome", (cell) => (BIOMES as readonly unknown[]).includes(cell));
  return value as unknown as ClimateRecord;
}

/** Sea-level temperature is `meanTempC + EQUATOR_BONUS_C` at the equator, falling by `POLE_DROP_C · (latitude/90)²`. */
const EQUATOR_BONUS_C = 11;
const POLE_DROP_C = 60;
/** Degrees Celsius lost per unit of elevation above sea level, on land only. */
const LAPSE_C_PER_UNIT = 0.3;

/** Land moisture is `MOISTURE_BASE − MOISTURE_PER_STEP · distance + MOISTURE_BELT · belt(latitude)`, clamped. */
const MOISTURE_BASE = 75;
const MOISTURE_PER_STEP = 12;
const MOISTURE_BELT = 20;
/** Distances from the ocean are counted up to this many steps; farther (or no ocean at all) counts as this. */
const MAX_OCEAN_DISTANCE = 8;

/** Rounds to an integer, never producing -0 (which realmlib state refuses). */
const roundInteger = (x: number): number => Math.round(x) || 0;
const clamp = (x: number, min: number, max: number): number => Math.min(max, Math.max(min, x));

/**
 * A crude stand-in for alternating wet and dry latitude bands: 1 at the
 * equator and at 60°, −1 at 30° and at the poles, linear in between.
 */
function latitudeBelt(latitude: number): number {
  const phase = (Math.abs(latitude) % 60) / 60;
  return 2 * Math.abs(1 - 2 * phase) - 1;
}

/**
 * Each cell's distance in steps from the nearest ocean cell, capped at
 * {@link MAX_OCEAN_DISTANCE}: a breadth-first search over the four neighbours,
 * wrapping east–west but not across the poles. Ocean cells are 0.
 */
function oceanDistances(terrain: TerrainRecord): number[] {
  const distance: number[] = new Array(SURFACE_CELLS).fill(MAX_OCEAN_DISTANCE);
  let frontier: number[] = [];
  for (let index = 0; index < SURFACE_CELLS; index++) {
    if (!isLand(terrain, index)) {
      distance[index] = 0;
      frontier.push(index);
    }
  }
  for (let step = 1; step < MAX_OCEAN_DISTANCE && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const index of frontier) {
      const row = Math.floor(index / SURFACE_WIDTH);
      const column = index % SURFACE_WIDTH;
      const neighbours = [
        row * SURFACE_WIDTH + ((column + 1) % SURFACE_WIDTH),
        row * SURFACE_WIDTH + ((column + SURFACE_WIDTH - 1) % SURFACE_WIDTH),
      ];
      if (row > 0) neighbours.push(index - SURFACE_WIDTH);
      if (row < SURFACE_HEIGHT - 1) neighbours.push(index + SURFACE_WIDTH);
      for (const neighbour of neighbours) {
        if (distance[neighbour]! > step) {
          distance[neighbour] = step;
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

function classify(land: boolean, temperatureC: number, moisture: number): Biome {
  if (!land) return "ocean";
  if (temperatureC < -10) return "ice";
  if (temperatureC < 0) return "tundra";
  if (moisture < 25) return "desert";
  if (temperatureC >= 20 && moisture >= 60) return "tropical-forest";
  if (moisture >= 50) return "forest";
  return "grassland";
}

/** The climate of `terrain` for the baseline `meanTempC`. */
function deriveClimate(terrain: TerrainRecord, meanTempC: number): ClimateRecord {
  const distance = oceanDistances(terrain);
  const temperatureC: number[] = [];
  const moisture: number[] = [];
  const biome: Biome[] = [];
  for (let index = 0; index < SURFACE_CELLS; index++) {
    const latitude = rowLatitude(Math.floor(index / SURFACE_WIDTH));
    const land = isLand(terrain, index);
    const ratio = latitude / 90;
    let temperature = meanTempC + EQUATOR_BONUS_C - POLE_DROP_C * ratio * ratio;
    if (land) temperature -= LAPSE_C_PER_UNIT * (terrain.elevation[index]! - terrain.seaLevel);
    const cellTemperature = clamp(roundInteger(temperature), TEMPERATURE_MIN, TEMPERATURE_MAX);
    const cellMoisture = land
      ? clamp(
          roundInteger(MOISTURE_BASE - MOISTURE_PER_STEP * distance[index]! + MOISTURE_BELT * latitudeBelt(latitude)),
          MOISTURE_MIN,
          MOISTURE_MAX,
        )
      : MOISTURE_MAX;
    temperatureC.push(cellTemperature);
    moisture.push(cellMoisture);
    biome.push(classify(land, cellTemperature, cellMoisture));
  }
  return { schemaVersion: CLIMATE_SCHEMA_VERSION, width: SURFACE_WIDTH, height: SURFACE_HEIGHT, meanTempC, temperatureC, moisture, biome };
}

/**
 * Applies one validated climate operation through the staged state view:
 * `derive` reads terrain's committed `surface` record with `state.get()` and
 * writes the `climate` record, replacing any earlier one.
 *
 * Throws, so nothing is committed, if terrain has not been generated, if its
 * record is malformed or of an unsupported schema version, or if the request is
 * not addressed to the climate module.
 */
export const applyClimateOperation: OperationHandler = (request, state) => {
  if (request.moduleId !== CLIMATE_MODULE) {
    throw new Error(`climate handler received a request for module ${JSON.stringify(request.moduleId)}`);
  }
  if (request.operation !== "derive") throw new Error(`unhandled operation ${JSON.stringify(request.operation)}`);
  const { meanTempC } = request.payload as ClimateDeriveParams;
  const source = state.get(TERRAIN_MODULE, TERRAIN_KEY);
  if (source === undefined) throw new Error("terrain surface has not been generated");
  state.set(CLIMATE_KEY, deriveClimate(parseTerrainRecord(source), meanTempC));
};
