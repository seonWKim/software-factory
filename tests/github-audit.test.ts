// The audit of inbound GitHub commands (design 05-sources): a command's actor is the factory user its GitHub account is
// linked to (src/core/authorize.ts), never a login or a display name. An account no link and no grant names is refused
// through the same permission path: the comment stays in the item's thread under `github:<numeric id>`, and no state
// changes. No audit table of its own.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { UserId, WorkerId, WorkItem } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import {
  FakeBroker, FakeGitHubClient, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, issueRef, prompts, recordingLog, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

/** The factory user an approver's GitHub account is linked to. */
const ANA = "local:ana@example.com" as UserId;
const linked = { id: 42, login: "ana-gh", type: "User" };
const stranger = { id: 99, login: "stranger", type: "User" };

/** GitHub repo o/r in memory: the factory-labelled open issues and the repository's comment list the source polls. */
class Repo extends FakeGitHubClient {
  open: { number: number; title: string; body: string; user: typeof linked; updated_at: string }[] = [];
  polled: { id: number; issue_url: string; html_url: string; body: string; user: typeof linked; updated_at: string }[] = [];

  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const [bare, query = ""] = path.split("?") as [string, string?];
    const firstPage = !/(^|&)page=([2-9]|\d\d)/.test(query);
    if (method === "GET" && bare === "/repos/o/r/issues") return (firstPage && query.includes("state=open") ? this.open : []) as T;
    if (method === "GET" && bare === "/repos/o/r/issues/comments") return (firstPage ? this.polled : []) as T;
    if (method === "GET" && bare === "/repos/o/r/commits") return [] as T;
    if (method === "POST" && /\/reactions$/.test(bare)) return {} as T;
    return super.request<T>(method, path, body);
  }

  comment(n: number, id: number, body: string, user: typeof linked): void {
    this.polled.push({
      id, body, user, updated_at: `2026-11-08T00:00:${String(id % 60).padStart(2, "0")}Z`,
      issue_url: `https://api.github.com/repos/o/r/issues/${n}`, html_url: `https://github.com/o/r/issues/${n}#issuecomment-${id}`,
    });
  }
}

async function factory() {
  const clock = new FakeClock("2026-11-08T09:00:00Z");
  const { store } = await newStore(clock);
  const repo = new Repo();
  const source = new GitHubIssueSource(repo, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  // The owner check; ANA is the owner.
  await store.claimOwner(ANA);
  const auth = new OwnerAuth(store);
  const controller = new ControllerRole({ store, sources: [source], auth, clock, config, log: recordingLog(), scanner: cleanScanner, repeated_failure_rule: false });
  const runner = new FakeRunner({ triage: () => ({ output: triageSpec }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config,
    prompts, log: recordingLog(), scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  // ANA links GitHub account 42 (`factory link-code`, then `/link <code>` from that account).
  await store.createLinkCode(ANA, "123456");
  expect(await store.redeemLinkCode("123456", { provider: "github", subject: String(linked.id) })).toEqual({ ok: true, user_id: ANA });
  /** Issue 7, taken in and triaged: its spec waits for approval. */
  const specced = async (): Promise<WorkItem> => {
    repo.open.push({ number: 7, title: "Add a scope gate", body: "the body", user: linked, updated_at: "2026-11-08T00:00:00Z" });
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    const it = (await store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    expect(it).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    return it;
  };
  return { store, repo, controller, specced };
}

describe("inbound GitHub commands: the actor is the linked factory user", () => {
  it("a /approve from a linked GitHub account is stored with the factory user ID as actor", async () => {
    const f = await factory();
    const item = await f.specced();
    f.repo.comment(7, 501, "/approve", linked);
    await f.controller.tickIntake();

    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "RUNNING" });
    const approval = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved");
    expect(approval?.actor).toEqual({ kind: "user", id: ANA });
    // The thread keeps the account's numeric ID; no login is stored anywhere.
    expect((await f.store.listItemMessages(item.id)).find((m) => m.marker === "github:501")).toMatchObject({ actor: "github:42", body: "/approve" });
    const stored = JSON.stringify([await f.store.listStateChanges(item.id), await f.store.listItemMessages(item.id), await f.store.listCliCommandsAfter(0, 100)]);
    expect(stored).not.toContain("ana-gh");
  });

  it("a /approve from an unlinked GitHub account is refused: recorded as an item message with actor github:<numeric id>, no state change", async () => {
    const f = await factory();
    const item = await f.specced();
    const before = await f.store.getWorkItem(item.id);
    const changes = (await f.store.listStateChanges(item.id)).length;
    f.repo.comment(7, 502, "/approve", stranger);
    await f.controller.tickIntake();

    expect(await f.store.getWorkItem(item.id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", version: before!.version });
    expect(await f.store.listStateChanges(item.id)).toHaveLength(changes);
    expect((await f.store.listItemMessages(item.id)).find((m) => m.marker === "github:502")).toMatchObject({ actor: "github:99", body: "/approve" });
    // The refusal is a reply in the thread, delivered through the outbox like every factory message.
    expect((f.repo.comments.get(7) ?? []).some((c) => /only the owner may send this command/.test(c.body))).toBe(true);
    expect(JSON.stringify(await f.store.listItemMessages(item.id))).not.toContain("stranger");
  });
});
