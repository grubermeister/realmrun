# realmrun

A small Bun/TypeScript command-line tool that runs a deterministic test
simulation offline with [`realmlib`](../realmlib). realmlib owns the state,
scheduling, execution, persistence, and driver ownership; realmrun only sets up
a fixture in PostgreSQL, asks realmlib to advance to a simulated time as fast as
it can (no real-time pacing, no game server), and prints the committed result.

This is an alpha development tool. It depends on the adjacent `realmlib`
checkout through `file:../realmlib`, and on three local module packages
through `file:./modules/...`:
[`lattice-accumulator-module`](modules/accumulator),
[`lattice-terrain-module`](modules/terrain), and
[`lattice-climate-module`](modules/climate).

## Intended use

realmrun is the offline laboratory for portable simulation modules: a place to
run simulation experiments on the same `realmlib` core without real-time
pacing. It is separate from the other Lattice processes, neither of which is
part of this repository:

- **`realmlord`**, the planned live world host and coordinator for long-lived,
  independent realms. It has not been written yet.
- **`edgelord`**, the existing player-facing gameplay server.

The longer-term aim is for realmrun to run experiments built from the same
independent modules that `realmlord` will host. **Today it does so only in a
small, fixed way.** realmrun runs exactly three built-in scenarios, each
against one PostgreSQL database per run:

- the **accumulator fixture** (the default), one numeric module;
- the **planet scenario**, two modules where one reads the other's committed
  state: a seeded terrain surface and a climate derived from it; and
- the **evolving planet scenario**, the same two modules, where a later
  terrain change emits the climate work that follows it, with an optional
  JSON export of the planet before and after.

Each module lives in a separate, host-independent package under
[`modules/`](modules), which realmrun imports by name. realmrun has no module
loader or plugin system, no realm configuration, and no multi-realm
orchestration; changing an experiment means editing
[`src/fixture.ts`](src/fixture.ts) or
[`src/planetary-fixture.ts`](src/planetary-fixture.ts).

## Setup

Requirements: Bun, a `realmlib` checkout next to this repository, and an
existing local PostgreSQL 18 server with `psql` and `createdb`/`dropdb`.

```sh
bun install   # also installs the packages in modules/; rerun after changing them

# A separate development database; realmlib requires UTF8. Bun loads .env
# automatically (it is gitignored), so nothing needs exporting.
echo 'DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/realmrun_dev' > .env
# or, as the local superuser over a Unix socket in /tmp:
#   echo 'DATABASE_URL=postgresql:///realmrun_dev?host=/tmp' > .env

# (Re)create it as a new UTF8 database with realmlib's schema applied.
bun run db:reset
```

A `DATABASE_URL` set in the environment takes precedence over `.env`.

`bun run db:reset` drops the database named by `DATABASE_URL`, creates it
again (UTF8, from `template0`), and applies realmlib's migration in one
transaction. **Everything in that database is destroyed.** As a guard, it only
resets databases named `realmrun_` followed by letters, digits, or
underscores, and it fails rather than disconnecting anyone if the database is
in use. The user in `DATABASE_URL` needs permission to create databases.

To do the same by hand:

```sh
dropdb --if-exists realmrun_dev                               # add -h/-U as needed
createdb --encoding=UTF8 --template=template0 realmrun_dev
psql -d realmrun_dev --single-transaction --file node_modules/realmlib/migrations/001_initial_persistence.sql
```

## Usage

The default scenario is the accumulator fixture:

```sh
bun run start --until 12
```

```text
Simulated time: 12 ms
Accumulator: 13
```

`--until` (also `--until=12`) is required: a nonnegative safe integer number of
simulated milliseconds. Malformed values, including `-0`, exit with status 2;
database and runtime errors exit with status 1. For the planet scenarios, see
[below](#the-planet-scenario).

### Options

Every option takes a value, as `--flag value` or `--flag=value`, and may be
given at most once. Numbers are plain decimal digits: no `+`, leading zeros,
exponents, fractions, or `-0`.

| Option               | Scenarios        | Default       | Meaning                                                                 |
|----------------------|------------------|---------------|-------------------------------------------------------------------------|
| `--until`            | all              | required      | Simulated milliseconds to advance to: `0` to `9007199254740991`         |
| `--scenario`         | all              | `accumulator` | `accumulator`, `planet`, or `planet-evolve`                             |
| `--seed`             | both planets     | `1729`        | Terrain seed: an unsigned 32-bit integer, `0` to `4294967295`           |
| `--sea-level`        | both planets     | `0`           | Terrain sea level: an integer from `-100` to `100` (`planet-evolve`: at most `90`); cells above it are land |
| `--mean-temp`        | both planets     | `15`          | Climate baseline temperature: an integer from `-40` to `40` (°C)        |
| `--export-snapshots` | `planet-evolve`  | none          | Write the [snapshot bundle](#snapshot-export-format-version-1) to this path, replacing any existing file |

An unknown scenario or option, a duplicated option, a missing or empty value,
an out-of-range or malformed number, a planet option with the accumulator, or
`--export-snapshots` with any scenario but `planet-evolve` exits with status 2
and the usage text.

Each run needs a **newly initialized** database. If the database already holds
a simulation, realmrun refuses to run rather than overwrite it. To run again,
reset it first:

```sh
bun run db:reset && bun run start --until 12
```

## The fixture

[`src/fixture.ts`](src/fixture.ts) registers one module, `accumulator` from
[`lattice-accumulator-module`](modules/accumulator/README.md), owning a numeric
record `value`, selects its handler, and defines its scheduled work in
insertion order:

| Simulated time (ms) | Operation     | Result |
|--------------------:|---------------|-------:|
| 0                   | Set to 1      | 1      |
| 5                   | Add 2         | 3      |
| 5                   | Multiply by 3 | 9      |
| 12                  | Add 4         | 13     |

realmlib has no API for seeding state directly, so the initial value is written
by the `set` operation at time 0, through the same module-owned execution path
as the rest. No random seed is used. Expected results: `--until 0` → 1, `5` → 9,
`12` → 13, `20` → 13 (clock at the requested time in each case).

## The planet scenario

A deliberately simplified planetary *surface* experiment: a coarse, static
elevation field and a toy climate derived from it, generated once at simulated
time 0. It is not a scientific model, and nothing evolves afterwards.

```sh
bun run db:reset
bun run start --scenario planet --seed 1729 --sea-level 0 --mean-temp 15 --until 0
```

[`src/planetary-fixture.ts`](src/planetary-fixture.ts) registers two modules
in one registry and schedules one operation for each, in this insertion order:

| Order | Work ID                   | Time (ms) | Module    | Operation  | Payload                  |
|------:|---------------------------|----------:|-----------|------------|--------------------------|
| 1     | `planet-terrain-generate` | 0         | `terrain` | `generate` | `{ seed, seaLevel }`     |
| 2     | `planet-climate-derive`   | 0         | `climate` | `derive`   | `{ meanTempC }`          |

- [`lattice-terrain-module`](modules/terrain/README.md) writes its `surface`
  record: 48 × 24 seeded, longitude-wrapped elevations.
- [`lattice-climate-module`](modules/climate/README.md) reads that record
  through realmlib's state view, `state.get("terrain", "surface")`, and writes
  only its own `climate` record: temperature, moisture, and a biome per cell.
  Its payload carries no terrain data.

Both items are due at time 0, and realmlib runs equal times in insertion order,
each in its own transaction, so climate reads terrain's **committed** record.
Scheduled the other way round, climate fails (`terrain surface has not been
generated`), commits nothing, and stays pending. Neither `generate` nor
`derive` emits work; a later `--until` only moves the clock.

realmrun routes each request, after realmlib's registry has validated it, to
the handler of the module it is addressed to: a two-entry map from module ID to
handler in `applyPlanetOperation`, which passes on realmlib's random source and
work emitter unchanged. After advancing, it reads both committed
records back through the runtime (`runtime.read()`), checks them against each
module's record contract, and renders them with
[`src/planetary-map.ts`](src/planetary-map.ts), a pure text renderer with no
database access. The header's seed, sea level, and mean temperature come from
those committed records.

The same inputs always print the same map; another seed gives another planet.
Raising `--sea-level` floods more of the same terrain; lowering
`--mean-temp` spreads ice and tundra. The output of the command above:

```text
Planet: seed 1729, sea level 0, mean temperature 15 C
Grid: 48 x 24 cells, rows north to south, columns wrap east-west
Simulated time: 0 ms

    +------------------------------------------------+
86N |**~~~~~***********************~~~~~~~~~~~~~~~~~*|
79N |***~~~~************************~~~~~~~~~~~~~~~~*|
71N |*******************************~~~~~~~~~~~~~~~~~|
64N |-------**************----****---~~~~~~~~~~~~~~~-|
56N |--------**********----tttt----tt~~~~~~~~~~~~~~t-|
49N |"..-------****------tt~~~~tt"tttt~~~~~~~~~~~~tt"|
41N |........------.....""t~~~~~t"t~t"t~~~~~~~~~~~t""|
34N |....................""~~~~~""~~""""~~~~~~~~~""..|
26N |.....................""~~~~""~~~"""~~~~~~""""...|
19N |....................""t~~~~~~~~~t"t~~~~tt""""...|
11N |".................""tT~~~~~~~~~~~TT~~~Ttt""""...|
 4N |t""...""........""ttTT~~~~~~~~~~~~~~~~TTt"""".""|
 4S |Tt"".""""......""tTTT~~~~~~~~~~~~~~~~~TTt""""""t|
11S |Tt"".""""......""tTT~~~~~~~~~~~~~~~~~~Tt"""""""t|
19S |~t"".""""......""t~~~~~ttt~~~~~~~~~ttt"t"""""""t|
26S |~~"".""""......""~~~~~~"""~~~~~~~~"""""~"""""""~|
34S |~~""""~~"".....""~~~~~~""""""~~~~~""""~~~~~~"""~|
41S |~t""t~~~~t"""""t~~~~~~~t"""""ttt~~ttt~~~~~~~~~~~|
49S |tt"tt~~~~~ttttt~~~~~~~tt"""""ttt~~~~~~~~~~~~~~tt|
56S |----t~~~~~~~~~~~~~~~~t-------tt~~~~~~~~~~~~~t---|
64S |**----~~~~~~~~~~~~~~---****---~~~~~~~~~~~~~~-***|
71S |*******~~~~~~~~~~~~***********~~~~~~~~~~~~~*****|
79S |******~~~~~~~~~~~**************~~~~~~~~~~~******|
86S |******~~~~~~~~~****************~~~~~~~~~~*******|
    +------------------------------------------------+

Surface: ocean 457 cells (39.7%), land 695 cells (60.3%)

  Biome            Cells  Share
~ ocean              457  39.7%
* ice                204  17.7%
- tundra              76   6.6%
. desert             149  12.9%
" grassland          163  14.1%
t forest              85   7.4%
T tropical forest     18   1.6%
```

Rows are labelled with their latitude; columns run around the planet and wrap
at the edges. The map is an equirectangular approximation, so polar rows
exaggerate their area. As with the accumulator, each run needs a newly
initialized database, and a populated one is refused.

## The evolving planet scenario

The same planet, changed **because one module schedules a consequence in
another**. It is a toy causal demonstration, not a sea-level model, and
simulated milliseconds are logical time, not a calendar.

```sh
bun run db:reset
bun run start --scenario planet-evolve --seed 1729 --sea-level 0 \
  --mean-temp 15 --until 2000 --export-snapshots ./planet-evolution.json
```

realmrun schedules three items, in this insertion order:

| Order | Work ID                          | Time (ms) | Module    | Operation         | Payload                       |
|------:|----------------------------------|----------:|-----------|-------------------|-------------------------------|
| 1     | `planet-terrain-generate`        | 0         | `terrain` | `generate`        | `{ seed, seaLevel }`          |
| 2     | `planet-climate-derive`          | 0         | `climate` | `derive`          | `{ meanTempC }`               |
| 3     | `planet-terrain-raise-sea-level` | 1000      | `terrain` | `raise-sea-level` | `{ toSeaLevel: seaLevel + 10 }` |

A fourth item is **not** scheduled by realmrun. Terrain's `raise-sea-level`
rewrites its own `surface` record with the higher sea level and, through the
work emitter realmlib gives its handler, emits climate's `refresh` due at the
same time, under the ID `terrain-climate-refresh-1000-<toSeaLevel>`. realmlib
stores the emitted item in the same commit as the terrain change (or neither),
and runs it later in the same `advanceTo(1000)`, after the rise. `refresh`
reads the new committed terrain and climate's own previous record, keeps that
record's baseline temperature, and rewrites only climate. So a run to
`--until 1000` or later completes:

1. `terrain.generate` at 0
2. `climate.derive` at 0
3. `terrain.raise-sea-level` at 1000
4. `climate.refresh` at 1000, emitted by step 3

Because the rise is 10, `--sea-level` is limited to 90 here; the static
`planet` scenario keeps the full range up to 100.

On its way to `--until`, realmrun stops to read the committed planet at
**checkpoints**: time 0, time 1000 if `--until` reaches it, and `--until`
itself (so `--until 500` gives `0, 500`; `2000` gives `0, 1000, 2000`). Each
read happens only once realmlib reports that every item due by then has
completed, and each keeps its own copies of the records. The console then
shows the map of the **final** state, as for `planet`. For the command above:

```text
Planet: seed 1729, sea level 10, mean temperature 15 C
Grid: 48 x 24 cells, rows north to south, columns wrap east-west
Simulated time: 2000 ms
...
Surface: ocean 644 cells (55.9%), land 508 cells (44.1%)
```

The sample planet goes from 695 land and 457 ocean cells at time 0 to 508
land and 644 ocean cells at 1000, and is unchanged at 2000. Its elevations and
seed never change; its biomes do, since climate follows the new coastline.

### Snapshot export (format version 1)

With `--export-snapshots <path>` (or `--export-snapshots=<path>`), realmrun
also writes the checkpoints as one JSON file, so a viewer can show the stored
planet at each time without running the simulation. The file is written only
after the run and every checkpoint read succeeded; a failed run writes
nothing. **An existing file at that path is overwritten.** It is UTF-8 JSON,
indented by two spaces, with a trailing newline:

```jsonc
{
  "format": "lattice.planet.snapshots",
  "formatVersion": 1,
  "scenario": "planet-evolve",
  "config": { "seed": 1729, "initialSeaLevel": 0, "meanTempC": 15, "seaLevelRise": 10, "seaLevelChangeAtMs": 1000 },
  "grid": { "width": 48, "height": 24, "cellOrder": "row-major", "rows": "north-to-south", "wrapsLongitude": true },
  "snapshots": [
    { "atMs": 0, "terrain": { /* surface record */ }, "climate": { /* climate record */ } },
    { "atMs": 1000, "terrain": { … }, "climate": { … } },
    { "atMs": 2000, "terrain": { … }, "climate": { … } }
  ],
  "events": [
    { "atMs": 1000, "kind": "sea-level-rise", "fromSeaLevel": 0, "toSeaLevel": 10, "consequence": "climate.refresh" }
  ]
}
```

- `format`, `formatVersion`: identify this envelope. `formatVersion` versions
  the envelope only, not the module records inside it, which carry their own
  `schemaVersion`.
- `scenario`: always `planet-evolve`.
- `config`: the run's inputs: terrain `seed`, the sea level before the rise
  (`initialSeaLevel`), climate's baseline `meanTempC` (°C), and the fixed rise
  (`seaLevelRise`, elevation units) and its time (`seaLevelChangeAtMs`).
- `grid`: the raster every array uses. Cell index = `row * width + column`;
  row 0 is the northernmost; columns 0 and 47 are neighbours.
- `snapshots`: one per checkpoint, in ascending `atMs` with no duplicates and
  none past `--until`. `atMs` is realmlib's logical simulation time in
  milliseconds, not wall time. `terrain` and `climate` are the **entire**
  committed records, checked against each module's contract and copied
  unchanged: terrain's [`surface` record](modules/terrain/README.md#the-surface-record-schema-version-1)
  and climate's [`climate` record](modules/climate/README.md#the-climate-record-schema-version-1),
  both at `schemaVersion` 1, each with its own `width`, `height`, and 1152
  cells per array. Nothing is recomputed for display.
- `events`: one `sea-level-rise` entry when the rise and its `climate.refresh`
  both completed, that is, when there is a checkpoint at 1000 (realmrun also
  checks that it shows the higher sea level and a climate whose ocean matches
  it). `fromSeaLevel` and `toSeaLevel` come from the committed terrain at time
  0 and at 1000. A run with `--until` below 1000 has `"events": []`.

To show one layer, pick a snapshot by `atMs` and read one array:

| Layer       | Array                      | Values                                                        |
|-------------|----------------------------|---------------------------------------------------------------|
| Elevation   | `terrain.elevation`        | Abstract units, −100 to 100; land where `elevation > terrain.seaLevel` |
| Temperature | `climate.temperatureC`     | °C, −100 to 100                                               |
| Moisture    | `climate.moisture`         | An index from 0 to 100                                        |
| Biome       | `climate.biome`            | One of `ocean`, `ice`, `tundra`, `desert`, `grassland`, `forest`, `tropical-forest` |

The same options in a freshly reset database produce **byte-identical** files:
key order, snapshot order, and formatting are fixed, and the file holds no
timestamps, paths, random IDs, or connection details.

To inspect an exported file in a browser, use the static, read-only
[planet snapshot viewer](viewer/README.md):

```sh
bun run viewer:build
python3 -m http.server 8000 --directory viewer   # then open http://localhost:8000/
```

## Development

```sh
bun test                  # CLI, scenario, renderer, module, and viewer tests; PostgreSQL tests are skipped
bun run typecheck         # strict TypeScript check
bun run viewer:typecheck  # the viewer's own DOM-enabled check
bun run viewer:build      # bundle the viewer into viewer/dist/
```

The PostgreSQL tests run every scenario through realmlib's PostgreSQL operation
runtime and compare it with realmlib's in-memory core path (for the evolving
planet, the in-memory operation runtime, at every checkpoint), and inspect the
committed `work_items` rows, including the emitted climate refresh. They are opt-in and
need a separate, **disposable** UTF8 database without a `realmlib` schema; they
apply the migration and drop the schema for each test:

```sh
createdb --encoding=UTF8 --template=template0 realmrun_test
REALMRUN_TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/realmrun_test bun test
```
