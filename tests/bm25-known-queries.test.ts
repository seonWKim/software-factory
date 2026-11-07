import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bm25CapabilitySearch } from "../src/impl/capability/bm25-capability-search.js";

/** The repo root: the real docs/ tree the checked-in `bm25` default indexes, not a fixture. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Queries an agent's task text could contain, and the topic file each must rank first. */
const KNOWN: [query: string, expected: string][] = [
  ["keep awake caffeinate lid sleep", "docs/plugins/keep-awake.md"],
  ["egress scanner secret patterns", "docs/plugins/egress-scanner.md"],
  ["self-improvement additive learnings improver", "docs/design/07-self-improvement.md"],
];

describe("bm25 over the real docs/ tree: known queries", () => {
  const search = new Bm25CapabilitySearch(REPO_ROOT);

  for (const [query, expected] of KNOWN) {
    it(`"${query}" ranks ${expected} first`, async () => {
      const [first] = await search.search(query, 8);
      expect(first?.id).toBe(expected);
    });
  }
});
