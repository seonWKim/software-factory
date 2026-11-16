import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { codeOnly, componentOf, countDrift, importsOf, ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 dependency-direction:
// - shared/ imports nothing outside itself (node: built-ins only).
// - A component imports another component only through its index.ts.
// - A router or core loop never imports handlers/ or plugins/; a handler never imports another handler.
// - Vendor words stay out of core paths (routers, the registry, shared).
// - A worker never imports outbound or a forge client.
// Legacy folders (core/, impl/, interfaces/, ...) are checked by tests/boundaries.test.ts until they move.
//
// Count budget per rule (known-violations/dependency-direction.json): a rule's count may only fall, and a rule
// with no budget allows none. A new file that imports legacy code raises the count over the budget and fails,
// whatever the JSON names; raising a budget is a reviewed change to the JSON.

interface Violation {
  rule: string;
  file: string;
  symbol: string;
}

function resolveImport(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return normalize(join(dirname(file), spec)).replace(/\.js$/, ".ts");
}

/** Source files as [src-relative path, text]. */
type Files = Iterable<readonly [string, string]>;

function srcFiles(): Files {
  return sourceFiles().map((f) => [f, read(f)] as const);
}

function violations(files: Files = srcFiles()): Violation[] {
  const out: Violation[] = [];
  for (const [file, text] of files) {
    const own = componentOf(file);
    if (!own) continue;
    for (const spec of importsOf(text)) {
      const target = resolveImport(file, spec);
      if (own === "shared") {
        if (target ? !target.startsWith("shared/") : !spec.startsWith("node:")) out.push({ rule: "shared-imports-only-shared", file, symbol: spec });
        continue;
      }
      if (!target) continue;
      const other = componentOf(target);
      if (other === null) {
        out.push({ rule: "component-imports-legacy", file, symbol: target });
        continue;
      }
      if (other !== own && other !== "shared" && !/^[a-z]+\/index\.ts$/.test(target)) {
        out.push({ rule: "cross-component-not-index", file, symbol: target });
      }
      const isCore = /\/(router|registry|executor|aggregator)\//.test(file) || file.startsWith("shared/");
      if (isCore && /\/(handlers|plugins)\//.test(target)) out.push({ rule: "core-imports-feature", file, symbol: target });
      const handlerDir = /^(.*\/handlers\/[^/]+)\//.exec(file)?.[1];
      const targetHandler = /^(.*\/handlers\/[^/]+)\//.exec(target)?.[1];
      if (handlerDir && targetHandler && handlerDir !== targetHandler) out.push({ rule: "handler-imports-handler", file, symbol: target });
      if (own === "worker" && (other === "outbound" || /forge/.test(target))) out.push({ rule: "worker-imports-outbound", file, symbol: target });
    }
    const isCore = /\/(router|registry|executor|aggregator)\//.test(file) || own === "shared";
    if (isCore && /\b(github|slack|octokit)\b/i.test(codeOnly(text))) out.push({ rule: "vendor-word-in-core", file, symbol: "" });
  }
  return out;
}

/** Distinct violations (rule, file, symbol) per rule: a file importing the same target twice counts once. */
function countsByRule(vs: readonly Violation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of new Set(vs.map((v) => `${v.rule}|${v.file}|${v.symbol}`))) {
    const rule = key.split("|")[0]!;
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

describe("dependency-direction", () => {
  it("no rule's count grows past its budget, and a fall lowers the budget (ratchet)", () => {
    ratchetCounts("dependency-direction", countsByRule(violations()));
  });

  it("shared/ has no exemptions", () => {
    expect(violations().filter((v) => v.rule === "shared-imports-only-shared")).toEqual([]);
  });

  it("a new file importing legacy code goes over the budget, with the JSON unchanged", () => {
    const counts = countsByRule(violations());
    const added = countsByRule(violations([...srcFiles(), ["cli/handlers/new-thing/new-thing.command.ts", 'import { compose } from "../../../compose.js";\n']]));
    expect(added["component-imports-legacy"]).toBe((counts["component-imports-legacy"] ?? 0) + 1);
    expect(countDrift("dependency-direction", added).grew).toEqual([`component-imports-legacy: ${counts["component-imports-legacy"]} → ${added["component-imports-legacy"]}`]);
  });

  it("a count below the budget fails until the JSON is lowered", () => {
    const counts = countsByRule(violations());
    const fewer = { ...counts, "component-imports-legacy": (counts["component-imports-legacy"] ?? 0) - 1 };
    expect(countDrift("dependency-direction", fewer).fell_but_list_not_lowered).toHaveLength(1);
  });

  it("a rule with no budget allows no violation", () => {
    const vs = violations([["worker/x.ts", 'import { send } from "../outbound/index.js";\n']]);
    expect(vs.map((v) => v.rule)).toEqual(["worker-imports-outbound"]);
    expect(countDrift("dependency-direction", countsByRule(vs)).grew).toEqual(["worker-imports-outbound: 0 → 1"]);
  });
});
