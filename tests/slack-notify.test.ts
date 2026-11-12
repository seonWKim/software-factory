// The owner's notices in Slack and their records (design 05-sources, "Replies under a notice"): when a notice posts,
// the Slack source's notifyOwner stores its channel and ts with the work item IDs its lines name. Fakes only.

import { describe, expect, it } from "vitest";
import type { SourceNotice } from "../src/interfaces/source-adapter.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { postNotices } from "../src/impl/source/slack-notify.js";
import { SlackSource } from "../src/impl/source/slack-source.js";
import { silent } from "./helpers/fakes.js";
import { CHANNEL, FakeSlackApi, FakeSocket, OTHER_CHANNEL } from "./helpers/slack.js";
import { newStore } from "./helpers/store.js";

const needs = (id: string, title = `Item ${id}`): SourceNotice => ({
  kind: "needs_you", work_item_id: id, title, reason: "ready to merge", close_reason: null, thread_url: null, count: 1,
});
const summary: SourceNotice = { kind: "summary", work_item_id: null, title: "", reason: "", close_reason: null, thread_url: null, count: 3 };

async function setup(notify_channel?: string) {
  const { store } = await newStore();
  const api = new FakeSlackApi();
  const slack = new SlackSource({
    api, connect: new FakeSocket().connect, channels: [CHANNEL], scanner: new PatternEgressScanner(async () => []), store,
    repo: { owner: "o", name: "r" }, log: silent, ...(notify_channel ? { notify_channel } : {}),
  });
  return { store, api, slack };
}

const topLevel = (api: FakeSlackApi) => api.messages.filter((m) => m.thread_ts === undefined);

describe("slack notices: the notice record", () => {
  it("a posted notice stores its ts and the item IDs its lines name, in line order", async () => {
    const f = await setup();
    await f.slack.notifyOwner([needs("wi_b"), needs("wi_a")]);
    const [posted] = topLevel(f.api);
    expect(posted!.text).toContain("🙋 Needs you: Item wi_b: ready to merge");
    expect(await f.store.getNoticeMessage(CHANNEL, posted!.ts)).toMatchObject({ channel: CHANNEL, ts: posted!.ts, work_item_ids: ["wi_b", "wi_a"] });
  });

  it("a summary line names no item: a notice of summaries only gets a record with no item IDs", async () => {
    const f = await setup();
    await f.slack.notifyOwner([summary]);
    const [posted] = topLevel(f.api);
    expect(await f.store.getNoticeMessage(CHANNEL, posted!.ts)).toMatchObject({ work_item_ids: [] });
  });

  it("a summary beside item lines adds no ID; an item named twice is stored once", async () => {
    const f = await setup();
    await f.slack.notifyOwner([summary, needs("wi_a"), { ...needs("wi_a"), kind: "finished", reason: "merged" }]);
    const [posted] = topLevel(f.api);
    expect((await f.store.getNoticeMessage(CHANNEL, posted!.ts))?.work_item_ids).toEqual(["wi_a"]);
  });

  it("the record is keyed on the notices channel when one is set", async () => {
    const f = await setup(OTHER_CHANNEL);
    await f.slack.notifyOwner([needs("wi_a")]);
    const [posted] = topLevel(f.api);
    expect(posted!.channel).toBe(OTHER_CHANNEL);
    expect(await f.store.getNoticeMessage(OTHER_CHANNEL, posted!.ts)).toMatchObject({ work_item_ids: ["wi_a"] });
    expect(await f.store.getNoticeMessage(CHANNEL, posted!.ts)).toBeNull();
  });

  it("no notices: nothing is posted and nothing is recorded", async () => {
    const f = await setup();
    await f.slack.notifyOwner([]);
    expect(f.api.messages).toEqual([]);
  });

  it("a failed post records nothing and throws, so outbound retries", async () => {
    const f = await setup();
    f.api.postMessage = async () => {
      throw new Error("slack down");
    };
    await expect(f.slack.notifyOwner([needs("wi_a")])).rejects.toThrow("slack down");
    expect(await f.store.getNoticeMessage(CHANNEL, "1800000000.005000")).toBeNull();
  });

  it("postNotices returns the posted message's channel and ts, or null for no notices", async () => {
    const api = new FakeSlackApi();
    expect(await postNotices({ api, channels: [CHANNEL] }, [])).toBeNull();
    const posted = await postNotices({ api, channels: [CHANNEL] }, [needs("wi_a")]);
    expect(posted).toEqual({ channel: CHANNEL, ts: api.messages[0]!.ts });
  });
});
