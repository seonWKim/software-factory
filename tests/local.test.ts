import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { Loaded } from "../src/load-config.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import type { WorkItemId, WorkItemPatch } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { REGISTRY } from "../src/plugins.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// The local handler (`factory task …`, `factory approve …`): its hints name the wrapper's command (FACTORY_CLI_NAME,
// else `factory`), and `task create` prints the item's link on the configured ui.port (design 05-sources, CLI intake).

const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Runs the real command `word` over `store` (kept open after it), with `ui` as the config's ui section. */
async function command(store: FactoryStore, word: string, args: string[], ui: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sf-local-"));
  const loaded = {
    root: dir, stateDir: dir, file: { ui }, config: { repo: { owner: "o", name: "r" }, local_only: true }, registry: REGISTRY, plugins: { clock: "system" },
  } as unknown as Loaded;
  const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
  vi.spyOn(console, "error").mockImplementation((l: string) => void out.push(l));
  const cmd = (await loadCommands()).get(word)!;
  const env = async () => ({ gitEmail: "me@example.com", osUser: null });
  const code = await cmd.run(args, { name: word, usage: "", load: async () => loaded, environment: env, openStore: async () => kept });
  vi.restoreAllMocks();
  return { code, out, dir };
}

async function itemAtSpec(store: FactoryStore) {
  const { item } = await store.createWorkItem(issue(7), system);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: SPEC_PENDING });
  if (!r.ok) throw new Error("setup");
  return r.item;
}

describe("the local handler's hints", () => {
  it("with FACTORY_CLI_NAME=gb, the stored-command line and the refusal hint both say gb", async () => {
    vi.stubEnv("FACTORY_CLI_NAME", "gb");
    const { store } = await newStore();
    const item = await itemAtSpec(store);
    const r = await command(store, "approve", [item.id]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([expect.stringContaining(`see \`gb task show ${item.id}\``), expect.stringContaining(`\`gb task show ${item.id}\` lists the reason`)]);
    expect(r.out.join("\n")).not.toContain("factory task show");
  });

  it("with no FACTORY_CLI_NAME, both say factory as before", async () => {
    vi.stubEnv("FACTORY_CLI_NAME", undefined);
    const { store } = await newStore();
    const item = await itemAtSpec(store);
    const r = await command(store, "approve", [item.id]);
    expect(r.out).toEqual([expect.stringContaining(`see \`factory task show ${item.id}\``), expect.stringContaining(`\`factory task show ${item.id}\` lists the reason`)]);
  });

  it("a short ID names the item: show ends with its refusal section, approve's hint names the full ID", async () => {
    const { store } = await newStore();
    const item = await itemAtSpec(store);
    const short = item.id.slice(3, 11);
    const shown = await command(store, "task", ["show", short]);
    expect(shown.code).toBe(0);
    expect(shown.out[0]).toContain(item.id);
    expect(shown.out.slice(-2)).toEqual(["Last refused command", "  (none)"]);
    const r = await command(store, "approve", [`wi_${short}`]);
    expect(r.out).toEqual([expect.stringContaining(`see \`factory task show ${item.id}\``), expect.stringContaining(`\`factory task show ${item.id}\` lists the reason`)]);
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.args.item)).toEqual([item.id]);
  });

  it("task create prints the ID, the short ID, the link on ui.port, then the next step", async () => {
    const { store } = await newStore();
    await itemAtSpec(store);
    await saveProjectLabel(store, { key: PROJECT_KEY, label: "github.com/o/r" }); // the configured repo's project
    const body = join(mkdtempSync(join(tmpdir(), "sf-body-")), "body.md");
    writeFileSync(body, "the body\n");
    const r = await command(store, "task", ["create", "--title", "t", "--body-file", body], { port: 5123 });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([r.out[0], r.out[0]!.slice(3, 11), `http://127.0.0.1:5123/app/items/${r.out[0]}`, "triage queued; you'll be asked to approve the spec"]);
    expect(await store.getWorkItem(r.out[0] as WorkItemId)).not.toBeNull();
  });
});
