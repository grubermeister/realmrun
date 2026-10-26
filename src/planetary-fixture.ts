/**
 * The planet scenarios: one seeded planetary surface from
 * `lattice-terrain-module` and its climate from `lattice-climate-module`,
 * each written only by its own module's operations through realmlib.
 *
 * The module packages only declare their modules and handle their operations;
 * this file registers both, routes each validated request to its module's
 * handler, and defines the work. The static scenario (`planet`) is terrain's
 * `generate` and then climate's `derive`, both at simulated time 0. Climate
 * reads the terrain record that `generate` committed, so the insertion order
 * matters; nothing recurs.
 *
 * The evolving scenario (`planet-evolve`) adds one host-scheduled item:
 * terrain's `raise-sea-level` at {@link SEA_LEVEL_CHANGE_AT_MS}. Its
 * consequence, climate's `refresh`, is not scheduled here: terrain emits it.
 */

import { CLIMATE_KEY, CLIMATE_MODULE, applyClimateOperation, climateModule, parseClimateRecord } from "lattice-climate-module";
import type { ClimateRecord } from "lattice-climate-module";
import {
  SEA_LEVEL_MAX,
  TERRAIN_KEY,
  TERRAIN_MODULE,
  applyTerrainOperation,
  parseTerrainRecord,
  terrainModule,
} from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { createModuleRegistry, simTime, workItemId } from "realmlib";
import type { ModuleId, ModuleRegistry, OperationHandler, ScheduledWork, SimTime, StateValue } from "realmlib";

export { CLIMATE_KEY, CLIMATE_MODULE, TERRAIN_KEY, TERRAIN_MODULE };

/** The scenario's inputs. */
export interface PlanetConfig {
  /** Terrain seed: an unsigned 32-bit integer. */
  readonly seed: number;
  /** Terrain sea level: cells above it are land. */
  readonly seaLevel: number;
  /** Climate baseline temperature, in degrees Celsius. */
  readonly meanTempC: number;
}

/** The documented sample planet, which has both land and ocean. */
export const DEFAULT_PLANET_CONFIG: PlanetConfig = { seed: 1729, seaLevel: 0, meanTempC: 15 };

/** A new registry accepting both modules' operations. */
export function createPlanetRegistry(): ModuleRegistry {
  const registry = createModuleRegistry();
  registry.register(terrainModule);
  registry.register(climateModule);
  return registry;
}

const HANDLERS: ReadonlyMap<ModuleId, OperationHandler> = new Map([
  [TERRAIN_MODULE, applyTerrainOperation],
  [CLIMATE_MODULE, applyClimateOperation],
]);

/**
 * The handler the scenarios' work is executed with: it passes each request,
 * already validated by the registry, to the handler of the module it is
 * addressed to, with the random source and work emitter realmlib supplied.
 */
export const applyPlanetOperation: OperationHandler = (request, state, random, emitter) => {
  const handler = HANDLERS.get(request.moduleId);
  if (handler === undefined) throw new Error(`no handler for module ${JSON.stringify(request.moduleId)}`);
  handler(request, state, random, emitter);
};

/** The terrain `generate` work item for `config`. */
export function terrainWork(config: PlanetConfig): ScheduledWork {
  return {
    id: workItemId("planet-terrain-generate"),
    at: simTime(0),
    request: {
      moduleId: TERRAIN_MODULE,
      operation: "generate",
      payloadVersion: 1,
      payload: { seed: config.seed, seaLevel: config.seaLevel },
    },
  };
}

/** The climate `derive` work item for `config`. */
export function climateWork(config: PlanetConfig): ScheduledWork {
  return {
    id: workItemId("planet-climate-derive"),
    at: simTime(0),
    request: { moduleId: CLIMATE_MODULE, operation: "derive", payloadVersion: 1, payload: { meanTempC: config.meanTempC } },
  };
}

/** The scenario's work, to be scheduled in this order: terrain, then climate, both at time 0. */
export function planetWork(config: PlanetConfig): readonly ScheduledWork[] {
  return [terrainWork(config), climateWork(config)];
}

/** How far `planet-evolve` raises the sea level, in elevation units. */
export const SEA_LEVEL_RISE = 10;

/** When `planet-evolve` raises the sea level, in simulated milliseconds. */
export const SEA_LEVEL_CHANGE_AT_MS = 1_000;

/** The highest starting sea level `planet-evolve` accepts, so the rise stays within terrain's bounds. */
export const EVOLVING_SEA_LEVEL_MAX = SEA_LEVEL_MAX - SEA_LEVEL_RISE;

/** The terrain `raise-sea-level` work item for `config`: {@link SEA_LEVEL_RISE} units at {@link SEA_LEVEL_CHANGE_AT_MS}. */
export function seaLevelRiseWork(config: PlanetConfig): ScheduledWork {
  return {
    id: workItemId("planet-terrain-raise-sea-level"),
    at: simTime(SEA_LEVEL_CHANGE_AT_MS),
    request: {
      moduleId: TERRAIN_MODULE,
      operation: "raise-sea-level",
      payloadVersion: 1,
      payload: { toSeaLevel: config.seaLevel + SEA_LEVEL_RISE },
    },
  };
}

/**
 * The evolving scenario's host-scheduled work, in this order: the static
 * planet's work, then the sea-level rise. Climate's `refresh` is not in it;
 * the rise emits that.
 */
export function evolvingPlanetWork(config: PlanetConfig): readonly ScheduledWork[] {
  return [...planetWork(config), seaLevelRiseWork(config)];
}

/**
 * The simulated times at which the evolving scenario captures the committed
 * planet on its way to `until`, ascending and distinct: always 0,
 * {@link SEA_LEVEL_CHANGE_AT_MS} if `until` reaches it, and `until` itself.
 */
export function planetSnapshotTimes(until: SimTime): readonly SimTime[] {
  const times = [0, ...(until >= SEA_LEVEL_CHANGE_AT_MS ? [SEA_LEVEL_CHANGE_AT_MS] : []), until];
  return [...new Set(times)].map((time) => simTime(time));
}

/** Both modules' committed records. */
export interface PlanetRecords {
  readonly terrain: TerrainRecord;
  readonly climate: ClimateRecord;
}

/**
 * Reads both committed records through `read` and checks them against their
 * modules' contracts.
 *
 * @throws if either record is missing or invalid.
 */
export function readPlanetRecords(read: (owner: ModuleId, key: string) => StateValue | undefined): PlanetRecords {
  const terrain = read(TERRAIN_MODULE, TERRAIN_KEY);
  const climate = read(CLIMATE_MODULE, CLIMATE_KEY);
  if (terrain === undefined) throw new Error("no committed terrain record");
  if (climate === undefined) throw new Error("no committed climate record");
  return { terrain: parseTerrainRecord(terrain), climate: parseClimateRecord(climate) };
}
