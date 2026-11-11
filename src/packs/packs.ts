// Packs (design 11-packs.md): layered folders of prompts, skills and plugins, so a user customizes the factory
// without editing engine files. Layers, in the default order: base (the code root's prompts/ and skills/), org (a
// folder set at `packs.org`), project (`.factory/` in the configured repo's main checkout) and learned (`learned/`
// under the state dir, read-only: nothing here writes to it). A missing layer folder or file is off, never an error.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Prompts } from "../core/config.js";
import type { Capability } from "../interfaces/capability-search.js";
import { skillCapability } from "../impl/capability/bm25-capability-search.js";
import { findDescriptorFiles } from "../state/index.js";
import { HOOK_NAME, PACK_CHECK_POINTS, type PackCheckPoint } from "../shared/hook.js";

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

/**
 * Every prompt through the layers (packPrompt), each passed through `fill` (the placeholders). Triage, implement
 * and review are required: no layer having one fails startup. `resolve` and `improve` are optional (resolve:
 * `prompt_missing`; improve: no drafts). `owner-defaults`, the owner's standing answers (design 04-triage.md, issue
 * #315), is appended to triage so triage applies them instead of asking.
 */
export async function packPrompts(packs: readonly Pack[], fill: (text: string) => string): Promise<Prompts> {
  const optional = async (name: string) => {
    const text = await packPrompt(packs, name);
    return text === undefined ? undefined : fill(text);
  };
  const required = async (name: string) => {
    const text = await optional(name);
    if (text === undefined) throw new Error(`no pack has the prompt prompts/${name}.md (layers: ${packs.map((p) => p.dir).join(", ")})`);
    return text;
  };
  const prompts: Prompts = { triage: await required("triage"), implement: await required("implement"), review: await required("review") };
  for (const name of ["resolve", "improve"] as const) {
    const text = await optional(name);
    if (text !== undefined) prompts[name] = text;
  }
  const ownerDefaults = await optional("owner-defaults");
  if (ownerDefaults !== undefined) prompts.triage = `${prompts.triage.trimEnd()}\n\n${ownerDefaults}`;
  return prompts;
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

/** A pack check (design 04-pre-push-gates.md, issue #494): `checks/<name>.json` in a layer, on when `hooks` names it. */
export interface PackCheck {
  name: string;
  layer: PackLayer;
  file: string;
  point: PackCheckPoint;
  /** Run as is, no shell; `on_tool_call` adds the tool name and the file path after it. */
  argv: string[];
  /** Lower runs first; then the layer order, then the name. */
  order: number;
  timeout_ms: number;
  /** before_finish: how many times a refusal sends the agent back before the run fails. */
  retries: number;
}

export const PACK_CHECK_DEFAULTS = { order: 100, timeout_ms: 20_000, retries: 3 } as const;
/** An `on_tool_call` check runs inside Claude Code's 30 s PreToolUse hook: it may take at most this long. */
export const MAX_TOOL_CALL_CHECK_MS = 20_000;
/** Any other point's longest timeout. */
export const MAX_PACK_CHECK_MS = 600_000;

const intIn = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** The checks of `file` (`checks/<name>.json`), or the problem that fails startup, naming the file. */
function readCheck(name: string, layer: PackLayer, file: string): PackCheck {
  const fail = (why: string): never => {
    throw new Error(`pack check ${name} (${file}): ${why} (docs/design/04-pre-push-gates.md)`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return fail(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) return fail("must be a JSON object with point and argv");
  const point = raw.point;
  if (typeof point !== "string" || !(PACK_CHECK_POINTS as readonly string[]).includes(point)) {
    return fail(`point ${JSON.stringify(point)} is not a pack check point; pack checks run at ${PACK_CHECK_POINTS.join(", ")}`);
  }
  if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((a) => typeof a !== "string" || a === "")) {
    return fail("argv must be a non-empty list of non-empty strings (run as is, no shell)");
  }
  const max = point === "on_tool_call" ? MAX_TOOL_CALL_CHECK_MS : MAX_PACK_CHECK_MS;
  const c = { ...PACK_CHECK_DEFAULTS, ...raw };
  if (!intIn(c.order, -1_000_000, 1_000_000)) fail("order must be an integer");
  if (!intIn(c.timeout_ms, 1, max)) fail(`timeout_ms must be an integer from 1 to ${max} at ${point}`);
  if (!intIn(c.retries, 0, 100)) fail("retries must be an integer from 0 to 100");
  return { name, layer, file, point: point as PackCheckPoint, argv: raw.argv as string[], order: c.order, timeout_ms: c.timeout_ms, retries: c.retries };
}

/**
 * The enabled pack checks, in run order (order, then the layer order, then the name). Only a name `enabled` (the
 * `hooks` key) lists runs: a layer's other checks are not read. Startup fails, naming the check or the file, on a
 * name two layers both have, a bad check file, a point other than the pack check points, a project-layer check
 * on a shared store (mysql), and an `on_tool_call` check when the runner has no tool hooks. A listed name no
 * layer has is left to the `*.hook.ts` check (checkEnabledHooks).
 */
export function packChecks(packs: readonly Pack[], enabled: readonly string[], opts: { sharedStore: boolean; toolHooks: boolean }): PackCheck[] {
  const checks: PackCheck[] = [];
  for (const name of new Set(enabled)) {
    if (!HOOK_NAME.test(name)) continue;
    const found = packs.map((p) => ({ layer: p.layer, file: join(p.dir, "checks", `${name}.json`) })).filter((f) => isFile(f.file));
    if (found.length === 0) continue;
    if (found.length > 1) {
      throw new Error(`hooks: the pack check ${name} is in more than one layer (${found.map((f) => f.file).join(", ")}); keep one, or rename the other`);
    }
    const { layer, file } = found[0]!;
    if (opts.sharedStore && layer === "project") {
      throw new Error(
        `project pack check ${file}: a shared store (mysql) runs no project pack checks; put the check in the org pack (packs.org) or remove ${name} from hooks`,
      );
    }
    const check = readCheck(name, layer, file);
    if (check.point === "on_tool_call" && !opts.toolHooks) {
      throw new Error(`hooks: the pack check ${name} runs at on_tool_call, but the selected agent runner has no tool hooks (supports_tool_hooks); remove it from hooks or pick a runner that has them`);
    }
    checks.push(check);
  }
  const rank = (c: PackCheck) => packs.findIndex((p) => p.layer === c.layer);
  return checks.sort((a, b) => a.order - b.order || rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
