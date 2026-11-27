import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../../src/core/types.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { SourceEvent } from "../../src/interfaces/source-adapter.js";
import { type TacitLedger, type TacitPromotion } from "../../src/interfaces/tacit-ledger.js";
import type { SqlDriver } from "../../src/state/index.js";
import { FakeAuth } from "./fakes/runner.js";
import { FakeForge } from "./fakes/forge.js";
import { FakeSource } from "./fakes/source.js";
import { alice, config, issueRef, silent } from "./fakes/config.js";
import { PROJECT_KEY, newStore, system, w1 } from "./store.js";


// The owner's tacit ledger (issue #570): a /revise, a /reject and a `changes` verdict each capture one record, keyed
// by the command's comment ID, through an outbound intent that runs <home>/bin/tacit. Every test runs against a temp
// home with stub CLIs: no real home, no network, no live CLI.

/** `evolve pending` as the owner's CLI prints it (checked 2026-11-12): text, not JSON. */
export const PENDING_SAMPLE = `## proposals (open) 1
- P-0007 [spec] src/core/foo.ts — Keep the flag
## proposals (held) 0
## tacit Pending 1
- C-012 keep existing CLI flags
## tacit Held 0
`;

/** `evolve show C-012` in the owner's sample form (2026-11-13): heading, incidents, draft, scope, then the sections. */
export const SHOW_SAMPLE = `### C-012 keep existing CLI flags
- 인시던트: T-0101, T-0102
- 초안: 기본값: Keep every existing CLI flag. / 예외: a flag the owner marked deprecated
- 범위: software, CLI

# incidents
- T-0101 renamed --out
# verdicts
`;

/** The owner's rules file before a promote: one rule, then the heading a new block goes before. */
export const RULES_SAMPLE = `# Rules

## C-001 summary first
- 기본값: Open with a one-line summary.
- 예외 (이럴 땐 override): none
- 근거: 인시던트 T-0001 / 판정일 2026-11-01
- 범위: 전역

## 다른 곳에 인코딩된 규칙
- C-009 → CLAUDE.md
`;

/** The owner's rule as the dialog sends it. */
export const RULE: TacitPromotion = { wording: "keep CLI flags", default: "Keep every flag.", exception: "a deprecated flag" };

/** A fixed today for the judged date. */
export const TODAY = { now: () => new Date(2026, 10, 13, 9, 30) };

/** `evolve show C-012` in the form the parser reads (docs/plugins/tacit-ledger.md; assumed, not checked against the real CLI). */
export const DETAIL_SAMPLE = `# C-012 keep existing CLI flags
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
export const SHOW_JSON = `${JSON.stringify({
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
export function stubHome(): {
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
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const s = statSync(join(dir, name));
    out[name] = `${s.size}:${s.mtimeMs}:${s.isDirectory() ? "d" : readFileSync(join(dir, name), "utf8")}`;
  }
  return out;
}

/** Flags any text with "SECRET" in it. */
export const flagging: EgressScanner = {
  async scan(channel, content) {
    return content.includes("SECRET") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true };
  },
};

export const WRITER = "github:1" as UserId;
export const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
export const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" };

export async function harness(tacit?: TacitLedger) {
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

export const revise = (n: number, feedback: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "revise_requested", source: issueRef(n), comment_id, requester: alice, feedback });
export const reject = (n: number, reason: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "spec_rejected", source: issueRef(n), comment_id, approver: alice, reason });
export const verdict = (n: number, args: string, comment_id = `c${n}`): SourceEvent =>
  ({ kind: "verdict_submitted", target: { kind: "issue", source: issueRef(n) }, comment_id, approver: alice, args });

/** The stub's `--help` output. */
export function execHelp(file: string): string {
  return execFileSync(file, ["--help"], { encoding: "utf8" });
}

/** The SQL driver under a SQL store: where outbound keeps its actions and batches. */
export function driverOf(store: unknown): SqlDriver {
  return (store as { db: SqlDriver }).db;
}
