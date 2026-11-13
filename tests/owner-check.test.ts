import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { topicTables } from "../src/bus/index.js";
import { NOT_OWNER, NOT_OWNER_REPLY, OwnerAuth, authorizeOwner } from "../src/core/authorize.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import { startIdentity } from "../src/identity/index.js";
import { AuditedAuthProvider, controllerServiceAuth, outboundServiceAuth } from "../src/impl/auth/audited-auth.js";
import { PassportToolBroker } from "../src/impl/broker/passport-broker.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";
import type { ToolBroker } from "../src/interfaces/tool-broker.js";
import { PackApprovalsStore, changeApproval } from "../src/packs/pack-approvals.store.js";
import { PackEntriesStore } from "../src/packs/pack-entries.store.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { commandsPost } from "../src/ui/commands.js";
import type { UiDeps } from "../src/ui/pages.js";
import { RunPassports } from "../src/worker/passports/run-passports.js";
import { FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The one owner check (design 08-permissions, One owner; phase A of issue #575): every person's command, whatever its
// origin, is allowed only when its caller resolves to the store's local owner; anyone else is refused as `not_owner`
// with one reply. Command rows and UI requests carry no edge passport, and each gate decision writes one authz_audit
// row with passport `none`. Service principals keep their passport checks and never reach the owner check.

const OWNER = "local:owner@example.com" as UserId;
const GITHUB_OWNER: ExternalIdentity = { provider: "github", subject: "42" };
const SLACK_OWNER: ExternalIdentity = { provider: "slack", subject: "U42" };
const SYSTEM = { kind: "system" as const, id: "system:test" };

async function setup() {
  const { store, clock } = await newStore();
  await store.claimLocalOwner(OWNER);
  // The owner links their GitHub and Slack accounts (`factory link-code`, then `/link <code>` from each).
  await store.createLinkCode(OWNER, "ABCDEFGHJK");
  await store.redeemLinkCode("ABCDEFGHJK", { provider: GITHUB_OWNER.provider, subject: GITHUB_OWNER.subject });
  await store.createLinkCode(OWNER, "BCDEFGHJKM");
  await store.redeemLinkCode("BCDEFGHJKM", { provider: SLACK_OWNER.provider, subject: SLACK_OWNER.subject });
  const identity = await startIdentity({ db: store.db, stateDir: await mkdtemp(join(tmpdir(), "sf-owner-")) });
  const auth = new AuditedAuthProvider(new OwnerAuth(store), identity.passports);
  const source = new FakeSource();
  const controller = new ControllerRole({ store, source, auth, clock, config, log: silent, scanner: cleanScanner });
  let n = 0;
  /** A work item on a new issue whose spec waits for approval. */
  const waiting = async (): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: issueRef(++n), requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, SYSTEM);
    const r = await store.transition({
      id: item.id, expected_version: item.version, actor: SYSTEM, reason: "setup", patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 },
    });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  const approveBy = async (approver: ExternalIdentity) => {
    const it = await waiting();
    await controller.handleEvent({ kind: "spec_approved", source: it.source, comment_id: `c-${it.id}`, approver });
    return it;
  };
  const stage = async (it: WorkItem) => (await store.getWorkItem(it.id))!.stage;
  const refusals = (it: WorkItem) => source.comments.filter((c) => c.source.id === it.source.id).map((c) => c.body);
  const audit = () => store.db.all("SELECT passport_id, principal, action, decision, reason FROM authz_audit ORDER BY seq");
  return { store, clock, identity, controller, source, waiting, approveBy, stage, refusals, audit };
}

describe("the owner check", () => {
  it("allows the owner and refuses anyone else as not_owner; anonymous never claims the owner", async () => {
    const { store } = await newStore();
    expect(await authorizeOwner(store, "local:anonymous" as UserId, "approve_spec")).toEqual({ allow: false, reason: NOT_OWNER });
    expect(await store.listLocalUsers()).toEqual([]);
    // A store with no owner: the first local identity asked becomes it, as the CLI's first writing command does.
    expect(await authorizeOwner(store, OWNER, "approve_merge")).toEqual({ allow: true });
    expect(await authorizeOwner(store, "local:bob" as UserId, "approve_merge")).toEqual({ allow: false, reason: NOT_OWNER });
    // An account of another provider never claims it, even on a fresh store.
    const fresh = (await newStore()).store;
    expect(await authorizeOwner(fresh, "github:7" as UserId, "approve_spec")).toEqual({ allow: false, reason: NOT_OWNER });
    expect(await fresh.listLocalUsers()).toEqual([]);
    expect(NOT_OWNER_REPLY).toBe("only the owner may send this command");
  });

  it("approves through a GitHub account and a Slack account linked to the owner", async () => {
    const h = await setup();
    try {
      expect(await h.stage(await h.approveBy(GITHUB_OWNER))).toBe("RUNNING");
      expect(await h.stage(await h.approveBy(SLACK_OWNER))).toBe("RUNNING");
    } finally {
      await h.identity.stop();
    }
  });

  it("refuses another GitHub account and another Slack account with the one reply", async () => {
    const h = await setup();
    try {
      for (const stranger of [{ provider: "github", subject: "7" }, { provider: "slack", subject: "U9" }] as const) {
        const it = await h.approveBy(stranger);
        expect(await h.stage(it)).toBe("READY");
        expect(h.refusals(it)).toEqual([`\`/approve\` was not applied: ${NOT_OWNER_REPLY}.`]);
      }
      expect((await h.audit()).map((r) => [r.principal, r.reason])).toEqual([["github:7", NOT_OWNER], ["slack:U9", NOT_OWNER]]);
    } finally {
      await h.identity.stop();
    }
  });

  it("the local CLI: the owner's command row has no edge passport and is applied; anonymous is refused", async () => {
    const h = await setup();
    try {
      const cli = (user: string, it: WorkItem) =>
        runLocalCli(
          { store: h.store, identity: { user: user as UserId, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `n-${it.id}` },
          { action: "command", id: it.id, command: "approve", text: "" },
        );
      const mine = await h.waiting();
      const anon = await h.waiting();
      expect((await cli(OWNER, mine)).code).toBe(0);
      expect((await cli("local:anonymous", anon)).code).toBe(0);
      expect(await h.store.db.all("SELECT actor, passport_id FROM inbound_commands WHERE origin = 'cli' ORDER BY seq")).toEqual([
        { actor: OWNER, passport_id: null },
        { actor: "local:anonymous", passport_id: null },
      ]);
      await h.controller.tickCommands();
      // Relayed with no passport either.
      expect((await h.store.db.all(`SELECT passport_id FROM ${topicTables("controller.commands").messages}`)).map((m) => m.passport_id)).toEqual([null, null]);
      expect(await h.stage(mine)).toBe("RUNNING");
      expect(await h.stage(anon)).toBe("READY");
      expect(h.refusals(anon)).toContain(`\`/approve\` was not applied: ${NOT_OWNER_REPLY}.`);
    } finally {
      await h.identity.stop();
    }
  });

  it("the dashboard: the owner's request has no edge passport and is applied", async () => {
    const h = await setup();
    try {
      const it = await h.waiting();
      const d = { store: h.store, commands: { actor: OWNER, source: "environment", token: "t" } } as unknown as UiDeps;
      const posted = await commandsPost(d, it.id, {
        host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310", contentType: "application/json", csrfToken: "t", body: JSON.stringify({ command: "approve" }),
      });
      expect(posted.status).toBe(202);
      expect(await h.store.db.all("SELECT origin, actor, passport_id FROM inbound_commands")).toEqual([{ origin: "app", actor: OWNER, passport_id: null }]);
      await h.controller.tickCommands();
      expect(await h.stage(it)).toBe("RUNNING");
    } finally {
      await h.identity.stop();
    }
  });

  it("each gate decision writes one authz_audit row with passport none", async () => {
    const h = await setup();
    try {
      await h.approveBy(GITHUB_OWNER);
      await h.approveBy({ provider: "github", subject: "7" });
      expect(await h.audit()).toEqual([
        { passport_id: "none", principal: OWNER, action: "approve_spec", decision: "allow", reason: "allowed" },
        { passport_id: "none", principal: "github:7", action: "approve_spec", decision: "deny", reason: NOT_OWNER },
      ]);
    } finally {
      await h.identity.stop();
    }
  });

  it("approve_tool takes the same owner check", async () => {
    const { store } = await newStore();
    await store.claimLocalOwner(OWNER);
    const now = () => "2026-11-13T00:00:00.000Z";
    const deps = (user_id: string) => ({ auth: new OwnerAuth(store), entries: new PackEntriesStore(store.db, now), approvals: new PackApprovalsStore(store.db, now), user_id: user_id as UserId });
    const request = { action: "approve", kind: "tool", name: "docs-reader" } as const;
    expect(await changeApproval(deps("local:bob"), request)).toEqual({ ok: false, refusal: "not_allowed", reason: `approve needs approve_tool: ${NOT_OWNER}` });
    // The owner passes the check; the request then fails only because no such tool is stored.
    expect(await changeApproval(deps(OWNER), request)).toMatchObject({ ok: false, refusal: "no_entry" });
  });
});

describe("service principals keep their passport checks and skip the owner check", () => {
  /** A store with no owner at all: a person's command would be refused, a service's step is not. */
  async function ownerless() {
    const { store } = await newStore();
    const identity = await startIdentity({ db: store.db, stateDir: await mkdtemp(join(tmpdir(), "sf-service-")) });
    expect(await new OwnerAuth(store).authorize({ user_id: "service:controller" as UserId, attributes: {} }, "approve_spec")).toEqual({ allow: false, reason: NOT_OWNER });
    return { store, identity };
  }

  it("the controller's auto-mode spec approvals and merges", async () => {
    const { store, identity } = await ownerless();
    try {
      const service = controllerServiceAuth(identity.passports);
      expect(await service("approve_spec", { project: PROJECT_KEY, item: "wi_1" })).toEqual({ allow: true });
      expect(await service("approve_merge", { project: PROJECT_KEY, item: "wi_1" })).toEqual({ allow: true });
      expect(await store.db.all("SELECT principal, decision FROM authz_audit WHERE passport_id <> 'none' ORDER BY seq")).toEqual([
        { principal: "service:controller", decision: "allow" },
        { principal: "service:controller", decision: "allow" },
      ]);
    } finally {
      await identity.stop();
    }
  });

  it("outbound's tool calls", async () => {
    const { identity } = await ownerless();
    try {
      const r = await outboundServiceAuth(identity.passports)(PROJECT_KEY, "github-push");
      expect(r.decision).toEqual({ allow: true });
      expect(r.passport_id).not.toBe("none");
    } finally {
      await identity.stop();
    }
  });

  it("the worker's tool calls", async () => {
    const { identity } = await ownerless();
    try {
      const runs = new RunPassports(identity.passports);
      const inner: ToolBroker = { listTools: () => [], allTools: () => [], call: async (_c, name) => ({ ok: true, content: name }) };
      const broker = new PassportToolBroker(inner, { checker: identity.passports, passportOf: (run) => runs.passportOf(run) });
      await runs.begin({ run: "run_1", lease_token: 1, kind: "implement", item: "wi_1", project: PROJECT_KEY, branch: "factory/wi_1", grants: [] });
      expect(await broker.call({ run_id: "run_1" as never, work_item_id: "wi_1" as never, lease_token: 1 }, "git.store_branch", { branch: "factory/wi_1" })).toEqual({
        ok: true, content: "git.store_branch",
      });
    } finally {
      await identity.stop();
    }
  });
});
