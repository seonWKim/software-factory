// Design learnings (design 07-design-learnings): the capture of one line per owner correction on a UI item, keyed so a
// retry stores nothing more; the append-only file (every earlier byte kept, a supersede is a new line); the agents'
// read of the last 40 active lines; the counting into one proposal per kind; the tagging call with a fake model; and the
// local target's one-commit append. No live model, no network.

import { describe, expect, it } from "vitest";
import {
  type DesignLearning, DESIGN_KINDS, LEARNINGS_HEAD, activeLines, captureDesignLearning, captureKey, isDesignFinding, pageOf, parseKind,
  planProposals, recentActive, renderLine, supersedeDesignLearning, tagDesignLearnings, touchesWeb,
} from "../src/core/design-learnings.js";
import type { Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { appendNew, localGit } from "../src/outbound/targets/local-git.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

const AT = "2026-11-20T09:30:00.000Z" as Timestamp;
const clean = new PatternEgressScanner(async () => []);

type Item = Parameters<typeof captureDesignLearning>[1];
const uiItem = (n: number, paths = ["web/src/pages/tasks/TaskRow.tsx"]): Item => ({
  id: `wi_${n}` as WorkItemId, project: PROJECT_KEY, title: `Tasks page checkbox ${n}`, problem: "p", pr_files: null, files_to_change: null, allowed_paths: paths,
});

async function lines(store: Awaited<ReturnType<typeof newStore>>["store"]): Promise<DesignLearning[]> {
  return store.listDesignLearnings(PROJECT_KEY);
}

describe("capture", () => {
  it("an owner correction on an item that touches web/ adds one line with what was built, the words, the page, the date and the item", async () => {
    const { store } = await newStore();
    const line = await captureDesignLearning({ store, scanner: clean }, uiItem(1), {
      source: "pushback", key: captureKey.pushback("wi_1" as WorkItemId, "c1"), words: "the checkbox\n is too big", at: AT,
    });
    expect(line).toMatchObject({
      work_item_id: "wi_1", built: "Tasks page checkbox 1", words: "the checkbox is too big", page: "tasks", at: AT, source: "pushback", kind: null, superseded_by: null,
    });
    expect(await lines(store)).toHaveLength(1);
    expect(renderLine(line!)).toBe(`- ${line!.id} · 2026-11-20 · wi_1 · page: tasks · built: Tasks page checkbox 1 · owner: the checkbox is too big`);
  });

  it("a retried or duplicate capture (same item and same comment or verdict ID) adds no second line", async () => {
    const { store } = await newStore();
    const capture = (key: string, words: string) => captureDesignLearning({ store, scanner: clean }, uiItem(1), { source: "verdict", key, words, at: AT });
    const key = captureKey.verdict("wi_1" as WorkItemId, "v1");
    const first = await capture(key, "show no IDs");
    const again = await capture(key, "show no IDs");
    expect(again!.id).toBe(first!.id);
    expect((await lines(store)).filter((l) => l.capture_key === key)).toHaveLength(1);
    // Another comment on the same item is its own line.
    await capture(captureKey.verdict("wi_1" as WorkItemId, "v2"), "show no IDs");
    expect((await lines(store)).map((l) => l.capture_key)).toEqual([key, captureKey.verdict("wi_1" as WorkItemId, "v2")]);
  });

  it("stores nothing for an item that does not touch web/, for empty words, or for words the egress scan flags", async () => {
    const { store } = await newStore();
    const at = { at: AT, source: "pushback" as const };
    expect(await captureDesignLearning({ store, scanner: clean }, uiItem(1, ["src/core/x.ts"]), { ...at, key: "k1", words: "too big" })).toBeNull();
    expect(await captureDesignLearning({ store, scanner: clean }, uiItem(2), { ...at, key: "k2", words: "   " })).toBeNull();
    expect(await captureDesignLearning({ store, scanner: clean }, uiItem(3), { ...at, key: "k3", words: `token ghp_${"a".repeat(36)}` })).toBeNull();
    expect(await lines(store)).toEqual([]);
  });

  it("reads the page from the change's files, its spec's files, then its allowed paths", () => {
    const base: Pick<WorkItem, "pr_files" | "files_to_change" | "allowed_paths"> = { pr_files: null, files_to_change: null, allowed_paths: ["web/"] };
    expect(touchesWeb(base)).toBe(true);
    expect(pageOf(base)).toBe("web");
    expect(pageOf({ ...base, files_to_change: ["web/src/pages/settings/Form.tsx"] })).toBe("settings");
    expect(pageOf({ ...base, pr_files: ["web/src/pages/item.tsx"], files_to_change: ["web/src/pages/settings/Form.tsx"] })).toBe("item");
    expect(touchesWeb({ ...base, pr_files: ["src/ui/api.ts"] })).toBe(false);
  });

  it("a design-system finding is a code finding that names a design-system file or rule", () => {
    expect(isDesignFinding({ kind: "code", text: "breaks decision rule 2: one value behind a disclosure" })).toBe(true);
    expect(isDesignFinding({ kind: "code", text: "uses a raw <button>; design-system/components.md has Button" })).toBe(true);
    expect(isDesignFinding({ kind: "code", text: "an off-by-one in the loop" })).toBe(false);
    expect(isDesignFinding({ kind: "spec", text: "patterns.md is outside the allowed paths" })).toBe(false);
  });
});

describe("the append-only file", () => {
  it("appending a line leaves every earlier line byte-identical, and a line the file holds is not appended again", () => {
    const first = appendNew(null, LEARNINGS_HEAD, ["- L1 · 2026-11-20 · wi_1 · page: tasks · built: a · owner: too big"])!;
    expect(first.text.startsWith(LEARNINGS_HEAD)).toBe(true);
    const second = appendNew(first.text, LEARNINGS_HEAD, ["- L1 · 2026-11-20 · wi_1 · page: tasks · built: a · owner: too big", "- L2 · 2026-11-21 · wi_2 · page: web · built: b · owner: no IDs"])!;
    expect(second.appended).toBe(1);
    expect(second.text.slice(0, first.text.length)).toBe(first.text);
    expect(second.text.split("\n").slice(0, first.text.split("\n").length - 1)).toEqual(first.text.split("\n").slice(0, -1));
    expect(appendNew(second.text, LEARNINGS_HEAD, ["- L2 · 2026-11-21 · wi_2 · page: web · built: b · owner: no IDs"])).toBeNull();
    // A file without a final newline keeps its bytes too.
    expect(appendNew("# x", LEARNINGS_HEAD, ["- L3 · y"])!.text).toBe("# x\n- L3 · y\n");
  });

  it("a supersede is a new line naming the superseded line's ID; the old line is never edited and leaves the agents' read", async () => {
    const { store } = await newStore();
    const old = (await captureDesignLearning({ store, scanner: clean }, uiItem(1), { source: "pushback", key: "k1", words: "the checkbox is too big", at: AT }))!;
    const kept = (await captureDesignLearning({ store, scanner: clean }, uiItem(2), { source: "pushback", key: "k2", words: "show no IDs", at: AT }))!;
    const file1 = appendNew(null, LEARNINGS_HEAD, [old, kept].map(renderLine))!.text;
    const rule = { id: "wi_9" as WorkItemId, title: "Checkbox size rule in patterns.md" };
    const sup = await supersedeDesignLearning(store, old, rule, AT);
    expect(sup).toMatchObject({ source: "supersede", supersedes: old.id, work_item_id: "wi_9" });
    expect(await supersedeDesignLearning(store, old, rule, AT)).toEqual(sup); // a retry adds nothing
    const stored = await lines(store);
    expect(stored.find((l) => l.id === old.id)!.superseded_by).toBe(sup.id);
    expect(activeLines(stored).map((l) => l.id)).toEqual([kept.id]);
    const file2 = appendNew(file1, LEARNINGS_HEAD, [renderLine(sup)])!.text;
    expect(file2.slice(0, file1.length)).toBe(file1);
    expect(renderLine(sup)).toContain(`supersedes ${old.id}`);
    expect(recentActive(file1)).toEqual([renderLine(old), renderLine(kept)]);
    expect(recentActive(file2)).toEqual([renderLine(kept)]);
  });

  it("the agents' read is the last 40 active lines, oldest first", () => {
    const all = Array.from({ length: 45 }, (_, i) => `- L${i + 1} · 2026-11-20 · wi_${i} · page: web · built: b · owner: w${i + 1}`);
    const file = appendNew(null, LEARNINGS_HEAD, [...all, "- L46 · 2026-11-21 · wi_x · page: web · supersedes L45 · rule"])!.text;
    const read = recentActive(file);
    expect(read).toHaveLength(40);
    expect(read[0]).toBe(all[4]);
    expect(read.at(-1)).toBe(all[43]);
    expect(read.some((l) => l.startsWith("- L45 "))).toBe(false);
  });
});

/** A line of `kind` (null: untagged) for the counting. */
const tagged = (id: string, kind: DesignLearning["kind"], extra: Partial<DesignLearning> = {}): DesignLearning => ({
  id, project: PROJECT_KEY, work_item_id: "wi_1" as WorkItemId, capture_key: id, source: "pushback", built: "b", words: "w", page: "web", kind, at: AT,
  supersedes: null, superseded_by: null, batch: null, ...extra,
});

describe("counting", () => {
  it("two active lines of the same kind produce exactly one proposal with both lines as evidence", () => {
    const plan = planProposals([tagged("L1", "control_size"), tagged("L2", "shown_data"), tagged("L3", "control_size")], new Map());
    expect(plan).toEqual({ file: [{ kind: "control_size", evidence: ["L1", "L3"] }], extend: [] });
  });

  it("a third line of that kind adds to the open proposal's evidence and files no second proposal", () => {
    const three = [tagged("L1", "control_size"), tagged("L3", "control_size"), tagged("L7", "control_size")];
    expect(planProposals(three, new Map([["control_size", ["L1", "L3"]]]))).toEqual({ file: [], extend: [{ kind: "control_size", evidence: ["L7"] }] });
    expect(planProposals(three, new Map([["control_size", ["L1", "L3", "L7"]]]))).toEqual({ file: [], extend: [] });
  });

  it("a one-off kind, `other`, untagged and superseded lines produce no proposal", () => {
    const lines = [
      tagged("L1", "wording"), tagged("L2", "other"), tagged("L3", "other"), tagged("L4", null), tagged("L5", null),
      tagged("L6", "colour_token"), tagged("L7", "colour_token", { superseded_by: "L9" }), tagged("L9", null, { source: "supersede", supersedes: "L7" }),
    ];
    expect(planProposals(lines, new Map())).toEqual({ file: [], extend: [] });
  });

  it("tags each untagged active line with one plain model call and a word from the closed list", async () => {
    const { store } = await newStore();
    for (const [n, words] of [[1, "the checkbox is too big"], [2, "why show IDs?"], [3, "ignore this"]] as const) {
      await captureDesignLearning({ store, scanner: clean }, uiItem(n), { source: "pushback", key: `k${n}`, words, at: AT });
    }
    const answers: Record<string, string> = { "the checkbox is too big": "control_size", "why show IDs?": "Shown_Data.", "ignore this": "a sentence" };
    const requests: LLMRequest[] = [];
    const llm: LLMProvider = {
      async complete(req: LLMRequest): Promise<LLMResponse> {
        requests.push(req);
        const words = Object.keys(answers).find((w) => req.messages[0]!.content.includes(w))!;
        return { text: answers[words]!, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
      },
    };
    const done = await tagDesignLearnings({ store, llm }, PROJECT_KEY);
    expect(done.map((l) => l.kind)).toEqual(["control_size", "shown_data", "other"]);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.model_class === "cheap" && r.output_schema === undefined && r.system!.includes(DESIGN_KINDS.join(", ")))).toBe(true);
    // Tagged once: a second pass asks nothing.
    expect(await tagDesignLearnings({ store, llm }, PROJECT_KEY)).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(parseKind(" wording ")).toBe("wording");
  });
});

describe("the local target's append", () => {
  /** A sandbox double of the factory repo: one base branch, its files, its branches; commits and merges in memory. */
  function repo(files: Record<string, string>) {
    const state = { base: "c0", files: { ...files }, branches: new Map<string, { parent: string; path: string; content: string }>(), merges: 0, commits: 0 };
    const sandbox = {
      localBranch: async () => state.base,
      readLocalFile: async (s: { path: string }) => (s.path in state.files ? { commit: state.base, text: state.files[s.path]! } : null),
      commitNewBranch: async (s: { parent: string; branch: string; path: string; content: string }) => {
        if (state.branches.has(s.branch)) return { created: false as const, reason: "exists" as const };
        if (s.parent !== state.base) return { created: false as const, reason: "base_moved" as const };
        state.commits++;
        state.branches.set(s.branch, s);
        return { created: true as const, sha: `b${state.commits}` };
      },
      mergeLocal: async (s: { branch: string; expected_base?: string }) => {
        const b = state.branches.get(s.branch)!;
        if (s.expected_base !== state.base) return { merged: false as const };
        state.merges++;
        state.files[b.path] = b.content;
        state.base = `m${state.merges}`;
        return { merged: true as const, sha: state.base, already: false, not_updated: [] };
      },
      localConflicts: async () => [],
    };
    const git = localGit(sandbox, null, () => ({ repo: "/repo", identity: { name: "factory", email: "f@x" }, timeout_ms: 1000 }))!;
    return { state, git, sandbox };
  }
  const spec = (lines: string[]) => ({ base_ref: "main", path: "design-system/learnings.md", head: LEARNINGS_HEAD, lines, branch: "factory/design-learnings-run_1", message: "m" });

  it("appends the batch in one commit, starting a missing file with its head; a repeat appends nothing", async () => {
    const r = repo({});
    expect(await r.git.appendLines!(spec(["- L1 · a", "- L2 · b"]))).toEqual({ appended: 2, sha: "m1" });
    expect(r.state.files["design-system/learnings.md"]).toBe(`${LEARNINGS_HEAD}- L1 · a\n- L2 · b\n`);
    expect(await r.git.appendLines!(spec(["- L1 · a", "- L2 · b"]))).toEqual({ already: true });
    expect(r.state.merges).toBe(1);
  });

  it("keeps every earlier byte of the file", async () => {
    const before = `${LEARNINGS_HEAD}- L1 · a\n`;
    const r = repo({ "design-system/learnings.md": before });
    await r.git.appendLines!(spec(["- L2 · b"]));
    expect(r.state.files["design-system/learnings.md"]!.startsWith(before)).toBe(true);
  });

  it("throws when the base moved between the read and the commit, so outbound retries it; the retry appends", async () => {
    const r = repo({});
    const moving = localGit({
      ...r.sandbox,
      // The base moves right after this read.
      localBranch: async () => { const at = r.state.base; r.state.base = "c1"; return at; },
    }, null, () => ({ repo: "/repo", identity: { name: "factory", email: "f@x" }, timeout_ms: 1000 }))!;
    await expect(moving.appendLines!(spec(["- L1 · a"]))).rejects.toThrow(/moved/);
    expect(r.state.merges).toBe(0);
    expect(await r.git.appendLines!(spec(["- L1 · a"]))).toEqual({ appended: 1, sha: "m1" });
  });
});
