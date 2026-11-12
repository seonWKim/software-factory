// The owner's ledger in their agents home (issue #570): `<home>/bin/tacit` and `<home>/bin/evolve`, found from
// AGENTS_HOME, else ~/.agents. The factory only runs these CLIs, each stopped after 30 seconds; it never writes under
// the home itself. Each value is its own argv item and nothing goes through a shell; only a captured record goes on
// stdin (as JSON). The forms are the owner's real CLIs (checked 2026-11-12); they print text, read in ledger-text.ts.
// Factory processes only: an agent run never gets it.

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type TacitDecision, type TacitLedger, type TacitPendingEntry, type TacitPushback, type TacitRule, tacitIdKind,
} from "../../interfaces/tacit-ledger.js";
import { baseEnv, runProcess } from "../process/run-process.js";
import { parsePending, parseRules } from "./ledger-text.js";
import { NoTacitLedger } from "./no-tacit-ledger.js";

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
  const runnable = (file: string) => {
    try {
      accessSync(join(path, file), constants.X_OK);
      return statSync(join(path, file)).isFile();
    } catch {
      return false;
    }
  };
  return { path, missing: AGENTS_HOME_CLIS.find((f) => !runnable(f)) ?? null };
}

/** The ledger at the agents home `env` names; with either CLI missing there, no ledger (as `none`), and startup goes on. */
export function tacitLedgerAt(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): TacitLedger {
  const found = checkAgentsHome(env, home);
  return found.missing === null ? new AgentsHomeTacitLedger(found.path) : new NoTacitLedger();
}

export class AgentsHomeTacitLedger implements TacitLedger {
  readonly enabled = true;

  constructor(
    private readonly home: string,
    private readonly timeout_ms: number = TACIT_CLI_TIMEOUT_MS,
  ) {}

  async capture(p: TacitPushback): Promise<void> {
    const record = { session: p.session, proposal: p.proposal, pushback: p.pushback, root_reason: "", hypothesis: "", improvement: "", rule_draft: "" };
    await this.run("tacit", ["capture", "--agent", TACIT_AGENT], JSON.stringify(record));
  }

  /** `evolve pending`: the open and held proposals and the pending and held classes. */
  async pending(): Promise<readonly TacitPendingEntry[]> {
    return parsePending(await this.run("evolve", ["pending"]));
  }

  /** `tacit verdict` for a class (with `--rule` on promote only), `evolve verdict` for a proposal (never a rule). */
  async verdict(id: string, decision: TacitDecision, reason: string, rule?: string): Promise<void> {
    const kind = tacitIdKind(id);
    if (kind === null) throw new Error(`"${id}" is neither a class (C-) nor a proposal (P-) ID`);
    if (kind === "proposal" && decision === "retire") throw new Error(`evolve verdict takes no retire: "${id}" is a proposal`);
    const args = ["verdict", id, decision, "--reason", reason];
    if (kind === "class" && decision === "promote" && rule !== undefined) args.push("--rule", rule);
    await this.run(kind === "class" ? "tacit" : "evolve", args);
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

  /** Runs `<home>/bin/<cli> <args>` with `stdin`; its stdout, or a throw on a non-zero exit or the timeout. */
  private async run(cli: "tacit" | "evolve", args: readonly string[], stdin = ""): Promise<string> {
    const r = await runProcess([join(this.home, "bin", cli), ...args], {
      cwd: this.home, env: baseEnv({ AGENTS_HOME: this.home }), stdin, timeout_ms: this.timeout_ms,
    });
    if (r.timed_out) throw new Error(`${cli} ${args[0]} stopped after ${this.timeout_ms} ms`);
    if (r.exit_code !== 0) throw new Error(`${cli} ${args[0]} exited ${r.exit_code ?? r.signal}: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  }
}
