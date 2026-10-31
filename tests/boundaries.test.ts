import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Architecture §1: core talks only to interfaces. Core and interfaces may import each other and nothing
// else: no implementations, no vendor packages, no node: I/O. Implementations are picked in src/compose.ts.

const SRC = join(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

describe("layer boundaries", () => {
  for (const layer of ["core", "interfaces"]) {
    it(`${layer}/ imports only core/ and interfaces/`, () => {
      const violations: string[] = [];
      for (const file of files(join(SRC, layer))) {
        for (const spec of imports(file)) {
          const ok = spec.startsWith(".") && /^(core|interfaces)\//.test(relative(SRC, join(file, "..", spec)));
          if (!ok) violations.push(`${relative(SRC, file)} → ${spec}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
