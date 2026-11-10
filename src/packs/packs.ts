// Packs (design 11-packs.md): layered folders of prompts, skills and plugins, so a user customizes the factory
// without editing engine files. Layers, in the default order: base (the code root's prompts/ and skills/), org (a
// folder set at `packs.org`), project (`.factory/` in the configured repo's main checkout) and learned (`learned/`
// under the state dir, read-only: nothing here writes to it). A missing layer folder or file is off, never an error.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Capability } from "../interfaces/capability-search.js";
import { skillCapability } from "../impl/capability/bm25-capability-search.js";
import { findDescriptorFiles } from "../state/index.js";

export const PACK_LAYERS = ["base", "org", "project", "learned"] as const;
export type PackLayer = (typeof PACK_LAYERS)[number];

/** The project pack's folder in the configured repo's main checkout. */
export const PROJECT_PACK_DIR = ".factory";
/** The learned pack's folder under the state dir. */
export const LEARNED_PACK_DIR = "learned";

/** One layer that is on: its folder holds `prompts/`, `skills/` and `plugins/`, each optional. */
export interface Pack {
  layer: PackLayer;
  dir: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The value problems of the `packs` key (its unknown keys are checked with the others in src/config-keys.ts).
 * `order` lists every layer once, base first and learned last; `org` is a non-empty path.
 */
export function packsProblems(raw: unknown): string[] {
  if (!isRecord(raw) || raw.packs === undefined) return [];
  const packs = raw.packs;
  if (!isRecord(packs)) return ["packs must be an object with `order` (a list of layers) and `org` (a path)"];
  const problems: string[] = [];
  if (packs.org !== undefined && (typeof packs.org !== "string" || packs.org.trim() === "")) {
    problems.push("packs.org must be a non-empty path to the org pack folder");
  }
  if (packs.order === undefined) return problems;
  const layers = PACK_LAYERS.join(", ");
  if (!Array.isArray(packs.order)) return [...problems, `packs.order must be a list of layers: ${layers}`];
  const order = packs.order as unknown[];
  for (const v of order) {
    if (typeof v !== "string" || !(PACK_LAYERS as readonly string[]).includes(v)) problems.push(`packs.order has an unknown layer ${JSON.stringify(v)}; layers: ${layers}`);
  }
  for (const layer of PACK_LAYERS) {
    const n = order.filter((v) => v === layer).length;
    if (n === 0) problems.push(`packs.order leaves out the layer "${layer}"; list every layer once: ${layers}`);
    if (n > 1) problems.push(`packs.order lists the layer "${layer}" ${n} times; list every layer once`);
  }
  if (order.length > 0 && order[0] !== "base") problems.push('packs.order must start with "base"');
  if (order.length > 0 && order[order.length - 1] !== "learned") problems.push('packs.order must end with "learned"');
  return problems;
}

/** The checked layer order (packsProblems ran at load); absent: base, org, project, learned. */
export function packOrder(packs: unknown): readonly PackLayer[] {
  const order = isRecord(packs) ? packs.order : undefined;
  return Array.isArray(order) ? (order as PackLayer[]) : PACK_LAYERS;
}

/**
 * The main checkout of the repo at `repoPath`: a git worktree's `.git` is a file naming its git dir, whose
 * `commondir` leads to the main checkout's `.git`. Anything else (a main checkout, no git) is `repoPath` itself.
 */
export function mainCheckout(repoPath: string): string {
  const dotGit = join(repoPath, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return repoPath;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!gitdir) return repoPath;
    const own = resolve(repoPath, gitdir);
    const common = resolve(own, readFileSync(join(own, "commondir"), "utf8").trim());
    return basename(common) === ".git" ? dirname(common) : repoPath;
  } catch {
    return repoPath;
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The layers that are on, in `packs.order`. Base is always on. Org is on when `packs.org` names a folder
 * (resolved from `configDir`); project when the repo's main checkout has `.factory/`; learned when the state
 * dir has `learned/`.
 */
export function findPacks(o: { codeRoot: string; repoPath: string; stateDir: string; configDir: string; packs: unknown }): Pack[] {
  const org = isRecord(o.packs) && typeof o.packs.org === "string" ? resolve(o.configDir, o.packs.org) : null;
  const dirs: Record<PackLayer, string | null> = {
    base: o.codeRoot,
    org,
    project: join(mainCheckout(o.repoPath), PROJECT_PACK_DIR),
    learned: join(o.stateDir, LEARNED_PACK_DIR),
  };
  return packOrder(o.packs).flatMap((layer) => {
    const dir = dirs[layer];
    return dir !== null && (layer === "base" || isDir(dir)) ? [{ layer, dir }] : [];
  });
}

interface Chunk {
  /** The `## ` heading's text; null for the text before the first heading. */
  heading: string | null;
  text: string;
}

/** The text cut at each `## ` heading outside a code fence. Joining the chunks' text with "\n" gives `text` back. */
function sections(text: string): Chunk[] {
  const chunks: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^## (.+)$/.exec(line);
    if (m) chunks.push({ heading: m[1]!.trim(), lines: [] });
    chunks[chunks.length - 1]!.lines.push(line);
  }
  return chunks.map((c) => ({ heading: c.heading, text: c.lines.join("\n") }));
}

const trailing = (text: string): string => /\s*$/.exec(text)![0];

/**
 * `base` with each `## ` section of `overlay` merged in: a section whose heading matches a base section replaces
 * it, one that matches none is added at the end, every other base section keeps its text. The overlay's text
 * before its first `## ` heading is not used.
 */
export function mergeSections(base: string, overlay: string): string {
  const chunks = sections(base);
  const added: string[] = [];
  for (const o of sections(overlay)) {
    if (o.heading === null) continue;
    const i = chunks.findIndex((c) => c.heading === o.heading);
    if (i < 0) added.push(o.text.trimEnd());
    else chunks[i] = { heading: o.heading, text: o.text.trimEnd() + trailing(chunks[i]!.text) };
  }
  const merged = chunks.map((c) => c.text).join("\n");
  return added.length === 0 ? merged : `${[merged.trimEnd(), ...added].join("\n\n")}${trailing(base) || "\n"}`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The prompt `name` through every layer, in order: the first layer that has `prompts/<name>.md` gives the
 * text, each later one merges its sections in (mergeSections). No layer has it: undefined.
 */
export async function packPrompt(packs: readonly Pack[], name: string): Promise<string | undefined> {
  let text: string | undefined;
  for (const p of packs) {
    const own = await readOptional(join(p.dir, "prompts", `${name}.md`));
    if (own !== undefined) text = text === undefined ? own : mergeSections(text, own);
  }
  return text;
}

/** The `skills/` folder of every layer but base (the code root's skills/ is indexed from the code root). */
export function packSkillDirs(packs: readonly Pack[]): string[] {
  return packs.filter((p) => p.layer !== "base").map((p) => join(p.dir, "skills")).filter(isDir);
}

/**
 * Every layer's skills (`skills/<name>.md`), as capabilities of kind `skill`, in layer order. A base skill's ID is
 * `skills/<name>.md` (from the code root, as the BM25 search names it); any other layer's is its absolute path.
 */
export function packSkills(packs: readonly Pack[]): Capability[] {
  const base = packs.find((p) => p.layer === "base");
  const dirs = [...(base && isDir(join(base.dir, "skills")) ? [{ dir: join(base.dir, "skills"), base: true }] : []), ...packSkillDirs(packs).map((dir) => ({ dir, base: false }))];
  return dirs.flatMap(({ dir, base }) =>
    readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort()
      .map((f) => skillCapability(base ? `skills/${f}` : join(dir, f), readFileSync(join(dir, f), "utf8"))),
  );
}

/**
 * The plugin descriptor files (`plugins/**\/*.plugin.js`) of every layer, in layer order. On a shared store a
 * project pack's plugin fails startup, naming the file: only reviewed layers (base, org) may add code there.
 */
export function packPluginFiles(packs: readonly Pack[], opts: { sharedStore: boolean }): string[] {
  const files: string[] = [];
  for (const p of packs) {
    const dir = join(p.dir, "plugins");
    if (!isDir(dir)) continue;
    const mine = findDescriptorFiles(dir, /\.plugin\.js$/);
    if (opts.sharedStore && p.layer === "project" && mine.length > 0) {
      throw new Error(
        `project pack plugin ${mine[0]}: a shared store (mysql) takes no project pack plugins; ` +
          "put the plugin in the org pack (packs.org) or in the engine (docs/design/11-packs.md)",
      );
    }
    files.push(...mine);
  }
  return files;
}
