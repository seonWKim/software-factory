import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GuidanceSource, ProjectGuidance } from "../../core/worker-deps.js";
import type { Pack } from "../../packs/packs.js";

/**
 * Rules and learnings for every agent prompt (design 07-self-improvement.md). Each pack layer, in layer order,
 * may hold `rules/*.md` (each file goes into the prompt in full) and a `learnings.md` whose `## ` sections are
 * entries; an entry with a `status: retired` line is left out. Rules come first (every layer's), then learnings.
 * Rules and learnings together are capped at GUIDANCE_MAX characters; text past the cap is dropped and counted
 * in `dropped`. Nothing is cached: each read sees the files as they are now.
 */

/** The cap on rules and learnings text per prompt (fixed). */
export const GUIDANCE_MAX = 8000;
/** The learnings file at a layer's root; the doc index skips every file with this name. */
export const LEARNINGS_FILE = "learnings.md";

const HEADING = "## Rules and learnings";
const INTRO = "Rules and learnings from the factory's packs. Follow them unless the work item says otherwise.";

export class PackGuidance implements GuidanceSource {
  constructor(private readonly packs: readonly Pick<Pack, "layer" | "dir">[]) {}

  async read(): Promise<ProjectGuidance> {
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

    let left = GUIDANCE_MAX;
    let dropped = 0;
    const take = (text: string): string | undefined => {
      const kept = text.slice(0, Math.max(left, 0));
      dropped += text.length - kept.length;
      left -= kept.length;
      return kept === "" ? undefined : kept;
    };
    const parts = [HEADING, INTRO];
    for (const r of rules) {
      const kept = take(r.text);
      if (kept !== undefined) parts.push(`### Rule: \`${r.id}\``, kept);
    }
    const kept = learnings.map(take).filter((t): t is string => t !== undefined);
    if (kept.length > 0) parts.push("### Learnings", ...kept);
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
