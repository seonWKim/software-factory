import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { codeOnly, componentOf, importsOf, ratchet, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 dependency-direction:
// - shared/ imports nothing outside itself (node: built-ins only).
// - A component imports another component only through its index.ts.
// - A router or core loop never imports handlers/ or plugins/; a handler never imports another handler.
// - Vendor words stay out of core paths (routers, the registry, shared).
// - A worker never imports outbound or a forge client.
// Legacy folders (core/, impl/, interfaces/, ...) are checked by tests/boundaries.test.ts until they move.

interface Violation {
  rule: string;
  file: string;
  symbol: string;
}

function resolveImport(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return normalize(join(dirname(file), spec)).replace(/\.js$/, ".ts");
}

function violations(): Violation[] {
  const out: Violation[] = [];
  for (const file of sourceFiles()) {
    const own = componentOf(file);
    if (!own) continue;
    const text = read(file);
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

describe("dependency-direction", () => {
  it("no new violations (ratchet)", () => {
    ratchet("dependency-direction", violations().map((v) => `${v.rule}|${v.file}|${v.symbol}`));
  });

  it("shared/ has no exemptions", () => {
    expect(violations().filter((v) => v.rule === "shared-imports-only-shared")).toEqual([]);
  });
});
