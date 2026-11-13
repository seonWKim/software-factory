// The owner's ledger in their agents home (issue #570): `<home>/bin/tacit` and `<home>/bin/evolve`, found from
// AGENTS_HOME, else ~/.agents. The factory runs these CLIs, each stopped after 30 seconds. Its one write under the
// home is a promote of a class: the rule's block goes into `<home>/private/tacit/rules.md` (its resolved path inside
// the resolved home), then `tacit verdict … --encoded-to private/tacit/rules.md` runs (the block is removed again if
// it fails), then `<home>/bin/sync-agents`. Each value is its own argv item and nothing goes through a shell; only a
// captured record goes on stdin (as JSON). The forms are the owner's real CLIs (checked 2026-11-12, `evolve show`
// 2026-11-13); they print text, read in ledger-text.ts. Factory processes only: an agent run never gets it.

import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  type TacitDecision, type TacitDraft, type TacitEntryDetail, type TacitLedger, type TacitPendingEntry, type TacitPromotion,
  type TacitPushback, type TacitRule, TacitRefusal, TacitSyncFailed, tacitIdKind,
} from "../../interfaces/tacit-ledger.js";
import { SystemClock } from "../clock/system-clock.js";
import { baseEnv, runProcess } from "../process/run-process.js";
import {
  ENCODED_ELSEWHERE_HEADING, hasEncodedElsewhere, hasRuleHeading, parseDraft, parsePending, parseRules, parseShow, withRuleBlock,
} from "./ledger-text.js";
import { NoTacitLedger } from "./no-tacit-ledger.js";

/** The owner's rules file, relative to the home: the one file the factory writes there, and the verdict's `--encoded-to`. */
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
   * first (`promote`).
   */
  async verdict(id: string, decision: TacitDecision, reason: string, rule?: TacitPromotion): Promise<void> {
    const kind = kindOf(id);
    if (kind === "proposal" && decision === "retire") throw new Error(`evolve verdict takes no retire: "${id}" is a proposal`);
    if (kind === "class" && decision === "promote") return this.promote(id, reason, rule);
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
    writeFileSync(file, withRuleBlock(text, id, rule, draft, localDate(this.clock.now()))!);
    try {
      await this.run("tacit", ["verdict", id, "promote", "--reason", reason, "--rule", rule.wording, "--encoded-to", RULES_FILE]);
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
    const out = new Map<string, string>();
    let since: number;
    let lines: string[];
    try {
      since = statSync(join(this.home, CANDIDATES_FILE)).mtimeMs;
      lines = readFileSync(join(this.home, LEDGER_FILE), "utf8").split("\n");
    } catch {
      return out;
    }
    const newest = new Map<string, number>();
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
      if (r.type !== "verdict" || typeof r.class !== "string" || typeof r.decision !== "string" || !(ts > since)) continue;
      if (ts >= (newest.get(r.class) ?? -Infinity)) {
        newest.set(r.class, ts);
        out.set(r.class, r.decision);
      }
    }
    return out;
  }

  /** `<home>/private/tacit/rules.md`, read as it is; no file: no rules. */
  async rules(): Promise<readonly TacitRule[]> {
    let text: string;
    try {
      text = readFileSync(join(this.home, "private", "tacit", "rules.md"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return parseRules(text);
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
