import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CommandName, commandTableMarkdown, helpReply, parseCommandPaths, parseComment, retryPathsReply, withholdReplyLines } from "../src/core/commands.js";
import { itemCommands, resolveScopePaths } from "../src/ui/commands.js";
import { resolveScopeDetail } from "../src/worker/support.js";
import type { WorkItem } from "../src/core/types.js";

describe("parseComment", () => {
  const cmd = (name: CommandName, text = "") => ({ kind: "command", name, text });

  it("reads /approve with no note, a same-line note, and a note on the lines below", () => {
    expect(parseComment("/approve")).toEqual(cmd("approve"));
    expect(parseComment("/approve keep it small")).toEqual(cmd("approve", "keep it small"));
    expect(parseComment("/approve\nkeep it small\nand tested")).toEqual(cmd("approve", "keep it small\nand tested"));
    expect(parseComment("/approve first\r\nsecond  \n\n")).toEqual(cmd("approve", "first\nsecond"));
    expect(parseComment("  /approve   \n")).toEqual(cmd("approve"));
  });

  it("matches names case-insensitively and accepts punctuation after the word", () => {
    expect(parseComment("/APPROVE")).toEqual(cmd("approve"));
    expect(parseComment("/Approve. thanks")).toEqual(cmd("approve", "thanks"));
    expect(parseComment("/retry!")).toEqual(cmd("retry"));
    expect(parseComment("/reject: too big")).toEqual(cmd("reject", "too big"));
    expect(parseComment("/help?")).toEqual(cmd("help"));
  });

  it("an unknown word is an unknown command, as typed", () => {
    expect(parseComment("/aprove")).toEqual({ kind: "unknown", word: "aprove" });
    expect(parseComment("/rejectfoo no")).toEqual({ kind: "unknown", word: "rejectfoo" });
    expect(parseComment("/Xyz")).toEqual({ kind: "unknown", word: "Xyz" });
  });

  it("anything that is not `/` plus letters and a boundary is not a command", () => {
    for (const body of ["looks good", "", "/", "/ approve", "/ ", "/src/core/x.ts is wrong", "/approve2", "/re-ject", "x /approve", "/123"]) {
      expect(parseComment(body)).toBeNull();
    }
  });

  it("/reject and /revise keep the rest of the first line and the lines below", () => {
    expect(parseComment("/reject too big\nsplit it")).toEqual(cmd("reject", "too big\nsplit it"));
    expect(parseComment("/revise   \n")).toEqual(cmd("revise"));
  });
});

describe("+paths (issue #280)", () => {
  it("the item API puts a permission ask's paths on the commands that take +paths, the covered ones left out", async () => {
    const it_ = {
      stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human", change_ref: null, allowed_paths: ["src/a.ts"],
      source: { type: "github_issue", id: "o/r#1", link: "x" },
    } as unknown as WorkItem;
    const ask = (paths: string[]) => ({
      kind: "implement", status: "succeeded",
      outcome: { status: "succeeded", data: { needs_human: { reason: "outside the paths", question: "May I edit these paths?", paths } } },
    });
    const runs = [ask(["docs/old.md"]), ask(["src/a.ts", "web/b.tsx", "web/b.tsx"])] as never[];
    const rows = await itemCommands(it_, runs, { allow: true }, async (v) => v);
    const retry = rows.find((r) => r.name === "retry");
    expect(retry?.paths).toEqual(["web/b.tsx"]);
    for (const r of rows.filter((r) => !["approve", "retry", "resolve"].includes(r.name))) expect(r.paths, r.name).toBeUndefined();
    // A path the Withholder changes is left out; an item that holds no ask gets none.
    expect((await itemCommands(it_, runs, { allow: true }, async (v) => (v === "web/b.tsx" ? "[withheld]" : v))).find((r) => r.name === "retry")?.paths).toBeUndefined();
    const plain = await itemCommands({ ...it_, blocked_reason: "spec_pending", stage: "READY" } as WorkItem, runs, { allow: true }, async (v) => v);
    expect(plain.some((r) => r.paths !== undefined)).toBe(false);
  });

  it("the `/resolve +paths` reply of an out_of_scope resolve failure reads back the paths, with the CLI's parser (2026-11-26)", () => {
    expect(resolveScopePaths(resolveScopeDetail(["a/b.ts"]))).toEqual(["a/b.ts"]);
    expect(resolveScopePaths(resolveScopeDetail(["tests/a.test.ts", "src/x.ts", "src/x.ts"]))).toEqual(["tests/a.test.ts", "src/x.ts"]);
    // No single reply, no reply at all, a path the CLI refuses, or another command's reply: none.
    expect(resolveScopePaths(resolveScopeDetail(Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`)))).toEqual([]);
    expect(resolveScopePaths("the resolve run timed out")).toEqual([]);
    expect(resolveScopePaths("Reply `/resolve +paths ../x.ts` to allow them and resolve again.")).toEqual([]);
    expect(resolveScopePaths("Reply `/retry +paths a/b.ts` to allow them and run again.")).toEqual([]);
  });

  it("the item API puts an out_of_scope resolve failure's reply paths on resolve only, marked out_of_scope (2026-11-26)", async () => {
    const it_ = {
      stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending", change_ref: "42", allowed_paths: ["src/a.ts"],
      source: { type: "github_issue", id: "o/r#1", link: "x" },
    } as unknown as WorkItem;
    const failed = (error_code: string, outside: string[]) => ({ kind: "resolve", status: "failed", outcome: { status: "failed", error_code, detail: resolveScopeDetail(outside), infra: false } });
    const rows = await itemCommands(it_, [failed("out_of_scope", ["a/b.ts", "src/a.ts"])] as never[], { allow: true }, async (v) => v);
    expect(rows.find((r) => r.name === "resolve")).toMatchObject({ paths: ["a/b.ts"], out_of_scope: true });
    for (const r of rows.filter((r) => r.name !== "resolve")) expect(r.paths, r.name).toBeUndefined();
    // The newest resolve run decides: one that failed another way, or succeeded, names none.
    const later = await itemCommands(it_, [failed("out_of_scope", ["a/b.ts"]), failed("tests_failed", ["a/b.ts"])] as never[], { allow: true }, async (v) => v);
    expect(later.some((r) => r.paths !== undefined || r.out_of_scope !== undefined)).toBe(false);
    // Not waiting on the merge conflict any more: none.
    const moved = await itemCommands({ ...it_, blocked_reason: "merge_pending" } as WorkItem, [failed("out_of_scope", ["a/b.ts"])] as never[], { allow: true }, async (v) => v);
    expect(moved.some((r) => r.paths !== undefined)).toBe(false);
  });

  it("splits +paths and its paths off the first line; the lines below are the note", () => {
    expect(parseCommandPaths("+paths src/a.ts docs/b.md\nkeep it small\nand tested")).toEqual({ paths: ["src/a.ts", "docs/b.md"], note: "keep it small\nand tested" });
    expect(parseCommandPaths("+paths `src/a.ts` ./src/a.ts src/dir/")).toEqual({ paths: ["src/a.ts", "src/dir/"], note: "" });
    expect(parseCommandPaths("keep it small")).toEqual({ paths: [], note: "keep it small" });
    expect(parseCommandPaths("")).toEqual({ paths: [], note: "" });
    // Not the flag: a word that only starts with it, or the flag later in the text.
    expect(parseCommandPaths("+pathsx a")).toEqual({ paths: [], note: "+pathsx a" });
    expect(parseCommandPaths("see +paths a")).toEqual({ paths: [], note: "see +paths a" });
  });

  it("refuses no path, an empty, absolute, `..` or glob path, and more than 10", () => {
    for (const text of ["+paths", "+paths \nnote", "+paths ``", "+paths ./", "+paths /etc/x", "+paths ~/x", "+paths C:/x", "+paths a/../b",
      "+paths ..", "+paths src/*.ts", "+paths src/a?.ts", "+paths src/{a,b}.ts", "+paths src/[ab].ts",
      `+paths ${Array.from({ length: 11 }, (_, i) => `f${i}`).join(" ")}`]) {
      expect({ text, refused: "refuse" in parseCommandPaths(text) }).toEqual({ text, refused: true });
    }
    expect(parseCommandPaths(`+paths ${Array.from({ length: 10 }, (_, i) => `f${i}`).join(" ")}`)).toMatchObject({ paths: expect.any(Array) });
  });

  it("the /retry +paths reply is exact, parses back to the same paths, and is null when no single reply can allow them", () => {
    const reply = retryPathsReply(["src/a.ts", "docs/b.md", "src/a.ts"])!;
    expect(reply).toBe("/retry +paths src/a.ts docs/b.md");
    const parsed = parseComment(reply);
    expect(parsed).toMatchObject({ kind: "command", name: "retry" });
    expect(parseCommandPaths(parsed!.kind === "command" ? parsed!.text : "")).toEqual({ paths: ["src/a.ts", "docs/b.md"], note: "" });
    expect(retryPathsReply([])).toBeNull();
    expect(retryPathsReply(["a b.ts"])).toBeNull();
    expect(retryPathsReply(["src/*.ts"])).toBeNull();
    expect(retryPathsReply(Array.from({ length: 11 }, (_, i) => `f${i}`))).toBeNull();
  });

  it("a first-line `+` path without `+paths` is refused with the corrected command for the command typed (design 04-gate-commands)", () => {
    const lead = "a path on the first line needs `+paths` before it, so nothing changed; ";
    expect(parseCommandPaths("+src/x.ts")).toEqual({ refuse: `${lead}did you mean \`/retry +paths src/x.ts\`?` });
    expect(parseCommandPaths("+tests/a.json +tests/b.json\nplease", "/retry"))
      .toEqual({ refuse: `${lead}did you mean \`/retry +paths tests/a.json tests/b.json\`?` });
    expect(parseCommandPaths("+src/x.ts", "/approve")).toEqual({ refuse: `${lead}did you mean \`/approve +paths src/x.ts\`?` });
    expect(parseCommandPaths("+src/x.ts", "/resolve")).toEqual({ refuse: `${lead}did you mean \`/resolve +paths src/x.ts\`?` });
    // retryPathsReply gives no reply for these paths: the usage only, no corrected line.
    for (const text of ["+src/*.ts", `${Array.from({ length: 11 }, (_, i) => `+f${i}.ts`).join(" ")}`]) {
      const r = parseCommandPaths(text, "/approve");
      expect(r).toEqual({ refuse: `${lead}the usage is \`/approve +paths <path>...\`` });
      expect(JSON.stringify(r)).not.toContain("did you mean");
    }
  });

  it("a first-line `+` word that does not look like a path stays a note", () => {
    expect(parseCommandPaths("+1 looks good")).toEqual({ paths: [], note: "+1 looks good" });
    expect(parseCommandPaths("+ok\n+src/x.ts below the first line")).toEqual({ paths: [], note: "+ok\n+src/x.ts below the first line" });
  });

  it("an agent's own /retry +, /approve + and /resolve + lines are withheld; other lines stay", () => {
    expect(withholdReplyLines("It needs src/x.ts.\nReply: /retry +tests/a.json\n`/approve +paths a.ts`\n/Resolve  +x")).toBe("It needs src/x.ts.");
    expect(withholdReplyLines("Reply /retry +paths src/x.ts")).toBe("(withheld: a reply command the agent wrote)");
    expect(withholdReplyLines("Use /retry to run again.")).toBe("Use /retry to run again.");
  });

  it("/help and the command table show the +paths usage of /approve, /retry and /resolve", () => {
    const help = helpReply({ phase: "spec_pending", has_pr: false });
    for (const usage of ["`/approve +paths <path>...`", "`/retry +paths <path>...`", "`/resolve +paths <path>...`"]) {
      expect(help).toContain(usage);
      expect(commandTableMarkdown()).toContain(usage);
    }
    // The usage column stays `/resolve [notes]`; `+paths` is in its description, as for /retry.
    expect(helpReply({ phase: "merge_conflict", has_pr: true })).toContain("`/resolve [notes]` **(now)**");
  });
});

describe("the commands unit's folder (issue #866)", () => {
  const DIR = join(import.meta.dirname, "..", "src", "controller", "units", "commands");
  const src = (f: string) => readFileSync(join(DIR, f), "utf8");
  const unit = () => src("commands.unit.ts");

  it("keeps every file in the folder within the 600-line budget, with commands.unit.ts its only unit file", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
    for (const f of files) expect({ f, over: src(f).split("\n").length > 600 }).toEqual({ f, over: false });
    expect(files.filter((f) => f.endsWith(".unit.ts"))).toEqual(["commands.unit.ts"]);
  });

  it("holds PR feedback, the checkpoint answer and the info and link replies in their own files, imported by the unit", () => {
    const moved: [string, string[]][] = [
      ["pr-feedback.ts", ["function reviewFeedback(", "PR_REVISE =", "PR_CHANGES =", "function prFeedback(", "function handlePrReview(", "function itemOfPr("]],
      ["checkpoint.ts", ["function answerCheckpoint("]],
      ["replies.ts", ["function handleInfo(", "function handleLink(", "LINK_REFUSALS"]],
    ];
    for (const [file, names] of moved) {
      for (const n of names) {
        expect({ file, n, there: src(file).includes(n) }).toEqual({ file, n, there: true });
        if (n !== "LINK_REFUSALS") expect({ n, left: unit().includes(n) }).toEqual({ n, left: false });
      }
      expect(unit()).toContain(`from "./${file.replace(/\.ts$/, ".js")}"`);
    }
    expect(unit()).not.toContain("LINK_REFUSALS");
  });
});
