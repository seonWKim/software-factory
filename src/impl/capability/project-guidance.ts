import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, errorText } from "../../core/log.js";
import type { GuidanceSource } from "../../core/worker-deps.js";
import type { Pack } from "../../packs/packs.js";

/**
 * Rules and learnings for every agent prompt (design 07-self-improvement.md). Each pack layer, in layer order,
 * may hold `rules/*.md` (each file goes into the prompt in full) and a `learnings.md` whose `## ` sections are
 * entries; an entry with a `status: retired` line is left out. Rules come first (every layer's), then learnings.
 * Rules and learnings together are capped at GUIDANCE_MAX characters: each entry is kept whole or left out, from the
 * first that does not fit on; the section then ends with a line giving the count left out, and a warning is logged.
 * Best effort: a failed read is a warning and gives no section. Nothing is cached: each read sees the files now.
 */

/** The cap on rules and learnings text per prompt (fixed). */
export const GUIDANCE_MAX = 8000;
/** The learnings file at a layer's root; the doc index skips every file with this name. */
export const LEARNINGS_FILE = "learnings.md";

const HEADING = "## Rules and learnings";
const INTRO = "Rules and learnings from the factory's packs. Follow them unless the work item says otherwise.";

export class PackGuidance implements GuidanceSource {
  constructor(private readonly packs: readonly Pick<Pack, "layer" | "dir">[]) {}

  /** The `## Rules and learnings` section; "" when there is nothing to put in it or the read failed. */
  async read(log: Logger): Promise<string> {
    const g = await this.collect().catch((err: unknown) => {
      log.warn("rules and learnings could not be read; none in the prompt", { error: errorText(err) });
      return { text: "", dropped: 0 };
    });
    if (g.dropped > 0) log.warn("rules and learnings over their cap; the rest was dropped", { dropped_entries: g.dropped, cap: GUIDANCE_MAX });
    return g.text;
  }

  /** The section and the count of entries left out at the cap. A read failure other than a missing file rejects. */
  async collect(): Promise<{ text: string; dropped: number }> {
    const rules: { id: string; text: string }[] = [];
    const learnings: string[] = [];
    for (const p of this.packs) {
      const dir = join(p.dir, "rules");
      for (const name of (await listOptional(dir)).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort()) {
        const text = await readOptional(join(dir, name));
        // A base rule is named from the code root, as the doc index names its files; any other layer's by absolute path.
        if (text !== undefined && text.trim() !== "") rules.push({ id: p.layer === "base" ? `rules/${name}` : join(dir, name), text: text.trim() });
      }
      learnings.push(...learningEntries((await readOptional(join(p.dir, LEARNINGS_FILE))) ?? ""));
    }
    if (rules.length === 0 && learnings.length === 0) return { text: "", dropped: 0 };

    // Each entry (a rule file's text or a learning) goes in whole while it fits the characters left under the cap;
    // at the first that does not, it and every later entry are left out, so no entry is ever cut.
    let left = GUIDANCE_MAX;
    let fit = 0;
    for (const text of [...rules.map((r) => r.text), ...learnings]) {
      if (text.length > left) break;
      left -= text.length;
      fit++;
    }
    const dropped = rules.length + learnings.length - fit;
    const parts = [HEADING, INTRO];
    for (const r of rules.slice(0, fit)) parts.push(`### Rule: \`${r.id}\``, r.text);
    const kept = learnings.slice(0, Math.max(fit - rules.length, 0));
    if (kept.length > 0) parts.push("### Learnings", ...kept);
    if (dropped > 0) parts.push(`${dropped} more rule or learning entries were left out because of the ${GUIDANCE_MAX}-character cap.`);
    return { text: parts.join("\n\n"), dropped };
  }
}

/** The `## ` sections of a learnings file (outside code fences) without a `status: retired` line, trimmed. */
export function learningEntries(text: string): string[] {
  const entries: string[][] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) entries.push([]);
    entries.at(-1)?.push(line); // text before the first entry (a title) is not an entry
  }
  return entries
    .filter((lines) => !lines.some((l) => /^\s*status:\s*retired\s*$/i.test(l)))
    .map((lines) => lines.join("\n").trim());
}

const absent = (err: unknown) => ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (absent(err)) return undefined;
    throw err;
  }
}

async function listOptional(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (absent(err)) return [];
    throw err;
  }
}
