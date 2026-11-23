// Run next (design 05-coordination, 2026-11-22): `factory run-next <id>` and the item page's Run next button store the
// same app request; the controller checks the owner, moves the item's queued run to queue position 1 and answers in
// the item's thread. It starts nothing and changes no item field; with no queued run it changes nothing and says so.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import RUN_NEXT from "../src/cli/handlers/run-next/run-next.command.js";
import type { CliEnvironment } from "../src/core/local-cli.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Loaded } from "../src/load-config.js";
import { REGISTRY } from "../src/plugins.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { parseCommand } from "../src/ui/commands.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

const OWNER = "github:1" as UserId;
const READER = "github:666" as UserId;

async function harness() {
  const { store, clock } = await newStore();
  const controller = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const item = async (n: number, kind: "triage" | "implement" | null) => {
    const r = await store.createWorkItem(issue(n), system, kind ? { enqueue: { kind, idempotency_key: `${n}:${kind}` } } : undefined);
    clock.advance(1_000);
    return r.item;
  };
  let keys = 0;
  const request = async (it: WorkItem, who: UserId = OWNER) =>
    (await store.recordAppCommandRequest({ key: `app:${++keys}`, actor: who, command: "run-next", args: { work_item_id: it.id } })).request;
  const apply = async () => {
    await controller.tickCommands();
    await controller.tickOutbox();
  };
  const order = async () => (await store.listQueuedInClaimOrder(10)).map((r) => r.work_item_id);
  const thread = async (it: WorkItem) => (await store.listItemMessages(it.id)).map((m) => m.body);
  return { store, item, request, apply, order, thread };
}

describe("Run next applied by the controller", () => {
  it("moves the item's queued run to position 1, answers once in its thread, and changes no item field", async () => {
    const h = await harness();
    const triage = await h.item(1, "triage");
    const impl = await h.item(2, "implement");
    expect(await h.order()).toEqual([triage.id, impl.id]);
    const r = await h.request(impl);
    await h.apply();
    await h.apply(); // a second pass applies nothing again
    expect(await h.order()).toEqual([impl.id, triage.id]);
    expect(await h.thread(impl)).toEqual([expect.stringContaining("Run next: the queued implement run is now at queue position 1.")]);
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
    expect(await h.store.getWorkItem(impl.id)).toMatchObject({ version: impl.version, stage: impl.stage, blocked_on: impl.blocked_on });
    // It starts nothing: the run is still queued.
    expect((await h.store.listRuns(impl.id)).map((x) => x.status)).toEqual(["queued"]);
  });

  it("an item with no queued run: nothing changes and the reply says so", async () => {
    const h = await harness();
    const triage = await h.item(1, "triage");
    const idle = await h.item(2, null);
    const r = await h.request(idle);
    await h.apply();
    expect(await h.order()).toEqual([triage.id]);
    expect((await h.store.getAppCommandRequest(r.seq))?.refusal).toBe("`run-next` was not applied: the item has no queued run, so nothing changed.");
    expect(await h.thread(idle)).toEqual(["`run-next` was not applied: the item has no queued run, so nothing changed."]);
  });

  it("a viewer who is not the owner is refused and the order stays", async () => {
    const h = await harness();
    const triage = await h.item(1, "triage");
    const impl = await h.item(2, "implement");
    const r = await h.request(impl, READER);
    await h.apply();
    expect(await h.order()).toEqual([triage.id, impl.id]);
    expect((await h.store.getAppCommandRequest(r.seq))?.refusal).toMatch(/^`run-next` was not applied: /);
  });
});

describe("the two ways in", () => {
  it("the item page may send `run-next` with no note", () => {
    expect(parseCommand({ command: "run-next" })).toEqual({ command: "run-next" });
  });

  it("`factory run-next <id>` stores the request the button stores, as the CLI identity; an unknown item stores nothing", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "1:triage" } });
    const run = async (args: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), "sf-run-next-"));
      const loaded = { root: dir, stateDir: dir, file: {}, config: { repo: { owner: "o", name: "r" }, local_only: true }, registry: REGISTRY, plugins: { clock: "system" } } as unknown as Loaded;
      const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) }) as FactoryStore;
      const out: string[] = [];
      vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
      vi.spyOn(console, "error").mockImplementation((l: string) => void out.push(l));
      const env: CliEnvironment = { gitEmail: "me@example.com", osUser: "me" };
      const code = await RUN_NEXT.run(args, { name: "run-next", usage: "", load: async () => loaded, environment: async () => env, openStore: async () => kept });
      vi.restoreAllMocks();
      return { code, out };
    };
    expect(await run(["wi_nope"])).toEqual({ code: 1, out: ["no work item wi_nope"] });
    const ok = await run([item.id]);
    expect(ok.code).toBe(0);
    expect(ok.out[0]).toContain(`stored \`factory run-next\` for ${item.id} as local:me@example.com`);
    const [stored, ...more] = await store.listAppCommandRequestsForItem(item.id, 10);
    expect(more).toEqual([]);
    expect(stored).toMatchObject({ command: "run-next", actor: "local:me@example.com", args: { work_item_id: item.id } });
    expect(stored!.key).toMatch(/^app:/);
  });
});
