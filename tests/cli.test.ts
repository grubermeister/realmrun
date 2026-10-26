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
