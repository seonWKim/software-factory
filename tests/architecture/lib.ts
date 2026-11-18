// Shared helpers of the architecture tests (RFC 0015 §9): a source walk, an import reader, and the ratchet.
//
// Ratchet: today's code breaks most rules. Each test compares what it finds with
// tests/architecture/known-violations/<test>.json and fails on a new violation, and also on a listed one that
// is gone, so the lists only shrink. Two forms: a list of named violations (`ratchet`), or a count budget per key
// (`ratchetCounts`), which a new violation exceeds whatever the JSON names. A rule with no violations left is a
// hard rule: its test expects none and reads no list. `SF_RATCHET_UPDATE=1 npm test -- tests/architecture`
// rewrites the lists: use it only to shrink them, and say so in the commit. `SF_RATCHET_SHRINK=1` (the implement
// run's pre-push checks, design 04-pre-push-gates) only lowers them: a fallen count is set to the real count (its key
// removed at 0), a name no longer found is removed. It never raises a value or adds a key, so growth still fails.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect } from "vitest";

export const REPO = join(import.meta.dirname, "..", "..");
export const SRC = join(REPO, "src");
const KNOWN = join(import.meta.dirname, "known-violations");

/** Where the lists live and the env that picks the mode; tests pass their own. */
export interface RatchetOptions { dir?: string; env?: Readonly<Record<string, string | undefined>> }

function listFile(test: string, o: RatchetOptions): { file: string; update: boolean; shrink: boolean } {
  const env = o.env ?? process.env;
  return { file: join(o.dir ?? KNOWN, `${test}.json`), update: env.SF_RATCHET_UPDATE === "1", shrink: env.SF_RATCHET_SHRINK === "1" };
}

function readList<T>(file: string, empty: T): T {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : empty;
}

function writeList(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

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

/** Fails on violations not in the known list, and on listed ones that are fixed (shrink mode: removes those). */
export function ratchet(test: string, found: readonly string[], o: RatchetOptions = {}): void {
  const { file, update, shrink } = listFile(test, o);
  const current = [...new Set(found)].sort();
  if (update) return writeList(file, current);
  let known: string[] = readList(file, []);
  if (shrink && known.some((v) => !current.includes(v))) writeList(file, (known = known.filter((v) => current.includes(v))));
  const added = current.filter((v) => !known.includes(v));
  const fixed = known.filter((v) => !current.includes(v));
  expect({ new_violations: added, fixed_but_still_listed: fixed }).toEqual({ new_violations: [], fixed_but_still_listed: [] });
}

/**
 * Budget form: a count per key may only fall. A fall must be written back (the list shrinks with the code); shrink
 * mode writes it back itself, lowering only the keys that fell (removed at 0), so a growth still fails.
 */
export function ratchetCounts(test: string, found: Readonly<Record<string, number>>, o: RatchetOptions = {}): void {
  const { file, update, shrink } = listFile(test, o);
  const current = positiveCounts(found);
  if (update) return writeList(file, current);
  if (shrink) {
    const known: Record<string, number> = readList(file, {});
    const lowered = Object.fromEntries(Object.entries(known).map(([k, n]) => [k, Math.min(n, current[k] ?? 0)] as const).filter(([, n]) => n > 0));
    if (JSON.stringify(lowered) !== JSON.stringify(known)) writeList(file, lowered);
  }
  expect(countDrift(test, current, o)).toEqual({ grew: [], fell_but_list_not_lowered: [] });
}

/**
 * How `found` differs from the budgets in known-violations/<test>.json: keys over their budget (a key with no
 * budget has 0), and budgets the count fell below. Both must be empty for the ratchet to pass.
 */
export function countDrift(test: string, found: Readonly<Record<string, number>>, o: RatchetOptions = {}): { grew: string[]; fell_but_list_not_lowered: string[] } {
  const known: Record<string, number> = readList(listFile(test, o).file, {});
  const current = positiveCounts(found);
  const grew = Object.entries(current).filter(([k, n]) => n > (known[k] ?? 0)).map(([k, n]) => `${k}: ${known[k] ?? 0} → ${n}`);
  const fell = Object.entries(known).filter(([k, n]) => (current[k] ?? 0) < n).map(([k, n]) => `${k}: ${n} → ${current[k] ?? 0}`);
  return { grew, fell_but_list_not_lowered: fell };
}

function positiveCounts(found: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(found).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));
}
