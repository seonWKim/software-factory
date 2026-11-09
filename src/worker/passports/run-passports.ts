// Run passports (RFC 0015 §8, M9): at run start the worker narrows its service passport to the run (project,
// item, run, branch, the run kind's broker tools, `use_tool`, the broker as audience). The token stays in this
// process, keyed by run id, and only the broker reads it (`held`): never the agent, never the store. Scratch for
// the runs this process executes, like the worker's meters; a run another replica takes over is minted again there.

import type { Issued, PassportService } from "../../identity/index.js";

/** The audience of a run passport: only the ToolBroker accepts it. */
export const BROKER_AUDIENCE = "tool-broker";

/** Forge tools the worker itself calls per run kind (src/worker/runs/). A kind not listed calls none. */
const FORGE_TOOLS = ["git.store_branch", "forge.preflight"] as const;
const WORKER_TOOLS: Readonly<Record<string, readonly string[]>> = {
  implement: FORGE_TOOLS,
  update: FORGE_TOOLS,
  resolve: FORGE_TOOLS,
};

export interface RunPassportRequest {
  readonly run: string;
  /** The claim's lease token: `end` drops the passport only for the claim that minted it. */
  readonly lease_token: number;
  readonly kind: string;
  readonly item: string;
  readonly project: string;
  readonly branch: string;
  /** The run's work-in-progress branch, named beside `branch` (see the broker interface's RunPassportRequest). */
  readonly wip_branch?: string;
  readonly grants: readonly string[];
}

/** What the broker reads for a call: the run's token and the facts the passport was minted for. */
export interface HeldPassport {
  readonly token: string;
  readonly project: string;
  readonly branch: string;
}

export class RunPassports {
  private readonly held = new Map<string, HeldPassport & { readonly lease_token: number }>();

  constructor(private readonly identity: Pick<PassportService, "service" | "narrow">) {}

  /** The tools a run kind's passport names: the worker's own forge tools plus its granted read-only tools. */
  static tools(kind: string, grants: readonly string[]): string[] {
    return [...new Set([...(WORKER_TOOLS[kind] ?? []), ...grants])];
  }

  async begin(req: RunPassportRequest): Promise<Issued> {
    const parent = await this.identity.service("worker");
    const tools = RunPassports.tools(req.kind, req.grants);
    const issued = await this.identity.narrow(parent.passport.id, {
      kind: "run",
      actions: ["use_tool"],
      projects: [req.project],
      items: [req.item],
      runs: [req.run],
      branches: [req.branch, ...(req.wip_branch ? [req.wip_branch] : [])],
      // An empty list would be malformed; a run with no tools gets one no tool matches, so it is still closed.
      tools: tools.length > 0 ? tools : ["none"],
      audience: [BROKER_AUDIENCE],
    });
    this.held.set(req.run, { token: issued.token, project: req.project, branch: req.branch, lease_token: req.lease_token });
    return issued;
  }

  /** Drops the run's passport if the claim under `lease_token` minted it; a later claim's passport stays. */
  end(run: string, lease_token: number): void {
    if (this.held.get(run)?.lease_token === lease_token) this.held.delete(run);
  }

  /** The run's passport, or null when the run has none in this process (the broker then refuses). */
  passportOf(run: string): HeldPassport | null {
    const held = this.held.get(run);
    return held ? { token: held.token, project: held.project, branch: held.branch } : null;
  }
}
