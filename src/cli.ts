/** Command-line argument handling for `realmrun`. */

import { MEAN_TEMP_MAX, MEAN_TEMP_MIN } from "lattice-climate-module";
import { SEA_LEVEL_MAX, SEA_LEVEL_MIN, SEED_MAX } from "lattice-terrain-module";
import { simTime } from "realmlib";
import type { SimTime } from "realmlib";
import { DEFAULT_PLANET_CONFIG, EVOLVING_SEA_LEVEL_MAX, SEA_LEVEL_RISE } from "./planetary-fixture.ts";
import type { PlanetConfig } from "./planetary-fixture.ts";

export const USAGE = [
  "Usage: bun run start --until <simulated-ms>",
  "       bun run start --scenario planet [--seed <n>] [--sea-level <n>] [--mean-temp <celsius>] --until <simulated-ms>",
  "       bun run start --scenario planet-evolve [--seed <n>] [--sea-level <n>] [--mean-temp <celsius>]",
  "                     [--export-snapshots <path>] --until <simulated-ms>",
].join("\n");

/** The arguments were malformed; the message says why. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The options only `--scenario planet-evolve` takes. */
export interface EvolveOptions {
  /** Where to write the snapshot bundle, if anywhere. */
  readonly exportSnapshots?: string;
}

export interface CliOptions {
  /** Simulated milliseconds to advance to. */
  readonly until: SimTime;
  /** Present only for `--scenario planet` and `planet-evolve`; otherwise the accumulator fixture runs. */
  readonly planet?: PlanetConfig;
  /** Present only for `--scenario planet-evolve`, together with `planet`. */
  readonly evolve?: EvolveOptions;
}

/** Plain decimal digits without a sign or leading zeros, so `-0`, `+5`, `1e3`, and `05` are refused. */
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;
/** The same, optionally negative, still refusing `-0`. */
const INTEGER = /^(0|-?[1-9][0-9]*)$/;

function parseUntil(text: string): SimTime {
  const value = Number(text);
  if (!NONNEGATIVE_INTEGER.test(text) || !Number.isSafeInteger(value)) {
    throw new UsageError(
      `--until must be a nonnegative safe integer of simulated milliseconds (0 to ${Number.MAX_SAFE_INTEGER}), received ${JSON.stringify(text)}`,
    );
  }
  return simTime(value);
}

function parseBounded(flag: string, text: string, pattern: RegExp, min: number, max: number, what: string): number {
  const value = Number(text);
  if (!pattern.test(text) || value < min || value > max) {
    throw new UsageError(`${flag} must be ${what} from ${min} to ${max}, received ${JSON.stringify(text)}`);
  }
  return value;
}

const FLAGS = ["--until", "--scenario", "--seed", "--sea-level", "--mean-temp", "--export-snapshots"] as const;
type Flag = (typeof FLAGS)[number];
const PLANET_FLAGS: readonly Flag[] = ["--seed", "--sea-level", "--mean-temp"];
const SCENARIOS = ["accumulator", "planet", "planet-evolve"] as const;

/**
 * Parses `args` (without the runtime and script paths). Each flag is given at
 * most once, as `--flag <value>` or `--flag=<value>`; `--until` is required.
 * `--scenario` is `accumulator` (the default), `planet`, or `planet-evolve`;
 * `--seed`, `--sea-level`, and `--mean-temp` are accepted only with the two
 * planet scenarios, and default to {@link DEFAULT_PLANET_CONFIG}.
 * `planet-evolve` limits `--sea-level` to {@link EVOLVING_SEA_LEVEL_MAX} and
 * alone accepts `--export-snapshots`, a nonempty path.
 */
export function parseCliArgs(args: readonly string[]): CliOptions {
  const values = new Map<Flag, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag === undefined) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    let value: string | undefined;
    if (arg === flag) {
      value = args[++i];
      if (value === undefined) throw new UsageError(`${flag} requires a value`);
    } else {
      value = arg.slice(flag.length + 1);
    }
    if (values.has(flag)) throw new UsageError(`${flag} may be given only once`);
    values.set(flag, value);
  }

  const scenario = values.get("--scenario") ?? "accumulator";
  if (!(SCENARIOS as readonly string[]).includes(scenario)) {
    throw new UsageError(`unknown scenario ${JSON.stringify(scenario)}; expected "accumulator", "planet", or "planet-evolve"`);
  }
  const untilText = values.get("--until");
  if (untilText === undefined) throw new UsageError("--until is required");
  const until = parseUntil(untilText);

  const exportSnapshots = values.get("--export-snapshots");
  if (exportSnapshots !== undefined && scenario !== "planet-evolve") {
    throw new UsageError("--export-snapshots is only accepted with --scenario planet-evolve");
  }
  if (exportSnapshots === "") throw new UsageError("--export-snapshots requires a nonempty path");

  if (scenario === "accumulator") {
    const stray = PLANET_FLAGS.find((flag) => values.has(flag));
    if (stray !== undefined) throw new UsageError(`${stray} is only accepted with --scenario planet or planet-evolve`);
    return { until };
  }

  const option = (flag: Flag, fallback: number, parse: (text: string) => number): number => {
    const text = values.get(flag);
    return text === undefined ? fallback : parse(text);
  };
  const planet: PlanetConfig = {
    seed: option("--seed", DEFAULT_PLANET_CONFIG.seed, (text) =>
      parseBounded("--seed", text, NONNEGATIVE_INTEGER, 0, SEED_MAX, "an unsigned 32-bit decimal integer"),
    ),
    seaLevel: option("--sea-level", DEFAULT_PLANET_CONFIG.seaLevel, (text) =>
      parseBounded("--sea-level", text, INTEGER, SEA_LEVEL_MIN, SEA_LEVEL_MAX, "a decimal integer"),
    ),
    meanTempC: option("--mean-temp", DEFAULT_PLANET_CONFIG.meanTempC, (text) =>
      parseBounded("--mean-temp", text, INTEGER, MEAN_TEMP_MIN, MEAN_TEMP_MAX, "a decimal integer of degrees Celsius"),
    ),
  };
  if (scenario === "planet") return { until, planet };

  if (planet.seaLevel > EVOLVING_SEA_LEVEL_MAX) {
    throw new UsageError(
      `--sea-level must be at most ${EVOLVING_SEA_LEVEL_MAX} with --scenario planet-evolve, so the ${SEA_LEVEL_RISE}-unit ` +
        `rise stays within the maximum of ${SEA_LEVEL_MAX}, received ${JSON.stringify(values.get("--sea-level"))}`,
    );
  }
  return { until, planet, evolve: exportSnapshots === undefined ? {} : { exportSnapshots } };
}
