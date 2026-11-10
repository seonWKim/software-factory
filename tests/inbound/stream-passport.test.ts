import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { topicTables } from "../../src/bus/index.js";
import type { SourceRef, UserId } from "../../src/core/types.js";
import { startIdentity } from "../../src/identity/index.js";
import { AuditedAuthProvider, PluginIdentityProvider } from "../../src/impl/auth/audited-auth.js";
import { storeRecord } from "../../src/inbound/records.js";
import type { AuthProvider } from "../../src/interfaces/auth-provider.js";
import type { SourceEvent } from "../../src/interfaces/source-adapter.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { FakeStreamSource, cleanScanner, config, silent } from "../helpers/fakes.js";
import { PROJECT_KEY, newStore } from "../helpers/store.js";

// RFC 0015 §8 "Edge" (M9): a Slack command the listener stored as a stream record gets its actor's edge passport when
// inbound relays it, as a comment command row does; the controller decides it under that passport.

const THREAD: SourceRef = { type: "slack_thread", id: "C1/1", link: "https://slack.example/archives/C1/p1" };
/** The auth plugin: it resolves and allows everyone. */
const plugin: AuthProvider = { resolve: async (i) => ({ user_id: `${i.provider}:${i.subject}` as UserId, attributes: {} }), authorize: async () => ({ allow: true }) };
/** The provider mapping Identity authenticates through: only Slack user 7 is linked to a factory user. */
const linked: AuthProvider = { ...plugin, resolve: async (i) => (i.subject === "7" ? plugin.resolve(i) : null) };
const RECEIVED_AT = "2026-11-01T00:00:00.000Z";

async function setup() {
  const { store, clock } = await newStore();
  const identity = await startIdentity({
    db: store.db,
    stateDir: await mkdtemp(join(tmpdir(), "sf-slack-edge-")),
    providers: [new PluginIdentityProvider("slack", linked)],
  });
  const auth = new AuditedAuthProvider(plugin, identity.passports);
  const controller = new ControllerRole({ store, source: new FakeStreamSource(), auth, clock, config, log: silent, scanner: cleanScanner, identity });
  await store.createWorkItem(
    { source: THREAD, requester_id: "slack:7" as UserId, project: PROJECT_KEY, problem: "p", resources: [] },
    { kind: "system", id: "system:test" },
  );
  /** Stores `events` as the Slack listener does, relays them and lets the controller decide them. */
  const relay = async (...events: SourceEvent[]) => {
    await store.db.transaction(async (tx) => {
      for (const [i, event] of events.entries()) await storeRecord(tx, "sqlite", { source_type: "slack_thread", dedupe_key: `ev${i}`, event, received_at: RECEIVED_AT });
    });
    await controller.tickIntake();
    return store.db.all(`SELECT idempotency_key, passport_id FROM ${topicTables("controller.commands").messages} ORDER BY seq`);
  };
  return { store, identity, relay };
}

function approve(subject: string): SourceEvent {
  return { kind: "spec_approved", source: THREAD, comment_id: `c${subject}`, approver: { provider: "slack", subject }, note: "" };
}

describe("Slack command passports", () => {
  it("a linked account's /approve is relayed with its passport and audited under it", async () => {
    const { store, identity, relay } = await setup();
    try {
      const [sent] = await relay(approve("7"));
      expect(sent!.passport_id).toEqual(expect.any(String));
      const [p] = await store.db.all("SELECT principal, provider, origin FROM identity_passports WHERE id = ?", [sent!.passport_id as string]);
      expect(p).toEqual({ principal: "slack:7", provider: "slack", origin: "slack" });
      expect(await store.db.all("SELECT passport_id, principal FROM authz_audit WHERE principal = 'slack:7'")).toEqual([
        { passport_id: sent!.passport_id, principal: "slack:7" },
      ]);
    } finally {
      await identity.stop();
    }
  });

  it("an account no provider resolves is relayed with no passport and decided by the plugin alone", async () => {
    const { store, identity, relay } = await setup();
    try {
      const [sent] = await relay(approve("99"));
      expect(sent!.passport_id).toBeNull();
      expect(await store.db.all("SELECT id FROM identity_passports WHERE provider = 'slack'")).toEqual([]);
      expect(await store.db.all("SELECT passport_id, decision FROM authz_audit WHERE principal = 'slack:99'")).toEqual([{ passport_id: "none", decision: "allow" }]);
    } finally {
      await identity.stop();
    }
  });

  it("a plain comment and an item request get no passport, even from a linked account", async () => {
    const { store, identity, relay } = await setup();
    try {
      const who = { provider: "slack" as const, subject: "7" };
      const sent = await relay(
        { kind: "plain_comment", source: THREAD, comment_id: "c1", author: who, body: "hello" },
        { kind: "item_requested", source: { ...THREAD, id: "C1/2" }, requester: who, title: "t", body: "b" },
      );
      expect(sent.map((m) => m.passport_id)).toEqual([null, null]);
      expect(await store.db.all("SELECT id FROM identity_passports WHERE provider = 'slack'")).toEqual([]);
    } finally {
      await identity.stop();
    }
  });
});
