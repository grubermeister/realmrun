/**
 * The viewer's one input boundary: parses and validates a
 * `lattice.planet.snapshots` file at format version 1, as `realmrun --scenario
 * planet-evolve --export-snapshots` writes it, and nothing else. Pure: it
 * neither fetches nor fills anything in, so a file that fails any check is
 * refused whole and no planet is shown.
 *
 * The record contracts belong to the terrain and climate modules; the browser
 * must not import them (they pull in realmlib), so the handful of constants
 * needed to check them are repeated here, and tests compare them with the
 * modules' own.
 */

export const SNAPSHOT_FORMAT = "lattice.planet.snapshots";
export const SNAPSHOT_FORMAT_VERSION = 1;

/** The raster every v1 array uses: 48 columns wrapping around longitude, 24 rows from north to south. */
export const GRID_WIDTH = 48;
export const GRID_HEIGHT = 24;
export const GRID_CELLS = GRID_WIDTH * GRID_HEIGHT;

export const TERRAIN_SCHEMA_VERSION = 1;
export const CLIMATE_SCHEMA_VERSION = 1;
export const SEED_MAX = 0xffff_ffff;
export const ELEVATION_MIN = -100;
export const ELEVATION_MAX = 100;
export const SEA_LEVEL_MIN = -100;
export const SEA_LEVEL_MAX = 100;
export const MEAN_TEMP_MIN = -40;
export const MEAN_TEMP_MAX = 40;
export const TEMPERATURE_MIN = -100;
export const TEMPERATURE_MAX = 100;
export const MOISTURE_MIN = 0;
export const MOISTURE_MAX = 100;
/** `planet-evolve`'s fixed rise and its time. */
export const SEA_LEVEL_RISE = 10;
export const SEA_LEVEL_CHANGE_AT_MS = 1_000;

/** Every biome, in the climate module's order. */
export const BIOMES = ["ocean", "ice", "tundra", "desert", "grassland", "forest", "tropical-forest"] as const;
export type Biome = (typeof BIOMES)[number];

/** Terrain's `surface` record, schema version 1. */
export type TerrainRecord = {
  readonly schemaVersion: 1;
  readonly width: 48;
  readonly height: 24;
  readonly seed: number;
  /** A cell is land if its elevation is above this, otherwise water. */
  readonly seaLevel: number;
  readonly elevation: readonly number[];
};

/** Climate's `climate` record, schema version 1. */
export type ClimateRecord = {
  readonly schemaVersion: 1;
  readonly width: 48;
  readonly height: 24;
  readonly meanTempC: number;
  readonly temperatureC: readonly number[];
  readonly moisture: readonly number[];
  readonly biome: readonly Biome[];
};

/** Both records as committed at one simulated time. */
export type Snapshot = {
  readonly atMs: number;
  readonly terrain: TerrainRecord;
  readonly climate: ClimateRecord;
};

/** The completed sea-level rise and its emitted climate refresh. */
export type SeaLevelRiseEvent = {
  readonly atMs: number;
  readonly kind: "sea-level-rise";
  readonly fromSeaLevel: number;
  readonly toSeaLevel: number;
  readonly consequence: "climate.refresh";
};

/** A validated format-version-1 bundle. */
export type SnapshotBundle = {
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
    readonly width: typeof GRID_WIDTH;
    readonly height: typeof GRID_HEIGHT;
    readonly cellOrder: "row-major";
    readonly rows: "north-to-south";
    readonly wrapsLongitude: true;
  };
  readonly snapshots: readonly Snapshot[];
  readonly events: readonly SeaLevelRiseEvent[];
};

/** The file is not a bundle this viewer can show; the message says why, naming the first problem found. */
export class SnapshotFormatError extends Error {
  override readonly name = "SnapshotFormatError";
}

/** Whether `terrain`'s cell at row-major `index` is water: at or below the sea level. */
export const isWater = (terrain: TerrainRecord, index: number): boolean => terrain.elevation[index]! <= terrain.seaLevel;

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && !Object.is(value, -0) && (value as number) >= min && (value as number) <= max;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (path: string, problem: string): never => {
  throw new SnapshotFormatError(`${path} ${problem}`);
};

/** `value` at `path` as an object with exactly the own keys `keys`. */
function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) return fail(path, "must be an object");
  const own = Object.keys(value);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail(`${path}.${missing}`, "is missing");
  const extra = own.find((key) => !keys.includes(key));
  if (extra !== undefined) fail(path, `has an unexpected field ${JSON.stringify(extra)}`);
  return value;
}

function expectValue(value: unknown, path: string, expected: unknown): void {
  if (value !== expected) fail(path, `must be ${JSON.stringify(expected)}, found ${JSON.stringify(value) ?? "undefined"}`);
}

function expectInteger(value: unknown, path: string, min: number, max: number): number {
  if (!isIntegerIn(value, min, max)) fail(path, `must be an integer from ${min} to ${max}, found ${JSON.stringify(value) ?? "undefined"}`);
  return value as number;
}

/** `value` at `path` as an array of exactly {@link GRID_CELLS} cells, each passing `valid`. */
function cells(value: unknown, path: string, valid: (cell: unknown) => boolean, what: string): void {
  if (!Array.isArray(value)) return fail(path, `must be an array of ${GRID_CELLS} cells`);
  if (value.length !== GRID_CELLS) fail(path, `must have ${GRID_CELLS} cells, found ${value.length}`);
  // A plain loop, so holes in a sparse array are visited as undefined.
  for (let index = 0; index < GRID_CELLS; index++) {
    if (!valid(value[index])) fail(`${path}[${index}]`, `must be ${what}, found ${JSON.stringify(value[index]) ?? "undefined"}`);
  }
}

function checkTerrain(value: unknown, path: string): TerrainRecord {
  const record = exactObject(value, path, ["schemaVersion", "width", "height", "seed", "seaLevel", "elevation"]);
  expectValue(record.schemaVersion, `${path}.schemaVersion`, TERRAIN_SCHEMA_VERSION);
  expectValue(record.width, `${path}.width`, GRID_WIDTH);
  expectValue(record.height, `${path}.height`, GRID_HEIGHT);
  expectInteger(record.seed, `${path}.seed`, 0, SEED_MAX);
  expectInteger(record.seaLevel, `${path}.seaLevel`, SEA_LEVEL_MIN, SEA_LEVEL_MAX);
  cells(record.elevation, `${path}.elevation`, (cell) => isIntegerIn(cell, ELEVATION_MIN, ELEVATION_MAX), `an integer from ${ELEVATION_MIN} to ${ELEVATION_MAX}`);
  return record as unknown as TerrainRecord;
}

function checkClimate(value: unknown, path: string): ClimateRecord {
  const record = exactObject(value, path, ["schemaVersion", "width", "height", "meanTempC", "temperatureC", "moisture", "biome"]);
  expectValue(record.schemaVersion, `${path}.schemaVersion`, CLIMATE_SCHEMA_VERSION);
  expectValue(record.width, `${path}.width`, GRID_WIDTH);
  expectValue(record.height, `${path}.height`, GRID_HEIGHT);
  expectInteger(record.meanTempC, `${path}.meanTempC`, MEAN_TEMP_MIN, MEAN_TEMP_MAX);
  cells(
    record.temperatureC,
    `${path}.temperatureC`,
    (cell) => isIntegerIn(cell, TEMPERATURE_MIN, TEMPERATURE_MAX),
    `an integer from ${TEMPERATURE_MIN} to ${TEMPERATURE_MAX}`,
  );
  cells(record.moisture, `${path}.moisture`, (cell) => isIntegerIn(cell, MOISTURE_MIN, MOISTURE_MAX), `an integer from ${MOISTURE_MIN} to ${MOISTURE_MAX}`);
  cells(record.biome, `${path}.biome`, (cell) => (BIOMES as readonly unknown[]).includes(cell), `one of ${BIOMES.join(", ")}`);
  return record as unknown as ClimateRecord;
}

function checkEvent(value: unknown, path: string): SeaLevelRiseEvent {
  const event = exactObject(value, path, ["atMs", "kind", "fromSeaLevel", "toSeaLevel", "consequence"]);
  expectValue(event.kind, `${path}.kind`, "sea-level-rise");
  expectInteger(event.atMs, `${path}.atMs`, 0, Number.MAX_SAFE_INTEGER);
  expectInteger(event.fromSeaLevel, `${path}.fromSeaLevel`, SEA_LEVEL_MIN, SEA_LEVEL_MAX);
  expectInteger(event.toSeaLevel, `${path}.toSeaLevel`, SEA_LEVEL_MIN, SEA_LEVEL_MAX);
  expectValue(event.consequence, `${path}.consequence`, "climate.refresh");
  return event as unknown as SeaLevelRiseEvent;
}

/**
 * Checks that `value` is a format-version-1 bundle and returns it typed. Beyond
 * each field's shape and range, it checks what the viewer relies on to draw
 * and label it truthfully:
 *
 * - snapshot times start at 0 and ascend strictly;
 * - every record has the bundle's seed and baseline temperature, and every
 *   climate's `ocean` cells are exactly its terrain's water cells;
 * - the one `sea-level-rise` event is recorded exactly when there is a
 *   checkpoint at its time, as realmrun records it, and its levels are the
 *   configured rise; every checkpoint's sea level is the one the recorded
 *   events imply for its time.
 *
 * @throws {SnapshotFormatError} naming the first problem found.
 */
export function parseSnapshotBundle(value: unknown): SnapshotBundle {
  const bundle = exactObject(value, "file", ["format", "formatVersion", "scenario", "config", "grid", "snapshots", "events"]);
  expectValue(bundle.format, "format", SNAPSHOT_FORMAT);
  expectValue(bundle.formatVersion, "formatVersion", SNAPSHOT_FORMAT_VERSION);
  expectValue(bundle.scenario, "scenario", "planet-evolve");

  const config = exactObject(bundle.config, "config", ["seed", "initialSeaLevel", "meanTempC", "seaLevelRise", "seaLevelChangeAtMs"]);
  const seed = expectInteger(config.seed, "config.seed", 0, SEED_MAX);
  const initialSeaLevel = expectInteger(config.initialSeaLevel, "config.initialSeaLevel", SEA_LEVEL_MIN, SEA_LEVEL_MAX - SEA_LEVEL_RISE);
  const meanTempC = expectInteger(config.meanTempC, "config.meanTempC", MEAN_TEMP_MIN, MEAN_TEMP_MAX);
  expectValue(config.seaLevelRise, "config.seaLevelRise", SEA_LEVEL_RISE);
  expectValue(config.seaLevelChangeAtMs, "config.seaLevelChangeAtMs", SEA_LEVEL_CHANGE_AT_MS);

  const grid = exactObject(bundle.grid, "grid", ["width", "height", "cellOrder", "rows", "wrapsLongitude"]);
  expectValue(grid.width, "grid.width", GRID_WIDTH);
  expectValue(grid.height, "grid.height", GRID_HEIGHT);
  expectValue(grid.cellOrder, "grid.cellOrder", "row-major");
  expectValue(grid.rows, "grid.rows", "north-to-south");
  expectValue(grid.wrapsLongitude, "grid.wrapsLongitude", true);

  if (!Array.isArray(bundle.snapshots) || bundle.snapshots.length === 0) fail("snapshots", "must be a nonempty array");
  const snapshots = (bundle.snapshots as unknown[]).map((entry, index): Snapshot => {
    const path = `snapshots[${index}]`;
    const snapshot = exactObject(entry, path, ["atMs", "terrain", "climate"]);
    const atMs = expectInteger(snapshot.atMs, `${path}.atMs`, 0, Number.MAX_SAFE_INTEGER);
    const terrain = checkTerrain(snapshot.terrain, `${path}.terrain`);
    const climate = checkClimate(snapshot.climate, `${path}.climate`);
    if (terrain.seed !== seed) fail(`${path}.terrain.seed`, `is ${terrain.seed}, but config.seed is ${seed}`);
    if (climate.meanTempC !== meanTempC) fail(`${path}.climate.meanTempC`, `is ${climate.meanTempC}, but config.meanTempC is ${meanTempC}`);
    for (let cell = 0; cell < GRID_CELLS; cell++) {
      if ((climate.biome[cell] === "ocean") !== isWater(terrain, cell)) {
        fail(
          `${path}.climate.biome[${cell}]`,
          `is ${JSON.stringify(climate.biome[cell])}, but terrain elevation ${terrain.elevation[cell]} at sea level ${terrain.seaLevel} makes that cell ${isWater(terrain, cell) ? "water" : "land"}`,
        );
      }
    }
    return { atMs, terrain, climate };
  });
  if (snapshots[0]!.atMs !== 0) fail("snapshots[0].atMs", `must be 0, found ${snapshots[0]!.atMs}`);
  snapshots.forEach((snapshot, index) => {
    if (index > 0 && snapshot.atMs <= snapshots[index - 1]!.atMs) {
      fail(`snapshots[${index}].atMs`, `must be later than the previous checkpoint's ${snapshots[index - 1]!.atMs}, found ${snapshot.atMs}`);
    }
  });

  if (!Array.isArray(bundle.events)) fail("events", "must be an array");
  const events = (bundle.events as unknown[]).map((entry, index) => checkEvent(entry, `events[${index}]`));
  const changeSaved = snapshots.some((snapshot) => snapshot.atMs === SEA_LEVEL_CHANGE_AT_MS);
  if (events.length > 1) fail("events", `must hold at most one sea-level-rise, found ${events.length}`);
  const [event] = events;
  if (event !== undefined) {
    if (event.atMs !== SEA_LEVEL_CHANGE_AT_MS) fail("events[0].atMs", `must be config.seaLevelChangeAtMs, ${SEA_LEVEL_CHANGE_AT_MS}, found ${event.atMs}`);
    if (!changeSaved) fail("events[0].atMs", `refers to ${event.atMs} ms, which is not a saved checkpoint`);
    expectValue(event.fromSeaLevel, "events[0].fromSeaLevel", initialSeaLevel);
    expectValue(event.toSeaLevel, "events[0].toSeaLevel", initialSeaLevel + SEA_LEVEL_RISE);
  } else if (changeSaved) {
    fail("events", `must record the sea-level-rise, since there is a checkpoint at ${SEA_LEVEL_CHANGE_AT_MS} ms`);
  }
  snapshots.forEach((snapshot, index) => {
    const expected = event !== undefined && snapshot.atMs >= event.atMs ? event.toSeaLevel : initialSeaLevel;
    if (snapshot.terrain.seaLevel !== expected) {
      fail(`snapshots[${index}].terrain.seaLevel`, `is ${snapshot.terrain.seaLevel}, but the recorded events give ${expected} at ${snapshot.atMs} ms`);
    }
  });

  return value as SnapshotBundle;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Parses the text of a chosen file. The result is deeply frozen, so nothing
 * the viewer does can change the loaded records.
 *
 * @throws {SnapshotFormatError} if the text is not JSON or not a valid bundle.
 */
export function parseSnapshotFile(text: string): SnapshotBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SnapshotFormatError(`file is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return deepFreeze(parseSnapshotBundle(value));
}
