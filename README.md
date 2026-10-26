# realmrun

A small Bun/TypeScript command-line tool that runs a deterministic test
simulation offline with [`realmlib`](../realmlib). realmlib owns the state,
scheduling, execution, persistence, and driver ownership; realmrun only sets up
a fixture in PostgreSQL, asks realmlib to advance to a simulated time as fast as
it can (no real-time pacing, no game server), and prints the committed result.

This is an alpha development tool. It depends on the adjacent `realmlib`
checkout through `file:../realmlib`.

## Intended use

realmrun is the offline laboratory for portable simulation modules: a place to
run simulation experiments on the same `realmlib` core without real-time
pacing. It is separate from the other Lattice processes, neither of which is
part of this repository:

- **`realmlord`**, the planned live world host and coordinator for long-lived,
  independent realms. It has not been written yet.
- **`edgelord`**, the existing player-facing gameplay server.

The longer-term aim is for realmrun to run experiments built from the same
independent modules that `realmlord` will host, including several modules
together. **Today it does not.** realmrun runs exactly one built-in fixture
(the numeric accumulator described below) against one PostgreSQL database per
run. It has no module loader or plugin system, no realm configuration, and no
multi-realm orchestration; changing the experiment means editing
[`src/fixture.ts`](src/fixture.ts).

## Setup

Requirements: Bun, a `realmlib` checkout next to this repository, and an
existing local PostgreSQL 18 server with `psql` and `createdb`/`dropdb`.

```sh
bun install

# A separate development database; realmlib requires UTF8.
export DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/realmrun_dev
# or, as the local superuser over a Unix socket in /tmp:
#   export DATABASE_URL='postgresql:///realmrun_dev?host=/tmp'   (and pass -h /tmp below)
createdb --encoding=UTF8 --template=template0 realmrun_dev   # add -h/-U as needed

# Apply realmlib's existing schema in one transaction.
psql "$DATABASE_URL" --single-transaction --file node_modules/realmlib/migrations/001_initial_persistence.sql
```

## Usage

```sh
bun run start --until 12
```

```text
Simulated time: 12 ms
Accumulator: 13
```

`--until` (also `--until=12`) is required: a nonnegative safe integer number of
simulated milliseconds. Malformed values, including `-0`, exit with status 2;
database and runtime errors exit with status 1.

Each run needs a **newly initialized** database. If the database already holds
a simulation, realmrun refuses to run rather than overwrite it. To run again,
recreate the database and reapply the schema:

```sh
dropdb realmrun_dev
createdb --encoding=UTF8 --template=template0 realmrun_dev
psql "$DATABASE_URL" --single-transaction --file node_modules/realmlib/migrations/001_initial_persistence.sql
```

## The fixture

[`src/fixture.ts`](src/fixture.ts) defines one module, `accumulator`, owning a
numeric record `value`, and its scheduled work in insertion order:

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

## Development

```sh
bun test             # CLI validation and fixture tests; PostgreSQL tests are skipped
bun run typecheck    # strict TypeScript check
```

The PostgreSQL tests run the fixture through realmlib's PostgreSQL operation
runtime and compare it with realmlib's in-memory core path. They are opt-in and
need a separate, **disposable** UTF8 database without a `realmlib` schema; they
apply the migration and drop the schema for each test:

```sh
createdb --encoding=UTF8 --template=template0 realmrun_test
REALMRUN_TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/realmrun_test bun test
```
