// The owner's ledger in their agents home (issue #570): `<home>/bin/tacit` and `<home>/bin/evolve`, found from
// AGENTS_HOME, else ~/.agents. The factory only runs these CLIs, each stopped after 30 seconds; it never writes under
// the home itself. A record goes on stdin as JSON, never in argv. Built in the controller only.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TacitEntry, TacitLedger, TacitPushback, TacitVerdictNote } from "../../interfaces/tacit-ledger.js";
import { baseEnv, runProcess } from "../process/run-process.js";
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

/** The ledger at the agents home `env` names; with no `bin/tacit` there, no ledger (as `none`), and startup goes on. */
export function tacitLedgerAt(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): TacitLedger {
  const at = agentsHome(env, home);
  return existsSync(join(at, "bin", "tacit")) ? new AgentsHomeTacitLedger(at) : new NoTacitLedger();
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

  async list(state: string): Promise<readonly TacitEntry[]> {
    const out = await this.run("tacit", ["list", "--agent", TACIT_AGENT, "--state", state, "--json"]);
    const parsed: unknown = JSON.parse(out || "[]");
    if (!Array.isArray(parsed)) throw new Error("tacit list printed no JSON list");
    return parsed as TacitEntry[];
  }

  async verdict(id: string, verdict: string, note?: TacitVerdictNote): Promise<void> {
    await this.run("evolve", ["verdict", "--agent", TACIT_AGENT], JSON.stringify({ id, verdict, ...note }));
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
