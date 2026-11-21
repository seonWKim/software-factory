// Tool broker fakes (RFC 0023 R4).
import type { Run } from "../../../src/core/types.js";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../../../src/interfaces/tool-broker.js";

const OBJECT_SCHEMA = { type: "object" } as const;

/** The runs a broker fences calls on (the real brokers' `holdsLease`, src/impl/broker/trusted-git.ts). */
type RunLookup = { getRun(id: Run["id"]): Promise<Run | null> };
const LEASE_LOST: ToolResult = { ok: false, error_code: "lease_lost", message: "run no longer holds its lease" };

/** Whether the call's run still holds the lease its context names: running, same item, same token. */
async function holdsLease(store: RunLookup, ctx: ToolCallContext): Promise<boolean> {
  const run = await store.getRun(ctx.run_id);
  return run !== null && run.work_item_id === ctx.work_item_id && run.status === "running" && run.lease?.token === ctx.lease_token;
}
/** What FakeBroker lists: the GitHub broker's tool names and read_only flags. */
export const FAKE_GITHUB_TOOLS: readonly ToolDescriptor[] = [
  { name: STORE_BRANCH, description: "store the branch in the factory repo", input_schema: OBJECT_SCHEMA, read_only: false },
  { name: "forge.preflight", description: "read-only preflight", input_schema: OBJECT_SCHEMA, read_only: true },
];

/**
 * A broker with one read-only tool, `test.read_note` (returns `notes[args.key]`), and one that is not,
 * `test.write_note`. Like the GitHub broker it fences every call on the lease when given the store: a run that
 * lost its lease gets `lease_lost` and the tool's own code never runs. `ran` records each time that code ran.
 */
export class FakeNoteBroker implements ToolBroker {
  calls: { ctx: ToolCallContext; name: string; args: unknown }[] = [];
  ran: { name: string; args: unknown }[] = [];
  readonly tools: ToolDescriptor[] = [
    { name: "test.read_note", description: "Read a note by key.", input_schema: { type: "object", properties: { key: { type: "string" } } }, read_only: true },
    { name: "test.write_note", description: "Write a note.", input_schema: OBJECT_SCHEMA, read_only: false },
  ];
  constructor(
    public notes: Record<string, string> = {},
    private readonly store?: RunLookup,
  ) {}
  listTools(grants: readonly string[]): ToolDescriptor[] {
    return this.tools.filter((t) => grants.includes(t.name));
  }
  allTools(): readonly ToolDescriptor[] {
    return this.tools;
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    this.calls.push({ ctx, name, args });
    if (this.store && !(await holdsLease(this.store, ctx))) return LEASE_LOST;
    this.ran.push({ name, args });
    if (name === "test.read_note") {
      const key = String((args as { key?: unknown } | null)?.key ?? "");
      return { ok: true, content: { key, note: this.notes[key] ?? null } };
    }
    if (name === "test.write_note") return { ok: true, content: {} };
    return { ok: false, error_code: "unknown_tool", message: name };
  }
}

export class FakeBroker implements ToolBroker {
  /**
   * Every other tool call, in order, and, when a FakeForge logs to it, outbound's pushes and PR opens under the names
   * of the broker tools they replaced (no `ctx`: outbound holds no run's lease). The preflight is in `preflights`.
   */
  calls: { ctx?: ToolCallContext; name: string; args: unknown }[] = [];
  /** Every read-only `forge.preflight` call, in order. */
  preflights: { ctx: ToolCallContext; name: string; args: unknown }[] = [];
  /** Every `git.store_branch` call (a run's last step, RFC 0015 M7: a factory-repo ref, nothing on the forge), in order. */
  stores: { ctx: ToolCallContext; name: string; args: unknown }[] = [];
  private stored = 0;
  /** Whether a stored branch must still reach a forge (the GitHub broker) or is the change itself (the local one). */
  toForge = true;
  /**
   * Scripted results per tool name, used in order before the default. A function gets the call's args, so a
   * test can fail a store of one branch only (e.g. the wip branch, not the PR branch); null falls through.
   */
  responses: Record<string, (ToolResult | ((args: unknown) => ToolResult | null))[]> = {};
  /** The GitHub broker's tools, flagged as it flags them: only the preflight is read-only. */
  tools: ToolDescriptor[] = FAKE_GITHUB_TOOLS.map((t) => ({ ...t }));
  /**
   * `store`: given, every call is fenced on the lease as the real brokers fence it (`lease_lost`, nothing recorded).
   * `branchPrefix`: a store of a branch outside it is refused `branch_not_allowed`, as the real brokers refuse it.
   */
  constructor(private readonly opts: { store?: RunLookup; branchPrefix?: string } = {}) {}
  listTools(grants: readonly string[]): ToolDescriptor[] {
    return this.tools.filter((t) => grants.includes(t.name));
  }
  allTools(): readonly ToolDescriptor[] {
    return this.tools;
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    if (this.opts.store && !(await holdsLease(this.opts.store, ctx))) return LEASE_LOST;
    (name === "forge.preflight" ? this.preflights : name === STORE_BRANCH ? this.stores : this.calls).push({ ctx, name, args });
    if (!this.tools.some((t) => t.name === name)) return { ok: false, error_code: "unknown_tool", message: name };
    const prefix = this.opts.branchPrefix ?? "factory/";
    const branch = (args as { branch?: unknown } | null)?.branch;
    if (name === STORE_BRANCH && !(typeof branch === "string" && branch.startsWith(prefix))) {
      return { ok: false, error_code: "branch_not_allowed", message: `only ${prefix}* branches` };
    }
    const next = this.responses[name]?.shift();
    const scripted = typeof next === "function" ? next(args) : next;
    // A stored branch must still reach the forge: outbound pushes it. Each store names a new sha.
    if (name === STORE_BRANCH && !scripted) return { ok: true, content: { sha: (++this.stored).toString(16).padStart(40, "0"), forge: this.toForge } };
    if (scripted) return scripted;
    return { ok: true, content: {} };
  }
}
