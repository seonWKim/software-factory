// The `local` source plugin (issue #199): reads CLI commands from the store as events, stores replies as item
// messages, and never calls GitHub.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig } from "../src/compose.js";
import type { SourceRef, UserId, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import localDescriptor from "../src/impl/source/local.plugin.js";
import { LOCAL_BATCH, LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore, NewWorkItem } from "../src/interfaces/factory-store.js";
import type { PollSource, SourceEvent } from "../src/interfaces/source-adapter.js";
import type { Contexts } from "../src/plugin-api.js";
import { REGISTRY, defaultPlugins } from "../src/plugins.js";
import { fakeRepoLookup } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

/** A GitHub client that fails the test on any use. */
const throwingGithub = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`GitHub client used: ${String(prop)}`);
  },
}) as GitHubClient;

function localItem(n: number): NewWorkItem {
  return {
    source: { type: "local", id: `local-${n}`, link: `local:local-${n}` },
    requester_id: "local:owner" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}

/** The source built through its descriptor, with a GitHub client that throws. */
async function makeSource(store: FactoryStore): Promise<PollSource> {
  const ctx = { github: throwingGithub, store } as unknown as Contexts["source"];
  const s = await localDescriptor.create(ctx);
  if (s.intake !== "poll") throw new Error("local source must be a poll source");
  return s;
}

async function setup() {
  const { store, clock } = await newStore();
  const item = (await store.createWorkItem(localItem(1), system)).item;
  const source = await makeSource(store);
  let n = 0;
  const cmd = async (command: string, args: Record<string, unknown> = { item: item.id }, actor = "local:alice") =>
    (await store.appendCliCommand({ key: `k${++n}`, actor, command, args })).command;
  return { store, clock, item, source, cmd };
}

describe("local source: descriptor", () => {
  it("registers as source plugin local, declares no secrets, and is not the default", () => {
    expect(localDescriptor.kind).toBe("source");
    expect(localDescriptor.name).toBe("local");
    expect(localDescriptor.secrets ?? []).toEqual([]);
    expect(localDescriptor.default).toBeUndefined();
    expect(REGISTRY.source.plugins["local"]).toBeDefined();
    expect(REGISTRY.source.secrets["local"]).toEqual([]);
    expect(defaultPlugins("darwin").source).toBe("github-issues");
    expect(defaultPlugins("linux").source).toBe("github-issues");
  });
});

describe("local source: build()", () => {
  afterEach(() => vi.unstubAllEnvs());

  function root(source: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-local-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const config = { ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none", source } };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
    return dir;
  }

  const sourcesOf = (built: { controller: unknown }) => (built.controller as { sources: readonly unknown[] }).sources;

  it('plugins.source "local" builds the local source', async () => {
    const built = await build(await loadConfig(root("local")), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const sources = sourcesOf(built);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toBeInstanceOf(LocalSource);
    } finally {
      await built.close();
    }
  });

  it('plugins.source ["github-issues", "local"] builds both, in that order', async () => {
    const built = await build(await loadConfig(root(["github-issues", "local"])), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const sources = sourcesOf(built);
      expect(sources).toHaveLength(2);
      expect(sources[0]).toBeInstanceOf(GitHubIssueSource);
      expect(sources[1]).toBeInstanceOf(LocalSource);
    } finally {
      await built.close();
    }
  });
});

describe("local source: poll", () => {
  const who = { provider: "local", subject: "alice" };

  it("turns each command into the event GitHub would give", async () => {
    const f = await setup();
    const withText = (text: string) => ({ item: f.item.id, text });
    const src: SourceRef = f.item.source;
    const c = [
      await f.cmd("approve", withText("looks good")),
      await f.cmd("reject", withText("not now")),
      await f.cmd("revise", withText("more tests")),
      await f.cmd("retry"),
      await f.cmd("budget", withText("50000")),
      await f.cmd("resolve", withText("keep both")),
      await f.cmd("help"),
      await f.cmd("verdict", withText("pass")),
      await f.cmd("frobnicate"),
      await f.cmd("link", withText("abc123")),
    ];
    const { events } = await f.source.poll(null);
    const expected: SourceEvent[] = [
      { kind: "spec_approved", source: src, comment_id: c[0]!.key, approver: who as never, note: "looks good" },
      { kind: "spec_rejected", source: src, comment_id: c[1]!.key, approver: who as never, reason: "not now" },
      { kind: "revise_requested", source: src, comment_id: c[2]!.key, requester: who as never, feedback: "more tests" },
      { kind: "retry_requested", source: src, comment_id: c[3]!.key, requester: who as never },
      { kind: "budget_continue", source: src, comment_id: c[4]!.key, approver: who as never, amount: "50000" },
      { kind: "resolve_requested", source: src, comment_id: c[5]!.key, requester: who as never, notes: "keep both", pr: null },
      { kind: "help_requested", source: src, comment_id: c[6]!.key, requester: who as never },
      { kind: "verdict_submitted", target: { kind: "issue", source: src }, comment_id: c[7]!.key, approver: who as never, args: "pass" },
      { kind: "unknown_command", source: src, comment_id: c[8]!.key, requester: who as never, command: "frobnicate" },
      { kind: "plain_comment", source: src, comment_id: c[9]!.key, author: who as never, body: "/link abc123" },
    ];
    expect(events).toEqual(expected);
    // revise has no pr at all.
    expect("pr" in events[2]!).toBe(false);
  });

  it("budget with no text gives amount null; the identity subject is the part after local:", async () => {
    const f = await setup();
    await f.cmd("budget", { item: f.item.id }, "local:bob");
    const { events } = await f.source.poll(null);
    expect(events).toEqual([
      { kind: "budget_continue", source: f.item.source, comment_id: "k1", approver: { provider: "local", subject: "bob" }, amount: null },
    ]);
  });

  it("a command for a missing item, or a non-local item, gives no event, and the cursor moves past it", async () => {
    const f = await setup();
    const gh = (await f.store.createWorkItem(issue(9), system)).item;
    await f.cmd("approve", { item: "wi_missing" });
    const last = await f.cmd("approve", { item: gh.id });
    const r = await f.source.poll(null);
    expect(r.events).toEqual([]);
    expect(r.next_cursor).toBe(String(last.seq));
    expect((await f.source.poll(r.next_cursor)).events).toEqual([]);
  });

  it("poll(null) reads from the first command; next_cursor is the last seq read; a later poll skips what was read", async () => {
    const f = await setup();
    const a = await f.cmd("help");
    const b = await f.cmd("retry");
    const first = await f.source.poll(null);
    expect(first.events.map((e) => (e as { comment_id: string }).comment_id)).toEqual([a.key, b.key]);
    expect(first.next_cursor).toBe(String(b.seq));
    expect(await f.source.poll("")).toEqual(first);

    const c = await f.cmd("approve");
    const second = await f.source.poll(first.next_cursor);
    expect(second.events.map((e) => (e as { comment_id: string }).comment_id)).toEqual([c.key]);
    expect(second.next_cursor).toBe(String(c.seq));

    // Nothing new: nothing delivered again, cursor stays.
    const third = await f.source.poll(second.next_cursor);
    expect(third).toEqual({ events: [], next_cursor: second.next_cursor });
  });

  it(`reads at most ${LOCAL_BATCH} commands per poll; the rest come next`, async () => {
    expect(LOCAL_BATCH).toBe(100);
    const f = await setup();
    const all = [];
    for (let i = 0; i < 130; i++) all.push(await f.cmd("help"));
    const first = await f.source.poll(null);
    expect(first.events).toHaveLength(100);
    expect(first.next_cursor).toBe(String(all[99]!.seq));
    const second = await f.source.poll(first.next_cursor);
    expect(second.events).toHaveLength(30);
    expect(second.next_cursor).toBe(String(all[129]!.seq));
    const keys = [...first.events, ...second.events].map((e) => (e as { comment_id: string }).comment_id);
    expect(new Set(keys).size).toBe(130);
  });

  it("a store read error makes poll throw", async () => {
    const f = await setup();
    await f.cmd("help");
    const broken = Object.create(f.store) as FactoryStore;
    broken.listCliCommandsAfter = async () => {
      throw new Error("store down");
    };
    await expect((await makeSource(broken)).poll(null)).rejects.toThrow(/store down/);
  });
});

describe("local source: replies and markers", () => {
  async function snapshot(store: FactoryStore, item: WorkItem) {
    return {
      item: await store.getWorkItem(item.id),
      messages: await store.listItemMessages(item.id),
      commands: await store.listCliCommandsAfter(0, 1000),
    };
  }

  it("postComment stores one message, returns url null, and makes no GitHub call", async () => {
    const f = await setup();
    expect(await f.source.postComment(f.item.source, "hello", "m1")).toEqual({ url: null });
    const msgs = await f.store.listItemMessages(f.item.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ work_item_id: f.item.id, marker: "m1", body: "hello" });
  });

  it("a second postComment with the same marker stores nothing new; the first body stays", async () => {
    const f = await setup();
    await f.source.postComment(f.item.source, "first", "m1");
    expect(await f.source.postComment(f.item.source, "second", "m1")).toEqual({ url: null });
    const msgs = await f.store.listItemMessages(f.item.id);
    expect(msgs.map((m) => m.body)).toEqual(["first"]);
  });

  it("postComment for a source id with no item throws naming the id, and stores nothing", async () => {
    const f = await setup();
    const ghost: SourceRef = { type: "local", id: "local-404", link: "local:local-404" };
    await expect(f.source.postComment(ghost, "x", "m1")).rejects.toThrow(/local-404/);
    expect(await f.store.listItemMessages(f.item.id)).toEqual([]);
  });

  it("markSeen, setStatus and closeIssue make no GitHub call and change no store row", async () => {
    const f = await setup();
    await f.cmd("help");
    await f.source.postComment(f.item.source, "hello", "m1");
    const before = await snapshot(f.store, f.item);
    await f.source.markSeen(f.item.source, "k1");
    await f.source.markSeen(f.item.source, null);
    await f.source.setStatus(f.item.source, "done", null);
    await f.source.setStatus(f.item.source, "in_review", 3);
    await f.source.closeIssue(f.item.source);
    await f.source.closeIssue(f.item.source, "completed");
    expect(await snapshot(f.store, f.item)).toEqual(before);
  });
});
