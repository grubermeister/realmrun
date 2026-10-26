import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs, UsageError } from "../src/cli.ts";

const mainPath = join(import.meta.dir, "..", "src", "main.ts");

describe("parseCliArgs", () => {
  test.each([
    [["--until", "0"], 0],
    [["--until", "12"], 12],
    [["--until=20"], 20],
    [["--until", String(Number.MAX_SAFE_INTEGER)], Number.MAX_SAFE_INTEGER],
  ])("accepts %j", (args, until) => {
    expect(parseCliArgs(args)).toEqual({ until: until as never });
  });

  test.each([
    [[]],
    [["--until"]],
    [["--until="]],
    [["--until", "-0"]],
    [["--until", "-1"]],
    [["--until", "+5"]],
    [["--until", "05"]],
    [["--until", "1.5"]],
    [["--until", "1e3"]],
    [["--until", "0x10"]],
    [["--until", " 5"]],
    [["--until", "abc"]],
    [["--until", String(Number.MAX_SAFE_INTEGER + 1)]],
    [["--until", "5", "--until", "6"]],
    [["--until", "5", "extra"]],
    [["--untill", "5"]],
    [["12"]],
  ])("rejects %j", (args) => {
    expect(() => parseCliArgs(args)).toThrow(UsageError);
  });
});

describe("realmrun process", () => {
  test("malformed --until exits nonzero with a clear error, before any database use", async () => {
    const child = Bun.spawn(["bun", mainPath, "--until", "-0"], {
      env: { ...process.env, DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--until must be a nonnegative safe integer");
    expect(stderr).toContain("Usage:");
  });

  test("a missing DATABASE_URL exits nonzero", async () => {
    const child = Bun.spawn(["bun", mainPath, "--until", "12"], {
      env: { ...process.env, DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, child.stderr.text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("DATABASE_URL is not set");
  });

  test("importing the entry point does not run it", async () => {
    const module = await import("../src/main.ts");
    expect(typeof module.main).toBe("function");
  });
});

describe("parseCliArgs with --scenario", () => {
  const planet = (until: number, seed = 1729, seaLevel = 0, meanTempC = 15) => ({
    until: until as never,
    planet: { seed, seaLevel, meanTempC },
  });

  test.each([
    [["--scenario", "accumulator", "--until", "12"], { until: 12 as never }],
    [["--until=12", "--scenario=accumulator"], { until: 12 as never }],
    [["--scenario", "planet", "--until", "0"], planet(0)],
    [["--scenario", "planet", "--seed", "1729", "--sea-level", "0", "--mean-temp", "15", "--until", "0"], planet(0)],
    [["--until=7", "--mean-temp=-40", "--sea-level=100", "--seed=0", "--scenario=planet"], planet(7, 0, 100, -40)],
    [["--scenario", "planet", "--seed", "4294967295", "--sea-level", "-100", "--mean-temp", "40", "--until", "5"], planet(5, 4294967295, -100, 40)],
    [["--scenario", "planet", "--sea-level", "-7", "--until", "0"], planet(0, 1729, -7)],
  ])("accepts %j", (args, expected) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  test.each([
    [["--scenario", "planets", "--until", "0"], "unknown scenario"],
    [["--scenario", "", "--until", "0"], "unknown scenario"],
    [["--scenario", "planet"], "--until is required"],
    [["--scenario", "planet", "--until", "0", "--scenario", "planet"], "only once"],
    [["--scenario", "planet", "--until", "0", "--seed", "1", "--seed=2"], "only once"],
    [["--scenario", "planet", "--until", "0", "--seed"], "--seed requires a value"],
    [["--scenario"], "--scenario requires a value"],
    [["--until", "0", "--seed", "1729"], "only accepted with --scenario planet"],
    [["--scenario", "accumulator", "--until", "0", "--mean-temp", "15"], "only accepted with --scenario planet"],
    [["--scenario", "planet", "--until", "0", "--seed", "-1"], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--seed", "-0"], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--seed", "4294967296"], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--seed", "0x10"], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--seed", "017"], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--seed", "1e3"], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--seed="], "--seed must be"],
    [["--scenario", "planet", "--until", "0", "--sea-level", "-0"], "--sea-level must be"],
    [["--scenario", "planet", "--until", "0", "--sea-level", "+5"], "--sea-level must be"],
    [["--scenario", "planet", "--until", "0", "--sea-level", "101"], "--sea-level must be"],
    [["--scenario", "planet", "--until", "0", "--sea-level", "-101"], "--sea-level must be"],
    [["--scenario", "planet", "--until", "0", "--sea-level", "1.5"], "--sea-level must be"],
    [["--scenario", "planet", "--until", "0", "--mean-temp", "41"], "--mean-temp must be"],
    [["--scenario", "planet", "--until", "0", "--mean-temp", "-41"], "--mean-temp must be"],
    [["--scenario", "planet", "--until", "0", "--mean-temp", "-0"], "--mean-temp must be"],
    [["--scenario", "planet", "--until", "0", "--mean-temp", "15C"], "--mean-temp must be"],
    [["--scenario", "planet", "--until", "-0"], "--until must be"],
    [["--scenario", "planet", "--until", "0", "--seeds", "1"], "unexpected argument"],
    [["--scenario", "planet", "--until", "0", "planet"], "unexpected argument"],
  ])("rejects %j", (args, message) => {
    expect(() => parseCliArgs(args)).toThrow(UsageError);
    expect(() => parseCliArgs(args)).toThrow(message);
  });
});

describe("parseCliArgs with --scenario planet-evolve", () => {
  const evolve = (until: number, evolveOptions = {}, seed = 1729, seaLevel = 0, meanTempC = 15) => ({
    until: until as never,
    planet: { seed, seaLevel, meanTempC },
    evolve: evolveOptions,
  });

  test.each([
    [["--scenario", "planet-evolve", "--until", "2000"], evolve(2000)],
    [
      ["--scenario", "planet-evolve", "--seed", "1729", "--sea-level", "0", "--mean-temp", "15", "--until", "2000", "--export-snapshots", "./planet-evolution.json"],
      evolve(2000, { exportSnapshots: "./planet-evolution.json" }),
    ],
    [["--export-snapshots=out.json", "--scenario=planet-evolve", "--until=0"], evolve(0, { exportSnapshots: "out.json" })],
    [["--scenario", "planet-evolve", "--sea-level", "90", "--until", "0"], evolve(0, {}, 1729, 90)],
    [["--scenario", "planet-evolve", "--sea-level", "-100", "--mean-temp", "-40", "--until", "0"], evolve(0, {}, 1729, -100, -40)],
  ])("accepts %j", (args, expected) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  test("the static planet keeps its full sea-level range and takes no evolve options", () => {
    expect(parseCliArgs(["--scenario", "planet", "--sea-level", "100", "--until", "0"])).toEqual({
      until: 0 as never,
      planet: { seed: 1729, seaLevel: 100, meanTempC: 15 },
    });
    expect(parseCliArgs(["--scenario", "planet", "--until", "0"])).not.toHaveProperty("evolve");
  });

  test.each([
    [["--scenario", "planet-evolve", "--sea-level", "91", "--until", "0"], "--sea-level must be at most 90 with --scenario planet-evolve"],
    [["--scenario", "planet-evolve", "--sea-level", "100", "--until", "0"], "--sea-level must be at most 90"],
    [["--scenario", "planet-evolve", "--sea-level", "101", "--until", "0"], "--sea-level must be a decimal integer from -100 to 100"],
    [["--scenario", "planet-evolve", "--until", "0", "--export-snapshots"], "--export-snapshots requires a value"],
    [["--scenario", "planet-evolve", "--until", "0", "--export-snapshots="], "--export-snapshots requires a nonempty path"],
    [["--scenario", "planet-evolve", "--until", "0", "--export-snapshots", "a", "--export-snapshots", "b"], "only once"],
    [["--scenario", "planet", "--until", "0", "--export-snapshots", "out.json"], "only accepted with --scenario planet-evolve"],
    [["--until", "0", "--export-snapshots", "out.json"], "only accepted with --scenario planet-evolve"],
    [["--scenario", "planet-evolve"], "--until is required"],
    [["--scenario", "planet-evolve", "--until", "-0"], "--until must be"],
    [["--scenario", "planet_evolve", "--until", "0"], "unknown scenario"],
  ])("rejects %j", (args, message) => {
    expect(() => parseCliArgs(args)).toThrow(UsageError);
    expect(() => parseCliArgs(args)).toThrow(message);
  });
});

describe("realmrun process with --scenario planet-evolve", () => {
  test.each([
    [["--scenario", "planet-evolve", "--sea-level", "95", "--export-snapshots", "x.json", "--until", "2000"], "--sea-level must be at most 90"],
    [["--scenario", "planet", "--export-snapshots", "x.json", "--until", "0"], "only accepted with --scenario planet-evolve"],
  ])("%j exits with status 2 and usage, before any database use, writing no file", async (args, message) => {
    const dir = await mkdtemp(join(tmpdir(), "realmrun-cli-"));
    try {
      const child = Bun.spawn(["bun", mainPath, ...args], {
        cwd: dir,
        env: { ...process.env, DATABASE_URL: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(message);
      expect(stderr).toContain("--scenario planet-evolve");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreachable database exits with status 1 and writes no export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realmrun-cli-"));
    try {
      const child = Bun.spawn(["bun", mainPath, "--scenario", "planet-evolve", "--until", "2000", "--export-snapshots", "out.json"], {
        cwd: dir,
        env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none?connect_timeout=2" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toStartWith("realmrun: ");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("realmrun process with --scenario planet", () => {
  test.each([
    [["--scenario", "moon", "--until", "0"], "unknown scenario"],
    [["--scenario", "planet", "--seed", "-0", "--until", "0"], "--seed must be"],
    [["--until", "0", "--sea-level", "3"], "only accepted with --scenario planet"],
  ])("%j exits with status 2 and usage, before any database use", async (args, message) => {
    const child = Bun.spawn(["bun", mainPath, ...args], {
      env: { ...process.env, DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(message);
    expect(stderr).toContain("--scenario planet");
  });

  test("a missing DATABASE_URL exits with status 1", async () => {
    const child = Bun.spawn(["bun", mainPath, "--scenario", "planet", "--until", "0"], {
      env: { ...process.env, DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, child.stderr.text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("DATABASE_URL is not set");
  });

  test("an unreachable database exits with status 1", async () => {
    const child = Bun.spawn(["bun", mainPath, "--scenario", "planet", "--until", "0"], {
      env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none?connect_timeout=2" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("realmrun: ");
  });
});
