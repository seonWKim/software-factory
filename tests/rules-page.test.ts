// The Rules page and the learned rules in the prompt (issue #571). The page lists the ledger's pending entries through
// TacitLedger.list and sends promote, reject and hold through TacitLedger.verdict, owner only, with a reason, and for
// promote the owner's wording. A promoted rule reaches the next run's prompt under its own heading, read through the
// plugin only; a rule scoped to another domain does not. Every test runs against a temp home with stub CLIs: no real
// home, no network, no live model.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { LearnedRules, inScope, joinGuidance, ruleEntry } from "../src/core/learned-rules.js";
import type { LogFields, Logger } from "../src/core/log.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { AgentsHomeTacitLedger } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import type { TacitLedger } from "../src/interfaces/tacit-ledger.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import type { RulesDeps } from "../src/ui/rules-api.js";
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

/**
 * A temp agents home whose `bin/tacit list` prints the entries of `<root>/ledger.json` in the asked state, and whose
 * `bin/evolve verdict` logs its stdin to `<root>/verdicts` and moves the entry: promote → promoted (with the owner's
 * text beside its draft), reject → rejected, hold → held. Node scripts; they write only outside the home.
 */
function stubHome(entries: Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), "sf-rules-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  const ledger = join(root, "ledger.json");
  writeFileSync(ledger, JSON.stringify(entries));
  const node = `#!${process.execPath}\nconst fs = require("node:fs");\nconst ledger = ${JSON.stringify(ledger)};\nconst read = () => JSON.parse(fs.readFileSync(ledger, "utf8"));\n`;
  writeFileSync(join(home, "bin", "tacit"), `${node}
const a = process.argv.slice(2);
if (a[0] !== "list") process.exit(2);
const state = a[a.indexOf("--state") + 1];
process.stdout.write(JSON.stringify(read().filter((e) => e.state === state)));
`);
  writeFileSync(join(home, "bin", "evolve"), `${node}
if (process.argv[2] !== "verdict") process.exit(2);
const v = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(join(root, "verdicts"))}, JSON.stringify(v) + "\\n");
const states = { promote: "promoted", reject: "rejected", hold: "held" };
fs.writeFileSync(ledger, JSON.stringify(read().map((e) => (e.id === v.id ? { ...e, state: states[v.verdict], ...(v.text ? { text: v.text } : {}) } : e))));
`);
  for (const cli of ["tacit", "evolve"]) chmodSync(join(home, "bin", cli), 0o755);
  const file = join(root, "verdicts");
  return {
    ledger: new AgentsHomeTacitLedger(home),
    verdicts: () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []),
    entries: () => JSON.parse(readFileSync(ledger, "utf8")) as Record<string, unknown>[],
  };
}

const PENDING = [
  {
    id: "r1", state: "pending", kind: "class", rule_draft: "Keep existing CLI flags when renaming commands.",
    evidence: ["wi_1: keep the existing CLI flag", "wi_2: do not drop --json"], scope: "software",
  },
  { id: "r2", state: "pending", kind: "structure", rule_draft: "Open every resume with a summary.", evidence: "resume: summary first", scope: "resume-writing" },
  { id: "r3", state: "pending", pushback: "split the test", rule_draft: "" },
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
  const d: RulesDeps = {
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

describe("Rules page: GET /api/v1/rules", () => {
  it("lists each pending entry's kind, evidence lines and rule draft, read through TacitLedger.list", async () => {
    const s = stubHome([...PENDING, { id: "old", state: "promoted", rule_draft: "x" }]);
    const v = await (await page(s.ledger)).get();
    expect(v).toMatchObject({ enabled: true, error: null, judge: null });
    expect(typeof v.csrf_token).toBe("string");
    expect(v.entries).toEqual([
      { id: "r1", kind: "class", scope: ["software"], evidence: ["wi_1: keep the existing CLI flag", "wi_2: do not drop --json"], rule_draft: "Keep existing CLI flags when renaming commands." },
      { id: "r2", kind: "structure", scope: ["resume-writing"], evidence: ["resume: summary first"], rule_draft: "Open every resume with a summary." },
      { id: "r3", kind: "pushback", scope: [], evidence: ["split the test"], rule_draft: "" },
    ]);
  });

  it("names why a user who is not the owner cannot judge", async () => {
    const v = await (await page(stubHome(PENDING).ledger, OTHER)).get();
    expect(v.judge).toContain("Only the owner judges rules");
    expect(v.entries).toHaveLength(PENDING.length);
  });

  it("with the plugin none (or none wired) the page is told the ledger is off, and a verdict is refused", async () => {
    for (const tacit of [new NoTacitLedger(), undefined]) {
      const p = await page(tacit);
      expect(await p.get()).toEqual({ enabled: false, entries: [], error: null, csrf_token: null, judge: null });
      expect(await p.post({ id: "r1", verdict: "promote", reason: "why" })).toMatchObject({ status: 409, value: { error: expect.stringContaining("agents-home") } });
    }
  });

  it("a ledger CLI that fails shows its error and no entries", async () => {
    const broken: TacitLedger = { enabled: true, capture: async () => {}, list: async () => { throw new Error("ledger locked"); }, verdict: async () => {} };
    const v = await (await page(broken)).get();
    expect(v).toMatchObject({ enabled: true, entries: [] });
    expect(v.error).toContain("ledger locked");
  });
});

describe("Rules page: POST /api/v1/rules/verdict", () => {
  it("promote, reject and hold reach the fake home's CLI through TacitLedger.verdict with the reason and the owner's user ID", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect(await p.post({ id: "r1", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag." })).toEqual({ status: 200, value: { id: "r1", verdict: "promote" } });
    expect((await p.post({ id: "r2", verdict: "reject", reason: "not for code" })).status).toBe(200);
    expect((await p.post({ id: "r3", verdict: "hold", reason: "wait for more" })).status).toBe(200);
    expect(s.verdicts()).toEqual([
      { id: "r1", verdict: "promote", reason: "seen twice", by: OWNER, text: "Keep every existing CLI flag." },
      { id: "r2", verdict: "reject", reason: "not for code", by: OWNER },
      { id: "r3", verdict: "hold", reason: "wait for more", by: OWNER },
    ]);
    // The edited wording is stored with the verdict; the draft is kept.
    expect(s.entries()[0]).toMatchObject({ state: "promoted", text: "Keep every existing CLI flag.", rule_draft: "Keep existing CLI flags when renaming commands." });
    expect(p.log.lines.map((l) => l.fields)).toEqual([
      { id: "r1", verdict: "promote", actor: OWNER, edited: true },
      { id: "r2", verdict: "reject", actor: OWNER, edited: false },
      { id: "r3", verdict: "hold", actor: OWNER, edited: false },
    ]);
    expect((await p.get()).entries).toEqual([]);
  });

  it("refuses before the CLI runs: no reason, an unknown verdict, a text on reject, a user who is not the owner, a stale token", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect((await p.post({ id: "r1", verdict: "promote" })).status).toBe(400);
    expect((await p.post({ id: "r1", verdict: "promote", reason: "  " })).status).toBe(400);
    expect((await p.post({ id: "r1", verdict: "accept", reason: "x" })).status).toBe(400);
    expect((await p.post({ id: "r2", verdict: "reject", reason: "x", text: "y" })).status).toBe(400);
    expect((await p.post({ id: "r1", verdict: "hold", reason: "x" }, { csrfToken: "stale" })).status).toBe(403);
    const other = await page(s.ledger, OTHER);
    expect(await other.post({ id: "r1", verdict: "promote", reason: "x" })).toMatchObject({ status: 403, value: { error: expect.stringContaining("Only the owner") } });
    expect(s.verdicts()).toEqual([]);
  });
});

describe("learned rules in the prompt", () => {
  it("a rule promoted through the page appears in the next run's prompt under its own heading, in the owner's wording", async () => {
    const s = stubHome(PENDING);
    expect(await nextRunPrompt(s.ledger)).not.toContain("## Learned rules");
    await (await page(s.ledger)).post({ id: "r1", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag." });
    const prompt = await nextRunPrompt(s.ledger);
    expect(prompt).toContain("## Learned rules");
    const section = prompt.slice(prompt.indexOf("## Learned rules"));
    expect(section).toContain("- Keep every existing CLI flag.");
    expect(section).not.toContain("Keep existing CLI flags when renaming commands.");
    expect(prompt.indexOf("## Learned rules")).toBeGreaterThan(prompt.indexOf("# Work item"));
  });

  it("a rule whose scope names another domain is not in the prompt", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    await p.post({ id: "r1", verdict: "promote", reason: "for code" });
    await p.post({ id: "r2", verdict: "promote", reason: "for resumes" });
    const prompt = await nextRunPrompt(s.ledger);
    expect(prompt).toContain("- Keep existing CLI flags when renaming commands.");
    expect(prompt).not.toContain("resume");
    expect(inScope(["mentoring"])).toBe(false);
    expect(inScope(["Software"].map((t) => t.toLowerCase()))).toBe(true);
    expect(inScope([])).toBe(true);
    expect(ruleEntry({ id: "x", scope: "mentoring, resume-writing" })!.scope).toEqual(["mentoring", "resume-writing"]);
  });

  it("no ledger or a failed read: no section, and a failed read is a warning", async () => {
    const log = new MemLog();
    expect(await new LearnedRules(new NoTacitLedger()).read(log)).toBe("");
    const broken = { enabled: true, list: async () => { throw new Error("ledger locked"); } };
    expect(await new LearnedRules(broken).read(log)).toBe("");
    expect(log.lines.map((l) => l.msg)).toEqual(["learned rules could not be read; none in the prompt"]);
  });

  it("the learned layer reads promoted rules only through the plugin: its module opens no file and names no path", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "core", "learned-rules.ts"), "utf8");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((i) => !i!.startsWith("node:"))).toBe(true);
    expect(imports).toContain("../interfaces/tacit-ledger.js");
    expect(src).not.toMatch(/AGENTS_HOME|\.agents|readFile|existsSync/);
  });
});
