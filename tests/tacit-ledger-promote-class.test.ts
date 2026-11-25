import { mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentsHomeTacitLedger, TACIT_CLI_TIMEOUT_MS } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { type TacitPromotion, TacitRefusal, TacitSyncFailed } from "../src/interfaces/tacit-ledger.js";
import { SHOW_SAMPLE, RULES_SAMPLE, RULE, TODAY, stubHome, snapshot, verdict } from "./helpers/tacit-ledger-stub.js";

describe("plugin agents-home: promote of a class encodes the rule", () => {
  const RULES = (home: string) => join(home, "private", "tacit", "rules.md");
  /** The stub home with the owner's rules file. */
  const withRules = (text = RULES_SAMPLE) => {
    const s = stubHome();
    mkdirSync(join(s.home, "private", "tacit"), { recursive: true });
    writeFileSync(RULES(s.home), text);
    return { ...s, ledger: new AgentsHomeTacitLedger(s.home, TACIT_CLI_TIMEOUT_MS, TODAY) };
  };

  it("writes one block before the 다른 곳에 인코딩된 규칙 heading, then the verdict with --encoded-to, then sync-agents", async () => {
    const s = withRules();
    await s.ledger.verdict("C-012", "promote", "seen twice", { wording: "keep CLI flags", default: "Keep every flag.\nEven old ones.", exception: "a deprecated flag" });
    expect(readFileSync(RULES(s.home), "utf8")).toBe(RULES_SAMPLE.replace("## 다른 곳에 인코딩된 규칙", [
      "## C-012 keep CLI flags",
      "- 기본값: Keep every flag. Even old ones.",
      "- 예외 (이럴 땐 override): a deprecated flag",
      "- 근거: 인시던트 T-0101, T-0102 / 판정일 2026-11-13",
      "- 범위: software, CLI",
      "",
      "## 다른 곳에 인코딩된 규칙",
    ].join("\n")));
    expect(s.argv()).toEqual([
      "evolve|show|C-012",
      "tacit|verdict|C-012|promote|--reason|seen twice|--rule|keep CLI flags|--encoded-to|private/tacit/rules.md",
      "sync-agents",
    ]);
    // The block reads back as a rule.
    expect((await s.ledger.rules()).map((r) => [r.id, r.default, r.exceptions, r.scope])).toContainEqual(["C-012", "Keep every flag. Even old ones.", "a deprecated flag", "software, CLI"]);
  });

  it("a verdict the ledger refuses removes the block: rules.md is byte-identical, and sync-agents does not run", async () => {
    const s = withRules();
    const before = readFileSync(RULES(s.home));
    s.control("refuse", true);
    await expect(s.ledger.verdict("C-012", "promote", "r", RULE)).rejects.toThrow(/^tacit verdict exited 1: ledger locked$/);
    expect(readFileSync(RULES(s.home)).equals(before)).toBe(true);
    expect(s.argv().map((l) => l.split("|")[0])).toEqual(["evolve", "tacit"]);
  });

  it("a sync-agents that fails after the verdict keeps the block and says so", async () => {
    const s = withRules();
    s.control("sync", true);
    const err = await s.ledger.verdict("C-012", "promote", "r", RULE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TacitSyncFailed);
    expect((err as Error).message).toBe("sync-agents exited 4: agents dir locked");
    expect(readFileSync(RULES(s.home), "utf8")).toContain("## C-012 keep CLI flags\n");
  });

  it("refuses with nothing written and no CLI run: a class already in the file, no heading, no rules file, no rule, no sync-agents", async () => {
    const refused = async (s: ReturnType<typeof withRules>, pattern: RegExp, rule: TacitPromotion | null = RULE) => {
      const before = snapshot(s.home);
      const err = await s.ledger.verdict("C-012", "promote", "r", rule ?? undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TacitRefusal);
      expect((err as Error).message).toMatch(pattern);
      expect(snapshot(s.home)).toEqual(before);
      expect(s.argv()).toEqual([]);
    };
    await refused(withRules(RULES_SAMPLE.replace("## C-001 summary first", "## C-012 keep existing CLI flags")), /C-012 is already in private\/tacit\/rules\.md/);
    await refused(withRules(RULES_SAMPLE.replace("## 다른 곳에 인코딩된 규칙", "## Elsewhere")), /no "## 다른 곳에 인코딩된 규칙" heading/);
    const gone = withRules();
    rmSync(RULES(gone.home));
    await refused(gone, /no private\/tacit\/rules\.md/);
    await refused(withRules(), /needs the rule's wording/, null);
    const noSync = withRules();
    rmSync(join(noSync.home, "bin", "sync-agents"));
    await refused(noSync, /sync-agents is missing/);
  });

  it("a draft with a missing part is refused after evolve show, with nothing written and no verdict", async () => {
    const s = withRules();
    writeFileSync(join(s.root, "drafts", "C-012"), SHOW_SAMPLE.replace(/^- 범위:.*$/m, ""));
    const before = readFileSync(RULES(s.home));
    await expect(s.ledger.verdict("C-012", "promote", "r", RULE)).rejects.toBeInstanceOf(TacitRefusal);
    expect(readFileSync(RULES(s.home)).equals(before)).toBe(true);
    expect(s.argv()).toEqual(["evolve|show|C-012"]);
  });

  it("a rules.md that is a symlink pointing outside the home is refused before any write", async () => {
    const s = withRules();
    const outside = join(s.root, "outside.md");
    writeFileSync(outside, RULES_SAMPLE);
    rmSync(RULES(s.home));
    symlinkSync(outside, RULES(s.home));
    const err = await s.ledger.verdict("C-012", "promote", "r", RULE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TacitRefusal);
    expect((err as Error).message).toMatch(/resolves outside the agents home/);
    expect(readFileSync(outside, "utf8")).toBe(RULES_SAMPLE);
    expect(s.argv()).toEqual([]);
    // A link that stays inside the home is the file it names.
    const inside = join(s.home, "private", "tacit", "real-rules.md");
    writeFileSync(inside, RULES_SAMPLE);
    rmSync(RULES(s.home));
    symlinkSync(inside, RULES(s.home));
    await s.ledger.verdict("C-012", "promote", "r", RULE);
    expect(readFileSync(inside, "utf8")).toContain("## C-012 keep CLI flags");
  });

  it("an entry with a ledger verdict newer than rule-candidates.md is judged, with no draft read; ledger.jsonl is only read", async () => {
    const s = withRules();
    const dir = join(s.home, "private", "tacit");
    writeFileSync(join(dir, "rule-candidates.md"), "view");
    const built = new Date("2026-11-13T08:30:00Z");
    utimesSync(join(dir, "rule-candidates.md"), built, built);
    const line = (cls: string, ts: string, decision: string) => JSON.stringify({ type: "verdict", class: cls, ts, decision, reason: "r", by: "owner", rule: "", encoded_to: "" });
    writeFileSync(join(dir, "ledger.jsonl"), [
      line("C-012", "2026-11-12T10:00:00Z", "hold"), // older than the view
      line("C-012", "2026-11-13T10:00:00Z", "promote"),
      JSON.stringify({ type: "capture", class: "P-0007", ts: "2026-11-13T11:00:00Z" }),
      "not json",
      "",
    ].join("\n"));
    const before = snapshot(s.home);
    const entries = await s.ledger.pending();
    expect(entries).toEqual([{ id: "P-0007", title: "Keep the flag", state: "open", kind: "spec", target: "src/core/foo.ts" }, { id: "C-012", title: "keep existing CLI flags", state: "pending", judged: "promote" }]);
    expect(s.argv()).toEqual(["evolve|pending"]);
    expect(snapshot(s.home)).toEqual(before);
    // Once the view is rebuilt after the verdict, the entry is not judged; with no view file, nothing is.
    const later = new Date("2026-11-14T08:30:00Z");
    utimesSync(join(dir, "rule-candidates.md"), later, later);
    expect((await s.ledger.pending())[1]!.judged).toBeUndefined();
    rmSync(join(dir, "rule-candidates.md"));
    utimesSync(join(dir, "ledger.jsonl"), later, later);
    expect((await s.ledger.pending())[1]!.judged).toBeUndefined();
  });
});

