/**
 * The planet scenario: one seeded planetary surface from
 * `lattice-terrain-module` and its climate from `lattice-climate-module`,
 * each written only by its own module's operation through realmlib.
 *
 * The module packages only declare their modules and handle their operations;
 * this file registers both, routes each validated request to its module's
 * handler, and defines the work: terrain's `generate` and then climate's
 * `derive`, both at simulated time 0. Climate reads the terrain record that
 * `generate` committed, so the insertion order matters. Nothing is scheduled
 * by the handlers themselves, and nothing recurs.
 */

import { CLIMATE_KEY, CLIMATE_MODULE, applyClimateOperation, climateModule, parseClimateRecord } from "lattice-climate-module";
import type { ClimateRecord } from "lattice-climate-module";
import { TERRAIN_KEY, TERRAIN_MODULE, applyTerrainOperation, parseTerrainRecord, terrainModule } from "lattice-terrain-module";
import type { TerrainRecord } from "lattice-terrain-module";
import { createModuleRegistry, simTime, workItemId } from "realmlib";
import type { ModuleId, ModuleRegistry, OperationHandler, ScheduledWork, StateValue } from "realmlib";

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
 * The handler the scenario's work is executed with: it passes each request,
 * already validated by the registry, to the handler of the module it is
 * addressed to.
 */
export const applyPlanetOperation: OperationHandler = (request, state) => {
  const handler = HANDLERS.get(request.moduleId);
  if (handler === undefined) throw new Error(`no handler for module ${JSON.stringify(request.moduleId)}`);
  handler(request, state);
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
