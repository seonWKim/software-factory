// Design 12-notification-channels: the `notify_channels` setting (checked against the registered source plugins at
// set time, on the CLI and the settings API), the `slack` block's notify keys checked at load, and the Slack
// `notifyOwner` capability on a fake Slack: one message per call, one line each, in slack.notify_channel.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConfigKeys } from "../src/config-keys.js";
import { SETTABLE_DEFAULTS, parseSettable } from "../src/core/settings.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { slackConfig } from "../src/impl/source/slack-config.js";
import { SlackSource, type SlackSourceDeps } from "../src/impl/source/slack-source.js";
import slackPlugin from "../src/impl/source/slack.plugin.js";
import type { SourceNotice } from "../src/interfaces/source-adapter.js";
import { loadSettingCatalog } from "../src/runtime/index.js";
import { runSettings } from "../src/settings-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiDeps } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, writeSettings } from "../src/ui/settings-api.js";
import { cleanScanner, config, recordingLog, silent } from "./helpers/fakes.js";
import { CHANNEL, FakeSlackApi, FakeSocket } from "./helpers/slack.js";
import { newStore } from "./helpers/store.js";

const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
const REPO = { owner: "o", name: "r" };
const NOTIFY = "C0NOTICES";
const BAD_VALUES: readonly [string, RegExp][] = [
  ['"slack"', /notify_channels must be a list/],
  ["[1]", /notify_channels must be a list/],
  ['["slack", "slack"]', /notify_channels must be a list/],
  ['["pager"]', /notify_channels names "pager", which is not a source plugin/],
];

describe("the notify_channels setting", () => {
  it("is a runtime, global setting of the controller with default []", async () => {
    const s = (await loadSettingCatalog()).get("notify_channels")!;
    expect(s).toMatchObject({ owner: "controller", type: "list", default: [], changed_by: "runtime", scope: "global" });
    expect(SETTABLE_DEFAULTS.notify_channels).toEqual([]);
    expect(parseSettable("notify_channels", ["slack"])).toEqual(["slack"]);
  });

  it("settings set refuses a non-list, a non-string, a repeat or a name that is no source plugin; takes a source plugin", async () => {
    const { store } = await newStore();
    const deps = { store, base: { file: {}, layers: config.settings }, repo: REPO, resolveProject: () => Promise.reject(new Error("no")), actor: "" };
    for (const [value, message] of BAD_VALUES) {
      const r = await runSettings(deps, { action: "set", key: "notify_channels", value });
      expect(r.ok, value).toBe(false);
      expect(r.lines.join("\n"), value).toMatch(message);
    }
    expect(await store.listSettingOverrides()).toEqual([]);
    expect((await runSettings(deps, { action: "set", key: "notify_channels", value: '["slack"]' })).ok).toBe(true);
    expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["notify_channels", '["slack"]']]);
  });

  it("the settings API refuses the same values with 422 and takes a source plugin", async () => {
    const clock = new FakeClock("2026-11-12T03:00:00.000Z");
    const { store } = await newStore(clock);
    const settings: UiSettings = {
      base: { file: {}, layers: config.settings }, repo: REPO, actor: "local:owner", resolveProject: async () => null, csrfToken: newCsrfToken(),
    };
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
    for (const [value, message] of BAD_VALUES) {
      const r = await writeSettings(d, settings, { action: "set", key: "notify_channels", value });
      expect(r.status, value).toBe(422);
      expect((r.value as { error: string }).error, value).toMatch(message);
    }
    expect((await writeSettings(d, settings, { action: "set", key: "notify_channels", value: '["slack"]' })).status).toBe(200);
  });
});

describe("the slack block's notify keys at load", () => {
  it("takes notify_channel as a channel ID; a channel name or an unknown key fails startup, naming it", () => {
    expect(() => checkConfigKeys({ ...REAL, slack: { channels: [CHANNEL], notify_channel: NOTIFY } })).not.toThrow();
    expect(slackConfig({ slack: { channels: [CHANNEL], notify_channel: NOTIFY } })).toEqual({ channels: [CHANNEL], notify_channel: NOTIFY });
    for (const bad of ["#factory", "factory", 42]) {
      expect(() => checkConfigKeys({ ...REAL, slack: { channels: [CHANNEL], notify_channel: bad } })).toThrow(/slack\.notify_channel is not a Slack channel ID/);
    }
    expect(() => checkConfigKeys({ ...REAL, slack: { channels: [CHANNEL], notify_channels: NOTIFY } })).toThrow(/notify_channels/);
  });
});

/** The `slack` source on a fake Slack; `dashboard: null` gives it none. */
function slack(over: { notify_channel?: string; dashboard?: null } = {}) {
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const source = new SlackSource({
    api, connect: socket.connect, channels: [CHANNEL, "C0SECOND"], scanner: cleanScanner, store: {} as SlackSourceDeps["store"], repo: REPO, log: silent,
    ...(over.dashboard === null ? {} : { dashboard: async () => "https://factory.example.com/" }),
    ...(over.notify_channel ? { notify_channel: over.notify_channel } : {}),
  });
  return { api, source };
}

const notice = (n: Partial<SourceNotice>): SourceNotice => ({
  kind: "finished", work_item_id: "wi_1", title: "Add dark mode", reason: "merged", close_reason: "completed", thread_url: null, count: 1, ...n,
});

describe("Slack notifyOwner (fake Slack)", () => {
  it("renders a finished notice as merged, rejected or dropped, linked to the item's dashboard page", async () => {
    const { api, source } = slack();
    await source.notifyOwner([
      notice({}), notice({ work_item_id: "wi_2", title: "Old idea", reason: "rejected", close_reason: "rejected" }),
      notice({ work_item_id: "wi_3", title: "Dup", reason: "dropped", close_reason: "duplicate" }),
    ]);
    expect(api.messages.map((m) => [m.channel, m.text])).toEqual([[
      CHANNEL,
      [
        "✅ Finished: <https://factory.example.com/app/items/wi_1|Add dark mode> (merged)",
        "✅ Finished: <https://factory.example.com/app/items/wi_2|Old idea> (rejected)",
        "✅ Finished: <https://factory.example.com/app/items/wi_3|Dup> (dropped)",
      ].join("\n"),
    ]]);
    expect(api.messages[0]!.thread_ts).toBeUndefined();
  });

  it("renders a needs-you notice with its reason, and links the item's Slack thread when it has one", async () => {
    const { api, source } = slack({ notify_channel: "C0NOTICES" });
    const thread = "https://slack.com/archives/C0LISTED/p1800000000000100";
    await source.notifyOwner([
      notice({ kind: "needs_you", title: "Spec for <search>", reason: "spec to approve", close_reason: null, thread_url: thread }),
      notice({ kind: "needs_you", work_item_id: "wi_2", title: "Fix login", reason: "a run failed", close_reason: null }),
    ]);
    expect(api.messages).toHaveLength(1);
    expect(api.messages[0]!.channel).toBe("C0NOTICES");
    expect(String(api.messages[0]!.text).split("\n")).toEqual([
      `🙋 Needs you: <https://factory.example.com/app/items/wi_1|Spec for &lt;search&gt;>: spec to approve (<${thread}|thread>)`,
      "🙋 Needs you: <https://factory.example.com/app/items/wi_2|Fix login>: a run failed",
    ]);
  });

  it("several notices are one message with one line each, the title as main text, never an ID or a person", async () => {
    const { api, source } = slack();
    await source.notifyOwner([notice({}), notice({ work_item_id: "wi_2", title: "Second" }), notice({ kind: "summary", work_item_id: null, title: "", count: 3 })]);
    expect(api.calls.filter((c) => c.method === "postMessage")).toHaveLength(1);
    const lines = String(api.messages[0]!.text).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("🌙 <https://factory.example.com/app/|3 updates during quiet hours>");
    // Link text is the title: an ID appears only inside a URL.
    for (const l of lines) expect(l!.replace(/<[^|>]+\|/g, "<")).not.toMatch(/wi_\d|U0[A-Z]/);
    await source.notifyOwner([]);
    expect(api.messages).toHaveLength(1);
  });

  it("with no dashboard sends no dashboard link; the plugin's default is the local dashboard (approver's note)", async () => {
    const { api, source } = slack({ dashboard: null });
    await source.notifyOwner([notice({})]);
    expect(api.messages[0]!.text).toBe("✅ Finished: Add dark mode (merged)");

    const built = slackPlugin.create({ loaded: { file: { slack: { channels: [CHANNEL] }, ui: { port: 5555 } } }, secrets: {}, scanner: cleanScanner, store: {}, repo: REPO, log: recordingLog() } as never);
    const fake = new FakeSlackApi();
    (built as unknown as { d: SlackSourceDeps }).d.api = fake;
    await (built as SlackSource).notifyOwner([notice({})]);
    expect(fake.messages.map((m) => [m.channel, m.text])).toEqual([[CHANNEL, "✅ Finished: <http://127.0.0.1:5555/app/items/wi_1|Add dark mode> (merged)"]]);
  });
});
