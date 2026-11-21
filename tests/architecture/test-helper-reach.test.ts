import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./lib.js";

// RFC 0023 R4: test helpers follow the same boundaries. A fake under tests/helpers/fakes/ fakes one port; only
// tests/helpers/harness.ts wires the controller, the worker or the plugin REGISTRY. The bug this catches: a fake
// that imports the controller, the worker or plugins.ts (or the harness, or a helper that does) pulls the harness
// back in, so every test that imports that fake reaches ~200 source files and test selection selects almost all.
// `import type` doesn't count: types can't change behavior, and the typecheck covers them.

const FAKES = join(REPO, "tests", "helpers", "fakes");
const FORBIDDEN = ["src/runtime/roles/controller-role.ts", "src/worker/index.ts", "src/plugins.ts", "tests/helpers/harness.ts"];

/** The relative specifiers a file imports at runtime: static imports and re-exports that are not `type`, and dynamic imports. */
function runtimeImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
    if (m[2]) continue;
    out.push((m[3] ?? m[4])!);
  }
  return out.filter((s) => s.startsWith("."));
}

/** A relative specifier from `file` as a repo path, or null when it names no file in the repo. */
function resolveSpec(file: string, spec: string): string | null {
  const base = resolve(dirname(file), spec).replace(/\.js$/, "");
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c)) return c;
  return null;
}

/**
 * Each forbidden file a fake module reaches, as `<fake> -> <forbidden>`. It follows runtime imports through other
 * test helpers (a fake that imports a helper that imports the harness still widens), and stops at src/: a src file's
 * own imports are src's boundaries, checked by dependency-direction.
 */
function violations(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(FAKES).filter((f) => /\.tsx?$/.test(f))) {
    const start = join(FAKES, name);
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const file = stack.pop()!;
      for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
        const dep = resolveSpec(file, spec);
        if (!dep || seen.has(dep)) continue;
        seen.add(dep);
        const rel = relative(REPO, dep);
        if (FORBIDDEN.includes(rel)) out.push(`${relative(REPO, start)} -> ${rel}`);
        else if (rel.startsWith("tests/")) stack.push(dep);
      }
    }
  }
  return out.sort();
}

describe("test-helper-reach", () => {
  it("no fake module reaches the controller, the worker, plugins.ts or the harness at runtime", () => {
    expect(violations()).toEqual([]);
  });

  it("the reader counts value imports and dynamic imports, and skips `import type`", () => {
    const text = [
      'import type { Worker } from "../../../src/worker/index.js";',
      'import { REGISTRY, type Registry } from "../../../src/plugins.js";',
      'export { pipeline } from "../harness.js";',
      'const m = await import("../../../src/runtime/roles/controller-role.js");',
      'import { readFileSync } from "node:fs";',
    ].join("\n");
    expect(runtimeImports(text)).toEqual(["../../../src/plugins.js", "../harness.js", "../../../src/runtime/roles/controller-role.js"]);
  });
});
