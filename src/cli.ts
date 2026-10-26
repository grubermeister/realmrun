/** Command-line argument handling for `realmrun`. */

import { simTime } from "realmlib";
import type { SimTime } from "realmlib";

export const USAGE = "Usage: bun run start --until <simulated-ms>";

/** The arguments were malformed; the message says why. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface CliOptions {
  /** Simulated milliseconds to advance to. */
  readonly until: SimTime;
}

/** Plain decimal digits without a sign or leading zeros, so `-0`, `+5`, `1e3`, and `05` are refused. */
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

function parseUntil(text: string): SimTime {
  const value = Number(text);
  if (!NONNEGATIVE_INTEGER.test(text) || !Number.isSafeInteger(value)) {
    throw new UsageError(
      `--until must be a nonnegative safe integer of simulated milliseconds (0 to ${Number.MAX_SAFE_INTEGER}), received ${JSON.stringify(text)}`,
    );
  }
  return simTime(value);
}

/** Parses `args` (without the runtime and script paths): exactly one `--until <n>` or `--until=<n>`. */
export function parseCliArgs(args: readonly string[]): CliOptions {
  let until: SimTime | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--until") {
      value = args[++i];
      if (value === undefined) throw new UsageError("--until requires a value");
    } else if (arg.startsWith("--until=")) {
      value = arg.slice("--until=".length);
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
    if (until !== undefined) throw new UsageError("--until may be given only once");
    until = parseUntil(value);
  }
  if (until === undefined) throw new UsageError("--until is required");
  return { until };
}
