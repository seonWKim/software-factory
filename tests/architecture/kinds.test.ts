import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { type Unit, unitOf } from "../../src/shared/kinds.js";
import { countDrift, ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0023 R1, "dependencies point down", over the kinds in src/shared/kinds.ts. Runtime imports only: a type
// import cannot change behaviour, and the full typecheck covers it.
// - kernel imports only kernel;
// - an adapter or a feature imports only kernel (and a feature its own engine);
// - an engine never imports a feature or the composition root.
// Each broken rule is counted per (rule, file, target) in known-violations/kinds.json: counts may only fall.

type Files = Iterable<readonly [string, string]>;

const srcFiles = (): Files => sourceFiles().map((f) => [`src/${f}`, read(f)] as const);

function runtimeImports(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^"';]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

function resolve(file: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(file), spec)).replace(/\.js$/, "");
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => known.has(c)) ?? null;
}

/** The R1 rule an import from `me` to `to` breaks, or null. */
function brokenRule(me: Unit, to: Unit): string | null {
  if (to.name === me.name || to.kind === "kernel") return null;
  if (me.kind === "kernel") return `kernel→${to.kind}`;
  if (me.kind === "adapter") return `adapter→${to.kind}`;
  if (me.kind === "feature") return to.kind === "engine" && me.name.startsWith(`${to.name}/`) ? null : `feature→${to.kind}`;
  if (me.kind === "engine" && (to.kind === "feature" || to.kind === "root")) return `engine→${to.kind}`;
  return null;
}

function counts(files: Files): Record<string, number> {
  const all = [...files];
  const known = new Set(all.map(([f]) => f));
  const seen = new Set<string>();
  const out: Record<string, number> = {};
  for (const [file, text] of all) {
    const me = unitOf(file);
    if (!me) continue;
    for (const spec of runtimeImports(text)) {
      const target = resolve(file, spec, known);
      const to = target ? unitOf(target) : null;
      const rule = to ? brokenRule(me, to) : null;
      if (!rule || seen.has(`${rule}|${file}|${target}`)) continue;
      seen.add(`${rule}|${file}|${target}`);
      out[rule] = (out[rule] ?? 0) + 1;
    }
  }
  return out;
}

describe("kinds (RFC 0023 R1)", () => {
  it("every source file has a unit", () => {
    expect(sourceFiles().filter((f) => unitOf(`src/${f}`) === null)).toEqual([]);
  });

  it("no rule's count grows past its budget, and a fall lowers the budget (ratchet)", () => {
    ratchetCounts("kinds", counts(srcFiles()));
  });

  it("an adapter importing a feature, or an engine importing a feature, is counted", () => {
    const files: Files = [
      ["src/impl/x/x.ts", 'import { run } from "../../worker/runs/implement/implement.run.js";\n'],
      ["src/worker/runs/implement/implement.run.ts", "export const run = 1;\n"],
      ["src/worker/pool.ts", 'import { run } from "./runs/implement/implement.run.js";\nimport type { T } from "./runs/implement/implement.run.js";\n'],
    ];
    expect(counts(files)).toEqual({ "adapter→feature": 1, "engine→feature": 1 });
  });

  it("a new import that breaks R1 goes over the budget with the JSON unchanged", () => {
    const now = counts(srcFiles());
    const added = counts([...srcFiles(), ["src/impl/new-thing/new-thing.ts", 'import { build } from "../../compose.js";\n']]);
    expect(countDrift("kinds", added).grew).toEqual([`adapter→root: ${now["adapter→root"] ?? 0} → ${(now["adapter→root"] ?? 0) + 1}`]);
  });
});
