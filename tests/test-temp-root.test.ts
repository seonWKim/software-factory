import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useRunTempRoot } from "./setup/temp-root.js";

describe("a test run's temp folder", () => {
  it("this run's tmpdir() is the run folder vitest's global setup made", () => {
    expect(tmpdir().split("/").pop()).toMatch(/^sf-test-run-/);
  });

  it("the teardown removes everything tests left in it and restores TMPDIR", () => {
    const base = mkdtempSync(join(tmpdir(), "sf-temp-root-"));
    const env: NodeJS.ProcessEnv = { TMPDIR: base };
    const teardown = useRunTempRoot(env);
    const root = env.TMPDIR!;
    expect(root.startsWith(base)).toBe(true);
    const left = mkdtempSync(join(root, "sf-plugins-"));
    mkdirSync(join(left, "deep"));
    writeFileSync(join(left, "deep", "f.txt"), "x");
    teardown();
    expect(existsSync(root)).toBe(false);
    expect(env.TMPDIR).toBe(base);
  });
});
