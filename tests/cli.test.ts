import { describe, expect, test } from "bun:test";
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
