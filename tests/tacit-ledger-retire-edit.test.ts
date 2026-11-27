import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentsHomeTacitLedger, TACIT_CLI_TIMEOUT_MS } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { withEditedBlock, withoutRuleBlock } from "../src/impl/tacit/ledger-text.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import { type TacitPromotion, TacitRefusal, TacitSyncFailed } from "../src/interfaces/tacit-ledger.js";
import { RULES_SAMPLE, TODAY, stubHome, snapshot, verdict } from "./helpers/tacit-ledger-stub.js";

describe("plugin agents-home: retire of a class removes its block", () => {
  const RULES = (home: string) => join(home, "private", "tacit", "rules.md");
  /** RULES_SAMPLE with a second rule, C-012, before the encoded-elsewhere heading. */
  const TWO = RULES_SAMPLE.replace("## 다른 곳에 인코딩된 규칙", "## C-012 keep CLI flags\n- 기본값: Keep every flag.\n- 근거: 인시던트 T-0101 / 판정일 2026-10-01\n\n## 다른 곳에 인코딩된 규칙");
  const withRules = (text = TWO) => {
    const s = stubHome();
    mkdirSync(join(s.home, "private", "tacit"), { recursive: true });
    writeFileSync(RULES(s.home), text);
    return { ...s, ledger: new AgentsHomeTacitLedger(s.home, TACIT_CLI_TIMEOUT_MS, TODAY) };
  };

  it("removes the ## <C-id> block, then runs tacit verdict <id> retire --reason <reason>, then sync-agents", async () => {
    const s = withRules();
    const reason = "covered by C-001; $(touch pwned)";
    await s.ledger.verdict("C-012", "retire", reason);
    expect(readFileSync(RULES(s.home), "utf8")).toBe(RULES_SAMPLE);
    expect(s.argv()).toEqual([`tacit|verdict|C-012|retire|--reason|${reason}`, "sync-agents"]);
    expect(existsSync(join(s.home, "pwned"))).toBe(false);
    expect((await s.ledger.applied()).rules.map((r) => r.id)).toEqual(["C-001"]);
  });

  it("the block text: removed up to the next heading or the end; other bytes kept; no block is null", () => {
    expect(withoutRuleBlock("# R\r\n\r\n## C-1 a\r\n- 기본값: b\r\n\r\n## C-2 c\r\n", "C-1")).toBe("# R\r\n\r\n## C-2 c\r\n");
    expect(withoutRuleBlock("## C-1 a\n## C-2 c\n- 기본값: d", "C-2")).toBe("## C-1 a\n");
    expect(withoutRuleBlock("## C-10 a\n", "C-1")).toBeNull();
  });

  it("a verdict the ledger refuses puts rules.md back byte for byte, and sync-agents does not run", async () => {
    const s = withRules();
    const before = readFileSync(RULES(s.home));
    s.control("refuse", true);
    await expect(s.ledger.verdict("C-012", "retire", "r")).rejects.toThrow(/^tacit verdict exited 1: ledger locked$/);
    expect(readFileSync(RULES(s.home)).equals(before)).toBe(true);
    expect(s.argv().map((l) => l.split("|")[0])).toEqual(["tacit"]);
  });

  it("a sync-agents that fails after the verdict keeps the removal and throws TacitSyncFailed", async () => {
    const s = withRules();
    s.control("sync", true);
    const err = await s.ledger.verdict("C-012", "retire", "r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TacitSyncFailed);
    expect(readFileSync(RULES(s.home), "utf8")).toBe(RULES_SAMPLE);
    expect(s.argv().map((l) => l.split("|")[0])).toEqual(["tacit", "sync-agents"]);
  });

  it("refuses with nothing written and no CLI run: no block for the class, no rules file, a file outside the home", async () => {
    const refused = async (s: ReturnType<typeof withRules>, pattern: RegExp) => {
      const before = snapshot(s.home);
      const err = await s.ledger.verdict("C-012", "retire", "r").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TacitRefusal);
      expect((err as Error).message).toMatch(pattern);
      expect(snapshot(s.home)).toEqual(before);
      expect(s.argv()).toEqual([]);
    };
    await refused(withRules(RULES_SAMPLE), /C-012 has no block in private\/tacit\/rules\.md/);
    const gone = withRules();
    rmSync(RULES(gone.home));
    await refused(gone, /no private\/tacit\/rules\.md/);
    const away = withRules();
    const outside = join(away.root, "outside.md");
    writeFileSync(outside, TWO);
    rmSync(RULES(away.home));
    symlinkSync(outside, RULES(away.home));
    await refused(away, /resolves outside the agents home/);
    expect(readFileSync(outside, "utf8")).toBe(TWO);
  });

  it("retired lists each class whose newest ledger verdict is a retire, newest first, with its reason and day; it writes nothing", async () => {
    const s = withRules();
    expect(await s.ledger.retired()).toEqual([]);
    const line = (cls: string, ts: string, decision: string, reason = "r") => JSON.stringify({ type: "verdict", class: cls, ts, decision, reason, by: "owner", rule: "", encoded_to: "" });
    writeFileSync(join(s.home, "private", "tacit", "ledger.jsonl"), [
      line("C-001", "2026-11-10T10:00:00Z", "promote"),
      line("C-001", "2026-11-12T10:00:00Z", "retire", "covered by C-012"),
      line("C-003", "2026-11-13T10:00:00Z", "retire", "no new incident for 40 days since judged on 2026-10-01"),
      line("C-004", "2026-11-11T10:00:00Z", "retire"),
      line("C-004", "2026-11-12T11:00:00Z", "promote"), // promoted again: not retired
      "not json",
    ].join("\n"));
    const before = snapshot(s.home);
    expect(await s.ledger.retired()).toEqual([
      { id: "C-003", reason: "no new incident for 40 days since judged on 2026-10-01", date: "2026-11-13" },
      { id: "C-001", reason: "covered by C-012", date: "2026-11-12" },
    ]);
    expect(snapshot(s.home)).toEqual(before);
  });

  it("the plugin none retires nothing and lists none", async () => {
    const none = new NoTacitLedger();
    await expect(none.verdict()).resolves.toBeUndefined();
    expect(await none.retired()).toEqual([]);
  });
});

describe("plugin agents-home: edit of an applied class rewrites only its block", () => {
  const RULES = (home: string) => join(home, "private", "tacit", "rules.md");
  /** RULES_SAMPLE with C-012 (two default lines, one continued, no exception line) before the encoded-elsewhere heading. */
  const TWO = RULES_SAMPLE.replace(
    "## 다른 곳에 인코딩된 규칙",
    "## C-012 keep CLI flags\n- 기본값: Keep every flag.\n  even the old ones\n- 근거: 인시던트 T-0101 / 판정일 2026-10-01\n- 기본값: Keep their help.\n- 범위: CLI\n\n## 다른 곳에 인코딩된 규칙",
  );
  const EDIT: TacitPromotion = { wording: "keep flags  stable", default: "Keep every flag.\nKeep its help text.", exception: "a flag marked deprecated" };
  const withRules = (text = TWO) => {
    const s = stubHome();
    mkdirSync(join(s.home, "private", "tacit"), { recursive: true });
    writeFileSync(RULES(s.home), text);
    return { ...s, ledger: new AgentsHomeTacitLedger(s.home, TACIT_CLI_TIMEOUT_MS, TODAY) };
  };

  it("rewrites the heading, default and exception lines (a missing 예외 line after the 기본값 line), keeps 근거, 범위 and every other byte, then runs sync-agents with no verdict", async () => {
    const s = withRules();
    await s.ledger.edit("C-012", EDIT);
    expect(readFileSync(RULES(s.home), "utf8")).toBe(RULES_SAMPLE.replace(
      "## 다른 곳에 인코딩된 규칙",
      "## C-012 keep flags stable\n- 기본값: Keep every flag.\n- 기본값: Keep its help text.\n- 예외 (이럴 땐 override): a flag marked deprecated\n- 근거: 인시던트 T-0101 / 판정일 2026-10-01\n- 범위: CLI\n\n## 다른 곳에 인코딩된 규칙",
    ));
    expect(s.argv()).toEqual(["sync-agents"]);
    // The page reads the new text back.
    const c012 = (await s.ledger.applied()).rules.find((r) => r.id === "C-012");
    expect(c012).toMatchObject({ name: "keep flags stable", default: "Keep every flag.\nKeep its help text.", exceptions: "a flag marked deprecated", scope: "CLI", incidents: ["T-0101"] });
  });

  it("the block text: keeps each line's label, line ends and the other blocks; a block at the end of the file with no last line end", () => {
    const crlf = "# R\r\n\r\n## C-1 a\r\n- 기본값: b\r\n- 예외 (이럴 땐 override): c\r\n  more\r\n- 범위: d\r\n\r\n## C-2 e\r\n- 기본값: f\r\n";
    expect(withEditedBlock(crlf, "C-1", { wording: "A", default: "B", exception: "C" })).toBe(
      "# R\r\n\r\n## C-1 A\r\n- 기본값: B\r\n- 예외 (이럴 땐 override): C\r\n- 범위: d\r\n\r\n## C-2 e\r\n- 기본값: f\r\n",
    );
    expect(withEditedBlock("## C-1 a\n- 기본값: b", "C-1", { wording: "A", default: "B", exception: "C" })).toBe("## C-1 A\n- 기본값: B\n- 예외 (이럴 땐 override): C");
    expect(withEditedBlock("## C-10 a\n", "C-1", { wording: "A", default: "B", exception: "C" })).toBeNull();
  });

  it("a failed write puts rules.md back byte for byte and runs nothing", async () => {
    const s = withRules();
    const before = readFileSync(RULES(s.home));
    chmodSync(RULES(s.home), 0o444);
    await expect(s.ledger.edit("C-012", EDIT)).rejects.toThrow(/EACCES/);
    expect(readFileSync(RULES(s.home)).equals(before)).toBe(true);
    expect(s.argv()).toEqual([]);
  });

  it("a sync-agents that fails after the write keeps the new text and throws TacitSyncFailed", async () => {
    const s = withRules();
    s.control("sync", true);
    const err = await s.ledger.edit("C-012", EDIT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TacitSyncFailed);
    expect(readFileSync(RULES(s.home), "utf8")).toContain("## C-012 keep flags stable\n");
    expect(s.argv()).toEqual(["sync-agents"]);
  });

  it("refuses with nothing written and no CLI run: no block, a proposal ID, no rules file, a file outside the home, no sync-agents", async () => {
    const refused = async (s: ReturnType<typeof withRules>, pattern: RegExp, id = "C-012") => {
      const before = snapshot(s.home);
      const err = await s.ledger.edit(id, EDIT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TacitRefusal);
      expect((err as Error).message).toMatch(pattern);
      expect(snapshot(s.home)).toEqual(before);
      expect(s.argv()).toEqual([]);
    };
    await refused(withRules(RULES_SAMPLE), /C-012 has no block in private\/tacit\/rules\.md/);
    await refused(withRules(), /only a class/, "P-0007");
    const gone = withRules();
    rmSync(RULES(gone.home));
    await refused(gone, /no private\/tacit\/rules\.md/);
    const away = withRules();
    const outside = join(away.root, "outside.md");
    writeFileSync(outside, TWO);
    rmSync(RULES(away.home));
    symlinkSync(outside, RULES(away.home));
    await refused(away, /resolves outside the agents home/);
    expect(readFileSync(outside, "utf8")).toBe(TWO);
    const nosync = withRules();
    rmSync(join(nosync.home, "bin", "sync-agents"));
    await refused(nosync, /sync-agents is missing/);
  });
});
