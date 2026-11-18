import { describe, expect, it } from "vitest";
import type { ActionRow } from "../../src/outbound/index.js";
import { buildTargets } from "../../src/outbound/targets/targets.js";
import type { SourceAdapter } from "../../src/interfaces/source-adapter.js";
import { LocalSource } from "../../src/impl/source/local-source.js";
import { PROJECT_KEY, newStore } from "../helpers/store.js";

// Red main (design 03-risk): the controller stores one `file_fix_item` action per failing base sha; outbound files it
// through the target source's `fileIssue`, with the marker keyed on the sha, so a retry files no second item.

const SHA = "0123456789abcdef0123456789abcdef01234567";

function row(type: string): ActionRow {
  return {
    seq: 1, action: "file_fix_item", source_type: type, target: { type, id: `red-main:${SHA}`, link: "" }, work_item_id: null,
    key: `file_fix_item:red_main:${SHA}`,
    args: { project: PROJECT_KEY, requester_id: "system:controller", base_sha: SHA, marker: `<!-- factory:red-main:${SHA} -->`, title: "Fix `main`", body: "it fails" },
    delivered_at: null, delivered_ref: null, delivered_url: null, outcome: null, last_error: null,
  };
}

describe("outbound: file_fix_item", () => {
  it("the local target files one local work item through the local source's fileIssue, the same one on a retry", async () => {
    const { store } = await newStore();
    const local = new LocalSource(store);
    const target = buildTargets({ byType: new Map([["local", local]]), forge: null, repo: "/repo" }).find((t) => t.accepts({ kind: "action", row: row("local") }))!;
    expect(target.name).toBe("local");
    const first = await target.deliver({ kind: "action", row: row("local") });
    const again = await target.deliver({ kind: "action", row: row("local") });
    expect(again).toEqual(first);
    const item = await store.getWorkItemBySource("local", first.ref!);
    expect(item).toMatchObject({ title: "Fix `main`", requester_id: "system:controller", project: PROJECT_KEY });
    expect(item!.problem).toContain(`<!-- factory:red-main:${SHA} -->`);
  });

  it("a GitHub source files it through fileIssue; one that cannot file (fileSubIssue only) does not take it", async () => {
    const filed: Parameters<NonNullable<SourceAdapter["fileIssue"]>>[0][] = [];
    const github = {
      type: "github_issue",
      fileIssue: async (i: (typeof filed)[number]) => {
        filed.push(i);
        return { type: "github_issue", id: "o/r#9", link: "https://github.com/o/r/issues/9" };
      },
    } as unknown as SourceAdapter;
    const targets = buildTargets({ byType: new Map([["github_issue", github]]), forge: null, repo: "/repo" });
    const d = { kind: "action", row: row("github_issue") } as const;
    const target = targets.find((t) => t.accepts(d))!;
    expect(target.name).toBe("github-issue");
    expect(await target.deliver(d)).toEqual({ url: "https://github.com/o/r/issues/9", ref: "o/r#9" });
    expect(filed).toEqual([{ project: PROJECT_KEY, requester_id: "system:controller", title: "Fix `main`", body: "it fails", marker: `<!-- factory:red-main:${SHA} -->` }]);

    const subOnly = { type: "github_issue", fileSubIssue: async () => ({ type: "github_issue", id: "x", link: "" }) } as unknown as SourceAdapter;
    const none = buildTargets({ byType: new Map([["github_issue", subOnly]]), forge: null, repo: "/repo" });
    expect(none.find((t) => t.accepts(d))?.name).not.toBe("github-issue");
  });
});
