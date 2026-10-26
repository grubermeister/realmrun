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
small, fixed way.** realmrun runs exactly two built-in scenarios, each against
one PostgreSQL database per run:

- the **accumulator fixture** (the default), one numeric module; and
- the **planet scenario**, two modules where one reads the other's committed
  state: a seeded terrain surface and a climate derived from it.

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
database and runtime errors exit with status 1. For the planet scenario, see
[below](#the-planet-scenario).

### Options

Every option takes a value, as `--flag value` or `--flag=value`, and may be
given at most once. Numbers are plain decimal digits: no `+`, leading zeros,
exponents, fractions, or `-0`.

| Option         | Scenarios | Default       | Meaning                                                                 |
|----------------|-----------|---------------|-------------------------------------------------------------------------|
| `--until`      | both      | required      | Simulated milliseconds to advance to: `0` to `9007199254740991`         |
| `--scenario`   | both      | `accumulator` | `accumulator` or `planet`                                               |
| `--seed`       | planet    | `1729`        | Terrain seed: an unsigned 32-bit integer, `0` to `4294967295`           |
| `--sea-level`  | planet    | `0`           | Terrain sea level: an integer from `-100` to `100`; cells above it are land |
| `--mean-temp`  | planet    | `15`          | Climate baseline temperature: an integer from `-40` to `40` (°C)        |

An unknown scenario or option, a duplicated option, a missing value, an
out-of-range or malformed number, or a planet option without
`--scenario planet` exits with status 2 and the usage text.

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
generated`), commits nothing, and stays pending. Neither handler schedules
work; a later `--until` only moves the clock.

realmrun routes each request, after realmlib's registry has validated it, to
the handler of the module it is addressed to: a two-entry map from module ID to
handler in `applyPlanetOperation`. After advancing, it reads both committed
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

## Development

```sh
bun test             # CLI, scenario, renderer, and module tests; PostgreSQL tests are skipped
bun run typecheck    # strict TypeScript check
```

The PostgreSQL tests run both scenarios through realmlib's PostgreSQL operation
runtime and compare them with realmlib's in-memory core path. They are opt-in and
need a separate, **disposable** UTF8 database without a `realmlib` schema; they
apply the migration and drop the schema for each test:

```sh
createdb --encoding=UTF8 --template=template0 realmrun_test
REALMRUN_TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/realmrun_test bun test
```
