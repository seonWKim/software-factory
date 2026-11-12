import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { AgentsHomeTacitLedger, TACIT_AGENT, TACIT_CLI_TIMEOUT_MS, agentsHome, tacitLedgerAt } from "../src/impl/tacit/agents-home-tacit-ledger.js";
import { parsePending } from "../src/impl/tacit/ledger-text.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import { REGISTRY, createPlugin, defaultPlugins } from "../src/plugins.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import type { TacitLedger } from "../src/interfaces/tacit-ledger.js";
import type { SqlDriver } from "../src/state/index.js";
import { FakeAuth, FakeForge, FakeSource, alice, config, issueRef, silent } from "./helpers/fakes.js";
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

/**
 * A temp agents home with stub `bin/tacit` and `bin/evolve` that take only the real CLIs' forms (checked 2026-11-12
 * with `--help`) and exit 2 with usage text on any other. The stubs log each call's argv, one item per field, to
 * `<root>/log/argv`, outside the home, and read `<root>/control/{fail,sleep}`, so the home itself is never written.
 * Only capture reads stdin; any other call that gets stdin fails.
 */
function stubHome(): { root: string; home: string; captures: () => Record<string, unknown>[]; argv: () => string[]; control: (name: "fail" | "sleep", on: boolean) => void } {
  const root = mkdtempSync(join(tmpdir(), "sf-tacit-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(root, "log"));
  mkdirSync(join(root, "control"));
  const prelude = (usage: string) => `#!/bin/sh
root="$(cd "$(dirname "$0")/../.." && pwd)"
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '|%s' "$a"; done; echo; } >> "$root/log/argv"
usage() { echo "${usage}" >&2; exit 2; }
no_stdin() { [ -z "$(cat)" ] || { echo "unexpected stdin" >&2; exit 4; }; }
`;
  writeFileSync(join(home, "bin", "tacit"), `${prelude("usage: tacit {capture --agent <name> | verdict <class> {hold,promote,reject,retire} --reason <reason> [--rule <rule text>] [--encoded-to <file>]}")}
case "$1" in
  --help)
    echo "usage: tacit <command> [options]"
    echo "commands:"
    echo "  capture --agent <name>  read one record as JSON on stdin"
    echo "  verdict <class> {hold,promote,reject,retire} --reason <reason> [--rule <rule text>] [--encoded-to <file>]"
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
    shift 5
    while [ "$#" -gt 0 ]; do
      case "$1" in --rule|--encoded-to) [ "$#" -ge 2 ] || usage; shift 2 ;; *) usage ;; esac
    done
    no_stdin
    ;;
  *) usage ;;
esac
`);
  writeFileSync(join(home, "bin", "evolve"), `${prelude("usage: evolve {pending | verdict <id> {hold,promote,reject} --reason <reason> [--applied-to <file>]}")}
case "$1" in
  --help)
    echo "usage: evolve <command> [options]"
    echo "commands:"
    echo "  pending  list what waits for a verdict"
    echo "  verdict <id> {hold,promote,reject} --reason <reason> [--applied-to <file>]"
    ;;
  pending)
    [ "$#" -eq 1 ] || usage
    no_stdin
    printf '%s' '${PENDING_SAMPLE}'
    ;;
  verdict)
    [ "$#" -ge 5 ] && [ "$4" = "--reason" ] || usage
    case "$2" in P-*) ;; *) usage ;; esac
    case "$3" in hold|promote|reject) ;; *) usage ;; esac
    shift 5
    while [ "$#" -gt 0 ]; do
      case "$1" in --applied-to) [ "$#" -ge 2 ] || usage; shift 2 ;; *) usage ;; esac
    done
    no_stdin
    ;;
  *) usage ;;
esac
`);
  for (const cli of ["tacit", "evolve"]) chmodSync(join(home, "bin", cli), 0o755);
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
    await none.verdict("C-1", "promote", "why", "rule");
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
    // The factory never writes under the home: only the stubs ran, and they wrote outside it.
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

  it("pending runs evolve pending and reads its text: one entry per row with its ID, title and state", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    expect(await ledger.pending()).toEqual([
      { id: "P-0007", title: "Keep the flag", state: "open" },
      { id: "C-012", title: "keep existing CLI flags", state: "pending" },
    ]);
    expect(s.argv()).toEqual(["evolve|pending"]);
  });

  it("the pending text: open and held proposals, pending and held classes; rows under any other heading are skipped", () => {
    expect(parsePending(PENDING_SAMPLE)).toEqual([
      { id: "P-0007", title: "Keep the flag", state: "open" },
      { id: "C-012", title: "keep existing CLI flags", state: "pending" },
    ]);
    const text = [
      "## proposals (open) 0", "## proposals (held) 1", "- P-0003 [prompt] prompts/review.md — Ask for tests first",
      "## tacit Pending 0", "## tacit Held 1", "- C-004 name the flag in the spec", "## stats", "- C-009 not an entry",
    ].join("\n");
    expect(parsePending(text)).toEqual([
      { id: "P-0003", title: "Ask for tests first", state: "held" },
      { id: "C-004", title: "name the flag in the spec", state: "held" },
    ]);
  });

  it("a verdict on a C- ID runs tacit verdict, with --rule on promote only; each value is its own argv item, no shell", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    const reason = "seen twice; $(touch pwned) `id`";
    await ledger.verdict("C-012", "promote", reason, "Keep every existing CLI flag.");
    await ledger.verdict("C-013", "retire", "no longer true", "ignored");
    await ledger.verdict("C-014", "hold", "wait");
    expect(s.argv()).toEqual([
      `tacit|verdict|C-012|promote|--reason|${reason}|--rule|Keep every existing CLI flag.`,
      "tacit|verdict|C-013|retire|--reason|no longer true",
      "tacit|verdict|C-014|hold|--reason|wait",
    ]);
    expect(existsSync(join(s.home, "pwned"))).toBe(false);
  });

  it("a verdict on a P- ID runs evolve verdict with no --rule; an ID that is neither throws before any CLI runs", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    await ledger.verdict("P-0007", "promote", "good shape", "dropped");
    await ledger.verdict("P-0008", "reject", "not now");
    expect(s.argv()).toEqual(["evolve|verdict|P-0007|promote|--reason|good shape", "evolve|verdict|P-0008|reject|--reason|not now"]);
    await expect(ledger.verdict("t1", "promote", "x")).rejects.toThrow(/neither a class \(C-\) nor a proposal \(P-\)/);
    await expect(ledger.verdict("P-0007", "retire", "x")).rejects.toThrow(/takes no retire/);
    expect(s.argv()).toHaveLength(2);
  });

  it("a CLI that exits non-zero throws with the CLI and subcommand first", async () => {
    const s = stubHome();
    const ledger = new AgentsHomeTacitLedger(s.home);
    writeFileSync(join(s.home, "bin", "evolve"), "#!/bin/sh\necho 'ledger locked' >&2\nexit 5\n");
    await expect(ledger.pending()).rejects.toThrow(/^evolve pending exited 5: ledger locked$/);
    await expect(ledger.verdict("P-1", "hold", "x")).rejects.toThrow(/^evolve verdict exited 5: ledger locked$/);
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

  it("pending and verdict call subcommands the CLIs' --help names, and never write under the home", async () => {
    const s = stubHome();
    const before = snapshot(s.home);
    const help = (cli: string) => [...execHelp(join(s.home, "bin", cli)).matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]);
    const ledger = new AgentsHomeTacitLedger(s.home);
    await ledger.pending();
    await ledger.verdict("C-012", "promote", "r", "rule");
    await ledger.verdict("P-0007", "hold", "r");
    const used = s.argv().filter((l) => !l.endsWith("--help")).map((l) => l.split("|").slice(0, 2).join(" "));
    expect(used).toEqual(["evolve pending", "tacit verdict", "evolve verdict"]);
    expect(help("tacit")).toEqual(expect.arrayContaining(["capture", "verdict"]));
    expect(help("evolve")).toEqual(expect.arrayContaining(["pending", "verdict"]));
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

/** The stub's `--help` output. */
function execHelp(file: string): string {
  return execFileSync(file, ["--help"], { encoding: "utf8" });
}

/** The SQL driver under a SQL store: where outbound keeps its actions and batches. */
function driverOf(store: unknown): SqlDriver {
  return (store as { db: SqlDriver }).db;
}
