# lattice-terrain-module

A portable [`realmlib`](../../../realmlib) simulation module: one coarse,
seeded elevation field for a whole planet's surface. It is a private local
package inside realmrun for now, written so it can move to its own repository
without changing what it exports.

This is a deliberately simplified experiment: a low-resolution height field
with contiguous land and ocean, not a geological model. There is no tectonics
or erosion; the only change after generation is a rise in sea level.

## State and operations

The module `terrain` owns one record, `surface`, written only by its two
operations:

| Operation         | Payload (version 1)                   | Effect                                         |
|-------------------|---------------------------------------|------------------------------------------------|
| `generate`        | `{ seed: number, seaLevel: number }`  | `surface` becomes the surface for that input   |
| `raise-sea-level` | `{ toSeaLevel: number }`              | `surface` gets the higher sea level; emits climate's `refresh` |

- `seed`: an unsigned 32-bit integer, `0` to `4294967295`.
- `seaLevel`, `toSeaLevel`: integers from `-100` to `100`.

Any other payload, including extra fields, fractions, and `-0`, is rejected by
the registry as `invalid-payload`. `generate` replaces an existing `surface`
record; a host that wants a planet generated only once must schedule it once.
The handler throws, committing nothing, if it is given a request addressed to
any other module.

### `raise-sea-level`

Reads the committed `surface` record through the state view and writes it
back with `seaLevel` set to `toSeaLevel`, keeping the seed, dimensions, and
elevations exactly. As part of the same operation it **emits** one work item
through the `WorkEmitter` realmlib passes its handler:

```ts
{
  id: climateRefreshWorkId(emitter.now, toSeaLevel), // "terrain-climate-refresh-<now>-<toSeaLevel>"
  at: emitter.now,                                   // due at the same simulated time
  request: CLIMATE_REFRESH_REQUEST,                  // climate, "refresh", payload version 1, {}
}
```

realmlib commits the new surface and stores the emitted item together, or
neither. The ID depends only on the simulated time and the target level,
never on the wall clock or randomness. Terrain does not schedule work itself,
does not run or import climate, and never writes climate's state.

It throws, committing and emitting nothing, if:

- no `surface` record is committed (`terrain surface has not been generated`),
  or it fails `parseTerrainRecord`;
- `toSeaLevel` is not strictly above the committed sea level (`sea level can
  only rise`);
- no work emitter is supplied: it must run for a scheduled work item of a
  realmlib operation runtime (`createInMemoryOperationRuntime()` or
  `loadPostgresOperationRuntime()`), not through `executeInMemoryOperation()`;
- realmlib cannot store the emitted item, for example because different work
  already holds its ID. realmlib then fails the whole operation, which stays
  pending.

**Coupling to climate.** `CLIMATE_REFRESH_REQUEST` spells out the public
address of climate's `refresh` operation: `moduleId("climate")`, operation
`"refresh"`, payload version 1, payload `{}`. It is the only thing terrain
knows about climate. Terrain cannot import it from
[`lattice-climate-module`](../climate/README.md), which already depends on
this package for the record contract, so the address is a protocol-level
constant that both packages must keep in step.

### The `surface` record (schema version 1)

```ts
{
  schemaVersion: 1,
  width: 48,            // columns: longitudes, wrapping at the dateline
  height: 24,           // rows: latitudes, north to south
  seed: 1729,           // from the payload
  seaLevel: 0,          // from the payload
  elevation: number[],  // 1152 integers in [-100, 100], row-major
}
```

- Cell `(row, column)` is `elevation[row * 48 + column]`. Row `r` is centred
  on latitude `90 − 7.5·(r + 0.5)` degrees (86.25 down to −86.25); column 47 is
  adjacent to column 0. This is an equirectangular visual approximation, not
  an equal-area grid.
- A cell is **land** when its elevation is strictly above `seaLevel`, and
  **ocean** otherwise. The elevations do not depend on `seaLevel`, so raising
  it (same seed) never adds land and usually removes some.
- Elevations are abstract units, not metres.
- Every value is plain JSON: integers only, never `-0`.

### Generation

Elevation is the sum of three octaves of value noise: lattices of 4 × 2,
8 × 4, and 16 × 8 cells, with amplitudes 1, ½, and ¼, sampled with
smoothstep-weighted bilinear interpolation and scaled to ±100. Each lattice
wraps east–west, so there is no seam at the dateline. The lattice values come
from a **stateless integer hash local to this package** (Chris Wellons'
`lowbias32` finalizer applied to the seed, octave, and lattice coordinates).
It is not `Math.random()`, not the wall clock, and not realmlib's
`createSeededRandom()`: there is no random stream shared between operations.
Only integer hashing and basic arithmetic are used, so the field does not
depend on engine-specific `Math.sin` or similar functions.

The same seed always gives the same elevations. Documented sample seeds:
`1729` (the realmrun default: 695 land and 457 ocean cells at sea level 0) and
`42` (383 land and 769 ocean cells at sea level 0).

## Exports

Import everything from the package root, `lattice-terrain-module`:

| Export                      | Type                          | What it is                                       |
|-----------------------------|-------------------------------|--------------------------------------------------|
| `terrainModule`             | `ModuleDefinition` (realmlib) | The module ID and its two operations             |
| `applyTerrainOperation`     | `OperationHandler` (realmlib) | The handler for its operations                   |
| `TERRAIN_MODULE`            | `ModuleId` (realmlib)         | `"terrain"`, the owning module                   |
| `TERRAIN_KEY`               | `string`                      | `"surface"`, the key of its record               |
| `TERRAIN_SCHEMA_VERSION`    | `1`                           | The record's schema version                      |
| `TerrainRecord`             | type                          | The record's shape                               |
| `TerrainGenerateParams`     | type                          | The `generate` payload's shape                   |
| `TerrainRaiseSeaLevelParams` | type                         | The `raise-sea-level` payload's shape            |
| `CLIMATE_REFRESH_REQUEST`   | `OperationRequest` (realmlib) | The climate `refresh` request it emits           |
| `climateRefreshWorkId(now, toSeaLevel)` | function          | The ID it emits that request under               |
| `parseTerrainRecord(value)` | function                      | Checks a value against the record contract and returns it typed; throws `TypeError` naming the problem |
| `isLand(record, index)`     | function                      | Whether a cell is above sea level                |
| `rowLatitude(row)`          | function                      | The latitude of a row's centre, in degrees       |
| `SURFACE_WIDTH`, `SURFACE_HEIGHT`, `SURFACE_CELLS` | `number` | 48, 24, 1152                          |
| `ELEVATION_MIN`, `ELEVATION_MAX` | `number`                 | −100, 100                                        |
| `SEA_LEVEL_MIN`, `SEA_LEVEL_MAX` | `number`                 | −100, 100                                        |
| `SEED_MAX`                  | `number`                      | 4294967295                                       |

`parseTerrainRecord`, `isLand`, `rowLatitude`, and the constants are the
**read-only record contract** for other modules that read `surface`, such as
[`lattice-climate-module`](../climate/README.md). They read it through
realmlib's state view; they never write it.

## Using it

The consumer owns registration, scheduling, and dispatch:

```ts
import { applyTerrainOperation, parseTerrainRecord, TERRAIN_KEY, TERRAIN_MODULE, terrainModule } from "lattice-terrain-module";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation } from "realmlib";

const registry = createModuleRegistry();
registry.register(terrainModule);

const store = createInMemoryStateStore();
const request = { moduleId: TERRAIN_MODULE, operation: "generate", payloadVersion: 1, payload: { seed: 1729, seaLevel: 0 } };
executeInMemoryOperation(registry, store, request, applyTerrainOperation);
parseTerrainRecord(store.forModule(TERRAIN_MODULE).get(TERRAIN_MODULE, TERRAIN_KEY)).elevation.length; // 1152
```

With realmlib's operation runtimes (PostgreSQL or in-memory), pass the same
handler to `runtime.execute(registry, request, applyTerrainOperation)` from
the scheduler's `advanceTo()` callback. `raise-sea-level` works only there,
since only they supply the work emitter, and its emitted `refresh` needs the
climate module registered and dispatched too.

Importing the package is inert: it does not register itself, touch any state or
database, schedule work, read the environment, or start anything. It depends
only on `realmlib`'s package root.
