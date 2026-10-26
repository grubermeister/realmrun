import { describe, expect, test } from "bun:test";
import { devDatabase } from "../scripts/reset-dev-db.ts";

describe("devDatabase", () => {
  test.each([
    ["postgresql:///realmrun_dev?host=/tmp", "realmrun_dev", "postgresql:///postgres?host=/tmp"],
    ["postgresql://user:pw@localhost:5432/realmrun_dev", "realmrun_dev", "postgresql://user:pw@localhost:5432/postgres"],
    ["postgres://localhost/realmrun_scratch_2", "realmrun_scratch_2", "postgres://localhost/postgres"],
  ])("accepts %s", (url, name, maintenanceUrl) => {
    expect(devDatabase(url)).toEqual({ name, maintenanceUrl });
  });

  test.each([
    "postgresql:///edgelord?host=/tmp",
    "postgresql:///postgres?host=/tmp",
    "postgresql:///realmrun_?host=/tmp",
    "postgresql:///?host=/tmp",
    "postgresql://localhost/realmrun_dev%22;%20DROP",
    "postgresql://localhost/realmrun-dev",
    "mysql://localhost/realmrun_dev",
  ])("refuses %s", (url) => {
    expect(() => devDatabase(url)).toThrow();
  });
});
