// "Last used" (Settings capabilities, the Plugins page's Skills and Tools tabs) reads stored run transcripts. A finished
// run's transcript does not change, so a second, unchanged request reads none again; a new marker (a new skill) reads
// only for itself, and a run with no transcript yet is asked again.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingsBase } from "../src/core/settings.js";
import type { WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { harnessToolName } from "../src/impl/runner/tool-bridge.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SharedStorage } from "../src/interfaces/shared-storage.js";
import { type UiCapabilitySources, capabilityRows } from "../src/ui/capabilities-api.js";
import { issue, newStore, system } from "./helpers/store.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Memory storage that counts transcript reads (get and getRange) and lists. */
class CountingStorage implements SharedStorage {
  data = new Map<string, Uint8Array>();
  reads = 0;
  lists = 0;
  async put(k: string, v: Uint8Array) {
    this.data.set(k, v);
  }
  async get(k: string) {
    this.reads++;
    return this.data.get(k) ?? null;
  }
  async getRange(k: string, start: number, end: number) {
    this.reads++;
    const v = this.data.get(k);
    return v ? { bytes: v.subarray(start, end), size: v.length } : null;
  }
  async list(prefix: string) {
    this.lists++;
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(k: string) {
    this.data.delete(k);
  }
}

async function skillFolder(names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "caps-cache-"));
  dirs.push(root);
  for (const n of names) {
    await mkdir(join(root, n), { recursive: true });
    await writeFile(join(root, n, "SKILL.md"), `---\nname: ${n}\n---\n`);
  }
  return root;
}

/** A finished implement run of a new item; its transcript stored unless null. */
async function finishedRun(store: FactoryStore, storage: CountingStorage, n: number, transcript: string | null) {
  const it = (await store.createWorkItem({ ...issue(n), title: `Item ${n}` }, system)).item;
  const r0 = await store.transition({ id: it.id, expected_version: it.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `k${n}` } });
  if (!r0.ok) throw new Error(r0.reason);
  const run = (await store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "checks_failed", detail: "x", infra: false });
  if (transcript !== null) await storage.put(`transcripts/${it.id}/${run.id}.json`, new TextEncoder().encode(transcript));
  return { item: it.id, run: run.id };
}

const BASE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };
const TOOLS = [{ name: "forge.preflight", description: "Read-only check.", read_only: true, origin: "broker" as const }];
const skillCall = (name: string) => `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"${name}"}}]}}\n`;

async function setup() {
  const clock = new FakeClock("2026-11-21T09:00:00.000Z");
  const { store } = await newStore(clock);
  const storage = new CountingStorage();
  const d = { store, scanner: new PatternEgressScanner(async () => []), storage };
  return { clock, store, storage, d };
}

const lastUsedOf = (rows: Awaited<ReturnType<typeof capabilityRows>>, id: string) => rows.find((c) => c.id === id)?.last_used ?? null;

describe("last used reads each finished run's transcript once", () => {
  it("reads no transcript on a second, unchanged request, and gives the same last-used times", async () => {
    const { clock, store, storage, d } = await setup();
    const sources: UiCapabilitySources = { skill_folders: [await skillFolder(["deploy", "never"])], tools: TOOLS, providers: [] };
    await finishedRun(store, storage, 1, `${skillCall("deploy")}{"name":"${harnessToolName("forge.preflight")}"}\n`);
    const at = clock.now().toISOString();
    clock.advance(60_000);
    await finishedRun(store, storage, 2, `{"type":"result"}\n`);

    const first = await capabilityRows(d, BASE, sources);
    expect(lastUsedOf(first, "skill:deploy")).toBe(at);
    expect(lastUsedOf(first, "tool:forge.preflight")).toBe(at);
    expect(lastUsedOf(first, "skill:never")).toBeNull();
    expect(storage.reads).toBe(2);

    storage.reads = 0;
    storage.lists = 0;
    const second = await capabilityRows(d, BASE, sources);
    expect(storage.reads).toBe(0);
    expect(storage.lists).toBe(0);
    expect(second.map((c) => [c.id, c.last_used])).toEqual(first.map((c) => [c.id, c.last_used]));
  });

  it("reads again only for a new marker, and asks again for a run whose transcript was not stored yet", async () => {
    const { store, storage, d } = await setup();
    const folder = await skillFolder(["deploy"]);
    await finishedRun(store, storage, 1, skillCall("deploy") + skillCall("later"));
    const pending = await finishedRun(store, storage, 2, null);
    await capabilityRows(d, BASE, { skill_folders: [folder], tools: [], providers: [] });
    expect(storage.reads).toBe(1);

    // A new skill: its marker was never looked for, so the stored transcript is read for it; the late one lands.
    await mkdir(join(folder, "later"));
    await writeFile(join(folder, "later", "SKILL.md"), "---\nname: later\n---\n");
    await storage.put(`transcripts/${pending.item}/${pending.run}.json`, new TextEncoder().encode(skillCall("later")));
    storage.reads = 0;
    const rows = await capabilityRows(d, BASE, { skill_folders: [folder], tools: [], providers: [] });
    expect(storage.reads).toBe(1);
    expect(lastUsedOf(rows, "skill:later")).not.toBeNull();
    expect(lastUsedOf(rows, "skill:deploy")).not.toBeNull();
  });
});
