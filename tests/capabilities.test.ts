// The Capabilities section's registry and read API (design 08-settings, 2026-11-13): the skills of the configured skill
// folders, the broker's tools and the provider entries, each with enabled, roles and last used (from stored runs), and
// no secret value in the response. Reading the list writes nothing.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConfigKeys } from "../src/config-keys.js";
import { capabilitiesConfig } from "../src/core/config.js";
import type { SettingsBase } from "../src/core/settings.js";
import type { WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { harnessToolName } from "../src/impl/runner/tool-bridge.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import type { SharedStorage } from "../src/interfaces/shared-storage.js";
import { REGISTRY } from "../src/plugins.js";
import { readSkills, skillFolderPath } from "../src/runtime/capabilities/capabilities.js";
import { type UiCapabilitySources, capabilitySources, readCapabilities } from "../src/ui/capabilities-api.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "../src/ui/settings-api.js";
import { issue, newStore, system } from "./helpers/store.js";

// Built here so no secret-shaped literal sits in the repository.
const SECRET = `sk-${"Zq7".repeat(14)}`;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "caps-"));
  dirs.push(d);
  return d;
}

/** A folder in Claude Code's layout (`<name>/SKILL.md`) and a pack's (`<name>.md`), with entries that are no skill. */
async function skillFolder(names: { dirs?: string[]; files?: string[] }): Promise<string> {
  const root = await tmp();
  for (const n of names.dirs ?? []) {
    await mkdir(join(root, n), { recursive: true });
    await writeFile(join(root, n, "SKILL.md"), `---\nname: ${n}\n---\n`);
  }
  for (const n of names.files ?? []) await writeFile(join(root, n), "# a skill\n");
  return root;
}

/** Memory storage holding run transcripts. */
class MemStorage implements SharedStorage {
  data = new Map<string, Uint8Array>();
  async put(k: string, v: Uint8Array) {
    this.data.set(k, v);
  }
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(k: string) {
    this.data.delete(k);
  }
}

/** Counts every store call that is not a read, so a test can say "no write". */
function counting(store: FactoryStore): { store: FactoryStore; writes: string[] } {
  const writes: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && !/^(get|list|read|count|find|has|is|migrate)/.test(prop)) writes.push(prop);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, writes };
}

/** A finished implement run of a new item, with its usage's model and (optionally) a stored transcript. */
async function finishedRun(store: FactoryStore, storage: MemStorage, n: number, model: string, transcript: string | null) {
  const it = (await store.createWorkItem({ ...issue(n), title: `Item ${n}` }, system)).item;
  const r0 = await store.transition({ id: it.id, expected_version: it.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `k${n}` } });
  if (!r0.ok) throw new Error(r0.reason);
  const run = (await store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model };
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "checks_failed", detail: "x", infra: false, usage });
  if (transcript !== null) await storage.put(`transcripts/${it.id}/${run.id}.json`, new TextEncoder().encode(transcript));
  return run;
}

const BASE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };

async function setup(sources: UiCapabilitySources, opts: { base?: SettingsBase; secrets?: readonly string[] } = {}) {
  const clock = new FakeClock("2026-11-13T09:00:00.000Z");
  const { store } = await newStore(clock);
  const storage = new MemStorage();
  const secretStore: SecretStore = { get: async () => null, valuesForScan: async () => opts.secrets ?? [] };
  const refuse = Object.assign(async () => ({ ok: false as const, reason: "not wired" }), { capabilities: async () => sources });
  const settings: UiSettings = {
    base: opts.base ?? BASE, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: storeProjectResolver(store, { owner: "o", name: "r" }), csrfToken: newCsrfToken(),
    editFile: refuse as unknown as NonNullable<UiSettings["editFile"]>,
  };
  const d: UiDeps = { store, scanner: new PatternEgressScanner(() => secretStore.valuesForScan()), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings, storage };
  return { clock, store, storage, settings, d };
}

type Cap = { kind: string; id: string; name: string; detail: string | null; enabled: boolean; roles: string[]; last_used: string | null; models?: { class: string; model: string }[] };
const caps = async (d: UiDeps, s: UiSettings) => (await readCapabilities(d, s)).capabilities as Cap[];

describe("skill folders", () => {
  it("lists each skill of a configured folder: a subfolder with SKILL.md, or a top-level <name>.md", async () => {
    const a = await skillFolder({ dirs: ["review-checklist", "empty-dir-no-skill"], files: ["release-notes.md", "README.md", "notes.txt"] });
    await rm(join(a, "empty-dir-no-skill", "SKILL.md"));
    const b = await skillFolder({ dirs: ["deploy"] });
    const { d, settings } = await setup({ skill_folders: [a, b], tools: [], providers: [] });
    const skills = (await caps(d, settings)).filter((c) => c.kind === "skill");
    expect(skills.map((s) => [s.name, s.detail, s.enabled])).toEqual([
      ["deploy", b, true],
      ["release-notes", a, true],
      ["review-checklist", a, true],
    ]);
  });

  it("with no folder configured the skill list is empty, and the config loads", async () => {
    expect(capabilitiesConfig({})).toEqual({ skill_folders: [] });
    expect(() => checkConfigKeys({})).not.toThrow();
    const { d, settings } = await setup({ skill_folders: [], tools: [], providers: [] });
    expect((await caps(d, settings)).filter((c) => c.kind === "skill")).toEqual([]);
  });

  it("a configured folder that is missing lists no skill and fails nothing", async () => {
    expect(await readSkills([join(await tmp(), "gone")])).toEqual([]);
  });

  it("checks the block at load: a list of paths, and no other key", () => {
    expect(capabilitiesConfig({ capabilities: { skill_folders: ["~/.claude/skills"] } })).toEqual({ skill_folders: ["~/.claude/skills"] });
    expect(() => checkConfigKeys({ capabilities: { skill_folders: "skills" } })).toThrow(/capabilities.skill_folders must be a list/);
    expect(() => checkConfigKeys({ capabilities: { skill_folder: [] } })).toThrow(/unknown config key "skill_folder" at capabilities.skill_folder/);
    expect(skillFolderPath("~/.claude/skills", "/repo", "/home/me")).toBe("/home/me/.claude/skills");
    expect(skillFolderPath("agent-skills", "/repo", "/home/me")).toBe("/repo/agent-skills");
  });
});

describe("the loaded config's sources", () => {
  const loaded = (root: string, file: Record<string, unknown>, plugins: Record<string, unknown>) =>
    ({
      root, file, registry: REGISTRY, pack_tools: [],
      plugins: { broker: "local", runner: "claude-code", llm: "claude-cli", ...plugins },
      config: { repo: { owner: "o", name: "r", path: "." }, branch_prefix: "factory/" },
    }) as unknown as Parameters<typeof capabilitySources>[0];

  it("reads the broker's tools, each registered runner and LLM plugin, and the skill folders from the root", async () => {
    const root = await tmp();
    const { store } = await newStore(new FakeClock());
    const s = await capabilitySources(loaded(root, { capabilities: { skill_folders: ["skills"] } }, { runners: ["claude-code", "openai-compatible"] }), store);
    expect(s.skill_folders).toEqual([join(root, "skills")]);
    expect(s.tools).toEqual([expect.objectContaining({ name: "git.store_branch", read_only: false, origin: "broker" })]);
    const entry = (i: string, p: string) => s.providers.find((x) => x.interface === i && x.plugin === p);
    expect(entry("runner", "claude-code")).toMatchObject({ selected: true, endpoint: null, models: null });
    expect(entry("runner", "openai-compatible")).toMatchObject({ selected: true });
    expect(entry("llm", "claude-cli")).toMatchObject({ selected: true });
    expect(entry("llm", "openai-compatible")).toMatchObject({ selected: false });
  });

  it("one entry per configured endpoint: its host and its own models, never the URL's user info or path", async () => {
    const root = await tmp();
    const { store } = await newStore(new FakeClock());
    const file = { openai_compatible: { base_url: `https://me:${SECRET}@api.example.com/v1?key=${SECRET}`, models: { cheap: "m-small", standard: "m-mid", strong: "m-big" } } };
    const s = await capabilitySources(loaded(root, file, { runner: "openai-compatible" }), store);
    const p = s.providers.find((x) => x.interface === "runner" && x.plugin === "openai-compatible")!;
    expect(p).toMatchObject({ selected: true, endpoint: "api.example.com", models: { cheap: "m-small", standard: "m-mid", strong: "m-big" } });
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });
});

describe("GET /api/v1/settings/capabilities", () => {
  const TOOLS = [
    { name: "forge.preflight", description: "Read-only check.", read_only: true, origin: "broker" as const },
    { name: "git.store_branch", description: "Store a branch.", read_only: false, origin: "broker" as const },
  ];
  const PROVIDERS = [
    { interface: "runner" as const, plugin: "claude-code", selected: true, endpoint: null, models: null },
    { interface: "runner" as const, plugin: "openai-compatible", selected: false, endpoint: "api.example.com", models: { cheap: "m-small", standard: "m-mid", strong: "m-big" } },
    { interface: "llm" as const, plugin: "claude-cli", selected: true, endpoint: null, models: null },
  ];

  it("shows each tool's roles from the grants in force, and each provider entry's models and roles", async () => {
    const base: SettingsBase = { ...BASE, file: { tool_grants: { triage: ["forge.preflight"] } } };
    const { d, settings, store } = await setup({ skill_folders: [], tools: TOOLS, providers: PROVIDERS }, { base });
    await store.setSettingOverride({ key: "tool_grants", project: "", value: JSON.stringify({ triage: ["forge.preflight"], review: ["forge.preflight"] }), actor: "local:owner" });
    const list = await caps(d, settings);
    const by = (id: string) => list.find((c) => c.id === id)!;
    expect(by("tool:forge.preflight")).toMatchObject({ kind: "tool", enabled: true, roles: ["review", "triage"] });
    expect(by("tool:git.store_branch")).toMatchObject({ enabled: false, roles: [] });
    expect(by("runner:claude-code")).toMatchObject({ kind: "provider", enabled: true, roles: ["triage", "implement", "review", "resolve"] });
    expect(by("runner:claude-code").models).toEqual([{ class: "cheap", model: "haiku" }, { class: "standard", model: "sonnet" }, { class: "strong", model: "opus" }]);
    expect(by("runner:openai-compatible")).toMatchObject({ enabled: false, roles: [], detail: "api.example.com" });
    expect(by("llm:claude-cli")).toMatchObject({ enabled: true, roles: ["improve"] });
    // The kinds come in order: skills, tools, then providers.
    const kinds = list.map((c) => c.kind);
    expect(kinds.indexOf("tool")).toBeLessThan(kinds.indexOf("provider"));
  });

  it("takes last used from stored runs: a tool or skill from the newest transcript that called it, a provider from the reported model", async () => {
    const folder = await skillFolder({ dirs: ["deploy"] });
    const { d, settings, store, storage, clock } = await setup({ skill_folders: [folder], tools: TOOLS, providers: PROVIDERS });
    const call = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"${harnessToolName("forge.preflight")}","input":{}}]}}`;
    const skill = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"deploy"}}]}}`;
    await finishedRun(store, storage, 1, "claude-sonnet-4-5", `${call}\n${skill}\n`);
    const older = clock.now().toISOString();
    clock.advance(60_000);
    await finishedRun(store, storage, 2, "claude-sonnet-4-5", `{"type":"result"}\n`);
    const newer = clock.now().toISOString();
    const list = await caps(d, settings);
    const by = (id: string) => list.find((c) => c.id === id)!;
    expect(by("tool:forge.preflight").last_used).toBe(older);
    expect(by("skill:deploy").last_used).toBe(older);
    expect(by("tool:git.store_branch").last_used).toBeNull();
    expect(by("runner:claude-code").last_used).toBe(newer);
    expect(by("runner:openai-compatible").last_used).toBeNull();
  });

  it("contains no secret value: a secret the SecretStore holds is withheld wherever it would appear", async () => {
    const folder = await skillFolder({ dirs: [`leak-${SECRET}`] });
    const providers = [{ interface: "runner" as const, plugin: "openai-compatible", selected: true, endpoint: "api.example.com", models: { cheap: SECRET, standard: "m", strong: "m" } }];
    const tools = [{ name: "forge.preflight", description: `token ${SECRET}`, read_only: true, origin: "broker" as const }];
    const { d, settings, store, storage } = await setup({ skill_folders: [folder], tools, providers }, { secrets: [SECRET] });
    await finishedRun(store, storage, 1, "m", `{"secret":"${SECRET}"}\n`);
    const r = await respond(d, { method: "GET", url: "/api/v1/settings/capabilities", host: "127.0.0.1:4310" });
    expect(r.status).toBe(200);
    const body = r.body;
    expect(body).toContain("capabilities");
    expect(body).toContain("[withheld");
    expect(body).not.toContain(SECRET);
  });

  it("reading the list writes nothing to the store", async () => {
    const folder = await skillFolder({ dirs: ["deploy"] });
    const t = await setup({ skill_folders: [folder], tools: TOOLS, providers: PROVIDERS });
    await finishedRun(t.store, t.storage, 1, "claude-sonnet-4-5", "{}\n");
    const c = counting(t.store);
    await readCapabilities({ ...t.d, store: c.store }, t.settings);
    expect(c.writes).toEqual([]);
  });

  it("is a 404 without the Settings wiring, and lists nothing without sources", async () => {
    const t = await setup({ skill_folders: [], tools: [], providers: [] });
    const { settings: _s, ...bare } = t.d;
    expect((await respond(bare, { method: "GET", url: "/api/v1/settings/capabilities", host: "127.0.0.1:4310" })).status).toBe(404);
    const plain: UiSettings = { ...t.settings };
    delete plain.editFile;
    expect(await caps(t.d, plain)).toEqual([]);
  });
});
