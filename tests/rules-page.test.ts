// The Rules page and the learned rules in the prompt (issue #571). The page lists the ledger's pending entries through
// TacitLedger.pending and sends promote, reject and hold through TacitLedger.verdict, owner only, with a reason, and for
// promote of a class the owner's wording, default and exception, which the plugin writes into the home's rules.md
// before the verdict (rolled back if the verdict fails). A promoted rule reaches the next run's prompt under its own
// heading, read through the plugin's rules() only. Every test runs against a temp home with stub CLIs that take only
// the real CLIs' forms: no real home, no network, no live model.
//
// Turn on (design 08-settings, 2026-11-12): with the ledger off, GET names the agents home and the CLI missing there,
// and gives the owner the `integrations` value; POST /api/v1/settings stores it through the settings route's guards
// and owner check, and the next GET uses the rebuilt ledger with no restart.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { LiveTacit } from "../src/runtime/live-tacit.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { Worker } from "../src/worker/index.js";
import { LearnedRules, joinGuidance } from "../src/core/learned-rules.js";
import type { LogFields, Logger } from "../src/core/log.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { AgentsHomeTacitLedger, checkAgentsHome, tacitLedgerAt } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import type { TacitApplied, TacitEntryDetail, TacitLedger } from "../src/interfaces/tacit-ledger.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiTacit, uiTacit } from "../src/ui/rules-api.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { type UiRequest, respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
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

/** The owner's rules file before any promote: no rule yet, and the heading a promoted block goes before. */
const RULES_MD = "# Rules\n\n## 다른 곳에 인코딩된 규칙\n- C-009 → CLAUDE.md\n";

/**
 * A temp agents home whose stub CLIs take only the real forms and exit 2 with usage text on any other.
 * `bin/evolve pending` prints the open and held entries of `<root>/ledger.json` as the real CLI's text, and `bin/evolve
 * show <C-id>` the class's draft in the owner's sample form (its title as the default, `없음` the exception, incidents
 * T-1 and T-2, scope `software`); `bin/tacit verdict` (a C- class) and `bin/evolve verdict` (a P- proposal) log their
 * argv to `<root>/verdicts` and move the entry: promote → promoted, reject → rejected, hold → held, retire → retired.
 * As the real ledger does, `tacit verdict … promote` exits 1 without both `--rule` and `--encoded-to`, and writes no
 * rules file: the factory does. `bin/sync-agents` logs each run to `<root>/synced`; `<root>/refuse` makes tacit
 * verdict fail and `<root>/sync-fail` sync-agents. The home holds `private/tacit/rules.md` (RULES_MD). Node scripts.
 */
function stubHome(entries: Entry[]) {
  const root = mkdtempSync(join(tmpdir(), "sf-rules-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, "private", "tacit"), { recursive: true });
  writeFileSync(join(home, "private", "tacit", "rules.md"), RULES_MD);
  const ledger = join(root, "ledger.json");
  const verdicts = join(root, "verdicts");
  const synced = join(root, "synced");
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
if (a[2] === "promote" && !(a.includes("--rule") && a.includes("--encoded-to"))) { process.stderr.write("promote requires --rule and --encoded-to\\n"); process.exit(1); }
if (fs.existsSync(path.join(${JSON.stringify(root)}, "refuse"))) { process.stderr.write("ledger locked\\n"); process.exit(1); }
verdict(/^C-/, ["hold", "promote", "reject", "retire"], ["--rule", "--encoded-to"]);
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
} else if (a[0] === "show") {
  const e = a.length === 2 && read().find((x) => x.id === a[1] && x.id.startsWith("C-"));
  if (!e) { process.stderr.write("no class " + a[1] + "\\n"); process.exit(1); }
  process.stdout.write(["### " + e.id + " " + e.title, "- 인시던트: T-1, T-2", "- 초안: 기본값: " + e.title + " / 예외: 없음", "- 범위: software", "", "# incidents", "# verdicts", ""].join("\\n"));
} else {
  verdict(/^P-/, ["hold", "promote", "reject"], ["--applied-to"]);
}
`);
  writeFileSync(join(home, "bin", "sync-agents"), `#!${process.execPath}
const fs = require("node:fs");
if (fs.existsSync(${JSON.stringify(join(root, "sync-fail"))})) { process.stderr.write("agents dir locked\\n"); process.exit(4); }
fs.appendFileSync(${JSON.stringify(synced)}, "synced\\n");
`);
  for (const cli of ["tacit", "evolve", "sync-agents"]) chmodSync(join(home, "bin", cli), 0o755);
  return {
    root, home,
    rulesFile: join(home, "private", "tacit", "rules.md"),
    ledger: new AgentsHomeTacitLedger(home),
    verdicts: () => (existsSync(verdicts) ? readFileSync(verdicts, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []),
    syncs: () => (existsSync(synced) ? readFileSync(synced, "utf8").trim().split("\n").length : 0),
    entries: () => JSON.parse(readFileSync(ledger, "utf8")) as Entry[],
  };
}

/** A promote of a class as the dialog sends it: wording, default and exception beside the reason. */
const promote = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, verdict: "promote", reason: "seen twice", text: "Keep CLI flags", default: "Keep every existing CLI flag.", exception: "없음", ...over });

/**
 * An entry as GET lists it: not judged, a class with its stub draft (its title as the default), a proposal with none
 * and with its kind and target.
 */
const listed = (e: Entry) => ({
  id: e.id, title: e.title, state: e.state, ...(e.kind !== undefined ? { kind: e.kind } : {}), ...(e.target !== undefined ? { target: e.target } : {}),
  judged: null, draft_error: null,
  draft: e.id.startsWith("C-") ? { default: e.title, exception: "없음", incidents: ["T-1", "T-2"], scope: "software" } : null,
});

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

/** A fixed ledger as the UI holds it: settings that never change, and a home with no CLI. */
const fixed = (ledger: TacitLedger): UiTacit => ({
  ledger, settings: { refresh: async () => {}, values: () => ({ integrations: {} }) }, home: () => ({ path: "/no/home", missing: "bin/tacit" }),
});

/**
 * The Rules page's deps. `tacit`: a fixed ledger, or `{ agentsHome }` for the UI's live holder as compose.ts builds it
 * (config `none`, settings read from this store), with `agents-home` built at that home instead of the real one.
 */
async function page(tacit: TacitLedger | { agentsHome: string } | undefined, as: UserId = OWNER, known: readonly string[] = []) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const log = new MemLog();
  const pauses: UiPauses = { principal: async () => as, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log };
  const settings: UiSettings = {
    base: baseFromConfig(config), repo: config.repo, actor: as, resolveProject: async () => null, csrfToken: pauses.csrfToken,
    integrations: [{ kind: "tacit", interface: "TacitLedger", configured: "none" }],
  };
  let ui: UiTacit | undefined;
  if (tacit && "agentsHome" in tacit) {
    const env = { AGENTS_HOME: tacit.agentsHome };
    const ledger = await LiveTacit.start("none", async (n) => (n === "agents-home" ? tacitLedgerAt(env) : new NoTacitLedger()), log);
    const live = new LiveSettings({ config, base: baseFromConfig(config), source: store, log, integrations: [ledger] });
    ui = { ledger, settings: live, home: () => checkAgentsHome(env) };
  } else if (tacit) ui = fixed(tacit);
  const d: PauseDeps = {
    store, scanner: new PatternEgressScanner(async () => known), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, settings,
    ...(ui ? { tacit: ui } : {}),
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
  /** POST /api/v1/settings, as the page's Turn on sends it. */
  const setting = async (body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, {
      method: "POST", url: "/api/v1/settings", host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body), ...over,
    });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  /** GET /api/v1/rules/entry with `query` (`?id=…`). */
  const entry = async (query: string) => {
    const r = await respond(d, { method: "GET", url: `/api/v1/rules/entry${query}`, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  return { get, post, setting, entry, log, store };
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
    expect(v.entries).toEqual([PENDING[1]!, PENDING[0]!, PENDING[2]!].map(listed));
  });

  it("an entry with a ledger verdict newer than rule-candidates.md is listed as judged with its decision and no draft", async () => {
    const s = stubHome(PENDING);
    const dir = join(s.home, "private", "tacit");
    writeFileSync(join(dir, "rule-candidates.md"), "view");
    const built = new Date("2026-11-13T08:30:00Z");
    utimesSync(join(dir, "rule-candidates.md"), built, built);
    writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ type: "verdict", class: "C-012", ts: "2026-11-13T10:00:00Z", decision: "promote", reason: "r", by: "owner", rule: "x", encoded_to: "private/tacit/rules.md" })}\n`);
    const v = await (await page(s.ledger)).get();
    expect(v.entries.find((e: { id: string }) => e.id === "C-012")).toEqual({ id: "C-012", title: "keep existing CLI flags", state: "pending", judged: "promote", draft: null, draft_error: null });
    expect(v.entries.find((e: { id: string }) => e.id === "C-013")).toEqual(listed(PENDING[2]!));
  });

  it("a class whose draft cannot be read gets a draft error and no draft", async () => {
    const s = stubHome(PENDING);
    writeFileSync(join(s.home, "bin", "evolve"), `#!/bin/sh\n[ "$1" = pending ] && { printf '## tacit Pending 1\\n- C-012 keep flags\\n'; exit 0; }\necho 'ledger locked' >&2\nexit 3\n`);
    const v = await (await page(s.ledger)).get();
    expect(v.entries).toEqual([{ id: "C-012", title: "keep flags", state: "pending", judged: null, draft: null, draft_error: expect.stringContaining("evolve show exited 3: ledger locked") }]);
  });

  it("names why a user who is not the owner cannot judge", async () => {
    const v = await (await page(stubHome(PENDING).ledger, OTHER)).get();
    expect(v.judge).toContain("Only the owner judges rules");
    expect(v.entries.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(PENDING.map((e) => e.id)));
  });

  it("with the plugin none (or none wired) the page is told the ledger is off, and a verdict is refused", async () => {
    for (const tacit of [new NoTacitLedger(), undefined]) {
      const p = await page(tacit);
      expect(await p.get()).toMatchObject({ enabled: false, entries: [], error: null, turn_on: null });
      expect(await p.post(promote("C-012"))).toMatchObject({ status: 409, value: { error: expect.stringContaining("turn it on from the Rules page") } });
    }
  });

  it("applied: the rules file's blocks, an unparsable block as raw text and the encoded-elsewhere lines, each through the Withholder", async () => {
    const s = stubHome(PENDING);
    writeFileSync(join(s.home, "private", "tacit", "rules.md"), [
      "# Rules", "", "## C-001 summary first", "- 기본값: Open with a summary.", "- 예외 (이럴 땐 override): a one-word reply", "- 근거: 인시던트 T-1, T-2 / 판정일 2026-11-13", "- 범위: 모든 문서",
      "", "## Notes", "just words", "", "## 다른 곳에 인코딩된 규칙", "- C-009 → CLAUDE.md", "", "- token sekret-token-value-0123456789",
    ].join("\n"));
    const v = await (await page(s.ledger, OWNER, ["sekret-token-value-0123456789"])).get();
    expect(v.applied.rules).toEqual([
      { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: "a one-word reply", scope: "모든 문서", incidents: ["T-1", "T-2"], judged: "2026-11-13", raw: null },
      { id: null, name: null, default: null, exceptions: null, scope: null, incidents: null, judged: null, raw: "## Notes\njust words" },
    ]);
    expect(v.applied.elsewhere[0]).toBe("- C-009 → CLAUDE.md");
    expect(v.applied.elsewhere[1]).not.toContain("sekret-token-value-0123456789");
  });

  it("applied: no rules.md gives no applied rules and no error; the ledger off gives null", async () => {
    const s = stubHome(PENDING);
    rmSync(join(s.home, "private", "tacit", "rules.md"));
    expect(await (await page(s.ledger)).get()).toMatchObject({ enabled: true, error: null, applied: { rules: [], elsewhere: [] } });
    expect(await (await page(new NoTacitLedger())).get()).toMatchObject({ enabled: false, applied: null });
  });

  it("a ledger CLI that fails shows its error and no entries", async () => {
    const broken: TacitLedger = {
      enabled: true, capture: async () => {}, pending: async () => { throw new Error("ledger locked"); }, verdict: async () => {}, rules: async () => [], applied: async () => ({ rules: [], elsewhere: [] }),
    };
    const v = await (await page(broken)).get();
    expect(v).toMatchObject({ enabled: true, entries: [] });
    expect(v.error).toContain("ledger locked");
  });
});

/** A ledger that is on, lists PENDING, and answers `show` with `show`; every call it gets is kept in `calls`. */
function fakeLedger(show: (id: string) => Promise<TacitEntryDetail | null>, applied: TacitApplied = { rules: [], elsewhere: [] }) {
  const calls: string[] = [];
  const ledger: TacitLedger = {
    enabled: true,
    capture: async () => { calls.push("capture"); },
    pending: async () => { calls.push("pending"); return PENDING; },
    show: async (id) => { calls.push(`show ${id}`); return show(id); },
    verdict: async () => { calls.push("verdict"); },
    rules: async () => [],
    applied: async () => { calls.push("applied"); return applied; },
  };
  return { ledger, calls };
}

const SECRET = "sekret-token-value-0123456789";

describe("Rules page: GET /api/v1/rules/entry", () => {
  it("returns each detail field read through TacitLedger.show, in its place; a field the ledger lacks is absent", async () => {
    const f = fakeLedger(async (id) => ({ id, default: "Keep every flag.", exceptions: "deprecated ones", incidents: 2, quotes: ["keep --json"], root_reason: "renames skip callers", scope: "CLI" }));
    const p = await page(f.ledger);
    expect(await p.entry("?id=C-012")).toEqual({
      status: 200,
      value: { id: "C-012", error: null, retire: null, detail: { id: "C-012", default: "Keep every flag.", exceptions: "deprecated ones", incidents: 2, quotes: ["keep --json"], root_reason: "renames skip callers", scope: "CLI" } },
    });
    const bare = fakeLedger(async (id) => ({ id, kind: "edit-asset", target: "prompts/review.md" }));
    expect((await (await page(bare.ledger)).entry("?id=P-20261103-34e9")).value.detail).toEqual({ id: "P-20261103-34e9", kind: "edit-asset", target: "prompts/review.md" });
    // The detail is read on demand only, and the read calls nothing but show and, for a class, the rules file.
    expect(f.calls).toEqual(["show C-012", "applied"]);
  });

  it("passes every text of the detail through the Withholder", async () => {
    const f = fakeLedger(async (id) => ({ id, default: `use ${SECRET}`, quotes: ["fine", `paste ${SECRET}`], root_reason: SECRET, scope: "CLI" }));
    const v = (await (await page(f.ledger, OWNER, [SECRET])).entry("?id=C-012")).value;
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(v.detail.default).toMatch(/^\[withheld: /);
    expect(v.detail.quotes[0]).toBe("fine");
    expect(v.detail.quotes[1]).toMatch(/^\[withheld: /);
    expect(v.detail.scope).toBe("CLI");
  });

  it("a show that returns nothing gives no detail; one that throws gives no detail and its error", async () => {
    expect((await (await page(fakeLedger(async () => null).ledger)).entry("?id=C-012")).value).toEqual({ id: "C-012", detail: null, error: null, retire: null });
    const broken = fakeLedger(async () => { throw new Error("evolve show exited 5: ledger locked"); });
    const v = (await (await page(broken.ledger)).entry("?id=C-012")).value;
    expect(v).toMatchObject({ id: "C-012", detail: null });
    expect(v.error).toContain("evolve show exited 5: ledger locked");
  });

  it("an ID that is neither C- nor P-, or none, is a 400 before show runs; the ledger off or none wired gives no detail", async () => {
    const f = fakeLedger(async (id) => ({ id }));
    const p = await page(f.ledger);
    for (const q of ["", "?id=", "?id=t1"]) expect((await p.entry(q)).status).toBe(400);
    expect(f.calls).toEqual([]);
    for (const tacit of [new NoTacitLedger(), undefined]) {
      expect(await (await page(tacit)).entry("?id=C-012")).toEqual({ status: 200, value: { id: "C-012", detail: null, error: null, retire: null } });
    }
  });

  it("a user who is not the owner reads the detail too: it is read-only", async () => {
    const f = fakeLedger(async (id) => ({ id, scope: "CLI" }));
    expect((await (await page(f.ledger, OTHER)).entry("?id=C-012")).value.detail).toEqual({ id: "C-012", scope: "CLI" });
  });

  it("the UI's live holder reads show from the plugin it built, and follows a switch", async () => {
    const { store } = await newStore(new FakeClock());
    const shown = fakeLedger(async (id) => ({ id, scope: "from the plugin" }));
    const ui = await uiTacit("fake", async (n) => (n === "fake" ? shown.ledger : new NoTacitLedger()), { base: baseFromConfig(config), source: store, log: silent, config });
    expect(await ui.ledger.show!("C-012")).toEqual({ id: "C-012", scope: "from the plugin" });
    await (ui.ledger as unknown as { apply(i: Record<string, string>): Promise<void> }).apply({ tacit: "none" });
    expect(ui.ledger.enabled).toBe(false);
    expect(await ui.ledger.show!("C-012")).toBeNull();
  });
});

describe("Rules page: Turn on", SPAWNS, () => {
  it("ledger off and the home found: GET names the home and gives the owner the integrations value", async () => {
    const s = stubHome(PENDING);
    const v = await (await page({ agentsHome: s.home })).get();
    expect(v).toMatchObject({ enabled: false, entries: [], judge: null, home: { path: s.home, missing: null }, turn_on: '{"tacit":"agents-home"}' });
    expect(typeof v.csrf_token).toBe("string");
  });

  it("Turn on stores the entry through POST /api/v1/settings, and the next GET lists the rules with no restart", async () => {
    const s = stubHome(PENDING);
    const p = await page({ agentsHome: s.home });
    const off = await p.get();
    expect(await p.setting({ action: "set", key: "integrations", value: off.turn_on })).toMatchObject({ status: 200, value: { ok: true } });
    const on = await p.get();
    expect(on).toMatchObject({ enabled: true, error: null, judge: null });
    expect(on.entries.map((e: { id: string }) => e.id)).toEqual(["P-0007", "C-012", "C-013"]);
    expect((await p.store.listSettingChanges(10)).map((c) => [c.key, c.new_value])).toEqual([["integrations", '{"tacit":"agents-home"}']]);
    // Turned off again (the entry reset): the config's `none` is back by the next request.
    expect((await p.setting({ action: "reset", key: "integrations" })).status).toBe(200);
    expect(await p.get()).toMatchObject({ enabled: false, turn_on: '{"tacit":"agents-home"}' });
  });

  it("the home not found: GET names the missing CLI and gives no turn-on value", async () => {
    const s = stubHome(PENDING);
    rmSync(join(s.home, "bin", "evolve"));
    expect(await (await page({ agentsHome: s.home })).get()).toMatchObject({ enabled: false, home: { path: s.home, missing: "bin/evolve" }, turn_on: null });
  });

  it("a user who is not the owner gets no turn-on value, and their write is refused with nothing stored", async () => {
    const s = stubHome(PENDING);
    const p = await page({ agentsHome: s.home }, OTHER);
    const v = await p.get();
    expect(v).toMatchObject({ enabled: false, csrf_token: null, turn_on: null, judge: expect.stringContaining("Only the owner turns the ledger on") });
    expect(await p.setting({ action: "set", key: "integrations", value: '{"tacit":"agents-home"}' })).toMatchObject({
      status: 422, value: { error: expect.stringContaining("integrations changes only by the owner") },
    });
    expect(await p.store.listSettingOverrides()).toEqual([]);
    expect(await p.store.listSettingChanges(10)).toEqual([]);
  });

  it("the write passes the existing request guards: a stale token, another origin or a non-JSON body is refused", async () => {
    const s = stubHome(PENDING);
    const p = await page({ agentsHome: s.home });
    const body = { action: "set", key: "integrations", value: '{"tacit":"agents-home"}' };
    expect((await p.setting(body, { csrfToken: "stale" })).status).toBe(403);
    expect((await p.setting(body, { origin: "http://evil.example" })).status).toBe(403);
    expect((await p.setting(body, { contentType: "text/plain" })).status).toBe(415);
    expect(await p.store.listSettingOverrides()).toEqual([]);
  });
});

describe("Rules page: POST /api/v1/rules/verdict", SPAWNS, () => {
  it("promote of a class writes its block, then tacit verdict with --rule and --encoded-to, then sync-agents; a proposal goes to evolve verdict", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect(await p.post(promote("C-012"))).toEqual({ status: 200, value: { id: "C-012", verdict: "promote" } });
    expect(readFileSync(s.rulesFile, "utf8")).toMatch(new RegExp(
      "^# Rules\\n\\n## C-012 Keep CLI flags\\n- 기본값: Keep every existing CLI flag\\.\\n- 예외 \\(이럴 땐 override\\): 없음\\n"
      + "- 근거: 인시던트 T-1, T-2 / 판정일 \\d{4}-\\d{2}-\\d{2}\\n- 범위: software\\n\\n## 다른 곳에 인코딩된 규칙\\n",
    ));
    expect(s.syncs()).toBe(1);
    expect((await p.post({ id: "P-0007", verdict: "promote", reason: "good shape" })).status).toBe(200);
    expect((await p.post({ id: "C-013", verdict: "reject", reason: "not for code" })).status).toBe(200);
    expect(s.syncs()).toBe(1);
    expect(s.verdicts()).toEqual([
      ["verdict", "C-012", "promote", "--reason", "seen twice", "--rule", "Keep CLI flags", "--encoded-to", "private/tacit/rules.md"],
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

  it("refuses before the CLI runs: no reason, an unknown verdict, a rule field on reject or on a proposal, a missing or long rule field, a user who is not the owner, a stale token", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    expect((await p.post({ id: "C-012", verdict: "promote" })).status).toBe(400);
    for (const field of ["text", "default", "exception"]) {
      expect(await p.post(promote("C-012", { [field]: undefined }))).toMatchObject({ status: 400, value: { error: `${field} must be 1 to 2000 characters` } });
      expect((await p.post(promote("C-012", { [field]: " " }))).status).toBe(400);
      expect((await p.post(promote("C-012", { [field]: "x".repeat(2001) }))).status).toBe(400);
    }
    expect(await p.post(promote("C-012", { scope: "x" }))).toMatchObject({ status: 400, value: { error: 'unknown field "scope"' } });
    expect((await p.post({ id: "C-013", verdict: "hold", reason: "x", default: "y" })).status).toBe(400);
    expect((await p.post({ id: "C-012", verdict: "promote", reason: "  " })).status).toBe(400);
    expect((await p.post({ id: "C-012", verdict: "accept", reason: "x" })).status).toBe(400);
    expect((await p.post({ id: "C-013", verdict: "reject", reason: "x", text: "y" })).status).toBe(400);
    expect((await p.post({ id: "P-0007", verdict: "promote", reason: "x", text: "y" })).status).toBe(400);
    expect((await p.post({ id: "C-012", verdict: "hold", reason: "x" }, { csrfToken: "stale" })).status).toBe(403);
    const other = await page(s.ledger, OTHER);
    expect(await other.post(promote("C-012"))).toMatchObject({ status: 403, value: { error: expect.stringContaining("Only the owner") } });
    expect(s.verdicts()).toEqual([]);
    expect(readFileSync(s.rulesFile, "utf8")).toBe(RULES_MD);
  });

  it("a verdict the ledger refuses is a 502 naming the CLI error, and rules.md is byte-identical to before", async () => {
    const s = stubHome(PENDING);
    writeFileSync(join(s.root, "refuse"), "");
    const before = readFileSync(s.rulesFile);
    expect(await (await page(s.ledger)).post(promote("C-012"))).toEqual({
      status: 502, value: { error: "The ledger refused the verdict: tacit verdict exited 1: ledger locked" },
    });
    expect(readFileSync(s.rulesFile).equals(before)).toBe(true);
    expect(s.syncs()).toBe(0);
  });

  it("a sync-agents that fails after the verdict is a 502 that says the verdict was recorded; the block stays", async () => {
    const s = stubHome(PENDING);
    writeFileSync(join(s.root, "sync-fail"), "");
    expect(await (await page(s.ledger)).post(promote("C-012"))).toEqual({
      status: 502, value: { error: "The verdict was recorded, but sync-agents failed: sync-agents exited 4: agents dir locked" },
    });
    expect(s.verdicts()).toHaveLength(1);
    expect(readFileSync(s.rulesFile, "utf8")).toContain("## C-012 Keep CLI flags\n");
  });

  it("a class already in rules.md, or a rules.md linked outside the home, is a 409 with nothing written and no CLI run", async () => {
    const s = stubHome(PENDING);
    const p = await page(s.ledger);
    const inFile = `${RULES_MD}\n## C-012 keep existing CLI flags\n- 기본값: old\n`;
    writeFileSync(s.rulesFile, inFile);
    expect(await p.post(promote("C-012"))).toMatchObject({ status: 409, value: { error: expect.stringContaining("C-012 is already in private/tacit/rules.md") } });
    expect(readFileSync(s.rulesFile, "utf8")).toBe(inFile);
    const outside = join(s.root, "outside.md");
    writeFileSync(outside, RULES_MD);
    rmSync(s.rulesFile);
    symlinkSync(outside, s.rulesFile);
    expect(await p.post(promote("C-012"))).toMatchObject({ status: 409, value: { error: expect.stringContaining("resolves outside the agents home") } });
    expect(readFileSync(outside, "utf8")).toBe(RULES_MD);
    expect(s.verdicts()).toEqual([]);
    expect(s.syncs()).toBe(0);
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

/** A rules file with three applied rules: C-001 judged long ago, C-002 covering it, C-003 naming a path this repo lacks. */
const APPLIED_MD = [
  "# Rules", "",
  "## C-001 summary first", "- 기본값: Open every summary with one line.", "- 근거: 인시던트 T-1, T-2 / 판정일 2025-11-01", "",
  "## C-002 summaries", "- 기본값: Open every summary with one line. Then the detail.", "- 근거: 인시던트 T-3 / 판정일 2025-12-20", "",
  "## C-003 old store", "- 기본값: Keep src/impl/old-gone-store.ts small.", "- 범위: src/core/rule-retirement.ts", "",
  "## 다른 곳에 인코딩된 규칙", "- C-009 → CLAUDE.md", "",
].join("\n");
const APPLIED_ENTRIES: Entry[] = [
  { id: "C-001", title: "summary first", state: "promoted" },
  { id: "C-002", title: "summaries", state: "promoted" },
  { id: "C-003", title: "old store", state: "promoted" },
];

describe("Rules page: retire suggestions (the Suggest button's reads)", SPAWNS, () => {
  it("an applied class gets its reasons: stale, covered by another rule, a path this repo lacks; a rule that meets none gets []", async () => {
    const s = stubHome([...PENDING, ...APPLIED_ENTRIES]);
    writeFileSync(s.rulesFile, APPLIED_MD);
    const p = await page(s.ledger);
    // The stub's evolve show lists no incident rows: no new incident since C-001 was judged (61 days before the clock's today).
    expect((await p.entry("?id=C-001")).value.retire).toEqual(["no new incident for 61 days since judged on 2025-11-01", "covered by C-002"]);
    expect((await p.entry("?id=C-002")).value.retire).toEqual([]);
    expect((await p.entry("?id=C-003")).value.retire).toEqual(["names src/impl/old-gone-store.ts, which this repo does not have"]);
    // A pending class or a proposal is no applied rule: no suggestion.
    expect((await p.entry("?id=C-012")).value.retire).toBeNull();
    expect((await p.entry("?id=P-0007")).value.retire).toBeNull();
  });

  it("a class with a new incident since it was judged is not stale; a failed show still gives the other signals", async () => {
    const rule = { id: "C-001", name: "a", default: "Open every summary with one line.", incidents: ["T-1"], judged: "2025-11-01" };
    const newer = fakeLedger(async (id) => ({ id, incidents: 2 }), { rules: [rule], elsewhere: [] });
    expect((await (await page(newer.ledger)).entry("?id=C-001")).value.retire).toEqual([]);
    const broken = fakeLedger(async () => { throw new Error("evolve show exited 5"); }, { rules: [rule, { id: "C-002", name: "b", default: rule.default }], elsewhere: [] });
    expect((await (await page(broken.ledger)).entry("?id=C-001")).value).toMatchObject({ detail: null, retire: ["covered by C-002"] });
  });

  it("reading the page and every suggestion leaves the rules file bytes, the ledger and the verdict CLIs untouched", async () => {
    const s = stubHome([...PENDING, ...APPLIED_ENTRIES]);
    writeFileSync(s.rulesFile, APPLIED_MD);
    const before = readFileSync(s.rulesFile);
    const entries = s.entries();
    const p = await page(s.ledger);
    await p.get();
    for (const id of ["C-001", "C-002", "C-003"]) expect((await p.entry(`?id=${id}`)).status).toBe(200);
    await p.get();
    expect(readFileSync(s.rulesFile).equals(before)).toBe(true);
    expect(s.entries()).toEqual(entries);
    expect(s.verdicts()).toEqual([]);
    expect(s.syncs()).toBe(0);
    expect(await p.store.listSettingChanges(10)).toEqual([]);
  });

  it("the plugin none gives no suggestions and no applied rules", async () => {
    const p = await page(new NoTacitLedger());
    expect(await p.get()).toMatchObject({ enabled: false, applied: null, retired: null });
    expect((await p.entry("?id=C-001")).value.retire).toBeNull();
  });
});

describe("Rules page: retire through POST /api/v1/rules/verdict", SPAWNS, () => {
  const retire = (id: string, over: Record<string, unknown> = {}) => ({ id, verdict: "retire", reason: "covered by C-002", ...over });

  it("removes the block, runs tacit verdict <id> retire --reason and sync-agents; the rule leaves Applied and shows under Retired from the ledger", async () => {
    const s = stubHome([...PENDING, ...APPLIED_ENTRIES]);
    writeFileSync(s.rulesFile, APPLIED_MD);
    const p = await page(s.ledger);
    expect((await p.get()).retired).toEqual([]);
    expect(await p.post(retire("C-001"))).toEqual({ status: 200, value: { id: "C-001", verdict: "retire" } });
    expect(s.verdicts()).toEqual([["verdict", "C-001", "retire", "--reason", "covered by C-002"]]);
    expect(s.syncs()).toBe(1);
    expect(readFileSync(s.rulesFile, "utf8")).not.toContain("## C-001");
    expect(p.log.lines.map((l) => l.fields)).toEqual([{ id: "C-001", verdict: "retire", actor: OWNER, edited: false }]);
    // The ledger records the verdict (as the real tacit does); the page reads it back as the Retired list.
    writeFileSync(join(s.home, "private", "tacit", "ledger.jsonl"), `${JSON.stringify({ type: "verdict", class: "C-001", ts: "2026-11-14T10:00:00Z", decision: "retire", reason: "covered by C-002", by: "owner", rule: "", encoded_to: "" })}\n`);
    const v = await p.get();
    expect(v.applied.rules.map((r: { id: string }) => r.id)).toEqual(["C-002", "C-003"]);
    expect(v.retired).toEqual([{ id: "C-001", reason: "covered by C-002", date: "2026-11-14" }]);
  });

  it("refuses before any CLI runs: a non-owner (403), a rule field, a proposal, no reason (400)", async () => {
    const s = stubHome([...PENDING, ...APPLIED_ENTRIES]);
    writeFileSync(s.rulesFile, APPLIED_MD);
    const other = await page(s.ledger, OTHER);
    expect(await other.post(retire("C-001"))).toMatchObject({ status: 403, value: { error: expect.stringContaining("Only the owner") } });
    const p = await page(s.ledger);
    expect(await p.post(retire("C-001", { text: "x" }))).toMatchObject({ status: 400, value: { error: "only promote of a class (C-) takes a text" } });
    expect(await p.post(retire("P-0007"))).toMatchObject({ status: 400, value: { error: "only a class (C-) is retired" } });
    expect((await p.post(retire("C-001", { reason: " " }))).status).toBe(400);
    expect(s.verdicts()).toEqual([]);
    expect(s.syncs()).toBe(0);
    expect(readFileSync(s.rulesFile, "utf8")).toBe(APPLIED_MD);
  });

  it("a class with no block in rules.md is a 409 with nothing written and no CLI run", async () => {
    const s = stubHome(PENDING);
    expect(await (await page(s.ledger)).post(retire("C-012"))).toMatchObject({ status: 409, value: { error: expect.stringContaining("The retire was refused: C-012 has no block") } });
    expect(readFileSync(s.rulesFile, "utf8")).toBe(RULES_MD);
    expect(s.verdicts()).toEqual([]);
  });

  it("a verdict the ledger refuses is a 502, and rules.md is byte-identical to before", async () => {
    const s = stubHome(APPLIED_ENTRIES);
    writeFileSync(s.rulesFile, APPLIED_MD);
    writeFileSync(join(s.root, "refuse"), "");
    const before = readFileSync(s.rulesFile);
    expect(await (await page(s.ledger)).post(retire("C-001"))).toEqual({ status: 502, value: { error: "The ledger refused the verdict: tacit verdict exited 1: ledger locked" } });
    expect(readFileSync(s.rulesFile).equals(before)).toBe(true);
    expect(s.syncs()).toBe(0);
  });

  it("a sync-agents that fails after the verdict is a 502 that says the verdict was recorded; the block stays removed", async () => {
    const s = stubHome(APPLIED_ENTRIES);
    writeFileSync(s.rulesFile, APPLIED_MD);
    writeFileSync(join(s.root, "sync-fail"), "");
    expect(await (await page(s.ledger)).post(retire("C-001"))).toEqual({
      status: 502, value: { error: "The verdict was recorded, but sync-agents failed: sync-agents exited 4: agents dir locked" },
    });
    expect(s.verdicts()).toHaveLength(1);
    expect(readFileSync(s.rulesFile, "utf8")).not.toContain("## C-001");
  });
});

describe("learned rules in the prompt", SPAWNS, () => {
  it("a class promoted through the page appears in the next run's prompt under its own heading, in the owner's wording", async () => {
    const s = stubHome(PENDING);
    expect(await nextRunPrompt(s.ledger)).not.toContain("## Learned rules");
    expect((await (await page(s.ledger)).post(promote("C-012"))).status).toBe(200);
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
