import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { AgentsHomeTacitLedger, TACIT_AGENT, TACIT_CLI_TIMEOUT_MS, agentsHome, checkAgentsHome, knownAgentsHomes, tacitLedgerAt } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { parseApplied, parseDraft, parsePending, parsePushbacks, parseShow, withEditedBlock, withoutRuleBlock } from "../src/impl/tacit/ledger-text.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import { REGISTRY, createPlugin, defaultPlugins } from "../src/plugins.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import {
  type TacitChangeProposal, type TacitHandOff, type TacitLedger, type TacitPromotion, type TacitVerdictRecord, TacitRefusal, TacitSyncFailed,
} from "../src/interfaces/tacit-ledger.js";
import type { LLMProvider } from "../src/interfaces/llm-provider.js";
import type { LogFields, Logger } from "../src/core/log.js";
import {
  type SkillImproveWiring, type SkillLedger, holdSkillDraft, improveSkills, promoteSkillDraft, rejectSkillDraft, skillDraftId, withHandOff,
} from "../src/core/skill-improve.js";
import { SKILL_IMPROVE_DEFAULTS } from "../src/core/skill-improve-config.js";
import type { SqlDriver } from "../src/state/index.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, system, w1 } from "./helpers/store.js";

// The owner's tacit ledger (issue #570): a /revise, a /reject and a `changes` verdict each capture one record, keyed
// by the command's comment ID, through an outbound intent that runs <home>/bin/tacit. Every test runs against a temp
// home with stub CLIs: no real home, no network, no live CLI.

/** `evolve pending` as the owner's CLI prints it (checked 2026-11-12): text, not JSON. */
const PENDING_SAMPLE = `## proposals (open) 1
- P-0007 [spec] src/core/foo.ts — Keep the flag
## proposals (held) 0
## tacit Pending 1
- C-012 keep existing CLI flags
## tacit Held 0
`;

/** `evolve show C-012` in the owner's sample form (2026-11-13): heading, incidents, draft, scope, then the sections. */
const SHOW_SAMPLE = `### C-012 keep existing CLI flags
- 인시던트: T-0101, T-0102
- 초안: 기본값: Keep every existing CLI flag. / 예외: a flag the owner marked deprecated
- 범위: software, CLI

# incidents
- T-0101 renamed --out
# verdicts
`;

/** The owner's rules file before a promote: one rule, then the heading a new block goes before. */
const RULES_SAMPLE = `# Rules

## C-001 summary first
- 기본값: Open with a one-line summary.
- 예외 (이럴 땐 override): none
- 근거: 인시던트 T-0001 / 판정일 2026-11-01
- 범위: 전역

## 다른 곳에 인코딩된 규칙
- C-009 → CLAUDE.md
`;

/** The owner's rule as the dialog sends it. */
const RULE: TacitPromotion = { wording: "keep CLI flags", default: "Keep every flag.", exception: "a deprecated flag" };

/** A fixed today for the judged date. */
const TODAY = { now: () => new Date(2026, 10, 13, 9, 30) };

/** `evolve show C-012` in the form the parser reads (docs/plugins/tacit-ledger.md; assumed, not checked against the real CLI). */
const DETAIL_SAMPLE = `# C-012 keep existing CLI flags
## incidents 3
- wi_1 — "keep --json, scripts use it"
- wi_2 — “don't rename the flag”
- wi_3
근본 원인: agents rename flags without checking callers
## rule draft
- 기본값: Keep every existing CLI flag when renaming a command.
- 예외: a flag the owner marked deprecated
- 범위: software, CLI
`;

/**
 * `evolve show <P-id>` as the owner's CLI prints it now: one JSON object with the keys id, ts, by, kind, target, title,
 * rationale, change (free text), evidence (IDs only) and verdicts. The values are made up; the keys and shapes are the CLI's.
 */
const SHOW_JSON = `${JSON.stringify({
  id: "P-20261017-4c1d",
  ts: "2026-10-17T21:04:11+09:00",
  by: "evolve",
  kind: "edit-asset",
  target: "skills/review/SKILL.md",
  title: "Review runs the changed tests before its verdict",
  rationale: "Two reviews on the same day passed a change whose tests never ran.",
  change: "Add a step before the verdict: run the changed tests and quote their result.",
  evidence: ["T-20261017-de7e", "T-20261017-9f3c", "L-20261016-0a1b"],
  state: "open",
  verdicts: [],
}, null, 2)}\n`;

/**
 * A temp agents home with stub `bin/tacit`, `bin/evolve` and `bin/sync-agents` that take only the real CLIs' forms
 * (checked 2026-11-12 with `--help`; `evolve show` 2026-11-13) and exit 2 with usage text on any other. As the real
 * ledger does, `tacit verdict … promote` exits 1 without both `--rule` and `--encoded-to`, and `evolve verdict … promote`
 * without `--applied-to`. The stubs log each call's
 * argv, one item per field, to `<root>/log/argv`, outside the home, read `<root>/control/{fail,sleep,refuse,sync}`
 * and `evolve show <id>` prints `<root>/drafts/<id>`, `tacit show --active --unclustered` `<root>/pushbacks` (the edit and pushback forms are assumed) (C-012's draft is SHOW_SAMPLE; an empty file prints nothing), so the stubs never write the
 * home. Only capture reads stdin; any other call that gets stdin fails.
 */
function stubHome(): {
  root: string; home: string; captures: () => Record<string, unknown>[]; argv: () => string[];
  control: (name: "fail" | "sleep" | "refuse" | "sync", on: boolean) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "sf-tacit-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(root, "log"));
  mkdirSync(join(root, "control"));
  mkdirSync(join(root, "drafts"));
  writeFileSync(join(root, "drafts", "C-012"), SHOW_SAMPLE);
  const prelude = (usage: string) => `#!/bin/sh
root="$(cd "$(dirname "$0")/../.." && pwd)"
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '|%s' "$a"; done; echo; } >> "$root/log/argv"
usage() { echo "${usage}" >&2; exit 2; }
no_stdin() { [ -z "$(cat)" ] || { echo "unexpected stdin" >&2; exit 4; }; }
`;
  writeFileSync(join(home, "bin", "tacit"), `${prelude("usage: tacit {capture --agent <name> | verdict <class> {hold,promote,reject,retire} --reason <reason> [--rule <rule text>] [--encoded-to <file>] | show --active --unclustered | status <incident> noise}")}
case "$1" in
  --help)
    echo "usage: tacit <command> [options]"
    echo "commands:"
    echo "  capture --agent <name>  read one record as JSON on stdin"
    echo "  verdict <class> {hold,promote,reject,retire} --reason <reason> [--rule <rule text>] [--encoded-to <file>]"
    echo "  show --active --unclustered  the active pushbacks in no class yet"
    echo "  status <incident> noise"
    ;;
  show)
    [ "$#" -eq 3 ] && [ "$2" = "--active" ] && [ "$3" = "--unclustered" ] || usage
    no_stdin
    [ -f "$root/control/fail" ] && { echo "ledger locked" >&2; exit 3; }
    [ -f "$root/pushbacks" ] && cat "$root/pushbacks"
    true
    ;;
  status)
    [ "$#" -eq 3 ] && [ "$3" = "noise" ] || usage
    case "$2" in T-*) ;; *) usage ;; esac
    no_stdin
    [ -f "$root/control/refuse" ] && { echo "ledger locked" >&2; exit 1; }
    true
    ;;
  capture)
    [ "$#" -eq 3 ] && [ "$2" = "--agent" ] || usage
    [ -f "$root/control/sleep" ] && sleep 5
    [ -f "$root/control/fail" ] && { echo "ledger locked" >&2; exit 3; }
    cat >> "$root/log/captures"; echo >> "$root/log/captures"
    ;;
  verdict)
    [ "$#" -ge 5 ] && [ "$4" = "--reason" ] || usage
    case "$2" in C-*) ;; *) usage ;; esac
    case "$3" in hold|promote|reject|retire) ;; *) usage ;; esac
    decision="$3"; shift 5; rule=""; encoded=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --rule) [ "$#" -ge 2 ] || usage; rule="$2"; shift 2 ;; --encoded-to) [ "$#" -ge 2 ] || usage; encoded="$2"; shift 2 ;; *) usage ;; esac
    done
    [ "$decision" = promote ] && { [ -n "$rule" ] && [ -n "$encoded" ] || { echo "promote requires --rule and --encoded-to" >&2; exit 1; }; }
    [ -f "$root/control/refuse" ] && { echo "ledger locked" >&2; exit 1; }
    no_stdin
    ;;
  *) usage ;;
esac
`);
  writeFileSync(join(home, "bin", "evolve"), `${prelude("usage: evolve {pending | show <id> | verdict <id> {hold,promote,reject} --reason <reason> [--applied-to <file>]}")}
case "$1" in
  --help)
    echo "usage: evolve <command> [options]"
    echo "commands:"
    echo "  pending  list what waits for a verdict"
    echo "  show <id>  one entry's detail: its draft, incidents and verdicts"
    echo "  verdict <id> {hold,promote,reject} --reason <reason> [--applied-to <file>]"
    ;;
  pending)
    [ "$#" -eq 1 ] || usage
    no_stdin
    printf '%s' '${PENDING_SAMPLE}'
    ;;
  show)
    [ "$#" -eq 2 ] || usage
    no_stdin
    [ -f "$root/drafts/$2" ] || { echo "no entry $2" >&2; exit 1; }
    cat "$root/drafts/$2"
    ;;
  verdict)
    [ "$#" -ge 5 ] && [ "$4" = "--reason" ] || usage
    case "$2" in P-*) ;; *) usage ;; esac
    case "$3" in hold|promote|reject) ;; *) usage ;; esac
    decision="$3"
    shift 5
    applied=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --applied-to) [ "$#" -ge 2 ] || usage; applied="$2"; shift 2 ;; *) usage ;; esac
    done
    no_stdin
    [ "$decision" != promote ] || [ -n "$applied" ] || { echo "promote requires --applied-to (반영한 파일)" >&2; exit 1; }
    ;;
  *) usage ;;
esac
`);
  writeFileSync(join(home, "bin", "sync-agents"), `${prelude("usage: sync-agents")}
[ "$#" -eq 0 ] || usage
no_stdin
[ -f "$root/control/sync" ] && { echo "agents dir locked" >&2; exit 4; }
exit 0
`);
  for (const cli of ["tacit", "evolve", "sync-agents"]) chmodSync(join(home, "bin", cli), 0o755);
  const lines = (f: string) => (existsSync(join(root, "log", f)) ? readFileSync(join(root, "log", f), "utf8").split("\n").filter((l) => l !== "") : []);
  return {
    root, home,
    captures: () => lines("captures").map((l) => JSON.parse(l) as Record<string, unknown>),
    argv: () => lines("argv"),
    control: (name, on) => (on ? writeFileSync(join(root, "control", name), "") : rmSync(join(root, "control", name), { force: true })),
  };
}

/** Every file under `dir` with its size and mtime: what a write would change. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const s = statSync(join(dir, name));
    out[name] = `${s.size}:${s.mtimeMs}:${s.isDirectory() ? "d" : readFileSync(join(dir, name), "utf8")}`;
  }
  return out;
}

/** Flags any text with "SECRET" in it. */
const flagging: EgressScanner = {
  async scan(channel, content) {
    return content.includes("SECRET") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true };
  },
};

const WRITER = "github:1" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" };

async function harness(tacit?: TacitLedger) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const controller = new ControllerRole({
    store, sources: [source], forge, auth: new FakeAuth(), clock, config, log: silent, scanner: flagging, ...(tacit ? { tacit } : {}),
  });
  /** A work item in `patch`, whose `kind` run finished with `summary`. */
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch, summary: string | null = null, kind: "triage" | "review" = "triage"): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    if (summary !== null) {
      await store.enqueueRun({ work_item_id: item.id, kind, idempotency_key: `${kind}:${item.id}` });
      const run = (await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary, data: {} });
    }
    const now = (await store.getWorkItem(item.id))!;
    const r = await store.transition({ id: item.id, expected_version: now.version, actor: system, reason: "setup", patch: { ...patch, tier: 2 } });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  /** Hands the event to the controller, then lets outbound deliver what it wrote. */
  const send = async (e: SourceEvent) => {
    await controller.handleEvent(e);
    await controller.tickOutbox();
  };
  const captureRows = async () => (await driverOf(store).all("SELECT * FROM outbound_actions WHERE action = 'tacit_capture'"));
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  return { store, clock, source, controller, itemIn, send, captureRows, get };
}

const revise = (n: number, feedback: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "revise_requested", source: issueRef(n), comment_id, requester: alice, feedback });
const reject = (n: number, reason: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "spec_rejected", source: issueRef(n), comment_id, approver: alice, reason });
const verdict = (n: number, args: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "verdict_submitted", target: { kind: "issue", source: issueRef(n) }, comment_id, approver: alice, args });

describe("plugin none (the default)", () => {
  it("is the default on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) expect(defaultPlugins(platform).tacit).toBe("none");
  });

  it("captures nothing and enqueues no outbound intent", async () => {
    const none = await createPlugin(REGISTRY, "tacit", "none", {} as never);
    expect(none).toBeInstanceOf(NoTacitLedger);
    expect(none.enabled).toBe(false);
    expect(await none.pending()).toEqual([]);
    expect(await none.rules()).toEqual([]);
    await none.verdict("C-1", "promote", "why", RULE);
    for (const ledger of [none, undefined]) {
      const h = await harness(ledger);
      const it1 = await h.itemIn(issueRef(1), SPEC_PENDING, "the spec");
      await h.send(revise(1, "keep the flag"));
      expect((await h.get(it1)).version).toBeGreaterThan(it1.version);
      expect(await h.captureRows()).toEqual([]);
    }
  });
});

describe("plugin agents-home", () => {
  it("resolves its home from AGENTS_HOME, else ~/.agents", () => {
    expect(agentsHome({ AGENTS_HOME: "/x/agents" }, "/home/me")).toBe("/x/agents");
    expect(agentsHome({}, "/home/me")).toBe(join("/home/me", ".agents"));
    expect(agentsHome({ AGENTS_HOME: "  " }, "/home/me")).toBe(join("/home/me", ".agents"));
  });

  it("with no bin/tacit at the home path behaves as none, and building it does not fail", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sf-tacit-empty-"));
    const ledger = tacitLedgerAt({ AGENTS_HOME: empty });
    expect(ledger).toBeInstanceOf(NoTacitLedger);
    const h = await harness(ledger);
    await h.itemIn(issueRef(1), SPEC_PENDING, "the spec");
    await h.send(revise(1, "keep the flag"));
    expect(await h.captureRows()).toEqual([]);
    expect(readdirSync(empty)).toEqual([]);
  });

  it("finds the home only when bin/tacit and bin/evolve are both executable files; else it names the first missing one", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-tacit-detect-"));
    const at = join(root, "home");
    const check = () => checkAgentsHome({ AGENTS_HOME: at }, "/nowhere");
    expect(check()).toMatchObject({ path: at, missing: "bin/tacit" });
    mkdirSync(join(at, "bin"), { recursive: true });
    writeFileSync(join(at, "bin", "tacit"), "#!/bin/sh\n");
    expect(check().missing).toBe("bin/tacit"); // not executable
    chmodSync(join(at, "bin", "tacit"), 0o755);
    expect(check().missing).toBe("bin/evolve");
    mkdirSync(join(at, "bin", "evolve")); // a folder is no CLI
    expect(check().missing).toBe("bin/evolve");
    rmSync(join(at, "bin", "evolve"), { recursive: true });
    writeFileSync(join(at, "bin", "evolve"), "#!/bin/sh\n", { mode: 0o755 });
    expect(check()).toMatchObject({ path: at, missing: null });
    expect(tacitLedgerAt({ AGENTS_HOME: at }, "/nowhere")).toBeInstanceOf(AgentsHomeTacitLedger);
    // No AGENTS_HOME: ~/.agents under the given home.
    expect(checkAgentsHome({}, root)).toMatchObject({ path: join(root, ".agents"), missing: "bin/tacit" });
  });

  it("lists only the known homes, AGENTS_HOME when set and ~/.agents, each once, with its own check; the one in use stays AGENTS_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-tacit-homes-"));
    const at = join(root, "set");
    const dflt = join(root, ".agents");
    for (const h of [at, dflt]) mkdirSync(join(h, "bin"), { recursive: true });
    for (const f of ["tacit", "evolve"]) writeFileSync(join(dflt, "bin", f), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(at, "bin", "tacit"), "#!/bin/sh\n", { mode: 0o755 });
    expect(knownAgentsHomes({ AGENTS_HOME: at }, root)).toEqual([at, dflt]);
    expect(knownAgentsHomes({}, root)).toEqual([dflt]);
    expect(knownAgentsHomes({ AGENTS_HOME: dflt }, root)).toEqual([dflt]);
    // Both results of the check: the first missing file, or none.
    expect(checkAgentsHome({ AGENTS_HOME: at }, root)).toEqual({
      path: at, missing: "bin/evolve", homes: [{ path: at, missing: "bin/evolve" }, { path: dflt, missing: null }],
    });
    expect(checkAgentsHome({}, root)).toEqual({ path: dflt, missing: null, homes: [{ path: dflt, missing: null }] });
    // A passing ~/.agents does not stand in for a broken AGENTS_HOME: the ledger stays off.
    expect(tacitLedgerAt({ AGENTS_HOME: at }, root)).toBeInstanceOf(NoTacitLedger);
  });

  it("is built from the stub home AGENTS_HOME names", () => {
    const s = stubHome();
    expect(tacitLedgerAt({ AGENTS_HOME: s.home })).toBeInstanceOf(AgentsHomeTacitLedger);
  });

  it("a /revise, a /reject and a changes verdict each capture one record keyed by the comment ID; a redelivery adds none", async () => {
    const s = stubHome();
    const before = snapshot(s.home);
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    const a = await h.itemIn(issueRef(1), SPEC_PENDING, "spec of one");
    const b = await h.itemIn(issueRef(2), SPEC_PENDING, "spec of two");
    const c = await h.itemIn(issueRef(3), MERGE_PENDING, "review of three", "review");

    for (let round = 0; round < 2; round++) {
      await h.send(revise(1, "keep the existing CLI flag\nand its help text"));
      await h.send(reject(2, "out of scope: belongs in the UI"));
      await h.send(verdict(3, "changes minor rename it\nand split the test"));
    }

    expect(await h.get(b)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const empty = { root_reason: "", hypothesis: "", improvement: "", rule_draft: "" };
    expect(s.captures()).toEqual([
      { session: a.id, proposal: "spec of one", pushback: "keep the existing CLI flag\nand its help text", ...empty },
      { session: b.id, proposal: "spec of two", pushback: "out of scope: belongs in the UI", ...empty },
      { session: c.id, proposal: "review of three", pushback: "rename it\nand split the test", ...empty },
    ]);
    expect((await h.captureRows()).map((r) => r.intent_key)).toEqual([`tacit:${a.id}:c1`, `tacit:${b.id}:c2`, `tacit:${c.id}:c3`]);
    // The record goes on stdin; argv carries only the subcommand and the agent.
    expect(s.argv()).toEqual(Array(3).fill(`tacit|capture|--agent|${TACIT_AGENT}`));
    // A capture writes nothing under the home: only the stubs ran, and they wrote outside it.
    expect(snapshot(s.home)).toEqual(before);
  });

  it("an accept verdict and a refused command capture nothing", async () => {
    const s = stubHome();
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    await h.itemIn(issueRef(3), MERGE_PENDING, "review", "review");
    await h.send(verdict(3, "accept none"));
    // A /revise on a merge-pending item's issue is refused (it goes on the PR).
    await h.send(revise(3, "more"));
    expect(await h.captureRows()).toEqual([]);
    expect(s.captures()).toEqual([]);
  });

  it("a failing CLI leaves the command's result unchanged, holds only the ledger's destination, and is retried with backoff", async () => {
    const s = stubHome();
    s.control("fail", true);
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    const a = await h.itemIn(issueRef(1), SPEC_PENDING, "spec of one");
    await h.send(reject(1, "no"));
    expect(await h.get(a)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const [batch] = await driverOf(h.store).all("SELECT * FROM outbound_batches WHERE destination = 'tacit:ledger'");
    expect(batch).toMatchObject({ state: "failed", attempts: 1 });
    expect(String(batch!.last_error)).toContain("ledger locked");

    // GitHub keeps sending: the reject's close and comment, and a later refusal on another item.
    expect(h.source.closed).toEqual([a.source]);
    await h.itemIn(issueRef(2), SPEC_PENDING, "spec of two");
    await h.send({ kind: "retry_requested", source: issueRef(2), comment_id: "r2", requester: alice, note: "" });
    expect(h.source.comments.some((c) => c.marker === "<!-- factory:refused:r2 -->")).toBe(true);
    expect(s.captures()).toEqual([]);

    // Not before its backoff; then once.
    s.control("fail", false);
    await h.controller.tickOutbox();
    expect(s.captures()).toEqual([]);
    h.clock.advance(config.retry_max_ms);
    await h.controller.tickOutbox();
    await h.controller.tickOutbox();
    expect(s.captures().map((r) => r.pushback)).toEqual(["no"]);
  });

  it("a CLI call that runs past its timeout is stopped and fails", async () => {
    expect(TACIT_CLI_TIMEOUT_MS).toBe(30_000);
    const s = stubHome();
    s.control("sleep", true);
    const ledger = new AgentsHomeTacitLedger(s.home, 200);
    const started = Date.now();
    await expect(ledger.capture({ session: "w", proposal: "p", pushback: "x" })).rejects.toThrow(/stopped after 200 ms/);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(s.captures()).toEqual([]);
  });

  it("pushback text passes the egress scanner first: a flagged text is replaced by the notice naming the rules", async () => {
    const s = stubHome();
    const h = await harness(new AgentsHomeTacitLedger(s.home));
    const c = await h.itemIn(issueRef(3), MERGE_PENDING, "review of three", "review");
    await h.send(verdict(3, "changes major the token SECRET-123 leaked"));
    expect(s.captures()).toEqual([expect.objectContaining({ session: c.id, proposal: "review of three" })]);
    const pushback = String(s.captures()[0]!.pushback);
    expect(pushback).not.toContain("SECRET");
    expect(pushback).toContain("test_rule");
  });

  it("the stubs refuse any form the real CLIs do not take, with usage text", () => {
    const s = stubHome();
    const run = (cli: string, args: string[]) => {
      try {
        execFileSync(join(s.home, "bin", cli), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return "ok";
      } catch (err) {
        const e = err as { status: number; stderr: string };
        return `${e.status}: ${e.stderr.trim()}`;
      }
    };
    for (const args of [["list", "--agent", TACIT_AGENT, "--state", "pending", "--json"], ["verdict", "--agent", TACIT_AGENT], ["verdict", "P-1", "hold", "--reason", "r"], ["capture"]]) {
      expect(run("tacit", args)).toMatch(/^2: usage: tacit/);
    }
    for (const args of [["verdict", "--agent", TACIT_AGENT], ["verdict", "P-1", "retire", "--reason", "r"], ["verdict", "P-1", "promote", "--reason", "r", "--rule", "x"], ["pending", "--json"]]) {
      expect(run("evolve", args)).toMatch(/^2: usage: evolve/);
    }
    expect(run("tacit", ["verdict", "C-1", "retire", "--reason", "r"])).toBe("ok");
  });

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

describe("plugin agents-home: pushbacks and dismiss", () => {
  it("pushbacks reads tacit show --active --unclustered: each row's ID, words and date; it writes nothing", async () => {
    const s = stubHome();
    writeFileSync(join(s.root, "pushbacks"), '# active, unclustered 2\n- T-0201 2026-11-20 — "keep the --json flag"\n- T-0202 — “두 줄 요약 먼저”\n');
    const before = snapshot(s.home);
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.pushbacks()).toEqual([
      { id: "T-0201", pushback: "keep the --json flag", date: "2026-11-20" },
      { id: "T-0202", pushback: "두 줄 요약 먼저" },
    ]);
    expect(s.argv()).toEqual(["tacit|show|--active|--unclustered"]);
    expect(snapshot(s.home)).toEqual(before);
    rmSync(join(s.root, "pushbacks"));
    expect(await ledger.pushbacks()).toEqual([]);
  });

  it("text in another form, or a failed CLI, throws", async () => {
    expect(() => parsePushbacks('{"id":"T-1","pushback":"x"}\n')).toThrow(/no pushback row/);
    expect(parsePushbacks("# none\n\n")).toEqual([]);
    const s = stubHome();
    s.control("fail", true);
    await expect(new AgentsHomeTacitLedger(s.home).pushbacks()).rejects.toThrow(/^tacit show exited 3: ledger locked$/);
  });

  it("dismiss runs tacit status <T-id> noise, each value its own argv item; any other ID throws before a CLI runs", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    await ledger.dismiss("T-0201");
    expect(s.argv()).toEqual(["tacit|status|T-0201|noise"]);
    await expect(ledger.dismiss("C-012")).rejects.toBeInstanceOf(TacitRefusal);
    await expect(ledger.dismiss("T-1; touch pwned")).rejects.toBeInstanceOf(TacitRefusal);
    expect(s.argv()).toEqual(["tacit|status|T-0201|noise"]);
    s.control("refuse", true);
    await expect(ledger.dismiss("T-0201")).rejects.toThrow(/^tacit status exited 1: ledger locked$/);
  });
});

/** The stub's `--help` output. */
function execHelp(file: string): string {
  return execFileSync(file, ["--help"], { encoding: "utf8" });
}

/** The SQL driver under a SQL store: where outbound keeps its actions and batches. */
function driverOf(store: unknown): SqlDriver {
  return (store as { db: SqlDriver }).db;
}

// The skill hand-off (design 07-self-improvement): with the ledger on, each skill draft stored `proposed` and each
// verdict the store accepts on it also go to the ledger, after the store holds them. No draft carries an owner label
// yet, so an improve run stores a gaining draft `tried` (untrusted) and hands nothing; `propose` sets it proposed. A fake ledger records the calls
// and can be told to throw; the model, the scratch run and the skill files are fakes: no CLI, no model.
describe("the skill hand-off (src/core/skill-improve.ts)", () => {
  const SKILL = "skills/a";
  const OWNER = "local:owner" as UserId;

  /** A ledger that records each hand-off and throws on each when `fail` is set. */
  function fakeLedger(o: { enabled?: boolean; fail?: boolean } = {}) {
    const proposals: TacitChangeProposal[] = [];
    const verdicts: TacitVerdictRecord[] = [];
    const tacit: TacitHandOff = {
      enabled: o.enabled ?? true,
      changeProposal: async (p) => { proposals.push(p); if (o.fail) throw new Error("ledger locked"); },
      verdictRecord: async (v) => { verdicts.push(v); if (o.fail) throw new Error("ledger locked"); },
    };
    const warns: { msg: string; fields: LogFields | undefined }[] = [];
    const log: Logger = { info() {}, error() {}, warn: (msg, fields) => void warns.push({ msg, fields }) };
    return { tacit, log, proposals, verdicts, warns };
  }

  /** A store with skills/a's score dropped (0.8 → 0.5 on v:SKILL A); the scratch run scores `scratchRate`. */
  async function dropped(scratchRate = 1) {
    const { store, clock } = await newStore();
    clock.set("2026-11-24T10:00:00.000Z");
    const files = new Map([["/repo/skills/a", "SKILL A"]]);
    const measured = async (id: string, version: string, rate: number, failed: string[] = []) => {
      clock.advance(1000);
      await store.createSkillEvalSuite({ id: `suite:${SKILL}`, skill_ref: SKILL, title: SKILL, created_by: OWNER });
      await store.startSkillEvalRun({ id, suite_id: `suite:${SKILL}`, created_by: OWNER, skill_version: version });
      await store.recordSkillEvalReplay({ run_id: id, case_id: "c1", verdict: "fail", detail: { answers: failed.map((check) => ({ check, answer: "no", reason: "r" })) } });
      await store.finishSkillEvalRun(id, "failed");
      await store.recordSkillEvalRunFigures(id, { model_class: "standard", judge_model_class: "strong", replays: 1, pass_rate: rate, errored: 0 });
      return (await store.getSkillEvalRun(id))!;
    };
    await measured("r1", "v:SKILL A", 0.8);
    await measured("r2", "v:SKILL A", 0.5, ["cites the source"]);
    const wiring: SkillImproveWiring = {
      config: SKILL_IMPROVE_DEFAULTS, skill_folders: ["/repo/skills"], folderOf: (ref) => `/repo/${ref}`, prompt: async () => "PROMPT",
      readSkill: async (f) => files.get(f) ?? null, writeSkill: async (f, t) => void files.set(f, t), version: async (f) => `v:${files.get(f)}`,
      newId: () => "scratch1", scratch: async (r) => measured(r.run_id, r.skill_version, scratchRate), rerun: async () => null,
    };
    const llm: LLMProvider = { complete: async () => ({ text: "NEW SKILL TEXT", stop_reason: "end", usage: { input_tokens: 50, output_tokens: 50, cost_usd: null } }) };
    const deps = { store, scanner: cleanScanner, llm, clock, wiring, signal: new AbortController().signal };
    const id = skillDraftId("local:p", SKILL, "v:SKILL A");
    return { store, deps, files, id, vd: { store, wiring, signal: deps.signal } };
  }

  /** The drafted skill's draft set proposed, as an owner label would let it be stored (none exists yet). */
  async function propose(s: Awaited<ReturnType<typeof dropped>>) {
    expect(await s.store.setSkillDraftState(s.id, "tried", "proposed")).toBe(true);
  }

  /** Each draft row and the verdicts' results, run once with `ledger` (absent: the plugin off). */
  async function judged(ledger?: SkillLedger) {
    const s = await dropped();
    const drafted = await improveSkills({ ...s.deps, ...(ledger ? { ledger } : {}) }, "local:p");
    await propose(s);
    const proposed = await s.store.getSkillDraft(s.id);
    const held = await holdSkillDraft(s.store, s.id, ledger);
    const promoted = await promoteSkillDraft(s.vd, s.id, OWNER, ledger);
    const again = await rejectSkillDraft(s.store, s.id, ledger);
    return { drafted, proposed, held, promoted, again, file: s.files.get("/repo/skills/a") };
  }

  it("with the ledger on, a gaining draft with no owner label is stored tried untrusted and is not handed off", async () => {
    const s = await dropped();
    const l = fakeLedger();
    expect(await improveSkills({ ...s.deps, ledger: l }, "local:p")).toEqual([expect.objectContaining({ draft: expect.objectContaining({ state: "tried", reason: "untrusted" }) })]);
    await improveSkills({ ...s.deps, ledger: l }, "local:p");
    expect((await s.store.getSkillDraft(s.id))?.state).toBe("tried");
    expect(l.proposals).toEqual([]);
    expect(l.verdicts).toEqual([]);
  });

  it("a draft that is not proposed (tried) is not handed off", async () => {
    const s = await dropped(0.5);
    const l = fakeLedger();
    expect(await improveSkills({ ...s.deps, ledger: l }, "local:p")).toEqual([expect.objectContaining({ draft: expect.objectContaining({ state: "tried" }) })]);
    expect(l.proposals).toEqual([]);
  });

  it("each hold, reject or promote the store accepts is recorded; a refused verdict sends nothing", async () => {
    const s = await dropped();
    const l = fakeLedger();
    await improveSkills({ ...s.deps, ledger: l }, "local:p");
    await propose(s);
    expect(await holdSkillDraft(s.store, s.id, l)).toEqual({ draft: expect.objectContaining({ state: "held" }) });
    expect(await holdSkillDraft(s.store, s.id, l)).toEqual({ refused: expect.any(String) });
    expect(await promoteSkillDraft(s.vd, s.id, OWNER, l)).toEqual({ draft: expect.objectContaining({ state: "promoted" }) });
    expect(await rejectSkillDraft(s.store, s.id, l)).toEqual({ refused: expect.any(String) });
    expect(await promoteSkillDraft(s.vd, s.id, OWNER, l)).toEqual({ refused: expect.any(String) });
    expect(await holdSkillDraft(s.store, "skd_none", l)).toEqual({ refused: expect.any(String) });
    expect(l.verdicts.map((v) => [v.id, v.decision, v.target])).toEqual([[s.id, "hold", "skills/a/SKILL.md"], [s.id, "promote", "skills/a/SKILL.md"]]);

    const r = await dropped();
    const lr = fakeLedger();
    await improveSkills({ ...r.deps, ledger: lr }, "local:p");
    await propose(r);
    await rejectSkillDraft(r.store, r.id, lr);
    expect(lr.verdicts.map((v) => v.decision)).toEqual(["reject"]);
  });

  it("a draft stored held past its token budget was never proposed: a verdict on it sends nothing", async () => {
    const s = await dropped();
    const l = fakeLedger();
    await improveSkills({ ...s.deps, wiring: { ...s.deps.wiring, config: { ...SKILL_IMPROVE_DEFAULTS, skill_draft_token_budget: 10 } }, ledger: l }, "local:p");
    expect(await rejectSkillDraft(s.store, s.id, l)).toEqual({ draft: expect.objectContaining({ state: "rejected" }) });
    expect(l.proposals).toEqual([]);
    expect(l.verdicts).toEqual([]);
  });

  it("with the ledger off (the none plugin, or enabled false) no call is made and the draft and verdicts are as with no ledger", async () => {
    const off = fakeLedger({ enabled: false });
    const none = new NoTacitLedger();
    const without = await judged();
    expect(without.proposed?.state).toBe("proposed");
    expect(await judged({ tacit: off.tacit, log: off.log })).toEqual(without);
    expect(await judged({ tacit: none, log: off.log })).toEqual(without);
    expect([off.proposals, off.verdicts, off.warns]).toEqual([[], [], []]);
  });

  it("withHandOff: enabled comes from the holder, and each method goes to the plugin the holder last built", async () => {
    const built: string[] = [];
    const plugin = (name: string): TacitLedger => Object.assign(new NoTacitLedger(), name === "on" ? { verdictRecord: async (v: TacitVerdictRecord) => void built.push(`${name}:${v.id}`) } : {});
    const holder = { enabled: false, build: undefined as undefined | ((n: string) => Promise<TacitLedger>) };
    const { handOff } = await withHandOff(async (build) => (await build("off"), Object.assign(holder, { build })), async (n) => plugin(n));
    expect(handOff.enabled).toBe(false);
    await handOff.verdictRecord!({ id: "skd_1", decision: "hold", target: "t", reason: "r" });
    await holder.build!("on");
    holder.enabled = true;
    expect(handOff.enabled).toBe(true);
    await handOff.verdictRecord!({ id: "skd_2", decision: "hold", target: "t", reason: "r" });
    await handOff.changeProposal!({ id: "skd_2", target: "t", title: "t", rationale: "r", change: "c" });
    expect(built).toEqual(["on:skd_2"]);
  });

  it("a ledger failure is logged and changes neither the stored draft nor any verdict's result", async () => {
    const without = await judged();
    const l = fakeLedger({ fail: true });
    expect(await judged({ tacit: l.tacit, log: l.log })).toEqual(without);
    expect(l.proposals).toEqual([]);
    expect(l.verdicts.map((v) => v.decision)).toEqual(["hold", "promote"]);
    expect(l.warns.map((w) => w.fields?.record)).toEqual(["hold", "promote"]);
    expect(l.warns.every((w) => w.fields?.error === "ledger locked")).toBe(true);
  });
});
