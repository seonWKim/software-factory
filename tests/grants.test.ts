import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_ACTIONS, authorize } from "../src/core/authorize.js";
import { Controller } from "../src/core/controller.js";
import type { Actor, UserId, WorkItem } from "../src/core/types.js";
import { GitHubAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { newLinkCode } from "../src/impl/auth/link-code.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubError } from "../src/impl/github/github-client.js";
import { GitHubPermissionGrant } from "../src/impl/grant/github-permission.js";
import { StaticGrant, staticGrantConfig } from "../src/impl/grant/static.js";
import type { ExternalIdentity, GrantSource, GrantSubject, Role } from "../src/interfaces/auth-provider.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { GRANTS, selectGrants } from "../src/plugins.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
import { FakeSource, cleanScanner, config, issueRef, recordingLog } from "./helpers/fakes.js";

// Permissions in the factory (design 2026-11-01, issue #107): factory users, linked accounts, grant plugins whose
// union decides, minus denies, through one authorize check.

const system: Actor = { kind: "system", id: "system:test" };
const gh = (subject: string, login = `u${subject}`): ExternalIdentity => ({ provider: "github", subject, login });
const slack = (subject: string): ExternalIdentity => ({ provider: "slack", subject });

/** GitHub's user and collaborator-permission endpoints for o/r. Records every call; an unknown user is a 404. */
class FakeGitHub {
  calls: string[] = [];
  constructor(private readonly perms: Record<string, string>) {}
  async request<T>(method: string, path: string): Promise<T> {
    this.calls.push(`${method} ${path}`);
    const user = /^\/user\/(\d+)$/.exec(path);
    if (user) return { login: `u${user[1]}` } as T;
    const perm = /^\/repos\/o\/r\/collaborators\/u(\d+)\/permission$/.exec(path);
    if (perm && this.perms[perm[1]!]) return { permission: this.perms[perm[1]!] } as T;
    throw new GitHubError(404, "Not Found");
  }
  /** Calls that looked up `id`'s permission. */
  permissionCalls(id: string): string[] {
    return this.calls.filter((c) => c.includes(`/collaborators/u${id}/`) || c.endsWith(`/user/${id}`));
  }
}

async function setup(opts: { perms?: Record<string, string>; static?: unknown; order?: "static-first" | "github-first" } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const github = new FakeGitHub(opts.perms ?? { "1": "write" });
  const ghGrant = new GitHubPermissionGrant(github, { owner: "o", name: "r" });
  const grants: GrantSource[] = [ghGrant];
  if (opts.static !== undefined) {
    const st = new StaticGrant(staticGrantConfig(opts.static));
    if (opts.order === "static-first") grants.unshift(st);
    else grants.push(st);
  }
  const auth = new GitHubAuthProvider(store, grants);
  const source = new FakeSource();
  const log = recordingLog();
  const controller = new Controller({ store, source, auth, clock, config, log, scanner: cleanScanner });
  return { clock, store, github, source, log, auth, controller };
}
type F = Awaited<ReturnType<typeof setup>>;

async function atSpecGate(f: F, n: number): Promise<WorkItem> {
  const { item } = await f.store.createWorkItem(
    { source: issueRef(n), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
    system,
  );
  const r = await f.store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "test",
    patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
  });
  if (!r.ok) throw new Error("setup transition failed");
  return r.item;
}

async function approve(f: F, n: number, who: ExternalIdentity, comment = String(n * 10)) {
  f.source.queue.push({ kind: "spec_approved", source: issueRef(n), comment_id: comment, approver: who });
  await f.controller.tickIntake();
  const item = (await f.store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  const refusals = f.source.comments.filter((c) => c.marker === `<!-- factory:refused:${comment} -->`);
  return { item, refusals };
}

async function link(f: F, user: string, who: ExternalIdentity): Promise<void> {
  const code = newLinkCode();
  await f.store.createLinkCode(user as UserId, code);
  expect(await f.store.redeemLinkCode(code, { provider: who.provider, subject: who.subject })).toMatchObject({ ok: true });
}

describe("who may /approve", () => {
  it("a GitHub account with write access, as today", async () => {
    const f = await setup();
    await atSpecGate(f, 1);
    const { item, refusals } = await approve(f, 1, gh("1"));
    expect(refusals).toEqual([]);
    expect(item.stage).toBe("RUNNING");
    const row = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(row.actor).toEqual({ kind: "user", id: "github:1" });
  });

  it("a GitHub account with only read access is refused", async () => {
    const f = await setup({ perms: { "1": "write", "2": "read" } });
    await atSpecGate(f, 2);
    const { item, refusals } = await approve(f, 2, gh("2"));
    expect(item.stage).toBe("READY");
    expect(refusals).toHaveLength(1);
  });

  it("a Slack identity linked to that factory user, acting as the factory user", async () => {
    const f = await setup();
    await link(f, "github:1", slack("U1"));
    await atSpecGate(f, 3);
    const { item, refusals } = await approve(f, 3, slack("U1"));
    expect(refusals).toEqual([]);
    expect(item.stage).toBe("RUNNING");
    const row = (await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!;
    expect(row.actor).toEqual({ kind: "user", id: "github:1" });
  });

  it("an unlinked Slack identity: one reply saying the account is not linked, and the store does not change", async () => {
    const f = await setup();
    const before = await atSpecGate(f, 4);
    const changes = await f.store.listStateChanges(before.id);
    const { item, refusals } = await approve(f, 4, slack("U404"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.body).toMatch(/not linked/);
    expect(item).toEqual(before);
    expect(await f.store.listStateChanges(before.id)).toEqual(changes);
    expect(await f.store.listRuns(before.id)).toEqual([]);
    expect(await f.store.resolveLink("slack", "U404")).toBeNull();
    expect(f.github.calls).toEqual([]);
    // A redelivery posts nothing new.
    f.source.queue.push({ kind: "spec_approved", source: issueRef(4), comment_id: "40", approver: slack("U404") });
    await f.controller.tickIntake();
    expect(f.source.comments.filter((c) => c.marker === "<!-- factory:refused:40 -->")).toHaveLength(1);
  });

  it("a user under the static grant, with no GitHub permission and no GitHub call for them", async () => {
    const f = await setup({ perms: {}, static: { roles: { "github:7": { "*": ["approver"] } } } });
    await atSpecGate(f, 5);
    const { item, refusals } = await approve(f, 5, gh("7"));
    expect(refusals).toEqual([]);
    expect(item.stage).toBe("RUNNING");
    expect(f.github.permissionCalls("7")).toEqual([]);
    expect(f.github.calls).toEqual([]);
  });

  it("a static grant on another project gives nothing here", async () => {
    const f = await setup({ perms: {}, static: { roles: { "github:7": { "github:github.com:R_other": ["approver"] } } } });
    await atSpecGate(f, 6);
    const { item, refusals } = await approve(f, 6, gh("7"));
    expect(item.stage).toBe("READY");
    expect(refusals).toHaveLength(1);
  });

  it("an explicit deny overrides a GitHub write grant, whatever the grant order", async () => {
    for (const order of ["static-first", "github-first"] as const) {
      const f = await setup({ static: { deny: { "github:1": ["*"] } }, order });
      await atSpecGate(f, 7);
      const { item, refusals } = await approve(f, 7, gh("1"));
      expect(item.stage, order).toBe("READY");
      expect(refusals, order).toHaveLength(1);
      expect(refusals[0]!.body).toContain("`denied`");
    }
  });

  it("a deny also covers every account linked to the user", async () => {
    const f = await setup({ static: { deny: { "github:1": [PROJECT_KEY] } } });
    await link(f, "github:1", slack("U1"));
    await atSpecGate(f, 8);
    const { item } = await approve(f, 8, slack("U1"));
    expect(item.stage).toBe("READY");
  });
});

describe("one shared authorize check", () => {
  /** Records the user ids it is asked about; gives approver to everyone. */
  class Recording implements GrantSource {
    readonly remote = false;
    asked: string[] = [];
    async denies(s: GrantSubject) {
      this.asked.push(s.user_id);
      return false;
    }
    async roles(): Promise<Role[]> {
      return ["approver"];
    }
  }

  it("every command path asks the grants with the factory user id, never the provider account", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const grant = new Recording();
    const auth = new GitHubAuthProvider(store, [grant]);
    const source = new FakeSource();
    const controller = new Controller({ store, source, auth, clock, config, log: recordingLog(), scanner: cleanScanner });
    const code = newLinkCode();
    await store.createLinkCode("github:1" as UserId, code);
    await store.redeemLinkCode(code, { provider: "slack", subject: "U1" });
    const who = slack("U1");
    const src = issueRef(1);
    await store.createWorkItem({ source: src, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    const events: SourceEvent[] = [
      { kind: "spec_approved", source: src, comment_id: "1", approver: who },
      { kind: "spec_rejected", source: src, comment_id: "2", approver: who, reason: "r" },
      { kind: "revise_requested", source: src, comment_id: "3", requester: who, feedback: "f" },
      { kind: "retry_requested", source: src, comment_id: "4", requester: who },
      { kind: "resolve_requested", source: src, comment_id: "5", requester: who, notes: "", pr: null },
      { kind: "budget_continue", source: src, comment_id: "6", approver: who, amount: null },
      { kind: "verdict_submitted", target: { kind: "issue", source: src }, comment_id: "7", approver: who, args: "accept none" },
    ];
    for (const e of events) {
      grant.asked = [];
      await controller.handleEvent(e);
      expect(grant.asked, e.kind).toEqual(["github:1"]);
    }
  });

  it("no code outside the github-permission grant asks GitHub for a permission", () => {
    const SRC = join(import.meta.dirname, "..", "src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
    const asking = files(SRC).filter((f) => /\/collaborators\//.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(asking).toEqual([join("impl", "grant", "github-permission.ts")]);
  });

  it("the controller decides permission only through its one authorize helper", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "src", "core", "controller.ts"), "utf8");
    expect(text.match(/\.auth\.authorize\(/g)).toHaveLength(1);
  });

  it("roles map onto the existing actions; approver covers every gate action", () => {
    expect(ROLE_ACTIONS.requester).toEqual(["submit_work"]);
    expect([...ROLE_ACTIONS.approver].sort()).toEqual(["approve_merge", "approve_spec", "record_verdict", "submit_work", "use_tool"]);
  });

  it("union of grants: any grant giving the action allows; no grant refuses with no_role", async () => {
    const { store } = await newStore();
    const fixed = (roles: Role[], remote = false): GrantSource => ({ remote, denies: async () => false, roles: async () => roles });
    const res = { kind: "project" as const, id: PROJECT_KEY };
    const u = "github:9" as UserId;
    expect(await authorize({ store, grants: [fixed([]), fixed(["approver"])] }, u, "approve_spec", res)).toEqual({ allow: true });
    expect(await authorize({ store, grants: [fixed(["requester"])] }, u, "approve_spec", res)).toEqual({ allow: false, reason: "no_role" });
    expect(await authorize({ store, grants: [] }, u, "approve_spec", res)).toEqual({ allow: false, reason: "no_role" });
    // submit_work stays open to any resolved user (the intake label is its gate), unless denied.
    expect(await authorize({ store, grants: [] }, u, "submit_work", res)).toEqual({ allow: true });
    const deny: GrantSource = { remote: false, denies: async () => true, roles: async () => [] };
    expect(await authorize({ store, grants: [deny] }, u, "submit_work", res)).toEqual({ allow: false, reason: "denied" });
  });

  it("asks local grants before remote ones, and stops at the first that gives the action", async () => {
    const { store } = await newStore();
    const asked: string[] = [];
    const g = (name: string, remote: boolean, roles: Role[]): GrantSource => ({
      remote, denies: async () => false, roles: async () => (asked.push(name), roles),
    });
    const res = { kind: "project" as const, id: PROJECT_KEY };
    await authorize({ store, grants: [g("remote", true, ["approver"]), g("local", false, ["approver"])] }, "github:9" as UserId, "approve_spec", res);
    expect(asked).toEqual(["local"]);
  });
});

describe("grant plugins", () => {
  it("github-permission: write, maintain or admin gives approver; read or triage gives requester; none gives nothing", async () => {
    const github = new FakeGitHub({ "1": "admin", "2": "maintain", "3": "write", "4": "triage", "5": "read" });
    const g = new GitHubPermissionGrant(github, { owner: "o", name: "r" });
    const roles = (id: string) => g.roles({ user_id: `github:${id}` as UserId, accounts: [{ provider: "github", subject: id }] }, PROJECT_KEY);
    for (const id of ["1", "2", "3"]) expect(await roles(id), id).toEqual(["approver"]);
    for (const id of ["4", "5"]) expect(await roles(id), id).toEqual(["requester"]);
    expect(await roles("6")).toEqual([]);
    expect(await g.roles({ user_id: "slack:U1" as UserId, accounts: [{ provider: "slack", subject: "U1" }] }, PROJECT_KEY)).toEqual([]);
    expect(await g.denies({ user_id: "github:1" as UserId, accounts: [{ provider: "github", subject: "1" }] }, PROJECT_KEY)).toBe(false);
    expect(g.remote).toBe(true);
  });

  it("static: roles per user and project (or every project), denies, and a bad config fails at startup", async () => {
    const g = new StaticGrant(staticGrantConfig({ roles: { "github:7": { "*": ["requester"], [PROJECT_KEY]: ["approver"] } }, deny: { "github:8": ["*"] } }));
    const s = (id: string): GrantSubject => ({ user_id: id as UserId, accounts: [] });
    expect([...(await g.roles(s("github:7"), PROJECT_KEY))].sort()).toEqual(["approver", "requester"]);
    expect(await g.roles(s("github:7"), "github:github.com:R_other")).toEqual(["requester"]);
    expect(await g.denies(s("github:8"), PROJECT_KEY)).toBe(true);
    expect(await g.denies(s("github:7"), PROJECT_KEY)).toBe(false);
    expect(g.remote).toBe(false);
    expect(() => staticGrantConfig({ roles: { "github:7": { "*": ["owner"] } } })).toThrow(/permissions.static.roles/);
    expect(() => staticGrantConfig({ deny: ["github:7"] })).toThrow(/permissions.static.deny/);
    expect(() => staticGrantConfig({ roles: { alice: { "*": ["approver"] } } })).toThrow(/user id/);
    expect(() => staticGrantConfig({ extra: 1 })).toThrow(/permissions.static/);
    expect(staticGrantConfig(undefined)).toEqual({ roles: {}, deny: {} });
  });

  it("permissions.grants: default github-permission; a list of known names; unknown, empty or repeated fails", () => {
    expect(Object.keys(GRANTS).sort()).toEqual(["github-permission", "static"]);
    expect(selectGrants(GRANTS, undefined)).toEqual(["github-permission"]);
    expect(selectGrants(GRANTS, {})).toEqual(["github-permission"]);
    expect(selectGrants(GRANTS, { grants: ["static", "github-permission"] })).toEqual(["static", "github-permission"]);
    expect(() => selectGrants(GRANTS, { grants: ["githubb-permission"] })).toThrow(/github-permission/);
    expect(() => selectGrants(GRANTS, { grants: [] })).toThrow(/permissions.grants/);
    expect(() => selectGrants(GRANTS, { grants: ["static", "static"] })).toThrow(/twice/);
    expect(() => selectGrants(GRANTS, { grant: ["static"] })).toThrow(/permissions/);
  });
});
