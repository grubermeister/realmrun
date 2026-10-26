/**
 * `realmrun` entry point: runs the accumulator fixture or the planet scenario
 * offline against `DATABASE_URL` and prints the committed result. Nothing runs
 * unless this is the main module.
 */

import pg from "pg";
import { parseCliArgs, USAGE, UsageError } from "./cli.ts";
import type { CliOptions } from "./cli.ts";
import { renderPlanetMap } from "./planetary-map.ts";
import { runFixture, runPlanet } from "./simulation.ts";

export async function main(args: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`realmrun: ${error.message}\n${USAGE}`);
    return 2;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("realmrun: DATABASE_URL is not set; point it at the realmrun_dev database (see README)");
    return 1;
  }

  const client = new pg.Client({ connectionString });
  // Connection failures surface through the active query; keep the event from crashing the process.
  client.on("error", () => {});
  try {
    await client.connect();
    if (options.planet !== undefined) {
      console.log(renderPlanetMap(await runPlanet(client, options.until, options.planet)));
      return 0;
    }
    const result = await runFixture(client, options.until);
    console.log(`Simulated time: ${result.now} ms`);
    console.log(`Accumulator: ${JSON.stringify(result.accumulator ?? null)}`);
    return 0;
  } catch (error) {
    console.error(`realmrun: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
