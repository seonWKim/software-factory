// The `slack` source plugin's edges (issue #109): its config block, its secrets and the Web API client.
// The end-to-end behaviour is in tests/slack-source.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigKeyError, checkConfigKeys } from "../src/config-keys.js";
import { commandFooter } from "../src/core/commands.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import { HttpSlackApi, SlackApiError, type FetchFn } from "../src/impl/source/slack-api.js";
import { slackConfig, slackConfigProblems } from "../src/impl/source/slack-config.js";
import { footerCommands, renderComment, suggestedCommand, toMrkdwn } from "../src/impl/source/slack-format.js";
import { SlackSource } from "../src/impl/source/slack-source.js";
import slackPlugin from "../src/impl/source/slack.plugin.js";
import { REGISTRY } from "../src/plugins.js";
import { cleanScanner, recordingLog } from "./helpers/fakes.js";
import { BOT, CHANNEL, FakeSocket, eventEnvelope, mention } from "./helpers/slack.js";

const REPO = { owner: "o", name: "r" };
const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;

/** Obvious fakes, not shaped like real Slack or GitHub tokens. */
const VALUES: Record<string, string> = {
  SLACK_BOT_TOKEN: "test-slack-bot-credential-value",
  SLACK_APP_TOKEN: "test-slack-app-credential-value",
  GITHUB_TOKEN: "test-github-credential-value",
};

/** Records every name read. */
class RecordingSecrets implements SecretStore {
  reads: string[] = [];
  async get(name: SecretName): Promise<Secret | null> {
    this.reads.push(name);
    const v = VALUES[name];
    return v === undefined ? null : { name, reveal: () => v, toString: () => "[secret]", toJSON: () => "[secret]" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(VALUES);
  }
}

/** A fake slack.com: answers each method, records requests. */
function fakeFetch(answers: Record<string, unknown> = {}) {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fn: FetchFn = async (url, init) => {
    requests.push({ url, headers: init.headers, body: init.body });
    const method = url.split("/").at(-1)!;
    const defaults: Record<string, unknown> = {
      "auth.test": { ok: true, team_id: "T0TEAM", user_id: BOT },
      "apps.connections.open": { ok: true, url: "wss://socket.fake.test/link" },
      "chat.postMessage": { ok: true, ts: "1800000000.000001" },
      "chat.update": { ok: true },
      "conversations.replies": { ok: true, messages: [] },
    };
    return { status: 200, json: async () => answers[method] ?? defaults[method] };
  };
  return { fn, requests };
}

describe("slack config block", () => {
  it("is validated at startup: an unknown key in the block fails, naming it", () => {
    expect(() => checkConfigKeys({ ...REAL, slack: { channels: [CHANNEL], channel: "x" } })).toThrow(ConfigKeyError);
    expect(() => checkConfigKeys({ ...REAL, slack: { channels: [CHANNEL], channel: "x" } })).toThrow(/unknown config key "channel" at slack\.channel/);
    expect(() => checkConfigKeys({ ...REAL, slack: { channels: [CHANNEL] } })).not.toThrow();
  });

  it("takes channel IDs only, a non-empty list without repeats", () => {
    expect(slackConfigProblems({ slack: { channels: ["#general"] } })[0]).toMatch(/not a Slack channel ID/);
    expect(slackConfigProblems({ slack: { channels: [] } })[0]).toMatch(/non-empty/);
    expect(slackConfigProblems({ slack: {} })[0]).toMatch(/required/);
    expect(slackConfigProblems({ slack: { channels: [CHANNEL, CHANNEL] } })).toEqual(["slack.channels lists the same channel twice"]);
    expect(slackConfigProblems({ slack: { channels: [CHANNEL, "G0PRIVATE1"] } })).toEqual([]);
    expect(slackConfigProblems({})).toEqual([]);
    expect(() => checkConfigKeys({ ...REAL, slack: { channels: ["general"] } })).toThrow(/slack\.channels\[0\]/);
  });

  it("is required once the plugin is selected", () => {
    expect(() => slackConfig({})).toThrow(/no "slack" block/);
    expect(slackConfig({ slack: { channels: [CHANNEL] } })).toEqual({ channels: [CHANNEL] });
  });

  it("a config that selects slack without the block fails when the plugin is built", () => {
    const { slack: _, ...withoutBlock } = REAL;
    const ctx = { loaded: { file: withoutBlock } } as never;
    expect(() => slackPlugin.create(ctx)).toThrow(/no "slack" block/);
  });
});

describe("slack plugin secrets", () => {
  it("declares exactly SLACK_APP_TOKEN and SLACK_BOT_TOKEN, each with a one-line purpose", () => {
    expect(REGISTRY.source.secrets.slack!.map((d) => d.name).sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    for (const d of REGISTRY.source.secrets.slack!) expect(d.purpose).toMatch(/^[^\n]+$/);
    expect(slackPlugin.secrets!.map((d) => d.name)).not.toContain("GITHUB_TOKEN");
  });

  it("reads only its two Slack tokens, never GITHUB_TOKEN or another GitHub credential", async () => {
    const secrets = new RecordingSecrets();
    const { fn, requests } = fakeFetch();
    const api = new HttpSlackApi(secrets, fn);
    await api.identity();
    await api.openSocketUrl();
    await api.postMessage({ channel: CHANNEL, thread_ts: "1800000000.000001", text: "hi" });
    await api.updateMessage({ channel: CHANNEL, ts: "1800000000.000002", text: "hi" });
    await api.threadReplies(CHANNEL, "1800000000.000001");
    expect([...new Set(secrets.reads)].sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    expect(requests.every((r) => r.url.startsWith("https://slack.com/api/"))).toBe(true);
    // The app token opens the socket and nothing else; the bot token does the rest.
    const byToken = (v: string) => requests.filter((r) => r.headers.authorization === `Bearer ${v}`).map((r) => r.url.split("/").at(-1));
    expect(byToken(VALUES.SLACK_APP_TOKEN!)).toEqual(["apps.connections.open"]);
    expect(byToken(VALUES.SLACK_BOT_TOKEN!)).toEqual(["auth.test", "chat.postMessage", "chat.update", "conversations.replies"]);
    expect(JSON.stringify(requests)).not.toContain(VALUES.GITHUB_TOKEN);
  });

  it("neither Slack token appears in a request body, an error, an event, a log line or a posted message", async () => {
    const secrets = new RecordingSecrets();
    const { fn, requests } = fakeFetch({ "chat.update": { ok: false, error: `bad ${VALUES.SLACK_BOT_TOKEN}` } });
    const api = new HttpSlackApi(secrets, fn);
    const err = await api.updateMessage({ channel: CHANNEL, ts: "1.2", text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as Error).message).toBe("slack chat.update failed: unknown_error");

    const log = recordingLog();
    const socket = new FakeSocket();
    const source = new SlackSource({
      api, connect: socket.connect, channels: [CHANNEL], scanner: cleanScanner, store: { getWorkItemBySource: async () => null }, repo: REPO, log,
    });
    socket.push(eventEnvelope(mention("1800000001.000100", "hello")));
    const ac = new AbortController();
    const iter = source.subscribe(ac.signal)[Symbol.asyncIterator]();
    const first = await iter.next();
    await first.value!.ack();
    ac.abort();
    await iter.return?.(undefined);
    await source.postComment(first.value!.event.kind === "item_requested" ? first.value!.event.source : (null as never), "hello there", "<!-- m -->");
    const outside = JSON.stringify([first.value!.event, first.value!.dedupe_key, log.lines, socket.urls, requests.map((r) => r.body)]);
    for (const v of [VALUES.SLACK_BOT_TOKEN!, VALUES.SLACK_APP_TOKEN!]) expect(outside).not.toContain(v);
    expect(socket.acks).toHaveLength(1);
  });

  it("a missing token fails the call with the secret's name only", async () => {
    const api = new HttpSlackApi({ get: async () => null }, fakeFetch().fn);
    await expect(api.identity()).rejects.toThrow("slack auth.test failed: missing_secret_slack_bot_token");
  });
});

describe("slack message format", () => {
  it("turns Markdown into mrkdwn: markers dropped, bold, headings, links, bullets, PR links", () => {
    const md = "<!-- factory:spec:x -->\n## Factory spec\n**Done** when [docs](https://e.test/d) say so.\n- one <two> & three\nPR #42 is open.\n```\na < b\n```";
    expect(toMrkdwn(md, REPO)).toBe(
      "*Factory spec*\n*Done* when <https://e.test/d|docs> say so.\n• one &lt;two&gt; &amp; three\n<https://github.com/o/r/pull/42|PR #42> is open.\n```\na &lt; b\n```",
    );
  });

  it("a folded <details> block becomes its summary as a bold line, with no HTML tag left as text", () => {
    const md = ["### Done when", "- a", "", "<details><summary>2 more criteria</summary>", "", "- b", "- c", "", "</details>", "", "```", "<details>", "```"].join("\n");
    expect(toMrkdwn(md, REPO)).toBe("*Done when*\n• a\n\n*2 more criteria*\n\n• b\n• c\n\n```\n&lt;details&gt;\n```");
  });

  it("buttons come from the footer the command table builds, for the commands that take no text", () => {
    const footer = commandFooter({ phase: "spec_pending", has_pr: false });
    expect(footerCommands(`Spec\n\n${footer}`)).toEqual(["approve", "help"]);
    expect(footerCommands(commandFooter({ phase: "failed_run", has_pr: false }))).toEqual(["retry", "help"]);
    expect(footerCommands("no footer")).toEqual([]);
    const r = renderComment(`Spec\n\n${footer}`, REPO, BOT);
    expect(JSON.stringify(r.blocks.at(-1))).toContain('"action_id":"sf_cmd:approve"');
  });

  it("a suggestion gets Confirm with the suggested command, and Cancel", () => {
    const body = "Did you mean `/approve`? Nothing has changed. To apply it, reply with:\n\n```\n/approve ship it\n```";
    expect(suggestedCommand(body)).toBe("/approve ship it");
    const actions = renderComment(body, REPO, BOT).blocks.at(-1) as { elements: { action_id: string; value: string }[] };
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([["sf_confirm", "/approve ship it"], ["sf_cancel", "cancel"]]);
  });

  it("splits a long message into sections Slack accepts", () => {
    const r = renderComment(Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"), REPO, BOT);
    const sections = r.blocks.filter((b) => (b as { type: string }).type === "section") as { text: { text: string } }[];
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.text.text.length <= 3000)).toBe(true);
  });
});
