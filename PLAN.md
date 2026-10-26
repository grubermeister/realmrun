# `realmrun` — Initial Implementation Brief

**Target:** New standalone Git repository named `realmrun`.

**Product:** A small Bun/TypeScript command-line application that uses the separate `realmlib` library to run a test simulation offline. `realmlib` owns simulation state, scheduling, execution, persistence, and exclusive driver ownership. `realmrun` only configures a fixture, asks the core to advance, and reports the result.

## Objective

Make this command work:

```sh
bun run start --until 12
```

It should initialize a small, deterministic test simulation in PostgreSQL, advance to **12 simulated milliseconds** as fast as the core permits, print the resulting clock and state, and exit. It must not sleep to match real time or connect to the game server.

## Before coding

1. Confirm you are working in the new `realmrun` repository. Inspect the adjacent `realmlib` checkout (`../realmlib`): package name and exports, sample usage, tests, PostgreSQL setup, and the APIs for module registration, state initialization, scheduling, advancement, and driver ownership.
2. Use those **actual public APIs**. Do not assume names or recreate core logic.
3. If a required capability is missing or incompatible, **stop and report the specific gap**. Do not modify `realmlib` or design a replacement interface as part of this ticket.

## Simple development setup

- Bun and TypeScript; standard minimal project files (`package.json`, lockfile, TypeScript config, `.gitignore`, README).
- Depend on the adjacent library checkout with a local Bun dependency (`file:../realmlib`), using its actual package name. This is an alpha development tool; no publishing or release pipeline is needed.
- Use an **existing local PostgreSQL server** with a separate development database named `realmrun_dev`. Read its connection string from `DATABASE_URL`.
- Document how to create that database and apply the **existing** `realmlib` schema using whatever SQL/setup method the library already provides. Do not introduce Docker, a migration framework, or automatic database provisioning.
- Run the fixture against a newly initialized development database. If it is already populated, fail with a useful explanation instead of silently overwriting it. For another run, the developer can manually recreate the database. No `reset` command is needed.

## The test fixture

Keep this in its own small source file, separate from CLI argument handling, so a later experiment can replace it without rewriting the CLI. Do **not** build a plugin system yet.

Use a single module-neutral numeric accumulator, initially **1**, with these scheduled operations in insertion order:

| Simulated time (ms) | Operation | Result |
|---:|---|---:|
| 5 | Add 2 | 3 |
| 5 | Multiply by 3 | 9 |
| 12 | Add 4 | 13 |

All updates must go through `realmlib`'s normal module-owned execution mechanisms. Use a fixed seed only if the core requires one.

## CLI behavior

- Accept one required `--until` argument: a nonnegative safe integer of simulated milliseconds. Reject malformed input, including `-0`, with a clear error and nonzero exit code.
- Open the configured PostgreSQL connection, set up the fixture through `realmlib`, acquire driver ownership using the library's mechanism, advance to the requested time, read back final state, and exit cleanly.
- Print a short result obtained from the **actual core state**, for example:

  ```text
  Simulated time: 12 ms
  Accumulator: 13
  ```

- Release acquired resources on exit. Imports alone must not start a simulation.

## Acceptance checks

Use fresh fixture state for each run:

| `--until` | Final clock | Accumulator |
|---:|---:|---:|
| 0 | 0 | 1 |
| 5 | 5 | 9 |
| 12 | 12 | 13 |
| 20 | 20 | 13 |

Add a small set of tests covering CLI argument validation and fixture ordering/results. Compare the same fixture's final result with an execution through `realmlib`'s existing core test path, using compatible initial state and inputs. Keep tests aligned with the actual APIs discovered during inspection; do not create a second scheduler to calculate results.

The README must include working setup commands and one complete example invocation. Run the available checks and report what passed, what was not run, and any remaining blockers.

## Boundaries and stop condition

Do not add world simulation models, game rules, a web UI, HTTP services, interactive commands, real-time pacing, resume/recovery tooling, fixture catalogs, benchmarking, Docker infrastructure, or integration with `edgelord`/Realm's Edge. Do not change `realmlib` or the game-server repository.

**Stop when** the command works with the fixture, the stated checks pass, and setup is documented. Report the files changed, exact commands tested, and the final example output. Do not begin additional infrastructure or simulation features.
