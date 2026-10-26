# lattice-climate-module

A portable [`realmlib`](../../../realmlib) simulation module: a toy climatology
derived from the terrain module's committed surface. It is a private local
package inside realmrun for now, written so it can move to its own repository
without changing what it exports.

It exists to test one module reading another's durable state, and following
it when it changes. Its rules are
simple and **explicitly approximate**: there are no seasons, winds, ocean
currents, or atmosphere, and the numbers are not a forecast of anything real.

## Dependency on terrain

This package depends on
[`lattice-terrain-module`](../terrain/README.md) **only for its public,
read-only record contract**: `TERRAIN_MODULE`, `TERRAIN_KEY`,
`parseTerrainRecord`, `isLand`, `rowLatitude`, and the grid constants. It does
not import terrain's handler or generator, never regenerates elevations, and
never writes terrain's namespace. It depends on no host.

## State and operations

The module `climate` owns one record, `climate`, written only by its two
operations:

| Operation | Payload (version 1)       | Effect                                              |
|-----------|---------------------------|-----------------------------------------------------|
| `derive`  | `{ meanTempC: number }`   | `climate` becomes the climate of terrain's `surface` |
| `refresh` | `{}`                      | The same, keeping the baseline of the committed `climate` record |

- `meanTempC`: an integer from `-40` to `40`, in degrees Celsius.

Any other payload, including extra fields (such as a copied elevation array),
fractions, and `-0`, is rejected as `invalid-payload`; `refresh` accepts only
an empty object.

`derive` reads terrain's record with `state.get("terrain", "surface")` on the
staged view realmlib passes to the handler, so it sees only what terrain has
**committed**. It throws, and realmlib commits nothing, if:

- terrain has not been generated (`terrain surface has not been generated`);
- the record fails `parseTerrainRecord` (missing fields, an unsupported
  `schemaVersion`, other dimensions, or out-of-range cells), so corrupt input
  is never treated as a blank world;
- the request is addressed to any module other than `climate`.

`derive` replaces an existing `climate` record.

`refresh` recomputes the climate with the same rules from terrain's current
committed `surface` and the `meanTempC` of climate's own committed record, so
climate can follow a terrain change without being told the baseline again. It
is what terrain's `raise-sea-level` emits, at the address terrain spells out as
`CLIMATE_REFRESH_REQUEST`; climate itself never schedules or emits work, so it
cannot trigger itself. In addition to the failures of `derive`, it throws,
committing nothing, if no `climate` record is committed (`climate has not been
derived`) or that record fails `parseClimateRecord`.

### The `climate` record (schema version 1)

```ts
{
  schemaVersion: 1,
  width: 48,
  height: 24,
  meanTempC: 15,           // from derive's payload; refresh keeps it
  temperatureC: number[],  // 1152 integers in [-100, 100]
  moisture: number[],      // 1152 integers in [0, 100]
  biome: string[],         // 1152 values from BIOMES
}
```

Arrays are row-major over terrain's raster. Every value is plain JSON:
integers and strings, never `-0`.

### Rules

For a cell at latitude φ (degrees) with terrain elevation `e`:

- **Temperature.** Sea-level temperature is `meanTempC + 11 − 60·(φ/90)²`, so
  `meanTempC` is roughly the area-weighted average of that profile. Land cells
  lose `0.3 °C` per elevation unit above sea level. The result is rounded and
  clamped to [−100, 100].
- **Moisture.** Ocean is 100. Land is `75 − 12·d + 20·b`, rounded and clamped
  to [0, 100], where `d` is the number of steps to the nearest ocean cell (four
  neighbours, wrapping east–west, counted up to 8) and `b` is a crude
  latitude band: 1 at the equator and at 60°, −1 at 30° and the poles, linear
  in between.
- **Biome**, the first rule that matches:

  | Biome             | Rule (land only, except ocean)     |
  |-------------------|------------------------------------|
  | `ocean`           | not land                           |
  | `ice`             | temperature < −10                  |
  | `tundra`          | temperature < 0                    |
  | `desert`          | moisture < 25                      |
  | `tropical-forest` | temperature ≥ 20 and moisture ≥ 60 |
  | `forest`          | moisture ≥ 50                      |
  | `grassland`       | otherwise                          |

  `ocean` is exactly the cells terrain reports as not land; frozen ocean stays
  `ocean`.

Only basic arithmetic is used, so results do not depend on the engine's
transcendental functions.

## Exports

Import everything from the package root, `lattice-climate-module`:

| Export                      | Type                          | What it is                                   |
|-----------------------------|-------------------------------|----------------------------------------------|
| `climateModule`             | `ModuleDefinition` (realmlib) | The module ID and its two operations         |
| `applyClimateOperation`     | `OperationHandler` (realmlib) | The handler for its operations               |
| `CLIMATE_MODULE`            | `ModuleId` (realmlib)         | `"climate"`, the owning module               |
| `CLIMATE_KEY`               | `string`                      | `"climate"`, the key of its record           |
| `CLIMATE_SCHEMA_VERSION`    | `1`                           | The record's schema version                  |
| `ClimateRecord`             | type                          | The record's shape                           |
| `ClimateDeriveParams`       | type                          | The `derive` payload's shape                 |
| `BIOMES`, `Biome`           | array, type                   | The biome vocabulary, in a fixed order       |
| `parseClimateRecord(value)` | function                      | Checks a value against the record contract and returns it typed; throws `TypeError` |
| `MEAN_TEMP_MIN`, `MEAN_TEMP_MAX` | `number`                 | −40, 40                                      |
| `TEMPERATURE_MIN`, `TEMPERATURE_MAX` | `number`             | −100, 100                                    |
| `MOISTURE_MIN`, `MOISTURE_MAX` | `number`                   | 0, 100                                       |

## Using it

Register both modules, then run terrain's `generate` before climate's `derive`.
They are separate operations, so climate reads terrain only after terrain's
operation has committed:

```ts
import { applyClimateOperation, CLIMATE_KEY, CLIMATE_MODULE, climateModule } from "lattice-climate-module";
import { applyTerrainOperation, TERRAIN_MODULE, terrainModule } from "lattice-terrain-module";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation } from "realmlib";

const registry = createModuleRegistry();
registry.register(terrainModule);
registry.register(climateModule);
const store = createInMemoryStateStore();

executeInMemoryOperation(registry, store,
  { moduleId: TERRAIN_MODULE, operation: "generate", payloadVersion: 1, payload: { seed: 1729, seaLevel: 0 } },
  applyTerrainOperation);
executeInMemoryOperation(registry, store,
  { moduleId: CLIMATE_MODULE, operation: "derive", payloadVersion: 1, payload: { meanTempC: 15 } },
  applyClimateOperation);
store.forModule(CLIMATE_MODULE).get(CLIMATE_MODULE, CLIMATE_KEY); // the climate record
```

Importing the package is inert: it does not register itself, touch any state or
database, schedule work, read the environment, or start anything.
