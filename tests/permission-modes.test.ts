// Permission modes, phase 1 (design 08-permissions, 2026-11-27): the owner-only `permission_mode` setting. Readable and
// settable through `factory settings set` and the settings API, owner only; ask_irreversible with nothing stored; a set
// toward `full` needs approve_merge, a set toward a tighter value does not; each set or reset writes one audit row.
// Phase 2: the gate (`permissionGate`, `authorizeWrite`, src/core/authorize.ts) over mode, reversible, origin and chat
// turn, after the secret and egress guards; held agent writes in controller_held_writes, once per key.
// Phase 3: `confirm hw_…` claims a held write (pending → confirmed) and runs it as the confirmer's typed command; a
// refusal stores it refused; a second confirm applies nothing and says so.
// Phase 4: every command row stores its write origin and the mode read from the store at that write; an agent write
// that runs stores one handled row the inbox skips; a held write records origin agent; typed commands pass the guards.

import { describe, expect, it } from "vitest";
import { AGENT_WRITE_IN_CHAT, EGRESS_BLOCKED, OwnerAuth, SECRET_READ, type WriteRequest, authorizeWrite, permissionGate } from "../src/core/authorize.js";
import { type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import { HELD_CONFIRM_COMMAND, parseLocalCliArgs } from "../src/core/local-cli-parse.js";
import { LOCAL_SOURCE } from "../src/core/local-merge.js";
import type { WorkItemPatch } from "../src/core/types.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { githubCommand } from "../src/core/command-inbox.js";
import { CONFIRM_COMMAND } from "../src/core/interpret.js";
import { COMMAND_RECEIVED } from "../src/controller/index.js";
import { INBOUND_RECEIVED } from "../src/inbound/index.js";
import normalize from "../src/inbound/handlers/normalize-source/normalize-source.handler.js";
import { envelope, type Draft } from "../src/shared/envelope.js";
import { type ChatDeps, runProposalPress } from "../src/impl/source/slack-commands.js";
import { ChatToolBroker, chatCallContext } from "../src/core/chat-agent-tools.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { PERMISSION_MODES } from "../src/controller/settings/permission-mode.setting.js";
import { LiveSettings, OWNER_KEYS, SETTABLE_DEFAULTS, SETTABLE_KEYS, type SettingsBase, baseFromConfig, parseSettable } from "../src/core/settings.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { type SettingsDeps, runSettings } from "../src/settings-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps } from "../src/ui/pause-api.js";
import { type UiSettings, effectiveGlobal, newCsrfToken, readSettings, storeProjectResolver, writeSettings } from "../src/ui/settings-api.js";
import { PROJECT, cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { BACKENDS, PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const KEY = "permission_mode";
const base: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };
const REPO = { owner: "o", name: "r" };

function cliDeps(store: FactoryStore, over: Partial<SettingsDeps> = {}): SettingsDeps {
  return { store, base, repo: REPO, resolveProject: async () => PROJECT, actor: "local:owner", mayOwn: async () => null, mayApproveMerge: async () => null, ...over };
}

const set = (d: SettingsDeps, value: string) => runSettings(d, { action: "set", key: KEY, value: JSON.stringify(value) });
const reset = (d: SettingsDeps) => runSettings(d, { action: "reset", key: KEY });

describe("permission_mode: the key", () => {
  it("is settable and owner-only, defaults to ask_irreversible, and takes only its three values, tightest first", () => {
    expect(SETTABLE_KEYS).toContain(KEY);
    expect(OWNER_KEYS).toContain(KEY);
    expect(SETTABLE_DEFAULTS[KEY]).toBe("ask_irreversible");
    expect(PERMISSION_MODES).toEqual(["ask_all", "ask_irreversible", "full"]);
    for (const m of PERMISSION_MODES) expect(parseSettable(KEY, m)).toBe(m);
    for (const bad of ["ask", "FULL", "", 1, null]) expect(() => parseSettable(KEY, bad)).toThrow(/permission_mode must be "ask_all" or "ask_irreversible" or "full"/);
  });
});

describe.each(BACKENDS)("permission_mode through factory settings: $name", ({ make }) => {
  it("with nothing stored the mode is ask_irreversible, and settings load with no error", async () => {
    const { store } = await make();
    const live = new LiveSettings({ config, base: baseFromConfig(config), source: store, log: silent });
    await live.refresh();
    expect(live.values().permission_mode).toBe("ask_irreversible");
    const list = await runSettings(cliDeps(store), { action: "list" });
    expect(list.ok).toBe(true);
    expect(list.lines.join("\n")).toContain(KEY);
  });

  it("a non-owner set or reset is refused and writes nothing", async () => {
    const { store } = await make();
    const other = cliDeps(store, { actor: "local:other", mayOwn: async () => "Only the owner changes this key; you are local:other." });
    expect(await set(other, "ask_all")).toEqual({ ok: false, lines: ["refused: permission_mode changes only by the owner: Only the owner changes this key; you are local:other."] });
    await set(cliDeps(store), "ask_all");
    const before = await store.listSettingChanges(50);
    expect((await reset(other)).ok).toBe(false);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: KEY, value: '"ask_all"' })]);
    expect(await store.listSettingChanges(50)).toEqual(before);
  });

  it("a set toward full needs approve_merge; a set toward a tighter value does not", async () => {
    const { store } = await make();
    let asked = 0;
    const d = cliDeps(store, { mayApproveMerge: async () => (asked++, "no approve_merge") });
    // Tighter than the default: no approve_merge asked.
    expect((await set(d, "ask_all")).ok).toBe(true);
    expect(asked).toBe(0);
    // Back toward full from ask_all loosens it: asked and refused.
    const loose = await set(d, "full");
    expect(loose.ok).toBe(false);
    expect(loose.lines[0]).toMatch(/loosening permission_mode from "ask_all" to "full" needs approve_merge on the project: no approve_merge/);
    expect(asked).toBe(1);
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: KEY, value: '"ask_all"' })]);
    // With approve_merge the same set is stored.
    const granted = cliDeps(store, { mayApproveMerge: async () => null });
    expect((await set(granted, "full")).ok).toBe(true);
    // From full, any set is tighter: no grant asked.
    asked = 0;
    expect((await set(d, "ask_irreversible")).ok).toBe(true);
    expect(asked).toBe(0);
  });

  it("each set and reset writes one settings history row with the actor and the time", async () => {
    const { store, clock } = await make();
    const d = cliDeps(store);
    await set(d, "ask_all");
    const at = clock.now().toISOString();
    expect((await store.listSettingChanges(50)).filter((c) => c.key === KEY)).toEqual([
      { seq: expect.any(Number), key: KEY, project: "", old_value: null, new_value: '"ask_all"', actor: "local:owner", at },
    ]);
    expect((await reset(d)).ok).toBe(true);
    const rows = (await store.listSettingChanges(50)).filter((c) => c.key === KEY);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ seq: expect.any(Number), key: KEY, project: "", old_value: '"ask_all"', new_value: null, actor: "local:owner", at: expect.any(String) });
  });
});

describe("permission_mode through the settings API", () => {
  async function setup(owner: UserId | null) {
    const clock = new FakeClock("2026-11-27T03:00:00.000Z");
    const { store } = await newStore(clock);
    await saveProjectLabel(store, PROJECT);
    if (owner) await store.claimOwner(owner);
    const settings: UiSettings = { base, repo: REPO, actor: "local:me", resolveProject: storeProjectResolver(store, REPO), csrfToken: newCsrfToken() };
    const d: PauseDeps = {
      store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings,
      pauses: { principal: async () => "local:me" as UserId, authorize: async () => ({ allow: true }), csrfToken: settings.csrfToken, log: silent },
    };
    return { store, d, settings };
  }

  it("reads ask_irreversible with nothing stored, and the owner's set is read back", async () => {
    const { store, d, settings } = await setup("local:me" as UserId);
    expect(await effectiveGlobal(d, KEY)).toEqual({ value: "ask_irreversible", source: "default" });
    expect(JSON.stringify((await readSettings(d, settings)).keys)).toContain(KEY);
    expect((await writeSettings(d, settings, { action: "set", key: KEY, value: '"ask_all"' })).status).toBe(200);
    expect((await effectiveGlobal(d, KEY)).value).toBe("ask_all");
    expect((await store.listSettingChanges(50)).filter((c) => c.key === KEY)).toEqual([expect.objectContaining({ actor: "local:me", new_value: '"ask_all"' })]);
  });

  it("refuses a set and a reset from someone who is not the owner", async () => {
    const { store, d, settings } = await setup("local:owner" as UserId);
    await store.setSettingOverride({ key: KEY, project: "", value: '"ask_all"', actor: "local:owner" });
    for (const body of [{ action: "set", key: KEY, value: '"full"' }, { action: "reset", key: KEY }]) {
      const r = await writeSettings(d, settings, body);
      expect(r.status).toBe(422);
      expect((r.value as { error: string }).error).toMatch(/permission_mode changes only by the owner/);
    }
    expect(await store.listSettingOverrides()).toEqual([expect.objectContaining({ key: KEY, value: '"ask_all"' })]);
  });
});

/** One reversible and one irreversible command of the table, by name (the gate reads `reversible` from the table). */
const REVERSIBLE = "task done";
const IRREVERSIBLE = "merge";
const scanner = new PatternEgressScanner(async () => []);
const SECRET_LOOKING = `sk-ant-${"a".repeat(24)}`;

function write(over: Partial<WriteRequest> = {}): WriteRequest {
  return { command: REVERSIBLE, args: ["tk_1"], actor: "service:coordinator" as UserId, origin: "agent", in_chat_turn: false, key: "k1", ...over };
}

describe("the permission gate, a pure function", () => {
  it("holds an agent write by mode: ask_all both, ask_irreversible the irreversible one (or one that declares neither), full neither", () => {
    const gate = (mode: (typeof PERMISSION_MODES)[number], reversible: boolean | undefined) => permissionGate({ mode, reversible, origin: "agent", in_chat_turn: false }).outcome;
    expect([gate("ask_all", true), gate("ask_all", false)]).toEqual(["hold", "hold"]);
    expect([gate("ask_irreversible", true), gate("ask_irreversible", false), gate("ask_irreversible", undefined)]).toEqual(["run", "hold", "hold"]);
    expect([gate("full", true), gate("full", false)]).toEqual(["run", "run"]);
  });

  it("refuses an agent write in a chat turn in every mode, and never gates a typed command, in a chat turn or not", () => {
    for (const mode of PERMISSION_MODES) {
      for (const reversible of [true, false]) {
        expect(permissionGate({ mode, reversible, origin: "agent", in_chat_turn: true })).toEqual({ outcome: "refuse", reason: AGENT_WRITE_IN_CHAT });
        for (const in_chat_turn of [true, false]) expect(permissionGate({ mode, reversible, origin: "human_command", in_chat_turn })).toEqual({ outcome: "run" });
      }
    }
  });
});

describe.each(BACKENDS)("authorizeWrite against the store: $name", ({ make }) => {
  async function inMode(mode: string | null) {
    const { store } = await make();
    if (mode) await store.setSettingOverride({ key: KEY, project: "", value: JSON.stringify(mode), actor: "local:owner" });
    return { store, auth: (w: WriteRequest) => authorizeWrite({ store, scanner }, w) };
  }

  it("ask_all holds a reversible and an irreversible agent write, each for confirm <id>, with the mode it ran under", async () => {
    const { store, auth } = await inMode("ask_all");
    const a = await auth(write({ key: "a" }));
    const b = await auth(write({ command: IRREVERSIBLE, args: ["wi_1"], key: "b" }));
    for (const d of [a, b]) {
      expect(d).toMatchObject({ outcome: "held", mode: "ask_all" });
      if (d.outcome === "held") expect(d.reply).toContain(`confirm ${d.id}`);
    }
    const held = await store.listHeldWrites(10);
    expect(held.map((h) => [h.key, h.command, h.mode, h.status]).sort()).toEqual([["a", "task done", "ask_all", "pending"], ["b", "merge", "ask_all", "pending"]]);
    expect(held.find((h) => h.key === "b")).toMatchObject({ args: ["wi_1"], actor: "service:coordinator" });
  });

  it("ask_irreversible (also with nothing stored) runs a reversible agent write and holds an irreversible one; full holds neither", async () => {
    for (const mode of ["ask_irreversible", null]) {
      const { store, auth } = await inMode(mode);
      expect(await auth(write())).toEqual({ outcome: "run", mode: "ask_irreversible" });
      expect(await auth(write({ command: IRREVERSIBLE, key: "m" }))).toMatchObject({ outcome: "held", mode: "ask_irreversible" });
      expect(await auth(write({ command: "no such command", key: "n" }))).toMatchObject({ outcome: "held", mode: "ask_irreversible" });
      expect((await store.listHeldWrites(10)).map((h) => h.key).sort()).toEqual(["m", "n"]);
    }
    const { store, auth } = await inMode("full");
    expect(await auth(write())).toEqual({ outcome: "run", mode: "full" });
    expect(await auth(write({ command: IRREVERSIBLE, key: "m" }))).toEqual({ outcome: "run", mode: "full" });
    expect(await store.listHeldWrites(10)).toEqual([]);
  });

  it("refuses a write that reads a secret or that egress flags, in full too and for both origins, before the gate holds anything", async () => {
    for (const mode of ["full", "ask_all"]) {
      const { store, auth } = await inMode(mode);
      for (const origin of ["agent", "human_command"] as const) {
        expect(await auth(write({ origin, reads_secret: true }))).toMatchObject({ outcome: "refused", reason: SECRET_READ });
        expect(await auth(write({ origin, args: [SECRET_LOOKING] }))).toMatchObject({ outcome: "refused", reason: EGRESS_BLOCKED });
      }
      expect(await store.listHeldWrites(10)).toEqual([]);
    }
  });

  it("refuses an agent write in a chat turn in every mode; a typed command in the same turn runs, never held", async () => {
    for (const mode of PERMISSION_MODES) {
      const { store, auth } = await inMode(mode);
      expect(await auth(write({ in_chat_turn: true }))).toMatchObject({ outcome: "refused", reason: AGENT_WRITE_IN_CHAT });
      expect(await auth(write({ in_chat_turn: true, origin: "human_command", command: IRREVERSIBLE }))).toEqual({ outcome: "run", mode });
      expect(await auth(write({ origin: "human_command", command: IRREVERSIBLE }))).toEqual({ outcome: "run", mode });
      expect(await store.listHeldWrites(10)).toEqual([]);
    }
  });

  it("reads the mode from the store at each write", async () => {
    const { store, auth } = await inMode("full");
    expect((await auth(write({ command: IRREVERSIBLE, key: "x" }))).outcome).toBe("run");
    await store.setSettingOverride({ key: KEY, project: "", value: '"ask_all"', actor: "local:owner" });
    expect(await auth(write({ command: IRREVERSIBLE, key: "x" }))).toMatchObject({ outcome: "held", mode: "ask_all" });
  });

  it("stores a pending held write once per key: asking it again gives the same id and adds no row", async () => {
    const { store, auth } = await inMode("ask_all");
    const first = await auth(write({ key: "same" }));
    const again = await auth(write({ key: "same" }));
    expect(first.outcome === "held" && again.outcome === "held" && again.id === first.id).toBe(true);
    expect((await store.listHeldWrites(10)).filter((h) => h.key === "same")).toHaveLength(1);
    expect(await store.holdWrite({ key: "same", command: "task done", args: [], actor: "service:coordinator" as UserId, mode: "full" })).toMatchObject({ created: false, write: { mode: "ask_all" } });
  });
});

describe("a chat tool call that names a command", () => {
  it("is refused as an agent write in a chat turn; any other unknown name stays unknown_tool", async () => {
    const broker = new ChatToolBroker([]);
    const ctx = chatCallContext("s1");
    expect(await broker.call(ctx, "task_done", { task_id: "tk_1" })).toMatchObject({ ok: false, error_code: AGENT_WRITE_IN_CHAT });
    expect(await broker.call(ctx, "merge", {})).toMatchObject({ ok: false, error_code: AGENT_WRITE_IN_CHAT });
    expect(await broker.call(ctx, "no_such_tool", {})).toMatchObject({ ok: false, error_code: "unknown_tool" });
  });
});

describe("confirm <id> applies a held write (phase 3)", () => {
  const OWNER = "local:owner@example.com" as UserId;
  const HELPER = "local:helper@example.com" as UserId;
  const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 };

  /** The owner, a held agent `approve` on an item at `patch`, and the controller on a fake issue source whose posts are the thread. */
  async function harness(patch: WorkItemPatch = SPEC_PENDING, command = "approve", local = false) {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new ControllerRole({ store, source, auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
    await store.claimOwner(OWNER);
    const fresh = local ? { ...issue(1), source: { type: LOCAL_SOURCE, id: "local-1", link: "" } } : issue(1);
    const { item: created } = await store.createWorkItem(fresh, system);
    const r = await store.transition({ id: created.id, expected_version: created.version, actor: system, reason: "test_setup", patch });
    if (!r.ok) throw new Error("setup");
    const { write: held } = await store.holdWrite({ key: `coordinator:approve:${created.id}`, command, args: command === "approve" ? [created.id, "ship it"] : [created.id], actor: "service:coordinator" as UserId, mode: "ask_all" });
    let n = 0;
    const cli = (user: UserId): LocalCliDeps => ({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `k${++n}` });
    /** `confirm <id>` as `user`, then the controller's command step; the CLI's lines. */
    const confirm = async (user: UserId) => {
      const out = await runLocalCli(cli(user), { action: "confirm_held", held: held.id });
      await controller.tickCommands();
      return out;
    };
    const status = async () => (await store.getHeldWrite(held.id))?.status;
    const posts = (re: RegExp) => source.comments.filter((c) => re.test(c.marker));
    return { store, controller, item: r.item, held, confirm, status, posts };
  }

  it("parses `confirm hw_…` as a held-write confirm; a proposal ID stays a proposal confirm", () => {
    const id = `hw_${"a1".repeat(16)}`;
    expect(parseLocalCliArgs("confirm", [id])).toEqual({ action: "confirm_held", held: id });
    expect(parseLocalCliArgs("confirm", ["prop_abc"])).toEqual({ action: "confirm", proposal: "prop_abc" });
  });

  it("applies the held write once through the typed command's path as the owner, and stores it confirmed", async () => {
    const h = await harness();
    const out = await h.confirm(OWNER);
    expect(out.code).toBe(0);
    expect(out.lines[0]).toContain(`confirm ${h.held.id}\` as ${OWNER}`);
    const [row] = (await h.store.listCliCommandsAfter(0, 10)).filter((c) => c.command === HELD_CONFIRM_COMMAND);
    expect(row).toMatchObject({ actor: OWNER, args: { held: h.held.id }, write_origin: "human_command" });
    expect((await h.store.getWorkItem(h.item.id))!.stage).toBe("RUNNING");
    const approved = (await h.store.listStateChanges(h.item.id)).filter((c) => c.reason === "spec_approved");
    expect(approved.map((c) => [c.actor, c.detail?.note])).toEqual([[{ kind: "user", id: OWNER }, "ship it"]]);
    expect(await h.status()).toBe("confirmed");
    expect(h.posts(/held-(refused|answered)/)).toEqual([]);
  });

  it("a second confirm applies nothing and says so, from the CLI and from a row stored anyway", async () => {
    const h = await harness();
    await h.confirm(OWNER);
    const version = (await h.store.getWorkItem(h.item.id))!.version;
    const rows = (await h.store.listCliCommandsAfter(0, 50)).length;
    const again = await h.confirm(OWNER);
    expect(again).toEqual({ code: 0, lines: [`nothing was applied: held write ${h.held.id} (\`approve ${h.item.id} ship it\`) was already confirmed`] });
    expect((await h.store.listCliCommandsAfter(0, 50)).length).toBe(rows);
    // A race: a second row stored before the first was applied.
    await h.store.appendCliCommand({ key: "cli:race", actor: OWNER, command: HELD_CONFIRM_COMMAND, args: { held: h.held.id } });
    await h.controller.tickCommands();
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(h.item.id))!.version).toBe(version);
    const answered = h.posts(/held-answered/);
    expect(answered).toHaveLength(1);
    expect(answered[0]!.body).toMatch(/^Nothing was applied this time: .* was already confirmed/);
    expect(await h.status()).toBe("confirmed");
  });

  it("a held write the typed path refuses is stored refused with one reply saying why, and is never applied again", async () => {
    const h = await harness({ stage: "RUNNING", tier: 2 });
    await h.confirm(OWNER);
    expect((await h.store.getWorkItem(h.item.id))!.version).toBe(h.item.version);
    expect(await h.status()).toBe("refused");
    const refused = h.posts(/held-refused/);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body).toMatch(new RegExp(`^\`approve ${h.item.id} ship it\` \\(${h.held.id}\\) was not applied: .*implementing`));
    expect((await h.confirm(OWNER)).lines[0]).toContain("was already refused");
    expect(await h.status()).toBe("refused");
  });

  it("a confirmer the typed path's own check refuses gets the held write refused, the item unchanged", async () => {
    const h = await harness();
    const before = await h.store.getWorkItem(h.item.id);
    await h.confirm(HELPER);
    expect(await h.store.getWorkItem(h.item.id)).toEqual(before);
    expect(await h.status()).toBe("refused");
    expect(h.posts(/held-refused/)).toHaveLength(1);
  });

  it("a held merge runs through the typed merge's own path: an item with no PR to merge gets it refused", async () => {
    const h = await harness(SPEC_PENDING, "merge");
    await h.confirm(OWNER);
    expect((await h.store.getWorkItem(h.item.id))!.version).toBe(h.item.version);
    expect(await h.status()).toBe("refused");
    const refused = h.posts(/held-refused/);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body).toMatch(new RegExp(`^\`merge ${h.item.id}\` \\(${h.held.id}\\) was not applied: `));
  });

  it("a held merge on a local item the local merge refuses gets one reply: the local merge's own", async () => {
    const h = await harness(SPEC_PENDING, "merge", true);
    await h.confirm(OWNER);
    expect((await h.store.getWorkItem(h.item.id))!.version).toBe(h.item.version);
    expect(await h.status()).toBe("refused");
    const replies = (await h.store.listItemMessages(h.item.id)).filter((m) => /factory:(refused|held-refused):/.test(m.marker));
    expect(replies.map((m) => m.body)).toEqual([expect.stringMatching(/^`factory merge` was not applied: .*is not waiting for a merge/)]);
  });

  it("an unknown held write fails in the CLI and stores nothing", async () => {
    const { store } = await newStore();
    const d: LocalCliDeps = { answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: OWNER, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "k" };
    const id = `hw_${"0".repeat(32)}`;
    expect(await runLocalCli(d, { action: "confirm_held", held: id })).toEqual({ code: 1, lines: [`no held write ${id}`] });
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
  });
});

describe("phase 4: every write row records its origin and the mode it ran under", () => {
  const OWNER = "local:owner@example.com" as UserId;
  const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 };
  const setMode = (store: FactoryStore, mode: string) => store.setSettingOverride({ key: KEY, project: "", value: JSON.stringify(mode), actor: "local:owner" });
  const rowOf = async (store: FactoryStore, key: string) => (await store.listCliCommandsAfter(0, 100)).find((c) => c.key === key);

  /** A store in `mode`, the owner claimed, one item at spec_pending, and the controller with the pattern egress scanner. */
  async function inMode(mode: (typeof PERMISSION_MODES)[number]) {
    const { store, clock } = await newStore();
    await setMode(store, mode);
    await store.claimOwner(OWNER);
    const { item: created } = await store.createWorkItem(issue(1), system);
    const r = await store.transition({ id: created.id, expected_version: created.version, actor: system, reason: "test_setup", patch: SPEC_PENDING });
    if (!r.ok) throw new Error("setup");
    const controller = new ControllerRole({ store, source: new FakeSource(), auth: new OwnerAuth(store), clock, config, log: silent, scanner, repeated_failure_rule: false });
    let n = 0;
    const cli = (args: string[]) => runLocalCli({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: OWNER, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `p4-${++n}` }, parseLocalCliArgs(args[0]!, args.slice(1)) as never);
    return { store, controller, item: r.item, cli };
  }

  it.each(PERMISSION_MODES)("%s: the CLI, confirm hw_…, the Slack confirm press and a GitHub comment command each store write_origin and the mode", async (mode) => {
    const h = await inMode(mode);
    await h.cli(["approve", h.item.id, "ship it"]);
    await h.cli(["confirm", `hw_${"0".repeat(32)}`]);
    const { write: held } = await h.store.holdWrite({ key: "k-held", command: "approve", args: [h.item.id], actor: "service:coordinator" as UserId, mode });
    await h.cli(["confirm", held.id]);
    const slack = { store: { resolveLink: async () => OWNER, appendCliCommand: (i: Parameters<FactoryStore["appendCliCommand"]>[0]) => h.store.appendCliCommand(i) } } as unknown as ChatDeps;
    await runProposalPress(slack, { kind: "confirm", id: "prop_1", index: null }, { user: "U1", item: h.item, id: "press-1", origin: "slack" } as never);
    await h.store.appendCliCommand({ ...githubCommand({ comment_id: 7, user_id: 1, command: "approve", text: "", source: h.item.source }), write_origin: "human_command" });
    const rows = await h.store.listCliCommandsAfter(0, 100);
    expect(rows.map((c) => c.command)).toEqual(["approve", HELD_CONFIRM_COMMAND, CONFIRM_COMMAND, "approve"]);
    for (const c of rows) expect(c, c.key).toMatchObject({ write_origin: "human_command", permission_mode: mode });
  });

  it("reads the mode from the store at each row's write, never a cache", async () => {
    const { store } = await newStore();
    await store.appendCliCommand({ key: "cli:a", actor: OWNER, command: "approve", args: {}, write_origin: "human_command" });
    for (const mode of PERMISSION_MODES) {
      await setMode(store, mode);
      await store.appendCliCommand({ key: `cli:${mode}`, actor: OWNER, command: "approve", args: {}, write_origin: "human_command" });
    }
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => [c.key, c.permission_mode])).toEqual([
      ["cli:a", "ask_irreversible"], ["cli:ask_all", "ask_all"], ["cli:ask_irreversible", "ask_irreversible"], ["cli:full", "full"],
    ]);
  });

  it.each(PERMISSION_MODES)("%s: an agent write the gate runs stores one handled row with origin agent and its mode, once per key; a held one stores none", async (mode) => {
    const { store } = await newStore();
    await setMode(store, mode);
    const auth = (w: WriteRequest) => authorizeWrite({ store, scanner }, w);
    for (const key of ["r1", "r1"]) await auth(write({ key }));
    await auth(write({ command: IRREVERSIBLE, args: ["wi_1"], key: "m1" }));
    const runs = (await store.listCliCommandsAfter(0, 10)).map((c) => [c.key, c.origin, c.write_origin, c.permission_mode, c.command, c.args]);
    const reversibleRuns = mode !== "ask_all", irreversibleRuns = mode === "full";
    expect(runs).toEqual([
      ...(reversibleRuns ? [["r1", "agent", "agent", mode, REVERSIBLE, { argv: ["tk_1"] }]] : []),
      ...(irreversibleRuns ? [["m1", "agent", "agent", mode, IRREVERSIBLE, { argv: ["wi_1"] }]] : []),
    ]);
    const [handled] = await (store as unknown as { db: { all(q: string): Promise<{ n: number }[]> } }).db.all("SELECT COUNT(*) AS n FROM inbound_commands WHERE handled_at IS NULL");
    expect(handled!.n).toBe(0);
    // A held write's row records origin agent as well as its mode.
    const held = await store.listHeldWrites(10);
    expect(held.map((w) => [w.key, w.write_origin, w.mode]).sort()).toEqual([
      ...(reversibleRuns ? [] : [["r1", "agent", mode]]),
      ...(irreversibleRuns ? [] : [["m1", "agent", mode]]),
    ].sort());
  });

  it.each(PERMISSION_MODES)("%s: the inbox never applies an agent's row again", async (mode) => {
    const { store } = await newStore();
    await setMode(store, mode);
    await store.recordAgentWrite({ key: "coordinator:merge:wi_1", command: "merge", args: ["wi_1"], actor: "service:coordinator" as UserId, mode });
    const [row] = await store.listCliCommandsAfter(0, 10);
    const out: Draft[] = [];
    const m = envelope({ type: INBOUND_RECEIVED, subject: "local", idempotency_key: row!.id, idempotency_key_ttl_ms: null, payload: { record_id: row!.id, kind: "command" } },
      { id: null, correlation_id: row!.id, project_id: "p", passport_id: null, occurred_at: "2026-11-28T00:00:00.000Z" }, "inbound");
    await normalize.handle(m, { tx: (store as unknown as { db: Parameters<typeof normalize.handle>[1]["tx"] }).db, emit: (d) => void out.push(d) });
    expect(out.filter((d) => d.type === COMMAND_RECEIVED)).toEqual([]);
    expect(await store.recordAgentWrite({ key: "coordinator:merge:wi_1", command: "merge", args: ["wi_1"], actor: "service:coordinator" as UserId, mode })).toEqual({ created: false });
  });

  it.each(PERMISSION_MODES)("%s: a typed command the egress scan flags is refused on its row; any other typed command runs with no confirm", async (mode) => {
    const flagged = await inMode(mode);
    await flagged.cli(["approve", flagged.item.id, SECRET_LOOKING]);
    await flagged.controller.tickCommands();
    expect((await flagged.store.getWorkItem(flagged.item.id))!.version).toBe(flagged.item.version);
    const refused = await (flagged.store as unknown as { db: { all(q: string): Promise<Record<string, unknown>[]> } }).db.all("SELECT refusal, handled_at FROM inbound_commands");
    expect(refused).toEqual([{ refusal: EGRESS_BLOCKED, handled_at: expect.any(String) }]);

    const clean = await inMode(mode);
    await clean.cli(["approve", clean.item.id, "ship it"]);
    await clean.controller.tickCommands();
    expect((await clean.store.getWorkItem(clean.item.id))!.stage).toBe("RUNNING");
    expect(await clean.store.listHeldWrites(10)).toEqual([]);
    expect(await rowOf(clean.store, "cli:p4-1")).toMatchObject({ write_origin: "human_command", permission_mode: mode });
  });

  it.each(PERMISSION_MODES)("%s: a typed write that reads a secret is refused, as an agent's is", async (mode) => {
    const { store } = await newStore();
    await setMode(store, mode);
    const d = await authorizeWrite({ store, scanner }, write({ origin: "human_command", command: IRREVERSIBLE, reads_secret: true }));
    expect(d).toMatchObject({ outcome: "refused", reason: SECRET_READ });
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
  });
});
