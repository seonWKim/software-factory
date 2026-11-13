// The owner's ledger in their agents home (issue #570): `<home>/bin/tacit` and `<home>/bin/evolve`, found from
// AGENTS_HOME, else ~/.agents. The factory runs these CLIs, each stopped after 30 seconds. One of its two writes under the
// home is a promote of a class: the rule's block goes into `<home>/private/tacit/rules.md` (its resolved path inside
// the resolved home), then `tacit verdict … --encoded-to private/tacit/rules.md` runs (the block is removed again if
// it fails), then `<home>/bin/sync-agents`. Each value is its own argv item and nothing goes through a shell; only a
// captured record goes on stdin (as JSON). The forms are the owner's real CLIs (checked 2026-11-12, `evolve show`
// 2026-11-13); they print text, read in ledger-text.ts. A retire of a class is the other write: its block leaves the
// rules file, then `tacit verdict <id> retire` runs (the file is put back if it fails), then `sync-agents`. Factory
// processes only: an agent run never gets it.

import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  type TacitApplied, type TacitDecision, type TacitDraft, type TacitEntryDetail, type TacitLedger, type TacitPendingEntry, type TacitPromotion,
  type TacitPushback, type TacitRetired, type TacitRule, TacitRefusal, TacitSyncFailed, tacitIdKind,
} from "../../interfaces/tacit-ledger.js";
import { SystemClock } from "../clock/system-clock.js";
import { baseEnv, runProcess } from "../process/run-process.js";
import {
  ENCODED_ELSEWHERE_HEADING, hasEncodedElsewhere, hasRuleHeading, parseDraft, parseApplied, parsePending, parseRules, parseShow, withRuleBlock,
  withoutRuleBlock,
} from "./ledger-text.js";
import { NoTacitLedger } from "./no-tacit-ledger.js";

/** The owner's rules file, relative to the home: the one file the factory writes there (promote and retire), and the verdict's `--encoded-to`. */
export const RULES_FILE = "private/tacit/rules.md";
/** The ledger's own records, one JSON object per line; only read. */
const LEDGER_FILE = "private/tacit/ledger.jsonl";
/** The view `evolve pending` reads, rebuilt by the daily brief: a verdict newer than it is not in the view yet. */
const CANDIDATES_FILE = "private/tacit/rule-candidates.md";

/** How long one CLI call may take before it is stopped and counted as a failure. */
export const TACIT_CLI_TIMEOUT_MS = 30_000;

/** The name the factory captures under (`--agent`). */
export const TACIT_AGENT = "software-factory";

/** The agents home: AGENTS_HOME when set, else `~/.agents`. */
export function agentsHome(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string {
  const set = env.AGENTS_HOME?.trim();
  return set ? set : join(home, ".agents");
}

/** The two CLIs a home must hold, as executable files. */
export const AGENTS_HOME_CLIS = ["bin/tacit", "bin/evolve"] as const;

/** The agents home `env` names, and the first of its CLIs that is missing or not executable (null: the home is found). */
export function checkAgentsHome(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): { path: string; missing: string | null } {
  const path = agentsHome(env, home);
  return { path, missing: AGENTS_HOME_CLIS.find((f) => !isRunnable(join(path, f))) ?? null };
}

/** The ledger at the agents home `env` names; with either CLI missing there, no ledger (as `none`), and startup goes on. */
export function tacitLedgerAt(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): TacitLedger {
  const found = checkAgentsHome(env, home);
  return found.missing === null ? new AgentsHomeTacitLedger(found.path) : new NoTacitLedger();
}

/** Which CLI judges `id`; throws, before any CLI runs, for an ID that is neither a class nor a proposal. */
function kindOf(id: string): "class" | "proposal" {
  const kind = tacitIdKind(id);
  if (kind === null) throw new Error(`"${id}" is neither a class (C-) nor a proposal (P-) ID`);
  return kind;
}

export class AgentsHomeTacitLedger implements TacitLedger {
  readonly enabled = true;

  constructor(
    private readonly home: string,
    private readonly timeout_ms: number = TACIT_CLI_TIMEOUT_MS,
    /** Today, for a promoted rule's judged date (a Clock's `now`). */
    private readonly clock: { now(): Date } = new SystemClock(),
  ) {}

  async capture(p: TacitPushback): Promise<void> {
    const record = { session: p.session, proposal: p.proposal, pushback: p.pushback, root_reason: "", hypothesis: "", improvement: "", rule_draft: "" };
    await this.run("tacit", ["capture", "--agent", TACIT_AGENT], JSON.stringify(record));
  }

  /**
   * `evolve pending`: the open and held proposals and the pending and held classes. An entry with a ledger verdict
   * newer than the view is judged; each other class gets its draft from `evolve show`, or why it could not.
   */
  async pending(): Promise<readonly TacitPendingEntry[]> {
    const entries = parsePending(await this.run("evolve", ["pending"]));
    const judged = this.judged();
    return Promise.all(entries.map(async (e): Promise<TacitPendingEntry> => {
      const decision = judged.get(e.id);
      if (decision !== undefined) return { ...e, judged: decision };
      if (tacitIdKind(e.id) !== "class") return e;
      try {
        return { ...e, draft: await this.draft(e.id) };
      } catch (err) {
        return { ...e, draft_error: err instanceof Error ? err.message : String(err) };
      }
    }));
  }

  /** `evolve show <id>`: one entry's detail; null when it prints nothing. An ID that is neither C- nor P- throws first. */
  async show(id: string): Promise<TacitEntryDetail | null> {
    kindOf(id);
    return parseShow(id, await this.run("evolve", ["show", id]));
  }

  /**
   * `tacit verdict` for a class, `evolve verdict` for a proposal (never a rule). Promote of a class encodes `rule`
   * first (`promote`); retire of a class removes its block first (`retire`).
   */
  async verdict(id: string, decision: TacitDecision, reason: string, rule?: TacitPromotion): Promise<void> {
    const kind = kindOf(id);
    if (kind === "proposal" && decision === "retire") throw new Error(`evolve verdict takes no retire: "${id}" is a proposal`);
    if (kind === "class" && decision === "promote") return this.promote(id, reason, rule);
    if (kind === "class" && decision === "retire") return this.retire(id, reason);
    await this.run(kind === "class" ? "tacit" : "evolve", ["verdict", id, decision, "--reason", reason]);
  }

  /**
   * Promote of a class, as the owner does it by hand. Checks first, with nothing written and no CLI run on a refusal:
   * the rules file's resolved path lies inside the resolved home, the class has no `## <id>` heading there yet, the
   * `## 다른 곳에 인코딩된 규칙` heading is there and `bin/sync-agents` is executable; then the draft is read. Then
   * the block is written, the verdict sent (a failure puts the file back byte for byte) and `sync-agents` run (a
   * failure keeps the block: the verdict is recorded).
   */
  private async promote(id: string, reason: string, rule: TacitPromotion | undefined): Promise<void> {
    if (rule === undefined) throw new TacitRefusal(`promote of ${id} needs the rule's wording, default and exception`);
    const file = this.rulesFile();
    const before = readFileSync(file);
    const text = before.toString("utf8");
    if (hasRuleHeading(text, id)) throw new TacitRefusal(`${id} is already in ${RULES_FILE}: nothing written`);
    if (!hasEncodedElsewhere(text)) throw new TacitRefusal(`${RULES_FILE} has no "${ENCODED_ELSEWHERE_HEADING}" heading: nothing written`);
    if (!this.runnable("bin/sync-agents")) throw new TacitRefusal("bin/sync-agents is missing or not executable in the agents home: nothing written");
    const draft = await this.draft(id);
    const after = withRuleBlock(text, id, rule, draft, localDate(this.clock.now()))!;
    await this.rewrite(file, before, after, ["verdict", id, "promote", "--reason", reason, "--rule", rule.wording, "--encoded-to", RULES_FILE]);
  }

  /**
   * Retire of a class. Checks first, with nothing written and no CLI run on a refusal: the rules file's resolved path
   * lies inside the resolved home and it has a `## <id>` block. Then the block is removed, the verdict sent (a failure
   * puts the file back byte for byte) and `sync-agents` run (a failure keeps the removal: the verdict is recorded).
   */
  private async retire(id: string, reason: string): Promise<void> {
    const file = this.rulesFile();
    const before = readFileSync(file);
    const after = withoutRuleBlock(before.toString("utf8"), id);
    if (after === null) throw new TacitRefusal(`${id} has no block in ${RULES_FILE}: nothing written`);
    await this.rewrite(file, before, after, ["verdict", id, "retire", "--reason", reason]);
  }

  /**
   * Writes `after` to the rules file, then runs `tacit <args>`: a failure writes `before` back byte for byte and
   * throws. Then `sync-agents`: a failure keeps `after` (the verdict is recorded) and throws `TacitSyncFailed`.
   */
  private async rewrite(file: string, before: Buffer, after: string, args: readonly string[]): Promise<void> {
    writeFileSync(file, after);
    try {
      await this.run("tacit", args);
    } catch (err) {
      writeFileSync(file, before);
      throw err;
    }
    try {
      await this.run("sync-agents", []);
    } catch (err) {
      throw new TacitSyncFailed(err instanceof Error ? err.message : String(err));
    }
  }

  /** The rules file's resolved path, refused when it is missing or resolves outside the resolved home. */
  private rulesFile(): string {
    let file: string;
    try {
      file = realpathSync(join(this.home, RULES_FILE));
    } catch {
      throw new TacitRefusal(`no ${RULES_FILE} in the agents home: nothing written`);
    }
    if (!file.startsWith(realpathSync(this.home) + sep) || !statSync(file).isFile()) {
      throw new TacitRefusal(`${RULES_FILE} resolves outside the agents home: nothing written`);
    }
    return file;
  }

  /** `evolve show <id>` read as a draft; a CLI failure or a missing part is a refusal. */
  private async draft(id: string): Promise<TacitDraft> {
    let text: string;
    try {
      text = await this.run("evolve", ["show", id]);
    } catch (err) {
      throw new TacitRefusal(`the draft of ${id} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    const draft = parseDraft(id, text);
    if (typeof draft === "string") throw new TacitRefusal(`the draft of ${id} (evolve show) has ${draft}: nothing written`);
    return draft;
  }

  /**
   * Each entry with a ledger verdict (`type: "verdict"`) newer than the pending view's file, and that verdict's
   * decision (the newest wins). No view file or no ledger file: none.
   */
  private judged(): Map<string, string> {
    let since: number;
    try {
      since = statSync(join(this.home, CANDIDATES_FILE)).mtimeMs;
    } catch {
      return new Map();
    }
    return new Map([...newestVerdicts(this.verdicts().filter((v) => v.ts > since))].map(([id, v]) => [id, v.decision]));
  }

  /** Each class whose newest ledger verdict is a retire, newest first, with that verdict's reason and day. */
  async retired(): Promise<readonly TacitRetired[]> {
    return [...newestVerdicts(this.verdicts()).values()]
      .filter((v) => v.decision === "retire")
      .sort((a, b) => b.ts - a.ts)
      .map((v) => ({ id: v.class, reason: v.reason, date: v.date }));
  }

  /** The ledger's verdict records (`type: "verdict"` with a class, a decision and a `ts`), in file order; no file: none. */
  private verdicts(): LedgerVerdict[] {
    let lines: string[];
    try {
      lines = readFileSync(join(this.home, LEDGER_FILE), "utf8").split("\n");
    } catch {
      return [];
    }
    const out: LedgerVerdict[] = [];
    for (const line of lines) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof rec !== "object" || rec === null) continue;
      const r = rec as Record<string, unknown>;
      const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
      if (r.type !== "verdict" || typeof r.class !== "string" || typeof r.decision !== "string" || Number.isNaN(ts)) continue;
      out.push({ class: r.class, decision: r.decision, ts, date: (r.ts as string).slice(0, 10), reason: typeof r.reason === "string" ? r.reason : "" });
    }
    return out;
  }

  /** `<home>/private/tacit/rules.md` as text; null when there is no file. */
  private readRulesText(): string | null {
    try {
      return readFileSync(join(this.home, RULES_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** `<home>/private/tacit/rules.md`, read as it is; no file: no rules. */
  async rules(): Promise<readonly TacitRule[]> {
    const text = this.readRulesText();
    return text === null ? [] : parseRules(text);
  }

  /** The whole rules file for the Rules page (`parseApplied`); no file: nothing. */
  async applied(): Promise<TacitApplied> {
    const text = this.readRulesText();
    return text === null ? { rules: [], elsewhere: [] } : parseApplied(text);
  }

  /** Whether `<home>/<file>` is an executable file. */
  private runnable(file: string): boolean {
    return isRunnable(join(this.home, file));
  }

  /** Runs `<home>/bin/<cli> <args>` with `stdin`; its stdout, or a throw on a non-zero exit or the timeout. */
  private async run(cli: "tacit" | "evolve" | "sync-agents", args: readonly string[], stdin = ""): Promise<string> {
    const r = await runProcess([join(this.home, "bin", cli), ...args], {
      cwd: this.home, env: baseEnv({ AGENTS_HOME: this.home }), stdin, timeout_ms: this.timeout_ms,
    });
    const name = args[0] === undefined ? cli : `${cli} ${args[0]}`;
    if (r.timed_out) throw new Error(`${name} stopped after ${this.timeout_ms} ms`);
    if (r.exit_code !== 0) throw new Error(`${name} exited ${r.exit_code ?? r.signal}: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  }
}

/** One verdict line of the ledger: its class, decision, time (ms), day as written (YYYY-MM-DD) and reason. */
interface LedgerVerdict {
  class: string;
  decision: string;
  ts: number;
  date: string;
  reason: string;
}

/** Each class's newest verdict (a later line wins a tie). */
function newestVerdicts(verdicts: readonly LedgerVerdict[]): Map<string, LedgerVerdict> {
  const out = new Map<string, LedgerVerdict>();
  for (const v of verdicts) if (v.ts >= (out.get(v.class)?.ts ?? -Infinity)) out.set(v.class, v);
  return out;
}

/** `d` as YYYY-MM-DD in local time. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whether `path` is an executable file. */
function isRunnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
