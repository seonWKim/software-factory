import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../web/src/i18n/en.js";

const AREA_DIR = join(import.meta.dirname, "..", "web", "src", "i18n", "en");
const KEY_LINE = /^ {2}"([^"]+)":/gm;

/** The keys each area file declares, read from its text: object spread hides a key that two files both set. */
function areaKeys(files: Readonly<Record<string, string>>): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const [file, source] of Object.entries(files)) {
    byFile.set(file, [...source.matchAll(KEY_LINE)].map((m) => m[1] as string));
  }
  return byFile;
}

/** Problems in a set of area files: a key in more than one place, and a prefix (before the first dot) in more than one file. */
function problems(byFile: Map<string, string[]>): string[] {
  const keyFiles = new Map<string, string[]>();
  const prefixFiles = new Map<string, Set<string>>();
  for (const [file, keys] of byFile) {
    for (const key of keys) {
      keyFiles.set(key, [...(keyFiles.get(key) ?? []), file]);
      const prefix = key.split(".")[0] as string;
      prefixFiles.set(prefix, (prefixFiles.get(prefix) ?? new Set()).add(file));
    }
  }
  const out: string[] = [];
  for (const [key, files] of keyFiles) if (files.length > 1) out.push(`key ${key} is in ${files.join(", ")}`);
  for (const [prefix, files] of prefixFiles) {
    if (files.size > 1) out.push(`prefix ${prefix} is in ${[...files].join(", ")}`);
  }
  return out;
}

function realFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(AREA_DIR).filter((n) => n.endsWith(".ts"))) {
    files[name] = readFileSync(join(AREA_DIR, name), "utf8");
  }
  return files;
}

describe("English text area files", () => {
  it("keeps each key once and each prefix in one file", () => {
    expect(problems(areaKeys(realFiles()))).toEqual([]);
  });

  it("joins every area file key into en", () => {
    const all = [...areaKeys(realFiles()).values()].flat();
    expect(all.length).toBeGreaterThan(0);
    expect(Object.keys(en).sort()).toEqual([...new Set(all)].sort());
  });

  it("fails on a planted key in two files", () => {
    const files = realFiles();
    const [first, second] = Object.keys(files) as [string, string];
    files[second] += `\n  "${(areaKeys(files).get(first) as string[])[0]}": "planted",\n`;
    expect(problems(areaKeys(files)).some((p) => p.startsWith("key "))).toBe(true);
  });

  it("fails on a prefix split across files", () => {
    const files = realFiles();
    const [first, second] = Object.keys(files) as [string, string];
    const prefix = (areaKeys(files).get(first) as string[])[0]!.split(".")[0];
    files[second] += `\n  "${prefix}.planted_new_key": "planted",\n`;
    expect(problems(areaKeys(files)).some((p) => p.startsWith("prefix "))).toBe(true);
  });
});
