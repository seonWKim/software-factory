import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { AgentsHomeTacitLedger } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { parseApplied, parseDraft, parsePending, parseShow } from "../src/impl/tacit/ledger-text.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import { TacitRefusal } from "../src/interfaces/tacit-ledger.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { config, issueRef, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";
import { PENDING_SAMPLE, SHOW_SAMPLE, RULE, DETAIL_SAMPLE, SHOW_JSON, stubHome, snapshot, flagging, WRITER, SPEC_PENDING, revise, reject, verdict, execHelp } from "./helpers/tacit-ledger-stub.js";

describe("plugin agents-home", () => {
  it("pending runs evolve pending and reads its text, and each class's draft with evolve show", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.pending()).toEqual([
      { id: "P-0007", title: "Keep the flag", state: "open", kind: "spec", target: "src/core/foo.ts" },
      {
        id: "C-012", title: "keep existing CLI flags", state: "pending",
        draft: { default: "Keep every existing CLI flag.", exception: "a flag the owner marked deprecated", incidents: ["T-0101", "T-0102"], scope: "software, CLI" },
      },
    ]);
    expect(s.argv()).toEqual(["evolve|pending", "evolve|show|C-012"]);
    rmSync(join(s.root, "drafts", "C-012"));
    expect((await ledger.pending())[1]).toEqual({ id: "C-012", title: "keep existing CLI flags", state: "pending", draft_error: expect.stringContaining("evolve show exited 1: no entry C-012") });
  });

  it("the draft text: each missing part names itself, and no draft is made", () => {
    expect(parseDraft("C-012", SHOW_SAMPLE)).toEqual({
      default: "Keep every existing CLI flag.", exception: "a flag the owner marked deprecated", incidents: ["T-0101", "T-0102"], scope: "software, CLI",
    });
    const without = (pattern: RegExp, to = "") => SHOW_SAMPLE.replace(pattern, to);
    expect(parseDraft("C-012", without(/^### .*$/m))).toMatch(/no "### C-012" heading/);
    expect(parseDraft("C-013", SHOW_SAMPLE)).toMatch(/no "### C-013" heading/);
    expect(parseDraft("C-012", without(/^- 인시던트:.*$/m))).toMatch(/incident IDs/);
    expect(parseDraft("C-012", without(/ \/ 예외: /, "; 예외: "))).toMatch(/초안/);
    expect(parseDraft("C-012", without(/^- 범위:.*$/m))).toMatch(/범위/);
    // A line under `# incidents` is not the draft's.
    expect(parseDraft("C-012", without(/^- 범위:.*$/m).replace("# verdicts", "# verdicts\n- 범위: late"))).toMatch(/범위/);
  });

  it("the pending text: open and held proposals, pending and held classes; rows under any other heading are skipped", () => {
    expect(parsePending(PENDING_SAMPLE)).toEqual([
      { id: "P-0007", title: "Keep the flag", state: "open", kind: "spec", target: "src/core/foo.ts" },
      { id: "C-012", title: "keep existing CLI flags", state: "pending" },
    ]);
    const text = [
      "## proposals (open) 0", "## proposals (held) 1", "- P-0003 [prompt] prompts/review.md — Ask for tests first",
      "- P-20261103-34e9 — No kind or target",
      "## tacit Pending 0", "## tacit Held 1", "- C-004 name the flag in the spec", "## stats", "- C-009 not an entry",
    ].join("\n");
    expect(parsePending(text)).toEqual([
      { id: "P-0003", title: "Ask for tests first", state: "held", kind: "prompt", target: "prompts/review.md" },
      { id: "P-20261103-34e9", title: "No kind or target", state: "held" },
      { id: "C-004", title: "name the flag in the spec", state: "held" },
    ]);
  });

  it("the pending text keeps each proposal's kind and target", () => {
    const text = [
      "## proposals (open) 3",
      "- P-20261103-34e9 [promote-learning] skills/review/SKILL.md — Promote the review learning",
      "- P-20261104-0a1b [edit-asset] prompts/implement.md — Ask for the failing test first",
      "- P-20261105-77c2 [new-asset] skills/flags/SKILL.md — A skill for CLI flags",
    ].join("\n");
    expect(parsePending(text).map((e) => [e.id, e.kind, e.target])).toEqual([
      ["P-20261103-34e9", "promote-learning", "skills/review/SKILL.md"],
      ["P-20261104-0a1b", "edit-asset", "prompts/implement.md"],
      ["P-20261105-77c2", "new-asset", "skills/flags/SKILL.md"],
    ]);
  });

  it("the show text: each field lands in its place, and a field the text lacks is absent", () => {
    expect(parseShow("C-012", DETAIL_SAMPLE)).toEqual({
      id: "C-012",
      default: "Keep every existing CLI flag when renaming a command.",
      exceptions: "a flag the owner marked deprecated",
      scope: "software, CLI",
      root_reason: "agents rename flags without checking callers",
      incidents: 3,
      evidence: [{ ref: "wi_1", quote: "keep --json, scripts use it" }, { ref: "wi_2", quote: "don't rename the flag" }, { ref: "wi_3" }],
    });
    const proposal = ["# P-20261103-34e9", "kind: edit-asset", "target: prompts/review.md", "root reason: reviews skip the tests", "  and nobody asks"].join("\n");
    expect(parseShow("P-20261103-34e9", proposal)).toEqual({
      id: "P-20261103-34e9", kind: "edit-asset", target: "prompts/review.md", root_reason: "reviews skip the tests\nand nobody asks",
    });
    // Incidents with no number count their rows; a bare reference has no words.
    expect(parseShow("C-1", "## incidents\n- wi_1\n- wi_2")).toEqual({ id: "C-1", incidents: 2, evidence: [{ ref: "wi_1" }, { ref: "wi_2" }] });
    expect(parseShow("C-1", "  \n")).toBeNull();
  });

  it("the show text: each incident's ID, optional date, proposal, quote and root reason, newest first; a description and the lines a proposal changes", () => {
    const text = [
      "# P-20261103-34e9",
      "설명: Quiet the notify script at night",
      "kind: edit-asset",
      "target: bin/evolve",
      "현재: notify always",
      "  even at 3am",
      "변경: notify 08:00-22:00 only",
      "## incidents 3",
      "- T-20261101-aa 2026-11-01 — \"too loud\"",
      "  proposal: keep notifying",
      "  근본 원인: no quiet hours",
      "- L-0042 — “stop at night”",
      "  제안: notify every hour",
      "- E-7 (2026-11-03) — \"again at 3am\"",
      "  date: 2026-11-04",
      "  root reason: the schedule ignores the hour",
      "근본 원인: nobody set quiet hours",
    ].join("\n");
    expect(parseShow("P-20261103-34e9", text)).toEqual({
      id: "P-20261103-34e9",
      description: "Quiet the notify script at night",
      kind: "edit-asset",
      target: "bin/evolve",
      current: "notify always\neven at 3am",
      proposed: "notify 08:00-22:00 only",
      root_reason: "nobody set quiet hours",
      incidents: 3,
      evidence: [
        { ref: "E-7", date: "2026-11-04", quote: "again at 3am", root_reason: "the schedule ignores the hour" },
        { ref: "T-20261101-aa", date: "2026-11-01", quote: "too loud", proposal: "keep notifying", root_reason: "no quiet hours" },
        { ref: "L-0042", quote: "stop at night", proposal: "notify every hour" },
      ],
    });
  });

  it("the show JSON (evolve show <P-id>): rationale is the Why, change is what it would change, each evidence ID is a row with its ref", () => {
    expect(parseShow("P-20261017-4c1d", SHOW_JSON)).toEqual({
      id: "P-20261017-4c1d",
      kind: "edit-asset",
      target: "skills/review/SKILL.md",
      root_reason: "Two reviews on the same day passed a change whose tests never ran.",
      change: "Add a step before the verdict: run the changed tests and quote their result.",
      incidents: 3,
      evidence: [{ ref: "T-20261017-de7e" }, { ref: "T-20261017-9f3c" }, { ref: "L-20261016-0a1b" }],
    });
    // No evidence, an empty value or a value of another type: absent; a JSON array or a broken object falls back to the text reader.
    expect(parseShow("P-1", JSON.stringify({ id: "P-1", kind: "new-asset", rationale: "", change: 3, evidence: [] }))).toEqual({ id: "P-1", kind: "new-asset" });
    expect(parseShow("P-1", "{ kind: edit-asset\ntarget: a.md")).toEqual({ id: "P-1", target: "a.md" });
  });

  it("the show text form still parses next to the JSON one, and an unknown ID's plain \"not found\" is null", () => {
    expect(parseShow("P-0007", "# P-0007 Quiet notify\nkind: edit-asset\ntarget: private/bin/notify\ncurrent: a\nproposed: b\n")).toEqual({
      id: "P-0007", kind: "edit-asset", target: "private/bin/notify", current: "a", proposed: "b",
    });
    expect(parseShow("P-0404", "not found: P-0404\n")).toBeNull();
  });

  it("an incident ID with hyphens is read whole in a 근거 line and a draft's 인시던트 line; two incidents of the same day count as two", () => {
    const rules = "## C-040 test first\n- 기본값: Run the tests.\n- 근거: 인시던트 T-20261017-de7e, T-20261017-9f3c / 판정일 2026-10-18\n";
    expect(parseApplied(rules).rules[0]!.incidents).toEqual(["T-20261017-de7e", "T-20261017-9f3c"]);
    const draft = parseDraft("C-040", "### C-040 test first\n- 인시던트: T-20261017-de7e, T-20261017-9f3c\n- 초안: 기본값: Run the tests. / 예외: a docs change\n- 범위: 전역\n");
    expect(typeof draft === "string" ? draft : draft.incidents).toEqual(["T-20261017-de7e", "T-20261017-9f3c"]);
  });

  it("show runs evolve show <id> and reads its text; it writes nothing; an empty text is null; a bad ID runs no CLI", async () => {
    const s = stubHome();
    writeFileSync(join(s.root, "drafts", "P-0007"), "");
    const before = snapshot(s.home);
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.show("C-012")).toMatchObject({ id: "C-012", incidents: 1, scope: "software, CLI" });
    expect(await ledger.show("P-0007")).toBeNull();
    await expect(ledger.show("t1")).rejects.toThrow(/neither a class \(C-\) nor a proposal \(P-\)/);
    expect(s.argv()).toEqual(["evolve|show|C-012", "evolve|show|P-0007"]);
    expect(snapshot(s.home)).toEqual(before);
    expect(await new NoTacitLedger().show()).toBeNull();
  });

  it("a hold or reject on a C- ID runs tacit verdict with no rule; each value is its own argv item, no shell", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    const reason = "seen twice; $(touch pwned) `id`";
    await ledger.verdict("C-014", "hold", reason, RULE);
    await ledger.verdict("C-015", "reject", "not for code");
    expect(s.argv()).toEqual([
      `tacit|verdict|C-014|hold|--reason|${reason}`,
      "tacit|verdict|C-015|reject|--reason|not for code",
    ]);
    expect(existsSync(join(s.home, "pwned"))).toBe(false);
  });

  it("a hold or reject on a P- ID runs evolve verdict with no --rule; an ID that is neither throws before any CLI runs", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    await ledger.verdict("P-0008", "reject", "not now");
    await ledger.verdict("P-0009", "hold", "later", RULE);
    expect(s.argv()).toEqual(["evolve|verdict|P-0008|reject|--reason|not now", "evolve|verdict|P-0009|hold|--reason|later"]);
    await expect(ledger.verdict("t1", "promote", "x")).rejects.toThrow(/neither a class \(C-\) nor a proposal \(P-\)/);
    await expect(ledger.verdict("P-0007", "retire", "x")).rejects.toThrow(/takes no retire/);
    expect(s.argv()).toHaveLength(2);
  });

  /** A stub home whose `evolve show P-0007` gives `show`, with `<home>/private/bin/notify` holding `file`. */
  const applyHome = (show: string, file = "#!/bin/sh\nnotify --loud \"$1\"\n") => {
    const s = stubHome();
    writeFileSync(join(s.root, "drafts", "P-0007"), show);
    mkdirSync(join(s.home, "private", "bin"), { recursive: true });
    writeFileSync(join(s.home, "private", "bin", "notify"), file);
    return { ...s, file: () => readFileSync(join(s.home, "private", "bin", "notify"), "utf8") };
  };
  const SHOW_P = "# P-0007 Quiet notify\nkind: edit-asset\ntarget: private/bin/notify\ncurrent: notify --loud \"$1\"\nproposed: notify --quiet \"$1\"\n";

  it("a promote of a P- ID applies its proposed lines to its target, then runs evolve verdict with --applied-to the target", async () => {
    const s = applyHome(SHOW_P);
    await new AgentsHomeTacitLedger(s.home).verdict("P-0007", "promote", "good shape");
    expect(s.file()).toBe("#!/bin/sh\nnotify --quiet \"$1\"\n");
    expect(s.argv()).toEqual(["evolve|show|P-0007", "evolve|verdict|P-0007|promote|--reason|good shape|--applied-to|private/bin/notify"]);
  });

  it("a promote of a P- ID whose change is prose (no current or proposed lines) runs evolve verdict once with --applied-to its target and writes no file", async () => {
    const s = applyHome(SHOW_JSON);
    const before = snapshot(s.home);
    await new AgentsHomeTacitLedger(s.home).verdict("P-0007", "promote", "applied it");
    expect(s.argv()).toEqual(["evolve|show|P-0007", "evolve|verdict|P-0007|promote|--reason|applied it|--applied-to|skills/review/SKILL.md"]);
    expect(snapshot(s.home)).toEqual(before);
    // The target need not exist: the change is built from a task (2026-11-20).
    const t = applyHome("# P-0007 Quiet notify\nkind: new-asset\ndescription: add a quiet-hours subcommand\ntarget: private/bin/quiet-hours\n");
    await new AgentsHomeTacitLedger(t.home).verdict("P-0007", "promote", "build it");
    expect(t.argv()).toEqual(["evolve|show|P-0007", "evolve|verdict|P-0007|promote|--reason|build it|--applied-to|private/bin/quiet-hours"]);
  });

  it("a promote of a P- ID with no target is a TacitRefusal before any verdict runs, prose or lines", async () => {
    for (const show of [JSON.stringify({ ...JSON.parse(SHOW_JSON), target: "" }), "not found: P-0007\n"]) {
      const s = applyHome(show);
      const err = await new AgentsHomeTacitLedger(s.home).verdict("P-0007", "promote", "r").catch((e: unknown) => e);
      expect(err, show).toBeInstanceOf(TacitRefusal);
      expect((err as Error).message).toMatch(/has no target line: nothing written/);
      expect(s.argv()).toEqual(["evolve|show|P-0007"]);
    }
  });

  it("a promote of a P- ID is refused, with nothing written and no verdict sent, when its lines or target do not fit", async () => {
    const base = "# P-0007 Quiet notify\nkind: edit-asset\n";
    for (const [show, error] of [
      [`${base}current: a\nproposed: b\n`, /has no target line/],
      [`${base}description: no lines and no target\n`, /has no target line/],
      [`${base}target: private/bin/notify\nproposed: b\n`, /has no current line/],
      [`${base}target: private/bin/notify\ncurrent: notify\n`, /has no proposed line/],
      [`${base}target: /etc/passwd\n`, /is an absolute path/],
      [`${base}target: /etc/passwd\ncurrent: a\nproposed: b\n`, /is an absolute path/],
      [`${base}target: private/../../x\ncurrent: a\nproposed: b\n`, /has a \.\. segment/],
      [`${base}target: private/bin/none\ncurrent: a\nproposed: b\n`, /no private\/bin\/none in the agents home/],
      [`${base}target: private/bin/notify\ncurrent: absent\nproposed: b\n`, /occur 0 times in private\/bin\/notify, not once/],
      [`${base}target: private/bin/notify\ncurrent: notify\nproposed: b\n`, /occur 2 times in private\/bin\/notify, not once/],
    ] as const) {
      const s = applyHome(show, "notify\nnotify --loud\n");
      const err = await new AgentsHomeTacitLedger(s.home).verdict("P-0007", "promote", "r").catch((e: unknown) => e);
      expect(err, show).toBeInstanceOf(TacitRefusal);
      expect((err as Error).message, show).toMatch(error);
      expect(s.file()).toBe("notify\nnotify --loud\n");
      expect(s.argv()).toEqual(["evolve|show|P-0007"]);
    }
  });

  it("a promote of a P- ID whose evolve verdict fails or times out puts the target back byte for byte and throws the CLI's error", async () => {
    const s = applyHome(SHOW_P);
    const before = s.file();
    writeFileSync(join(s.home, "bin", "evolve"), `#!/bin/sh\n[ "$1" = show ] && { cat "${join(s.root, "drafts", "P-0007")}"; exit 0; }\necho 'evolve: P-0007 was judged already' >&2\nexit 1\n`);
    await expect(new AgentsHomeTacitLedger(s.home).verdict("P-0007", "promote", "r")).rejects.toThrow(/^evolve verdict exited 1: evolve: P-0007 was judged already$/);
    expect(s.file()).toBe(before);
    writeFileSync(join(s.home, "bin", "evolve"), `#!/bin/sh\n[ "$1" = show ] && { cat "${join(s.root, "drafts", "P-0007")}"; exit 0; }\nsleep 5\n`);
    await expect(new AgentsHomeTacitLedger(s.home, 300).verdict("P-0007", "promote", "r")).rejects.toThrow(/evolve verdict stopped after 300 ms/);
    expect(s.file()).toBe(before);
  });

  it("decided gives each ID's newest ledger verdict, a proposal's too, and leaves out an ID with none; ledger.jsonl is only read", async () => {
    const s = stubHome();
    const dir = join(s.home, "private", "tacit");
    mkdirSync(dir, { recursive: true });
    const line = (id: string, ts: string, decision: string) => JSON.stringify({ type: "verdict", class: id, ts, decision, reason: "r", by: "owner", rule: "", encoded_to: "" });
    writeFileSync(join(dir, "ledger.jsonl"), [
      line("P-0003", "2026-11-10T10:00:00Z", "hold"), line("P-0003", "2026-11-12T10:00:00Z", "promote"), line("C-001", "2026-11-11T10:00:00Z", "reject"), "not json",
    ].join("\n"));
    const before = snapshot(s.home);
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.decided(["P-0003", "C-001", "T-1", "L-2"])).toEqual({ "P-0003": "promote", "C-001": "reject" });
    expect(snapshot(s.home)).toEqual(before);
    expect(s.argv()).toEqual([]);
    expect(await new AgentsHomeTacitLedger(stubHome().home).decided(["P-0003"])).toEqual({});
  });

  it("the stub evolve, as the real one, refuses a proposal promote without --applied-to and has no apply subcommand", () => {
    const s = stubHome();
    const run = (args: string[]) => () => execFileSync(join(s.home, "bin", "evolve"), args, { stdio: ["ignore", "pipe", "pipe"] });
    expect(run(["verdict", "P-1", "promote", "--reason", "r"])).toThrow(/promote requires --applied-to/);
    expect(run(["apply", "P-1"])).toThrow(/usage: evolve/);
  });

  it("a CLI that exits non-zero throws with the CLI and subcommand first", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    writeFileSync(join(s.home, "bin", "evolve"), "#!/bin/sh\necho 'ledger locked' >&2\nexit 5\n");
    await expect(ledger.pending()).rejects.toThrow(/^evolve pending exited 5: ledger locked$/);
    await expect(ledger.verdict("P-1", "hold", "x")).rejects.toThrow(/^evolve verdict exited 5: ledger locked$/);
    await expect(ledger.show("C-1")).rejects.toThrow(/^evolve show exited 5: ledger locked$/);
  });

  it("rules reads <home>/private/tacit/rules.md: each C- section's default, exceptions and scope; no file, no rules", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.rules()).toEqual([]);
    mkdirSync(join(s.home, "private", "tacit"), { recursive: true });
    writeFileSync(join(s.home, "private", "tacit", "rules.md"), [
      "# Rules", "", "intro text", "",
      "## C-012 keep existing CLI flags", "- 기본값: Keep every existing CLI flag when renaming a command.", "- 예외: a flag the owner marked deprecated", "- 범위: software, CLI",
      "", "## Notes", "- 기본값: not a rule",
      "", "## C-020 summary first", "- 기본값: Open with a one-line summary.", "  Then the details.", "- 예외 없음", "- 범위: 모든 문서",
    ].join("\n"));
    const before = snapshot(s.home);
    expect(await ledger.rules()).toEqual([
      { id: "C-012", name: "keep existing CLI flags", default: "Keep every existing CLI flag when renaming a command.", exceptions: "a flag the owner marked deprecated", scope: "software, CLI" },
      { id: "C-020", name: "summary first", default: "Open with a one-line summary.\nThen the details.", exceptions: "없음", scope: "모든 문서" },
    ]);
    expect(s.argv()).toEqual([]);
    expect(snapshot(s.home)).toEqual(before);
  });

  it("applied parses a real-format rules.md: each C- block with its evidence, a block that does not parse as raw text, the encoded-elsewhere lines", async () => {
    const text = [
      "# Rules", "intro", "",
      "## C-001 summary first", "- 기본값: Open with a summary.", "  Then the details.", "- 예외 (이럴 땐 override): a one-word reply", "- 근거: 인시던트 T-1, T-20 / 판정일 2026-11-13", "- 범위: 모든 문서", "",
      "## C-002 no scope", "- 기본값: Keep flags.", "",
      "## Notes", "- 기본값: but no C- ID", "",
      "## C-003 no default", "- 예외: x", "",
      "## 다른 곳에 인코딩된 규칙", "- C-009 → CLAUDE.md", "", "- C-010 → prompts/review.md", "", "## After", "- not elsewhere",
    ].join("\n");
    const a = parseApplied(text);
    expect(a.rules).toEqual([
      { id: "C-001", name: "summary first", default: "Open with a summary.\nThen the details.", exceptions: "a one-word reply", scope: "모든 문서", incidents: ["T-1", "T-20"], judged: "2026-11-13" },
      { id: "C-002", name: "no scope", default: "Keep flags." },
      { raw: "## Notes\n- 기본값: but no C- ID" },
      { raw: "## C-003 no default\n- 예외: x" },
      { raw: "## After\n- not elsewhere" },
    ]);
    expect(a.elsewhere).toEqual(["- C-009 → CLAUDE.md", "- C-010 → prompts/review.md"]);
    expect(parseApplied("")).toEqual({ rules: [], elsewhere: [] });
  });

  it("applied skips fenced code blocks (``` and ~~~), and an unclosed fence runs to the end of the file", () => {
    const fenced = ["# Rules", "", "```md", "## C-xxx 규칙 이름", "- 기본값: template", "```", "", "## C-001 real", "- 기본값: Keep.", "~~~", "## C-002 hidden", "- 기본값: no", "~~~", "", "## 다른 곳에 인코딩된 규칙", "- C-009 → CLAUDE.md"].join("\n");
    const a = parseApplied(fenced);
    expect(a.rules).toEqual([{ id: "C-001", name: "real", default: "Keep." }]);
    expect(a.elsewhere).toEqual(["- C-009 → CLAUDE.md"]);
    const open = ["## C-001 real", "- 기본값: Keep.", "", "```", "## C-002 after the fence", "- 기본값: no", "", "## 다른 곳에 인코딩된 규칙", "- C-009 → x"].join("\n");
    expect(parseApplied(open)).toEqual({ rules: [{ id: "C-001", name: "real", default: "Keep." }], elsewhere: [] });
  });

  it("applied keeps a repeated 기본값, 예외 or 범위 line after the earlier one instead of overwriting it", () => {
    const text = ["## C-001 two defaults", "- 기본값: Keep flags.", "- 예외: none", "- 기본값: Keep their help text.", "  in every command.", "- 범위: CLI", "- 예외: a deprecated flag", "- 범위: docs"].join("\n");
    expect(parseApplied(text).rules).toEqual([{
      id: "C-001", name: "two defaults", default: "Keep flags.\nKeep their help text.\nin every command.", exceptions: "none\na deprecated flag", scope: "CLI\ndocs",
    }]);
  });

  it("applied reads through the plugin: no rules.md, nothing; the plugin none, nothing; it writes nothing", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.applied()).toEqual({ rules: [], elsewhere: [] });
    mkdirSync(join(s.home, "private", "tacit"), { recursive: true });
    writeFileSync(join(s.home, "private", "tacit", "rules.md"), "## C-001 a\n- 기본값: b\n\n## 다른 곳에 인코딩된 규칙\n- C-9 → x\n");
    const before = snapshot(s.home);
    expect(await ledger.applied()).toEqual({ rules: [{ id: "C-001", name: "a", default: "b" }], elsewhere: ["- C-9 → x"] });
    expect(snapshot(s.home)).toEqual(before);
    expect(await new NoTacitLedger().applied()).toEqual({ rules: [], elsewhere: [] });
  });

  it("pending, show and verdicts other than promote of a class call subcommands the CLIs' --help names, and never write under the home", async () => {
    const s = stubHome();
    const before = snapshot(s.home);
    const help = (cli: string) => [...execHelp(join(s.home, "bin", cli)).matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]);
    const ledger = new AgentsHomeTacitLedger(s.home);
    await ledger.pending();
    await ledger.verdict("C-012", "reject", "r");
    await ledger.verdict("P-0007", "hold", "r");
    await ledger.show("C-012");
    const used = s.argv().filter((l) => !l.endsWith("--help")).map((l) => l.split("|").slice(0, 2).join(" "));
    expect(used).toEqual(["evolve pending", "evolve show", "tacit verdict", "evolve verdict", "evolve show"]);
    expect(help("tacit")).toEqual(expect.arrayContaining(["capture", "verdict"]));
    expect(help("evolve")).toEqual(expect.arrayContaining(["pending", "show", "verdict"]));
    expect(snapshot(s.home)).toEqual(before);
  });

  it("captures only commands after it is selected: pushbacks stored before are not backfilled", async () => {
    const s = stubHome();
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const deps = { store, sources: [source], forge: new FakeForge(source), auth: new FakeAuth(), clock, config, log: silent, scanner: flagging };
    const off = new ControllerRole(deps);
    for (const n of [1, 2]) {
      const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
      await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch: { ...SPEC_PENDING, tier: 2 } });
    }
    await off.handleEvent(revise(1, "earlier pushback", "old"));
    await off.tickOutbox();

    const on = new ControllerRole({ ...deps, tacit: new AgentsHomeTacitLedger(s.home) });
    await on.tickOutbox();
    expect(s.captures()).toEqual([]);
    await on.handleEvent(reject(2, "later pushback", "new"));
    await on.tickOutbox();
    expect(s.captures().map((r) => r.pushback)).toEqual(["later pushback"]);
  });
});

