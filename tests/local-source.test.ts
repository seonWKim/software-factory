import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig } from "../src/compose.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { REGISTRY } from "../src/plugins.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import { LOCAL_BATCH, LocalSource } from "../src/impl/source/local-source.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";
import type { FactoryStore, NewWorkItem } from "../src/interfaces/factory-store.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { fakeRepoLookup } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// The `local` poll source (issue #199): CLI commands from the store's command log become events, and its
// replies are stored as item messages. No GitHub call at all.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

/** A GitHub client that fails the test on any call. */
class ThrowingClient extends GitHubClient {
  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }
  override async request<T>(method: string, path: string): Promise<T> {
    throw new Error(`unexpected GitHub call ${method} ${path}`);
  }
}

function localItem(n: number): NewWorkItem {
  return {
    source: { type: "local", id: `local-${n}`, link: `local:local-${n}` },
    requester_id: "local:owner" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}

async function setup() {
  const { store, clock } = await newStore();
  const item = (await store.createWorkItem(localItem(1), system)).item;
  const source = new LocalSource(store);
  let n = 0;
  const cmd = async (command: string, args: Record<string, unknown> = { item: item.id }, actor = "local:alice") =>
    (await store.appendCliCommand({ key: `k${++n}`, actor, command, args })).command;
  return { store, clock, item, source, cmd };
}

/** Every row the local source could touch, for "changes nothing" checks. */
async function snapshot(store: FactoryStore, id: WorkItemId) {
  return { item: await store.getWorkItem(id), messages: await store.listItemMessages(id), commands: await store.listCliCommandsAfter(0, 1000) };
}

describe("local source: commands become events", () => {
  it("each command maps to the event GitHub would give for the same comment", async () => {
    const { item, source, cmd } = await setup();
    const ref = item.source;
    const who: ExternalIdentity = { provider: "local", subject: "alice" };
    await cmd("approve", { item: item.id, text: "ok" });
    await cmd("reject", { item: item.id, text: "no" });
    await cmd("revise", { item: item.id, text: "more" });
    await cmd("retry");
    await cmd("budget", { item: item.id, text: "5000" });
    await cmd("resolve", { item: item.id, text: "notes" });
    await cmd("help");
    await cmd("verdict", { item: item.id, text: "pass" });
    await cmd("frobnicate");
    await cmd("link", { item: item.id, text: "abc" });
    const { events } = await source.poll(null);
    expect(events).toEqual<SourceEvent[]>([
      { kind: "spec_approved", source: ref, comment_id: "k1", approver: who, note: "ok" },
      { kind: "spec_rejected", source: ref, comment_id: "k2", approver: who, reason: "no" },
      { kind: "revise_requested", source: ref, comment_id: "k3", requester: who, feedback: "more" },
      { kind: "retry_requested", source: ref, comment_id: "k4", requester: who },
      { kind: "budget_continue", source: ref, comment_id: "k5", approver: who, amount: "5000" },
      { kind: "resolve_requested", source: ref, comment_id: "k6", requester: who, notes: "notes", pr: null },
      { kind: "help_requested", source: ref, comment_id: "k7", requester: who },
      { kind: "verdict_submitted", target: { kind: "issue", source: ref }, comment_id: "k8", approver: who, args: "pass" },
      { kind: "unknown_command", source: ref, comment_id: "k9", requester: who, command: "frobnicate" },
      { kind: "plain_comment", source: ref, comment_id: "k10", author: who, body: "/link abc" },
    ]);
    const revise = events[2] as { pr?: unknown };
    expect(revise.pr).toBeUndefined();
  });

  it("retry text is its note, a +paths line included, as on GitHub (issue #280)", async () => {
    const { source, cmd, item } = await setup();
    await cmd("retry", { item: item.id, text: "+paths src/a.ts\nkeep it small" });
    await cmd("approve", { item: item.id, text: "+paths src/a.ts" });
    const { events } = await source.poll(null);
    expect(events[0]).toMatchObject({ kind: "retry_requested", note: "+paths src/a.ts\nkeep it small" });
    expect(events[1]).toMatchObject({ kind: "spec_approved", note: "+paths src/a.ts" });
  });

  it("no text: approve has an empty note and budget a null amount", async () => {
    const { source, cmd } = await setup();
    await cmd("approve");
    await cmd("budget");
    const { events } = await source.poll(null);
    expect(events[0]).toMatchObject({ kind: "spec_approved", note: "" });
    expect(events[1]).toMatchObject({ kind: "budget_continue", amount: null });
  });

  it("the identity is provider local, subject the actor after `local:`", async () => {
    const { source, cmd } = await setup();
    await cmd("retry", undefined, "local:bob");
    const { events } = await source.poll(null);
    expect(events[0]).toMatchObject({ requester: { provider: "local", subject: "bob" } });
  });

  it("a command for a missing item or a non-local item gives no event, and the cursor moves past it", async () => {
    const { store, source, cmd } = await setup();
    const gh = (await store.createWorkItem(issue(2), system)).item;
    await cmd("retry", { item: "wi_missing" });
    const last = await cmd("retry", { item: gh.id });
    const r = await source.poll(null);
    expect(r.events).toEqual([]);
    expect(r.next_cursor).toBe(String(last.seq));
  });
});

describe("local source: cursor", () => {
  it("poll(null) reads from the first command; next_cursor is the last seq read", async () => {
    const { source, cmd } = await setup();
    await cmd("retry");
    const last = await cmd("help");
    const r = await source.poll(null);
    expect(r.events.map((e) => e.kind)).toEqual(["retry_requested", "help_requested"]);
    expect(r.next_cursor).toBe(String(last.seq));
  });

  it("an empty cursor means 0", async () => {
    const { source, cmd } = await setup();
    await cmd("retry");
    expect((await source.poll("")).events).toHaveLength(1);
  });

  it("a later poll with the cursor returns nothing read before it", async () => {
    const { source, cmd } = await setup();
    await cmd("retry");
    const first = await source.poll(null);
    await cmd("help");
    const second = await source.poll(first.next_cursor);
    expect(second.events.map((e) => (e as { comment_id: string }).comment_id)).toEqual(["k2"]);
  });

  it("with nothing new the cursor stays where it was", async () => {
    const { source, cmd } = await setup();
    await cmd("retry");
    const first = await source.poll(null);
    const again = await source.poll(first.next_cursor);
    expect(again).toEqual({ events: [], next_cursor: first.next_cursor });
  });

  it(`one poll reads at most ${LOCAL_BATCH} commands; the rest come on the next`, async () => {
    const { source, cmd } = await setup();
    expect(LOCAL_BATCH).toBe(100);
    for (let i = 0; i < 105; i++) await cmd("retry");
    const first = await source.poll(null);
    expect(first.events).toHaveLength(100);
    const second = await source.poll(first.next_cursor);
    expect(second.events).toHaveLength(5);
  });

  it("a command delivered by one poll is not delivered again after the cursor advances", async () => {
    const { store, source, cmd } = await setup();
    await cmd("retry");
    const before = await store.getCursor("intake:local");
    const first = await source.poll(before);
    expect(await store.advanceCursor("intake:local", before, first.next_cursor)).toBe(true);
    const second = await source.poll(await store.getCursor("intake:local"));
    expect(first.events).toHaveLength(1);
    expect(second.events).toEqual([]);
  });

  it("a store read error makes poll throw", async () => {
    const { store, cmd } = await setup();
    await cmd("retry");
    const broken = Object.create(store) as FactoryStore;
    broken.listCliCommandsAfter = async () => {
      throw new Error("db down");
    };
    await expect(new LocalSource(broken).poll(null)).rejects.toThrow("db down");
  });
});

describe("local source: replies", () => {
  it("postComment stores one message, returns url null, and makes no GitHub call", async () => {
    const { store, item } = await setup();
    const source = new LocalSource(store);
    expect(await source.postComment(item.source, "hello", "m1")).toEqual({ url: null });
    const msgs = await store.listItemMessages(item.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ marker: "m1", body: "hello" });
  });

  it("a second postComment with the same marker stores nothing new", async () => {
    const { store, item, source } = await setup();
    await source.postComment(item.source, "first", "m1");
    expect(await source.postComment(item.source, "second", "m1")).toEqual({ url: null });
    const msgs = await store.listItemMessages(item.id);
    expect(msgs.map((m) => m.body)).toEqual(["first"]);
  });

  it("postComment for a source id with no item throws naming the id, and stores nothing", async () => {
    const { store, item, source } = await setup();
    await expect(source.postComment({ type: "local", id: "local-404", link: "" }, "x", "m")).rejects.toThrow("local-404");
    expect(await store.listItemMessages(item.id)).toEqual([]);
  });

  it("markSeen, setStatus and closeIssue change no store row", async () => {
    const { store, item, source, cmd } = await setup();
    await cmd("retry");
    const before = await snapshot(store, item.id);
    await source.markSeen(item.source, "k1");
    await source.markSeen(item.source, null);
    await source.setStatus(item.source, "implementing", null);
    await source.closeIssue(item.source, "not_planned");
    expect(await snapshot(store, item.id)).toEqual(before);
  });
});

describe("local source plugin", () => {
  afterEach(() => vi.unstubAllEnvs());

  function root(source: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-local-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const file = { ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none", source }, state_dir: "state", worktrees_dir: "wt" };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify(file));
    writeFileSync(join(dir, "secrets.env"), "GITHUB_TOKEN=gh\nMYSQL_PASSWORD=pw\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
    return dir;
  }

  async function builtSources(source: unknown) {
    const built = await build(await loadConfig(root(source)), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      return (built.controller as unknown as { sources: readonly unknown[] }).sources;
    } finally {
      await built.close();
    }
  }

  it("is registered as source plugin `local`, with no secrets, and is not the default", () => {
    expect(REGISTRY.source.plugins.local).toBeTypeOf("function");
    expect(REGISTRY.source.secrets.local).toEqual([]);
    expect(REGISTRY.source.defaults.fallback).toBe("github-issues");
  });

  it('`plugins.source: "local"` selects the local source', async () => {
    const sources = await builtSources("local");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(LocalSource);
  });

  it('`["github-issues", "local"]` builds both, in that order', async () => {
    const sources = await builtSources(["github-issues", "local"]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBeInstanceOf(GitHubIssueSource);
    expect(sources[1]).toBeInstanceOf(LocalSource);
  });

  it("the plugin's source makes no GitHub call when posting", async () => {
    const { store, item } = await setup();
    const { default: desc } = await import("../src/impl/source/local.plugin.js");
    const loaded = await loadConfig(root("local"));
    const src = await desc.create({ loaded, repo: loaded.config.repo, extraScanValues: [], github: new ThrowingClient(), store });
    expect(await src.postComment(item.source, "hi", "m")).toEqual({ url: null });
    await src.markSeen(item.source, null);
    await src.setStatus(item.source, "done", null);
    await src.closeIssue(item.source);
    expect(await store.listItemMessages(item.id)).toHaveLength(1);
  });
});
