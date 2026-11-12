// The Rules page and the learned rules in the prompt (issue #571). The page lists the ledger's pending entries through
// TacitLedger.pending and sends promote, reject and hold through TacitLedger.verdict, owner only, with a reason, and for
// promote of a class the owner's wording as the rule. A promoted rule reaches the next run's prompt under its own
// heading, read through the plugin's rules() only. Every test runs against a temp home with stub CLIs that take only
// the real CLIs' forms: no real home, no network, no live model.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { LearnedRules, joinGuidance } from "../src/core/learned-rules.js";
import type { LogFields, Logger } from "../src/core/log.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { AgentsHomeTacitLedger } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import type { TacitLedger } from "../src/interfaces/tacit-ledger.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const OWNER = "local:owner@example.com" as UserId;
const OTHER = "local:other@example.com" as UserId;
// Each stub CLI call starts a node process (about half a second on a loaded CI runner), and a test makes up to four,
// beside a store and a run: more than the 5 s default leaves, as in the other tests that start processes.
const SPAWNS = { timeout: 30_000 };

type Entry = { id: string; title: string; state: string; kind?: string; target?: string };

/**
 * A temp agents home whose stub CLIs take only the real forms and exit 2 with usage text on any other.
 * `bin/evolve pending` prints the open and held entries of `<root>/ledger.json` as the real CLI's text; `bin/tacit
 * verdict` (a C- class) and `bin/evolve verdict` (a P- proposal) log their argv to `<root>/verdicts` and move the
 * entry: promote → promoted, reject → rejected, hold → held, retire → retired. A promoted class is written, as the
 * real CLI does, to `<home>/private/tacit/rules.md` with its `--rule` (else its title) as the default. Node scripts.
 */
function stubHome(entries: Entry[]) {
  const root = mkdtempSync(join(tmpdir(), "sf-rules-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  const ledger = join(root, "ledger.json");
  const verdicts = join(root, "verdicts");
  writeFileSync(ledger, JSON.stringify(entries));
  const node = (usage: string) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const ledger = ${JSON.stringify(ledger)};
const read = () => JSON.parse(fs.readFileSync(ledger, "utf8"));
const usage = () => { process.stderr.write(${JSON.stringify(usage)} + "\\n"); process.exit(2); };
const a = process.argv.slice(2);
/** \`verdict <id> <decision> --reason <r> [<option> <v>]...\`: the options, or usage. */
const verdict = (id, decisions, options) => {
  if (a[0] !== "verdict" || a.length < 5 || !id.test(a[1]) || !decisions.includes(a[2]) || a[3] !== "--reason") usage();
  const opts = {};
  for (let i = 5; i < a.length; i += 2) { if (!options.includes(a[i]) || i + 1 >= a.length) usage(); opts[a[i]] = a[i + 1]; }
  fs.appendFileSync(${JSON.stringify(verdicts)}, JSON.stringify(a) + "\\n");
  const states = { promote: "promoted", reject: "rejected", hold: "held", retire: "retired" };
  fs.writeFileSync(ledger, JSON.stringify(read().map((e) => (e.id === a[1] ? { ...e, state: states[a[2]] } : e))));
  return opts;
};
`;
  writeFileSync(join(home, "bin", "tacit"), `${node("usage: tacit {capture --agent <name> | verdict <class> {hold,promote,reject,retire} --reason <reason> [--rule <rule text>] [--encoded-to <file>]}")}
if (a[0] === "capture") { if (a.length !== 3 || a[1] !== "--agent") usage(); process.exit(0); }
const opts = verdict(/^C-/, ["hold", "promote", "reject", "retire"], ["--rule", "--encoded-to"]);
if (a[2] === "promote") {
  const e = read().find((x) => x.id === a[1]);
  const file = path.join(${JSON.stringify(home)}, "private", "tacit", "rules.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, "## " + a[1] + " " + e.title + "\\n- 기본값: " + (opts["--rule"] ?? e.title) + "\\n- 예외: 없음\\n- 범위: software\\n\\n");
}
`);
  writeFileSync(join(home, "bin", "evolve"), `${node("usage: evolve {pending | verdict <id> {hold,promote,reject} --reason <reason> [--applied-to <file>]}")}
if (a[0] === "pending") {
  if (a.length !== 1) usage();
  const all = read();
  const section = (heading, rows) => [heading + " " + rows.length, ...rows];
  const p = (s) => all.filter((e) => e.id.startsWith("P-") && e.state === s).map((e) => "- " + e.id + " [" + e.kind + "] " + e.target + " — " + e.title);
  const c = (s) => all.filter((e) => e.id.startsWith("C-") && e.state === s).map((e) => "- " + e.id + " " + e.title);
  process.stdout.write([...section("## proposals (open)", p("open")), ...section("## proposals (held)", p("held")),
    ...section("## tacit Pending", c("pending")), ...section("## tacit Held", c("held"))].join("\\n") + "\\n");
} else {
  verdict(/^P-/, ["hold", "promote", "reject"], ["--applied-to"]);
}
`);
  for (const cli of ["tacit", "evolve"]) chmodSync(join(home, "bin", cli), 0o755);
  return {
    home,
    ledger: new AgentsHomeTacitLedger(home),
    verdicts: () => (existsSync(verdicts) ? readFileSync(verdicts, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []),
    entries: () => JSON.parse(readFileSync(ledger, "utf8")) as Entry[],
  };
}

const PENDING: Entry[] = [
  { id: "C-012", title: "keep existing CLI flags", state: "pending" },
  { id: "P-0007", title: "Split the review prompt", state: "open", kind: "prompt", target: "prompts/review.md" },
  { id: "C-013", title: "summary first", state: "held" },
];

class MemLog implements Logger {
  lines: { msg: string; fields?: LogFields | undefined }[] = [];
  info(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  warn(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  error(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
}

async function page(tacit: TacitLedger | undefined, as: UserId = OWNER) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimLocalOwner(OWNER);
  const log = new MemLog();
  const pauses: UiPauses = { principal: async () => as, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log };
  const d: PauseDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses,
    ...(tacit ? { tacit } : {}),
  };
  const get = async () => {
    const r = await respond(d, { method: "GET", url: "/api/v1/rules", host: HOST });
    expect(r.status).toBe(200);
    return JSON.parse(r.body);
  };
  const post = async (body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, {
      method: "POST", url: "/api/v1/rules/verdict", host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body), ...over,
    });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  return { get, post, log };
}

/** One triage run through the controller and a worker with `guidance`: its agent prompt. */
async function nextRunPrompt(tacit: TacitLedger): Promise<string> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const runner = new FakeRunner({ triage: () => ({ output: triageSpec }) });
  const controller = new ControllerRole({ store, source, forge: new FakeForge(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
    guidance: joinGuidance([new LearnedRules(tacit)]),
  });
  source.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "CLI rename", body: "please" });
  await controller.tickIntake();
  while (await worker.tick()) await controller.tickRuns();
  expect(runner.specs.map((s) => s.role)).toEqual(["triage"]);
  return runner.specs[0]!.prompt;
}

describe("Rules page: GET /api/v1/rules", SPAWNS, () => {
  it("lists each open, pending or held entry's ID, title and state, read through TacitLedger.pending", async () => {
    const s = stubHome([...PENDING, { id: "C-001", title: "old", state: "promoted" }]);
    const v = await (await page(s.ledger)).get();
    expect(v).toMatchObject({ enabled: true, error: null, judge: null });
    expect(typeof v.csrf_token).toBe("string");
    expect(v.entries).toEqual([
      { id: "P-0007", title: "Split the review prompt", state: "open" },
      { id: "C-012", title: "keep existing CLI flags", state: "pending" },
      { id: "C-013", title: "summary first", state: "held" },
    ]);
  });

  it("names why a user who is not the owner cannot judge", async () => {
    const v = await (await page(stubHome(PENDING).ledger, OTHER)).get();
    expect(v.judge).toContain("Only the owner judges rules");
    expect(v.entries.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(PENDING.map((e) => e.id)));
  });

  it("with the plugin none (or none wired) the page is told the ledger is off, and a verdict is refused", async () => {
    for (const tacit of [new NoTacitLedger(), undefined]) {
      const p = await page(tacit);
      expect(await p.get()).toEqual({ enabled: false, entries: [], error: null, csrf_token: null, judge: null });
      expect(await p.post({ id: "C-012", verdict: "promote", reason: "why" })).toMatchObject({ status: 409, value: { error: expect.stringContaining("agents-home") } });
    }
  });

  it("a ledger CLI that fails shows its error and no entries", async () => {
    const broken: TacitLedger = {
      enabled: true, capture: async () => {}, pending: async () => { throw new Error("ledger locked"); }, verdict: async () => {}, rules: async () => [],
    };
    const v = await (await page(broken)).get();
    expect(v).toMatchObject({ enabled: true, entries: [] });
    expect(v.error).toContain("ledger locked");
  });
});

describe("Rules page: POST /api/v1/rules/verdict", SPAWNS, () => {
  it("a class goes to tacit verdict (the owner's wording as --rule on promote), a proposal to evolve verdict with no rule", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect(await p.post({ id: "C-012", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag." })).toEqual({ status: 200, value: { id: "C-012", verdict: "promote" } });
    expect((await p.post({ id: "P-0007", verdict: "promote", reason: "good shape" })).status).toBe(200);
    expect((await p.post({ id: "C-013", verdict: "reject", reason: "not for code" })).status).toBe(200);
    expect(s.verdicts()).toEqual([
      ["verdict", "C-012", "promote", "--reason", "seen twice", "--rule", "Keep every existing CLI flag."],
      ["verdict", "P-0007", "promote", "--reason", "good shape"],
      ["verdict", "C-013", "reject", "--reason", "not for code"],
    ]);
    expect(s.entries().map((e) => e.state)).toEqual(["promoted", "promoted", "rejected"]);
    expect(p.log.lines.map((l) => l.fields)).toEqual([
      { id: "C-012", verdict: "promote", actor: OWNER, edited: true },
      { id: "P-0007", verdict: "promote", actor: OWNER, edited: false },
      { id: "C-013", verdict: "reject", actor: OWNER, edited: false },
    ]);
    expect((await p.get()).entries).toEqual([]);
  });

  it("refuses before the CLI runs: no reason, an unknown verdict, a text on reject or on a proposal, a user who is not the owner, a stale token", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect((await p.post({ id: "C-012", verdict: "promote" })).status).toBe(400);
    expect((await p.post({ id: "C-012", verdict: "promote", reason: "  " })).status).toBe(400);
    expect((await p.post({ id: "C-012", verdict: "accept", reason: "x" })).status).toBe(400);
    expect((await p.post({ id: "C-013", verdict: "reject", reason: "x", text: "y" })).status).toBe(400);
    expect((await p.post({ id: "P-0007", verdict: "promote", reason: "x", text: "y" })).status).toBe(400);
    expect((await p.post({ id: "C-012", verdict: "hold", reason: "x" }, { csrfToken: "stale" })).status).toBe(403);
    const other = await page(s.ledger, OTHER);
    expect(await other.post({ id: "C-012", verdict: "promote", reason: "x" })).toMatchObject({ status: 403, value: { error: expect.stringContaining("Only the owner") } });
    expect(s.verdicts()).toEqual([]);
  });

  it("an ID that is neither a class nor a proposal is a 502 and no CLI runs", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect(await p.post({ id: "t1", verdict: "hold", reason: "x" })).toMatchObject({ status: 502, value: { error: expect.stringContaining("neither a class") } });
    expect(s.verdicts()).toEqual([]);
  });

  it("a CLI that refuses the verdict is a 502 with its message", async () => {
    const s = stubHome(PENDING);
    writeFileSync(join(s.home, "bin", "tacit"), "#!/bin/sh\necho 'ledger locked' >&2\nexit 3\n");
    expect(await (await page(s.ledger)).post({ id: "C-012", verdict: "hold", reason: "x" })).toMatchObject({
      status: 502, value: { error: expect.stringContaining("tacit verdict exited 3: ledger locked") },
    });
  });
});

describe("learned rules in the prompt", SPAWNS, () => {
  it("a class promoted through the page appears in the next run's prompt under its own heading, in the owner's wording", async () => {
    const s = stubHome(PENDING);
    expect(await nextRunPrompt(s.ledger)).not.toContain("## Learned rules");
    await (await page(s.ledger)).post({ id: "C-012", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag." });
    const prompt = await nextRunPrompt(s.ledger);
    expect(prompt).toContain("## Learned rules");
    const section = prompt.slice(prompt.indexOf("## Learned rules"));
    expect(section).toContain("- Keep every existing CLI flag.\n  Except: 없음\n  Scope: software");
    expect(prompt.indexOf("## Learned rules")).toBeGreaterThan(prompt.indexOf("# Work item"));
  });

  it("each rule is its default with its exceptions and scope when given; a rule with no default is left out", async () => {
    const rule = (id: string, d: string, exceptions = "", scope = "") => ({ id, name: id, default: d, exceptions, scope });
    const ledger = { enabled: true, rules: async () => [rule("C-1", "Keep flags.", "", "CLI"), rule("C-2", ""), rule("C-3", "Two\nlines", "never")] };
    expect(await new LearnedRules(ledger).read(new MemLog())).toContain("- Keep flags.\n  Scope: CLI\n- Two\n  lines\n  Except: never");
  });

  it("no ledger, no rules file or a failed read: no section, and a failed read is a warning", async () => {
    const log = new MemLog();
    expect(await new LearnedRules(new NoTacitLedger()).read(log)).toBe("");
    expect(await new LearnedRules(stubHome(PENDING).ledger).read(log)).toBe("");
    const broken = { enabled: true, rules: async () => { throw new Error("ledger locked"); } };
    expect(await new LearnedRules(broken).read(log)).toBe("");
    expect(log.lines.map((l) => l.msg)).toEqual(["learned rules could not be read; none in the prompt"]);
  });

  it("the learned layer reads promoted rules only through the plugin: its module opens no file and names no path", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "core", "learned-rules.ts"), "utf8");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((i) => !i!.startsWith("node:"))).toBe(true);
    expect(imports).toContain("../interfaces/tacit-ledger.js");
    expect(src).not.toMatch(/AGENTS_HOME|\.agents|rules\.md|readFile|existsSync/);
  });
});
