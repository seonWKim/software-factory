import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../web/src/i18n/en.js";
import { BARREL, readAreas, render } from "../scripts/i18n-catalog.js";

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

describe("the generated catalog barrel", () => {
  it("web/src/i18n/en.ts is what `npm run i18n:catalog` writes", () => {
    expect(readFileSync(BARREL, "utf8")).toBe(render(readAreas()));
  });

  it("imports and spreads every area file once, in file order", () => {
    const areas = readAreas();
    const text = render(areas);
    for (const a of areas) {
      expect(text).toContain(`import { ${a.name} } from "./en/${a.file}.js";`);
      expect(text.split(`  ...${a.name},`).length).toBe(2);
    }
    expect(areas.map((a) => a.file)).toEqual([...areas.map((a) => a.file)].sort());
  });

  it("a barrel that misses an area does not match", () => {
    const areas = readAreas();
    expect(render(areas.slice(1))).not.toBe(readFileSync(BARREL, "utf8"));
  });
});

describe("attach help and confirmation text", () => {
  it("uses the owner's words: no triage, no spec without plan, no triage run in the confirmation", () => {
    const values = Object.entries(en).filter(([key]) => key.startsWith("attach.")).map(([, value]) => String(value));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v.toLowerCase()).not.toContain("triage");
      if (v.toLowerCase().includes("spec")) expect(v.toLowerCase()).toContain("plan");
    }
    expect(en["attach.contextSent"]).not.toContain("triage run");
  });
});
