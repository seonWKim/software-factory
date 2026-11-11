// The guided `factory setup` (owner decision 2026-11-08): defaults per step, `--yes`, the factory.config.json
// edit (only the chosen keys change, shown as a diff first), and "you": the display name stored once by ID.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultsAsk, terminalAsk } from "../src/cli/handlers/setup/ask.js";
import {
  applyChoices,
  configDiffLines,
  currentChoices,
  editConfigText,
  parseSlackChannels,
} from "../src/cli/handlers/setup/config-edit.js";
import { registerMe } from "../src/cli/handlers/setup/me.js";
import { loadConfig } from "../src/compose.js";
import { cliIdentity, runLocalCli } from "../src/core/local-cli.js";
import { ProfileStore } from "../src/identity/index.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { newStore } from "./helpers/store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CHECKED_IN = readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8");
const AT = "2026-11-08T12:00:00.000Z";

/** Loads `text` as an external config in its own folder, as `--config` would. */
async function load(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "sf-setup-guided-"));
  mkdirSync(join(dir, "prompts"));
  const file = join(dir, "factory.config.json");
  writeFileSync(file, text);
  return loadConfig(REPO_ROOT, { configFile: file });
}

const changedLines = (a: string, b: string) => {
  const x = a.split("\n");
  const y = b.split("\n");
  return { removed: x.filter((l) => !y.includes(l)), added: y.filter((l) => !x.includes(l)) };
};

describe("setup: the shared choices in factory.config.json", () => {
  it("reads each step's default from the file: the checked-in one has GitHub and Slack; a file listing no sources gets the solo defaults", () => {
    const raw = JSON.parse(CHECKED_IN);
    expect(currentChoices(raw, true)).toEqual({ github: true, slack: true, slack_channels: ["C0CDEHN4HM5"] });
    expect(currentChoices({ repo: {} }, true)).toEqual({ github: false, slack: false, slack_channels: [] });
  });

  it("the defaults change nothing, so `--yes` on a set-up file writes nothing", () => {
    const raw = JSON.parse(CHECKED_IN);
    const changes = applyChoices(raw, currentChoices(raw, true));
    expect(changes.size).toBe(0);
    expect(configDiffLines(raw, changes)).toEqual([]);
    expect(editConfigText(CHECKED_IN, changes)).toBe(CHECKED_IN);
  });

  it("local only: selects no GitHub plugin, changes only those keys and keeps every other line as written", async () => {
    const raw = JSON.parse(CHECKED_IN);
    const changes = applyChoices(raw, { github: false, slack: false, slack_channels: [] });
    expect([...changes.keys()].sort()).toEqual(["auth", "permissions", "plugins"]);
    const text = editConfigText(CHECKED_IN, changes);
    const edited = JSON.parse(text);
    expect(edited.store).toEqual({ type: "sqlite" });
    expect(edited.auth).toBe("local");
    // Only the remote grant goes; the checked-in static roles (the owner's approver grant) stay as written.
    expect(edited.permissions).toEqual({ grants: ["static"], static: raw.permissions.static });
    expect(edited.plugins).toMatchObject({ source: ["local"], broker: "local", github_auth: "app", runner: "claude-code" });
    const { removed, added } = changedLines(CHECKED_IN, text);
    // The checked-in "permissions" block (its static roles kept) is written back on one line.
    expect(removed.filter((l) => !/"auth"|"broker"|"source"|"agent_git_identity"|"permissions"|"grants"|"static"/.test(l))).toEqual([]);
    expect(added.filter((l) => !/"auth"|"broker"|"source"|"permissions"|"agent_git_identity"/.test(l))).toEqual([]);
    const loaded = await load(text);
    expect(loaded.config.local_only).toBe(true);
    expect(loaded.store).toEqual({ type: "sqlite" });

    const diff = configDiffLines(raw, changes);
    expect(diff).toContain('- "auth": "github"');
    expect(diff).toContain('+ "auth": "local"');
    expect(diff).toContain('+ "permissions": { "grants": ["static"], "static": { "roles": { "github:69591622": { "*": ["approver"] } } } }');
  });

  it("no choice touches the store key: setup asks no store question", () => {
    const raw = { ...JSON.parse(CHECKED_IN), store: { type: "mysql" } };
    for (const github of [true, false]) {
      expect(applyChoices(raw, { github, slack: false, slack_channels: [] }).has("store")).toBe(false);
    }
  });

  it("turning GitHub and Slack back on from local only round-trips to a config that loads", async () => {
    const local = editConfigText(CHECKED_IN, applyChoices(JSON.parse(CHECKED_IN), { github: false, slack: false, slack_channels: [] }));
    const raw = JSON.parse(local);
    expect(currentChoices(raw, false)).toMatchObject({ github: false });
    const changes = applyChoices(raw, { github: true, slack: true, slack_channels: ["C0123456789"] });
    const text = editConfigText(local, changes);
    const edited = JSON.parse(text);
    expect(edited.store).toEqual({ type: "sqlite" });
    expect(edited.auth).toBe("github");
    expect(edited.plugins.source).toEqual(["github-issues", "local", "slack"]);
    expect(edited.plugins.broker).toBe("github");
    expect(edited.permissions.grants).toEqual(["static", "github-permission"]);
    expect(edited.slack).toEqual({ channels: ["C0123456789"] });
    expect(text.endsWith('"slack": { "channels": ["C0123456789"] }\n}\n')).toBe(true);
    const loaded = await load(text);
    expect(loaded.config.local_only).toBeUndefined();
  });

  it("checks Slack channel IDs", () => {
    expect(parseSlackChannels("C0123456789, G0ABC")).toEqual({ ok: true, channels: ["C0123456789", "G0ABC"] });
    expect(parseSlackChannels("#general")).toEqual({ ok: false, bad: "#general" });
  });
});

describe("setup: asking", () => {
  it("Enter takes the default; a unique prefix or the full word picks an option; anything else asks again", async () => {
    const answers = ["", "my", "x", "sqlite", "", "n", "", "  Kim  "];
    const prompts: string[] = [];
    const printed: string[] = [];
    const ask = terminalAsk(async (p) => (prompts.push(p), answers.shift()!), (l) => printed.push(l));
    expect(await ask.choose("Store", ["sqlite", "mysql"], "mysql")).toBe("mysql");
    expect(await ask.choose("Store", ["sqlite", "mysql"], "sqlite")).toBe("mysql");
    expect(await ask.choose("Store", ["sqlite", "mysql"], "mysql")).toBe("sqlite");
    expect(printed).toEqual(["   answer one of: sqlite, mysql"]);
    expect(await ask.yesNo("GitHub?", true)).toBe(true);
    expect(await ask.yesNo("GitHub?", true)).toBe(false);
    expect(await ask.text("Name", "", (a) => (a === "" ? "empty" : null))).toBe("Kim");
    expect(prompts[0]).toBe("Store sqlite / [mysql]: ");
    expect(prompts[4]).toBe("GitHub? [Y/n] ");
  });

  it("--yes takes every default and prints it", async () => {
    const printed: string[] = [];
    const ask = defaultsAsk((l) => printed.push(l));
    expect(ask.interactive).toBe(false);
    expect(await ask.choose("Store", ["sqlite", "mysql"], "sqlite")).toBe("sqlite");
    expect(await ask.yesNo("Write them?", true)).toBe(true);
    expect(await ask.text("Name", "Kim")).toBe("Kim");
    expect(printed).toEqual(["Store sqlite", "Write them? yes", "Name Kim"]);
  });
});

describe("setup: you (display name by ID)", () => {
  const me = cliIdentity(null, { gitEmail: "Me@Example.com", osUser: "me" });
  const you = cliIdentity(null, { gitEmail: "you@example.com", osUser: "you" });

  it("the first person becomes the owner; the name is stored once in identity_profiles, against the ID only", async () => {
    const { store } = await newStore();
    const profiles = new ProfileStore(storeSql(store));
    const r = await registerMe({ store, profiles, identity: me, gitName: "Kim Seon Woo", ask: defaultsAsk(() => undefined), now: AT });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain('you are local:me@example.com (from git user.email), shown as "Kim Seon Woo"');
    expect(r.lines.join("\n")).toContain("you are the local owner");
    expect(await profiles.get("local:me@example.com")).toEqual({ user_id: "local:me@example.com", display_name: "Kim Seon Woo", source: "self", updated_at: AT });
    expect(await store.listLocalUsers()).toEqual([expect.objectContaining({ user_id: "local:me@example.com", role: "owner" })]);

    // Rerun: the stored name is the default, git's name is not.
    const again = await registerMe({ store, profiles, identity: me, gitName: "Other", ask: defaultsAsk(() => undefined), now: AT });
    expect(again.lines[0]).toContain('"Kim Seon Woo"');

    // No table but identity_profiles holds the name.
    const db = storeSql(store);
    for (const t of await store.listTables()) {
      if (t.name === "identity_profiles") continue;
      const rows = await db.all(`SELECT * FROM ${t.name}`);
      expect(JSON.stringify(rows), t.name).not.toContain("Kim Seon Woo");
    }
  });

  it("a later person (setup --me) gets no role until the owner grants one", async () => {
    const { store } = await newStore();
    const profiles = new ProfileStore(storeSql(store));
    await registerMe({ store, profiles, identity: me, gitName: "Me", ask: defaultsAsk(() => undefined), now: AT });
    const r = await registerMe({ store, profiles, identity: you, gitName: null, ask: terminalAsk(async () => "You Person", () => undefined), now: AT });
    expect(r.lines.join("\n")).toContain("no role yet: you may create and read work items. The owner (local:me@example.com) can run `factory users add local:you@example.com --role approver`");
    expect(await store.getLocalUser("local:you@example.com" as never)).toBeNull();
    expect((await profiles.get("local:you@example.com"))?.display_name).toBe("You Person");
    await store.setLocalUserRole("local:you@example.com" as never, "approver", "local:me@example.com" as never);
    const later = await registerMe({ store, profiles, identity: you, gitName: null, ask: defaultsAsk(() => undefined), now: AT });
    expect(later.lines.join("\n")).toContain("your role: approver");
  });

  it("`users list` shows the name next to the ID, looked up at the edge", async () => {
    const { store } = await newStore();
    const profiles = new ProfileStore(storeSql(store));
    await registerMe({ store, profiles, identity: me, gitName: "Kim", ask: defaultsAsk(() => undefined), now: AT });
    const r = await runLocalCli(
      { store, identity: me, project: async () => null, read: async () => "", newId: () => "x", displayNames: (ids) => profiles.displayNames(ids) },
      { action: "users_list" },
    );
    expect(r.lines[0]).toBe("you are local:me@example.com (Kim) (from git user.email)");
    expect(r.lines[1]).toMatch(/^local:me@example\.com \(Kim\)\towner\t/);
  });

  it("anonymous stores nothing and claims nothing; --yes with no git user.name stores no name", async () => {
    const { store } = await newStore();
    const profiles = new ProfileStore(storeSql(store));
    const anon = cliIdentity(null, { gitEmail: null, osUser: null });
    const r = await registerMe({ store, profiles, identity: anon, gitName: "Someone", ask: defaultsAsk(() => undefined), now: AT });
    expect(r.ok).toBe(false);
    expect(await store.listLocalUsers()).toEqual([]);
    expect(await profiles.get("local:anonymous")).toBeNull();

    const n = await registerMe({ store, profiles, identity: me, gitName: null, ask: defaultsAsk(() => undefined), now: AT });
    expect(n.ok).toBe(true);
    expect(n.lines[0]).toContain("no display name stored");
    expect(await profiles.get("local:me@example.com")).toBeNull();
  });
});
