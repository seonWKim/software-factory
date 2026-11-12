// Shared helpers of the architecture tests (RFC 0015 §9): a source walk, an import reader, and the ratchet.
//
// Ratchet: today's code breaks most rules. Each test compares what it finds with
// tests/architecture/known-violations/<test>.json and fails on a new violation, and also on a listed one that
// is gone, so the lists only shrink. `SF_RATCHET_UPDATE=1 npm test -- tests/architecture` rewrites the lists:
// use it only to shrink them, and say so in the commit.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect } from "vitest";

export const REPO = join(import.meta.dirname, "..", "..");
export const SRC = join(REPO, "src");
const KNOWN = join(import.meta.dirname, "known-violations");
const UPDATE = process.env.SF_RATCHET_UPDATE === "1";

/**
 * The components of the target layout (RFC 0015 §6.1) that exist so far. Folders under src/ not listed here
 * are legacy. `ui` joins when src/ui/ is rebuilt as a component (today's src/ui/ is legacy).
 */
export const COMPONENTS = ["shared", "bus", "state", "runtime", "identity", "inbound", "controller", "worker", "outbound", "guards", "cli", "calendar"] as const;

/** Table prefixes and the component that owns each (RFC 0015 §6.3). `legacy_` is kept until contract. */
export const TABLE_PREFIXES: Readonly<Record<string, string>> = {
  bus_: "bus",
  inbound_: "inbound",
  controller_: "controller",
  worker_: "worker",
  outbound_: "outbound",
  identity_: "identity",
  authz_: "identity",
  runtime_: "runtime",
  ui_: "ui",
  ext_: "extension",
  calendar_: "calendar",
  legacy_: "runtime",
};

/** Every .ts/.tsx file under `dir`, as paths relative to src/. */
export function sourceFiles(dir: string = SRC): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [relative(SRC, path)] : [];
  });
}

export function read(srcPath: string): string {
  return readFileSync(join(SRC, srcPath), "utf8");
}

/** The import specifiers of a file (static imports and re-exports). */
export function importsOf(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)[^"';]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

/** The component a src/ path belongs to, or null for legacy folders. */
export function componentOf(srcPath: string): string | null {
  const top = srcPath.split("/")[0]!;
  return (COMPONENTS as readonly string[]).includes(top) ? top : null;
}

/** Text with comments and string contents blanked, so word rules match code only. Keeps line numbers. */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Fails on violations not in the known list, and on listed ones that are fixed. */
export function ratchet(test: string, found: readonly string[]): void {
  const file = join(KNOWN, `${test}.json`);
  const current = [...new Set(found)].sort();
  if (UPDATE) {
    writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
    return;
  }
  const known: string[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const added = current.filter((v) => !known.includes(v));
  const fixed = known.filter((v) => !current.includes(v));
  expect({ new_violations: added, fixed_but_still_listed: fixed }).toEqual({ new_violations: [], fixed_but_still_listed: [] });
}

/** Budget form: a count per key may only fall. A fall must be written back (the list shrinks with the code). */
export function ratchetCounts(test: string, found: Readonly<Record<string, number>>): void {
  const file = join(KNOWN, `${test}.json`);
  const current = Object.fromEntries(Object.entries(found).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));
  if (UPDATE) {
    writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
    return;
  }
  const known: Record<string, number> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const grew = Object.entries(current).filter(([k, n]) => n > (known[k] ?? 0)).map(([k, n]) => `${k}: ${known[k] ?? 0} → ${n}`);
  const fell = Object.entries(known).filter(([k, n]) => (current[k] ?? 0) < n).map(([k, n]) => `${k}: ${n} → ${current[k] ?? 0}`);
  expect({ grew, fell_but_list_not_lowered: fell }).toEqual({ grew: [], fell_but_list_not_lowered: [] });
}
