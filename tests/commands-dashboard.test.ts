import { describe, expect, it } from "vitest";
import { parseCommandPaths } from "../src/core/commands.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { UserId, WorkItem, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { newStore, PROJECT_KEY, system, w1 } from "./helpers/store.js";

describe("+paths from the dashboard on /retry and /resolve (design 09-dashboard-item-commands, 2026-11-26)", () => {
  const ME = "local:me" as UserId;
  const auth: AuthProvider = { resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId }), authorize: async () => ({ allow: true }) };
  const NOTE = "+paths a/b.ts\nkeep both imports";

  async function harness() {
    const { store, clock } = await newStore();
    const controller = new ControllerRole({ store, source: new FakeSource(), auth, clock, config, log: silent, scanner: cleanScanner });
    /** A new item on issue `n`, set to `patch`; with `failed`, after one failed run of that kind. */
    const itemIn = async (n: number, patch: WorkItemPatch, failed: "implement" | "resolve") => {
      const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: "github:1" as never, project: PROJECT_KEY, problem: "p", resources: [] }, system);
      const queued = await store.transition({ id: item.id, expected_version: item.version, patch: {}, actor: system, reason: "setup", enqueue: { kind: failed, idempotency_key: `${failed}:${n}` } });
      if (!queued.ok) throw new Error("setup failed");
      const run = (await store.claimRun({ worker_id: w1, kinds: [failed], lease_ms: 60_000 }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "out_of_scope", detail: "x", infra: false });
      const r = await store.transition({ id: item.id, expected_version: queued.item.version, actor: system, reason: "setup", patch: { ...patch, tier: 2 } });
      if (!r.ok) throw new Error("setup failed");
      return r.item;
    };
    /** `command` with `note` as the dashboard sends it: one app request row, then a controller tick. */
    const send = async (it: WorkItem, command: string, note: string, key: string) => {
      await store.recordAppCommandRequest({ key, actor: ME, command, args: { work_item_id: it.id, note } });
      await controller.tickCommands();
      return (await store.listAppCommandRequestsForItem(it.id, 5)).find((r) => r.key === key)!;
    };
    const queuedOf = async (id: WorkItemId, kind: string) => (await store.listRuns(id)).filter((r) => r.kind === kind && r.status === "queued");
    return { store, itemIn, send, queuedOf };
  }
  const CONFLICT: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending", change_ref: "42" };
  const FAILED_IMPLEMENT: WorkItemPatch = { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts" };

  it("a /resolve with +paths on its first line widens allowed_paths and queues a resolve run with the notes below", async () => {
    const h = await harness();
    const it = await h.itemIn(40_001, CONFLICT, "resolve");
    const r = await h.send(it, "resolve", NOTE, "kr1");
    expect(r.refusal).toBeNull();
    const now = (await h.store.getWorkItem(it.id))!;
    expect(now.allowed_paths).toEqual([...it.allowed_paths, "a/b.ts"]);
    expect((await h.queuedOf(it.id, "resolve")).map((x) => x.input)).toEqual([{ notes: "keep both imports" }]);
    expect((await h.store.listStateChanges(it.id)).find((c) => c.reason === "resolve_requested")?.detail?.added_paths).toBe(JSON.stringify(["a/b.ts"]));
  });

  it("a /retry with +paths on its first line after a failed implement run widens allowed_paths and queues an implement run with the note below", async () => {
    const h = await harness();
    const it = await h.itemIn(40_002, FAILED_IMPLEMENT, "implement");
    const r = await h.send(it, "retry", NOTE, "kr2");
    expect(r.refusal).toBeNull();
    expect((await h.store.getWorkItem(it.id))!.allowed_paths).toEqual([...it.allowed_paths, "a/b.ts"]);
    expect(await h.queuedOf(it.id, "implement")).toHaveLength(1);
    expect((await h.store.listStateChanges(it.id)).find((c) => c.reason === "retry_requested")?.detail).toMatchObject({ added_paths: JSON.stringify(["a/b.ts"]), note: "keep both imports" });
  });

  it("a +paths line the CLI would refuse is refused with the CLI's words, and nothing changes", async () => {
    const h = await harness();
    for (const [n, command, kind, patch] of [[40_003, "resolve", "resolve", CONFLICT], [40_004, "retry", "implement", FAILED_IMPLEMENT]] as const) {
      const it = await h.itemIn(n, patch, kind);
      const r = await h.send(it, command, "+paths ../x.ts\nkeep both", `kb${n}`);
      const words = parseCommandPaths("+paths ../x.ts", `/${command}`);
      if (!("refuse" in words)) throw new Error("the CLI accepts it");
      expect(r.refusal).toContain(words.refuse);
      expect(await h.store.getWorkItem(it.id)).toEqual(it);
      expect(await h.queuedOf(it.id, kind)).toEqual([]);
    }
  });
});
