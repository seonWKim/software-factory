import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTECTED_PATHS } from "../../src/core/standing.js";
import { REPO } from "./lib.js";

// Every path the gates name must exist: a floors prefix, a hotspot_paths entry or a PROTECTED_PATHS entry that
// names a missing file guards nothing. An entry ending in `/` names a folder; any other names a file.

const config = JSON.parse(readFileSync(join(REPO, "factory.config.json"), "utf8")) as {
  floors?: { prefix: string }[];
  hotspot_paths?: string[];
};

/** The entries that name no file or folder in the repo, each as `<source>: <entry>`. */
function missing(source: string, entries: readonly string[]): string[] {
  return entries
    .filter((entry) => {
      const path = join(REPO, entry);
      if (!existsSync(path)) return true;
      return entry.endsWith("/") ? !statSync(path).isDirectory() : !statSync(path).isFile();
    })
    .map((entry) => `${source}: ${entry}`);
}

describe("config-paths", () => {
  it("every floors prefix, hotspot_paths entry and PROTECTED_PATHS entry names a path that exists", () => {
    const misses = [
      ...missing("factory.config.json floors", (config.floors ?? []).map((f) => f.prefix)),
      ...missing("factory.config.json hotspot_paths", config.hotspot_paths ?? []),
      ...Object.entries(PROTECTED_PATHS).flatMap(([category, paths]) => missing(`PROTECTED_PATHS.${category}`, paths)),
    ];
    expect(misses, `paths that do not exist:\n${misses.join("\n")}`).toEqual([]);
  });
});
