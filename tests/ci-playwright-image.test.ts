import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The CI `responsive` job runs in Playwright's image, whose browsers are built for one playwright-core version.
// A dependency bump that leaves the tag behind makes playwright-core look for browsers the image does not have.
describe("the responsive job's Playwright image", () => {
  it("names the playwright-core version in package-lock.json", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    const installed = lock.packages["node_modules/playwright-core"]?.version;
    expect(installed).toMatch(/^\d+\.\d+\.\d+$/);
    const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
    const tags = [...workflow.matchAll(/mcr\.microsoft\.com\/playwright:v([^\s"'-]+)-[a-z]+/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toBe(installed);
  });
});
