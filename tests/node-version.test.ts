import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CI and local runs use one Node major: `.nvmrc` names it and every `node-version:` in the CI workflow must match.
describe("the Node major", () => {
  it(".nvmrc matches every node-version in the CI test workflow", () => {
    const nvmrc = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
    expect(nvmrc).toMatch(/^\d+$/);
    const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
    const versions = [...workflow.matchAll(/^\s*node-version:\s*["']?(\d+)/gm)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v).toBe(nvmrc);
  });
});
