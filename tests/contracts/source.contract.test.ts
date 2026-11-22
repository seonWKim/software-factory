// The SourceAdapter contract (tests/contracts/source.contract.ts) over every implementation: the local source, the
// GitHub issue source on an in-memory GitHub, the Slack source on a fake Slack, and the test fakes the feature tests
// use (RFC 0023 R2).
import { createHash } from "node:crypto";
import { OwnerAuth } from "../../src/core/authorize.js";
import type { WorkStatus } from "../../src/core/status-label.js";
import type { SourceRef, UserId } from "../../src/core/types.js";
import type { SourceEvent } from "../../src/interfaces/source-adapter.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import { GitHubIssueSource, statusLabels } from "../../src/impl/github/github-issue-source.js";
import { LocalSource } from "../../src/impl/source/local-source.js";
import { META_MESSAGE, META_STATUS, SlackSource } from "../../src/impl/source/slack-source.js";
import { threadRef } from "../../src/impl/source/slack-thread.js";
import { silent } from "../helpers/fakes/config.js";
import { FakeSlackPollSource, FakeSource, FakeStreamSource } from "../helpers/fakes/source.js";
import { CHANNEL, FakeSlackApi, FakeSocket, TEAM, eventEnvelope, mention } from "../helpers/slack.js";
import { PROJECT_KEY, newStore, system } from "../helpers/store.js";
import { MemoryGitHub } from "./memory-github.js";
import { type SourceHarness, sourceContract } from "./source.contract.js";

let n = 0;

sourceContract("local", async () => {
  const { store } = await newStore();
  return {
    source: new LocalSource(store),
    async item() {
      const id = `tk_contract_${++n}`;
      const source = { type: "local", id, link: `local:${id}` };
      await store.createWorkItem({ source, requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "a local task", resources: [] }, system);
      return source;
    },
    async posted(ref, marker) {
      const item = (await store.getWorkItemBySource("local", ref.id))!;
      return (await store.listItemMessages(item.id)).filter((m) => m.marker === marker).length;
    },
  };
});

sourceContract("github", async () => {
  const gh = new MemoryGitHub();
  const { store } = await newStore();
  const source = new GitHubIssueSource(gh, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  const status = new Map(statusLabels("sf: ").map((l) => [l.name, l.status] as [string, WorkStatus]));
  const number = (ref: SourceRef) => Number(ref.id.split("#")[1]);
  return {
    source,
    async item() {
      const i = gh.addIssue({ labels: ["factory"] });
      return { type: "github_issue", id: `o/r#${i.number}`, link: `https://github.com/o/r/issues/${i.number}` };
    },
    async posted(ref, marker) {
      return gh.comments.filter((c) => c.number === number(ref) && c.body.includes(marker)).length;
    },
    async statuses(ref) {
      return gh.issue(number(ref)).labels.flatMap((l) => (status.has(l) ? [status.get(l)!] : []));
    },
    foreign: {
      async add(ref) {
        gh.issue(number(ref)).labels.push("bug");
      },
      async present(ref) {
        return gh.issue(number(ref)).labels.includes("bug");
      },
    },
    async closed(ref) {
      const i = gh.issue(number(ref));
      return i.state === "open" ? "open" : (i.state_reason as "completed" | "not_planned");
    },
    async personMessage(ref) {
      return String(gh.addComment(number(ref), "a person's comment").id);
    },
    async seen(_ref, id) {
      return gh.comments.find((c) => c.id === Number(id))!.reactions.filter((r) => r === "eyes").length;
    },
    async comment(ref, body) {
      const c = gh.addComment(number(ref), body);
      return {
        async edit(text) {
          c.body = text;
          c.updated_at = gh.tick();
        },
      };
    },
  };
});

sourceContract("slack", async () => {
  const { store } = await newStore();
  const api = new FakeSlackApi();
  const socket = new FakeSocket();
  const slack = new SlackSource({
    api, connect: socket.connect, channels: [CHANNEL], scanner: new PatternEgressScanner(async () => []), store, auth: new OwnerAuth(store),
    repo: { owner: "o", name: "r" }, log: silent,
  });
  // The marker's hash as the Slack source keeps it in a message's metadata.
  const hash = (marker: string) => createHash("sha256").update(marker).digest("hex").slice(0, 32);
  const thread = (ref: SourceRef) => api.messages.filter((m) => ref.id.endsWith(`:${m.channel}:${m.thread_ts}`));
  let ts = 1700000000;
  return {
    source: slack,
    async item() {
      return threadRef({ team: TEAM, channel: CHANNEL, thread_ts: `${++ts}.000100` });
    },
    async posted(ref, marker) {
      return thread(ref).filter((m) => m.metadata?.event_type === META_MESSAGE && m.metadata.event_payload.marker === hash(marker)).length;
    },
    async statuses(ref) {
      return thread(ref).flatMap((m) => (m.metadata?.event_type === META_STATUS ? [m.metadata.event_payload.status as WorkStatus] : []));
    },
    async personMessage(ref) {
      const [, , channel, thread_ts] = ref.id.split(":");
      const at = `${++ts}.000200`;
      api.messages.push({ ts: at, user: "U0ALICE", channel: channel!, thread_ts: thread_ts!, text: "a person's message" });
      return at;
    },
    async seen(ref, id) {
      return api.reactions.filter((r) => ref.id.includes(`:${r.channel}:`) && r.ts === id && r.name === "eyes").length;
    },
    async push(text) {
      socket.push(eventEnvelope(mention(`${++ts}.000300`, text)));
    },
  };
});

/** FakeSource and FakeSlackPollSource: their records stand in for the forge's issue, labels and reactions. */
function fakePoll(source: FakeSource): SourceHarness {
  let comment = 500;
  return {
    source,
    async item() {
      const id = `o/r#${++n}`;
      return { type: source.type, id, link: `https://github.com/o/r/issues/${n}` };
    },
    async posted(ref, marker) {
      return source.comments.filter((c) => c.source.id === ref.id && c.marker === marker).length;
    },
    async statuses(ref) {
      return source.statusLabels(ref) as WorkStatus[];
    },
    foreign: {
      async add(ref) {
        source.labels.set(ref.id, new Set([...(source.labels.get(ref.id) ?? []), "bug"]));
      },
      async present(ref) {
        return source.labels.get(ref.id)?.has("bug") ?? false;
      },
    },
    async closed(ref) {
      const i = source.closed.findLastIndex((c) => c.id === ref.id);
      return i === -1 ? "open" : source.closeReasons[i]!;
    },
    async personMessage() {
      return String(++comment);
    },
    async seen(ref, id) {
      return source.reactions.filter((r) => r.source.id === ref.id && r.comment_id === id).length;
    },
    async comment(ref, body) {
      const event = (text: string): SourceEvent => ({
        kind: "plain_comment", source: ref, comment_id: String(id), author: { provider: "github", subject: "1", login: "alice" }, body: text,
      });
      const id = ++comment;
      source.queue.push(event(body));
      return {
        // An edit shows the comment again, under its id, as GitHub's `since` list does.
        async edit(text) {
          source.queue.push(event(text));
        },
      };
    },
  };
}

sourceContract("fake (FakeSource)", async () => fakePoll(new FakeSource()));
sourceContract("fake (FakeSlackPollSource)", async () => fakePoll(new FakeSlackPollSource()));

sourceContract("fake (FakeStreamSource)", async () => {
  const source = new FakeStreamSource();
  let key = 0;
  let comment = 700;
  return {
    source,
    async item() {
      return threadRef({ team: TEAM, channel: CHANNEL, thread_ts: `${1700000000 + ++n}.000100` });
    },
    async posted(ref, marker) {
      return source.comments.filter((c) => c.source.id === ref.id && c.marker === marker).length;
    },
    async personMessage() {
      return `1700000000.${String(++comment).padStart(6, "0")}`;
    },
    async seen(ref, id) {
      return source.reactions.filter((r) => r.source.id === ref.id && r.comment_id === id).length;
    },
    async push(text) {
      const ref = threadRef({ team: TEAM, channel: CHANNEL, thread_ts: `${1700000000 + ++n}.000100` });
      source.push({ kind: "item_requested", source: ref, requester: { provider: "slack", subject: "U0ALICE" }, title: text, body: text, classify: true }, `Ev${++key}`);
    },
  };
});
