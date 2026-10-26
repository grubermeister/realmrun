/**
 * The terrain simulation module: one coarse, seeded elevation field for a
 * whole planet's surface, owned by the `terrain` module as its `surface`
 * record and written only by its `generate` operation.
 *
 * The surface is a fixed 48 × 24 longitude/latitude raster: rows run from
 * north to south and columns wrap around at the dateline. It is a visual
 * approximation, not an equal-area grid. Elevations are a few octaves of
 * longitude-wrapped value noise, so land and ocean form contiguous regions.
 *
 * This package declares the module, handles its operation, and publishes the
 * read-only contract of its record ({@link parseTerrainRecord}, {@link isLand},
 * {@link rowLatitude}) for other modules that read it. It does not register
 * itself, schedule work, or choose when operations run. Importing it has no
 * side effects.
 */

import { moduleId } from "realmlib";
import type { ModuleDefinition, OperationHandler } from "realmlib";

/** The module's ID, under which it owns its state. */
export const TERRAIN_MODULE = moduleId("terrain");

/** The key of the module's one record, a {@link TerrainRecord}. */
export const TERRAIN_KEY = "surface";

/** The version of the {@link TerrainRecord} shape this package writes and accepts. */
export const TERRAIN_SCHEMA_VERSION = 1;

/** Columns (longitudes) of the surface raster; column 0 is east of column 47. */
export const SURFACE_WIDTH = 48;
/** Rows (latitudes) of the surface raster, from north to south. */
export const SURFACE_HEIGHT = 24;
/** Cells of the surface raster, stored row-major. */
export const SURFACE_CELLS = SURFACE_WIDTH * SURFACE_HEIGHT;

/** Inclusive bounds of every elevation, in abstract units. */
export const ELEVATION_MIN = -100;
export const ELEVATION_MAX = 100;

/** Inclusive bounds of `seaLevel`. */
export const SEA_LEVEL_MIN = -100;
export const SEA_LEVEL_MAX = 100;

/** Largest accepted seed: seeds are unsigned 32-bit integers. */
export const SEED_MAX = 0xffff_ffff;

/**
 * The `terrain` module's `surface` record, at {@link TERRAIN_SCHEMA_VERSION}.
 * (A type alias, not an interface, so it is assignable to realmlib's `StateValue`.)
 */
export type TerrainRecord = {
  readonly schemaVersion: typeof TERRAIN_SCHEMA_VERSION;
  readonly width: typeof SURFACE_WIDTH;
  readonly height: typeof SURFACE_HEIGHT;
  /** The seed the elevations were generated from. */
  readonly seed: number;
  /** A cell is land if its elevation is above this, otherwise ocean. */
  readonly seaLevel: number;
  /** {@link SURFACE_CELLS} integers in [{@link ELEVATION_MIN}, {@link ELEVATION_MAX}], row-major. */
  readonly elevation: readonly number[];
};

/** The payload of `generate`, at payload version 1. */
export interface TerrainGenerateParams {
  /** An unsigned 32-bit integer. */
  readonly seed: number;
  /** An integer in [{@link SEA_LEVEL_MIN}, {@link SEA_LEVEL_MAX}]. */
  readonly seaLevel: number;
}

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && !Object.is(value, -0) && (value as number) >= min && (value as number) <= max;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` is a plain object with exactly the own keys `keys`. */
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

function isGenerateParams(payload: unknown): boolean {
  return (
    isPlainRecord(payload) &&
    hasExactKeys(payload, ["seed", "seaLevel"]) &&
    isIntegerIn(payload.seed, 0, SEED_MAX) &&
    isIntegerIn(payload.seaLevel, SEA_LEVEL_MIN, SEA_LEVEL_MAX)
  );
}

/** The module's one operation, `generate`, at payload version 1 with a {@link TerrainGenerateParams} payload. */
export const terrainModule: ModuleDefinition = {
  id: TERRAIN_MODULE,
  operations: [{ name: "generate", version: 1, validatePayload: isGenerateParams }],
};

/**
 * The latitude of the centre of `row`, in degrees: positive north, from 86.25
 * in row 0 to -86.25 in the last row, in equal 7.5° steps.
 */
export function rowLatitude(row: number): number {
  return 90 - (row + 0.5) * (180 / SURFACE_HEIGHT);
}

/** Whether the cell at row-major `index` of `terrain` is land: its elevation is above sea level. */
export function isLand(terrain: TerrainRecord, index: number): boolean {
  return terrain.elevation[index]! > terrain.seaLevel;
}

/**
 * Checks that `value` is a {@link TerrainRecord} this package can read and
 * returns it typed: a plain object with exactly the record's fields, the
 * supported schema version, the fixed dimensions, and in-range integers.
 *
 * @throws {TypeError} naming the first problem found.
 */
export function parseTerrainRecord(value: unknown): TerrainRecord {
  const fail = (problem: string): never => {
    throw new TypeError(`Invalid terrain record: ${problem}`);
  };
  if (!isPlainRecord(value)) return fail("not an object");
  if (value.schemaVersion !== TERRAIN_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (expected ${TERRAIN_SCHEMA_VERSION})`);
  }
  if (!hasExactKeys(value, ["schemaVersion", "width", "height", "seed", "seaLevel", "elevation"])) {
    fail(`unexpected fields ${JSON.stringify(Object.keys(value))}`);
  }
  if (value.width !== SURFACE_WIDTH || value.height !== SURFACE_HEIGHT) {
    fail(`dimensions ${JSON.stringify(value.width)} x ${JSON.stringify(value.height)} (expected ${SURFACE_WIDTH} x ${SURFACE_HEIGHT})`);
  }
  if (!isIntegerIn(value.seed, 0, SEED_MAX)) fail("seed is not an unsigned 32-bit integer");
  if (!isIntegerIn(value.seaLevel, SEA_LEVEL_MIN, SEA_LEVEL_MAX)) fail("seaLevel is out of range");
  const { elevation } = value;
  if (!Array.isArray(elevation) || elevation.length !== SURFACE_CELLS) fail(`elevation must be an array of ${SURFACE_CELLS} cells`);
  (elevation as unknown[]).forEach((cell, index) => {
    if (!isIntegerIn(cell, ELEVATION_MIN, ELEVATION_MAX)) fail(`elevation[${index}] is not an integer in range`);
  });
  return value as unknown as TerrainRecord;
}

/** One noise layer: a lattice of `columns` points around each latitude (wrapping) by `rows + 1` from pole to pole. */
interface Octave {
  readonly columns: number;
  readonly rows: number;
  readonly amplitude: number;
}

/** Coarse continents first, then finer detail at half the amplitude each time. */
const OCTAVES: readonly Octave[] = [
  { columns: 4, rows: 2, amplitude: 1 },
  { columns: 8, rows: 4, amplitude: 0.5 },
  { columns: 16, rows: 8, amplitude: 0.25 },
];
const TOTAL_AMPLITUDE = OCTAVES.reduce((sum, octave) => sum + octave.amplitude, 0);

/** Chris Wellons' "lowbias32" integer finalizer: a well-mixed, stateless 32-bit hash. */
function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** The value in [-1, 1) at one lattice point of one octave, from the seed alone. */
function latticeValue(seed: number, octave: number, column: number, row: number): number {
  const hash = mix(mix(mix(mix(seed) ^ octave) ^ column) ^ row);
  return (hash / 2 ** 32) * 2 - 1;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Rounds to an integer, never producing -0 (which realmlib state refuses). */
const roundInteger = (x: number): number => Math.round(x) || 0;

/**
 * The elevation field for `seed`, row-major. Each octave samples its lattice
 * with smoothstep-weighted bilinear interpolation; columns wrap, so the
 * dateline has no seam. Only integer hashing and basic arithmetic are used,
 * so the result does not depend on the engine's transcendental functions.
 */
function generateElevation(seed: number): number[] {
  const elevation: number[] = [];
  for (let row = 0; row < SURFACE_HEIGHT; row++) {
    for (let column = 0; column < SURFACE_WIDTH; column++) {
      let sum = 0;
      OCTAVES.forEach((octave, index) => {
        const x = (column / SURFACE_WIDTH) * octave.columns;
        const y = ((row + 0.5) / SURFACE_HEIGHT) * octave.rows;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = (x0 + 1) % octave.columns;
        const tx = smoothstep(x - x0);
        const ty = smoothstep(y - y0);
        const north = latticeValue(seed, index, x0, y0) * (1 - tx) + latticeValue(seed, index, x1, y0) * tx;
        const south = latticeValue(seed, index, x0, y0 + 1) * (1 - tx) + latticeValue(seed, index, x1, y0 + 1) * tx;
        sum += (north * (1 - ty) + south * ty) * octave.amplitude;
      });
      const scaled = roundInteger((sum / TOTAL_AMPLITUDE) * ELEVATION_MAX);
      elevation.push(Math.min(ELEVATION_MAX, Math.max(ELEVATION_MIN, scaled)));
    }
  }
  return elevation;
}

/**
 * Applies one validated terrain operation through the staged state view:
 * `generate` writes the `surface` record for the payload's seed and sea level,
 * replacing any earlier one. Throws if the request is not addressed to the
 * terrain module, so a misrouted request cannot write another module's state.
 */
export const applyTerrainOperation: OperationHandler = (request, state) => {
  if (request.moduleId !== TERRAIN_MODULE) {
    throw new Error(`terrain handler received a request for module ${JSON.stringify(request.moduleId)}`);
  }
  if (request.operation !== "generate") throw new Error(`unhandled operation ${JSON.stringify(request.operation)}`);
  const { seed, seaLevel } = request.payload as TerrainGenerateParams;
  const record: TerrainRecord = {
    schemaVersion: TERRAIN_SCHEMA_VERSION,
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    seed,
    seaLevel,
    elevation: generateElevation(seed),
  };
  state.set(TERRAIN_KEY, record);
};
