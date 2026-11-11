// Pack tool implementations (design 11-packs, issue #592). A layer's `tools/<file>.json` is the descriptor `factory
// pack add` stores and the owner approves; a `tools/<file>.tool.js` beside it is the code that serves it. Startup
// imports every such module, in layer order, into the worker process only: the pack tool broker
// (pack-tool-broker.ts) calls it there, after the approval check, with the entry's credential. The agent's sandbox
// never loads it. A descriptor with no module stays data, as before. Each tool's credential is declared as a secret
// of the selected broker (which the pack tool broker wraps), so the SecretStore loads and scans it and setup asks for it.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PACK_GRANT, type ToolGrants } from "../../core/config.js";
import { type Secret, type SecretName, secretName } from "../../interfaces/secret-store.js";
import type { ToolBroker, ToolResult } from "../../interfaces/tool-broker.js";
import { descriptionHash } from "../../packs/pack-entries.store.js";
import type { Json } from "../../packs/pack-scans.js";
import type { Pack } from "../../packs/packs.js";
import type { Registry } from "../../plugin-api.js";
import { PackToolBroker } from "./pack-tool-broker.js";

/** A pack tool's module, beside its descriptor: `tools/<file>.tool.js`. */
export const PACK_TOOL_MODULE = ".tool.js";

/** One pack tool's implementation, as the worker holds it. */
export interface PackTool {
  /** The entry's name; the tool is listed and granted as `pack:tool:<name>`. */
  readonly name: string;
  /** The description_hash of the descriptor this implementation runs: it runs only while that one is approved and current. */
  readonly description_hash: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly read_only: boolean;
  /** The secret the call gets (the descriptor's `credential`); null without one. Never its value. */
  readonly credential_name: SecretName | null;
  /** The call function. Gets the entry's credential here, in the worker, and nowhere else. */
  call(args: unknown, credential: Secret | null): Promise<ToolResult>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One module and its descriptor, checked; any problem fails startup, naming the file. */
async function loadOne(dir: string, module: string): Promise<PackTool> {
  const file = join(dir, module);
  const descriptorFile = join(dir, `${module.slice(0, -PACK_TOOL_MODULE.length)}.json`);
  const bad = (why: string) => new Error(`pack tool ${file}: ${why} (docs/design/11-packs.md)`);
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(await readFile(descriptorFile, "utf8"));
  } catch {
    throw bad(`needs its descriptor ${descriptorFile}, a JSON object`);
  }
  if (!isRecord(descriptor) || typeof descriptor.name !== "string" || descriptor.name.trim() === "") throw bad("its descriptor has no name");
  if (typeof descriptor.description !== "string") throw bad("its descriptor has no description");
  if (descriptor.input_schema !== undefined && !isRecord(descriptor.input_schema)) throw bad("its descriptor's input_schema is not an object");
  const credential = descriptor.credential;
  if (credential !== undefined && typeof credential !== "string") throw bad("its descriptor's credential is not a secret name");
  let credential_name: SecretName | null = null;
  try {
    credential_name = credential === undefined ? null : secretName(credential);
  } catch (err) {
    throw bad((err as Error).message);
  }
  const call = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  if (typeof call !== "function") throw bad("write `export default async function (args, credential) { return { ok: true, content } }`");
  return {
    name: descriptor.name,
    description_hash: descriptionHash(descriptor as Json),
    description: descriptor.description,
    input_schema: (descriptor.input_schema as Record<string, unknown> | undefined) ?? { type: "object" },
    read_only: descriptor.read_only === true,
    credential_name,
    call: call as PackTool["call"],
  };
}

/**
 * Every layer's pack tools, in layer order. A name in two layers fails startup, naming both files. On a shared store
 * a project pack's tool module fails startup too: only reviewed layers (base, org) may add code there.
 */
export async function loadPackTools(packs: readonly Pack[], opts: { sharedStore: boolean }): Promise<PackTool[]> {
  const out: PackTool[] = [];
  const where = new Map<string, string>();
  for (const p of packs) {
    const dir = join(p.dir, "tools");
    let modules: string[];
    try {
      modules = (await readdir(dir)).filter((f) => f.endsWith(PACK_TOOL_MODULE) && !f.startsWith(".")).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (opts.sharedStore && p.layer === "project" && modules.length > 0) {
      throw new Error(
        `project pack tool ${join(dir, modules[0]!)}: a shared store (mysql) takes no project pack tools; ` +
          "put the tool in the org pack (packs.org) (docs/design/11-packs.md)",
      );
    }
    for (const module of modules) {
      const tool = await loadOne(dir, module);
      const seen = where.get(tool.name);
      if (seen) throw new Error(`pack tool ${tool.name} is in two layers: ${seen} and ${join(dir, module)}; keep one`);
      where.set(tool.name, join(dir, module));
      out.push(tool);
    }
  }
  return out;
}

/**
 * The pack layers' tools, and the registry with each one's credential declared as a secret of the selected broker
 * (`broker`). What loadConfig keeps; a bad tool fails startup.
 */
export async function withPackTools(registry: Registry, broker: string, packs: readonly Pack[], opts: { sharedStore: boolean }): Promise<{ registry: Registry; pack_tools: PackTool[] }> {
  const pack_tools = await loadPackTools(packs, opts);
  const declared = pack_tools.flatMap((t) => (t.credential_name ? [{ name: t.credential_name, purpose: `the pack tool ${t.name}` }] : []));
  if (declared.length === 0) return { registry, pack_tools };
  const entry = registry.broker;
  return { registry: { ...registry, broker: { ...entry, secrets: { ...entry.secrets, [broker]: [...(entry.secrets[broker] ?? []), ...declared] } } }, pack_tools };
}

/**
 * The startup check of the `pack:tool:<name>` grants: each needs a pack layer's tool of that name, read-only (the
 * tool gate lists read-only tools only). Its approval is checked per run and per call, never here.
 */
function checkPackToolGrants(tool_grants: ToolGrants | undefined, tools: readonly PackTool[]): void {
  const problems: string[] = [];
  for (const [kind, names] of Object.entries(tool_grants ?? {})) {
    for (const name of names ?? []) {
      const m = PACK_GRANT.exec(name);
      if (!m || m[1] !== "tool") continue;
      const tool = tools.find((t) => t.name === m[2]);
      if (!tool) problems.push(`tool_grants.${kind} grants ${name}, but no pack layer has a tools/*${PACK_TOOL_MODULE} for it`);
      else if (!tool.read_only) problems.push(`tool_grants.${kind} grants ${name}, which is not read-only (its descriptor needs "read_only": true)`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** What every pack tool broker of a build shares: all of PackToolBroker's deps but the tools. */
type PackToolDeps = Omit<ConstructorParameters<typeof PackToolBroker>[1], "tools">;

/**
 * compose's wrapper for every broker an agent's granted tools reach: checks the `pack:tool:` grants against the
 * pack tools first (startup fails on a bad one), then wraps each broker in a PackToolBroker. With no pack tools, a
 * broker is returned as is.
 */
export function packToolBrokers(tools: readonly PackTool[], tool_grants: ToolGrants | undefined, deps: PackToolDeps): (b: ToolBroker) => ToolBroker {
  checkPackToolGrants(tool_grants, tools);
  return (b) => (tools.length === 0 ? b : new PackToolBroker(b, { ...deps, tools }));
}
