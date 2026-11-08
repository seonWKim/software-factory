import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { topicTables } from "../src/bus/index.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { UserId } from "../src/core/types.js";
import { startIdentity } from "../src/identity/index.js";
import { commandIdentity } from "../src/identity/runtime/start.js";
import { AuditedAuthProvider, PluginIdentityProvider } from "../src/impl/auth/audited-auth.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore } from "./helpers/store.js";

// RFC 0015 §8 "Edge" (M9): a CLI or UI command row carries its actor's passport; a comment command a poll stored
// gets one from its provider's mapping when inbound relays it, and CommandReceived carries it as passport_id.

async function setup() {
  const { store, clock } = await newStore();
  const stateDir = await mkdtemp(join(tmpdir(), "sf-edge-"));
  const identity = await startIdentity({
    db: store.db,
    stateDir,
    providers: [new PluginIdentityProvider("github", { resolve: async (i) => ({ user_id: `github:${i.subject}` as UserId, attributes: {} }), authorize: async () => ({ allow: true }) })],
  });
  return { store, clock, identity };
}

describe("edge passports", () => {
  it("maps a command row's origin and actor to an edge proof", () => {
    expect(commandIdentity("cli", "local:ada")).toEqual({ identity: { provider: "local", subject: "local:ada" }, origin: "cli" });
    expect(commandIdentity("app", "local:ada")).toEqual({ identity: { provider: "local", subject: "local:ada" }, origin: "ui" });
    expect(commandIdentity("github", "github:42")).toEqual({ identity: { provider: "github", subject: "42" }, origin: "github" });
    expect(commandIdentity("github", "local:ada")).toBeNull();
    expect(commandIdentity("fax", "x")).toBeNull();
  });

  it("a CLI command row carries the CLI identity's passport", async () => {
    const { store, identity } = await setup();
    try {
      const { item } = await store.createWorkItem(
        { source: { type: "local", id: "l1", link: "local:l1" }, requester_id: "local:ada" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
        { kind: "system", id: "system:test" },
      );
      const r = await runLocalCli(
        {
          store,
          identity: { user: "local:ada" as UserId, from: "git user.email" },
          project: async () => PROJECT_KEY,
          read: async () => "",
          newId: () => "n1",
          passport: () => identity.edge({ provider: "local", subject: "local:ada" }, "cli"),
        },
        { action: "command", id: item.id, command: "approve", text: "" },
      );
      expect(r.code).toBe(0);
      const [row] = await store.db.all("SELECT passport_id FROM inbound_commands");
      const [passport] = await store.db.all("SELECT principal, provider, origin, kind FROM identity_passports WHERE id = ?", [row!.passport_id as string]);
      expect(passport).toEqual({ principal: "local:ada", provider: "local", origin: "cli", kind: "person" });
    } finally {
      await identity.stop();
    }
  });

  it("a comment command gets its provider's passport at the relay, and CommandReceived carries it", async () => {
    const { store, clock, identity } = await setup();
    try {
      const controller = new ControllerRole({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, identity });
      await store.appendCliCommand({ key: "github:comment:1", actor: "github:42", command: "approve", args: { item: "wi_missing" } });
      await store.appendCliCommand({ key: "github:comment:2", actor: "slack:7", command: "approve", args: { item: "wi_missing" } });
      await controller.tickCommands();
      const sent = await store.db.all(`SELECT passport_id FROM ${topicTables("controller.commands").messages} ORDER BY seq`);
      expect(sent).toHaveLength(2);
      const [p] = await store.db.all("SELECT principal, provider, origin FROM identity_passports WHERE id = ?", [sent[0]!.passport_id as string]);
      expect(p).toEqual({ principal: "github:42", provider: "github", origin: "github" });
      // An actor no provider of its origin resolves gets none; the controller's authorize still decides.
      expect(sent[1]!.passport_id).toBeNull();
    } finally {
      await identity.stop();
    }
  });

  it("the controller decides a command under its passport: audited under it, and refused once it is revoked", async () => {
    const { store, clock, identity } = await setup();
    try {
      const plugin: AuthProvider = { resolve: async (i) => ({ user_id: `local:${i.subject}` as UserId, attributes: {} }), authorize: async () => ({ allow: true }) };
      const auth = new AuditedAuthProvider(plugin, identity.passports);
      const controller = new ControllerRole({ store, source: new FakeSource(), auth, clock, config, log: silent, scanner: cleanScanner, identity });
      const { item } = await store.createWorkItem(
        { source: { type: "local", id: "l1", link: "local:l1" }, requester_id: "local:ada" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
        { kind: "system", id: "system:test" },
      );
      const passport = await identity.edge({ provider: "local", subject: "ada" }, "cli");
      await store.appendCliCommand({ key: "cli:1", actor: "local:ada", command: "approve", args: { item: item.id }, passport_id: passport });
      await controller.tickCommands();
      await identity.passports.revoke(passport, "local:owner", "lost laptop");
      await store.appendCliCommand({ key: "cli:2", actor: "local:ada", command: "approve", args: { item: item.id }, passport_id: passport });
      await controller.tickCommands();
      expect(await store.db.all("SELECT passport_id, principal, decision, reason FROM authz_audit ORDER BY seq")).toEqual([
        { passport_id: passport, principal: "local:ada", decision: "allow", reason: "allowed" },
        { passport_id: passport, principal: "local:ada", decision: "deny", reason: "revoked" },
      ]);
    } finally {
      await identity.stop();
    }
  });

  it("a comment command is decided under the passport inbound minted at the relay, audited under it", async () => {
    // The row a poll stored has no passport; only CommandReceived carries the one minted at the relay.
    const { store, clock, identity } = await setup();
    try {
      const plugin: AuthProvider = { resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId, attributes: {} }), authorize: async () => ({ allow: true }) };
      const auth = new AuditedAuthProvider(plugin, identity.passports);
      const controller = new ControllerRole({ store, source: new FakeSource(), auth, clock, config, log: silent, scanner: cleanScanner, identity });
      await store.createWorkItem(issue(7), { kind: "system", id: "system:test" });
      await store.appendCliCommand({ key: "github:555", actor: "github:42", command: "approve", args: { source: issueRef(7) } });
      await controller.tickCommands();
      const [sent] = await store.db.all(`SELECT passport_id FROM ${topicTables("controller.commands").messages}`);
      expect(sent!.passport_id).toEqual(expect.any(String));
      expect(await store.db.all("SELECT passport_id, principal FROM authz_audit ORDER BY seq")).toEqual([
        { passport_id: sent!.passport_id, principal: "github:42" },
      ]);
    } finally {
      await identity.stop();
    }
  });
});
