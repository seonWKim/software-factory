// G2 for pack tools (design 11-packs, issue #592). A pack tool's grant is `pack:tool:<name>`; its call runs here, in
// the worker, never in the agent's sandbox. Every call checks, in order: the run's lease, then the store's approval of
// the entry's current description (`approvedEntry`, a read only, so a retried call checks again and writes nothing),
// then that the approved description is the one this implementation runs. Only then is the credential read from the
// SecretStore and the tool's call function reached. A refusal never reaches it. Any other tool name goes to `inner`.

import type { FactoryStore } from "../../interfaces/factory-store.js";
import { type Secret, type SecretStore, secretName } from "../../interfaces/secret-store.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { packGrantName } from "../../packs/pack-approvals.store.js";
import { approvedEntry } from "../../packs/pack-grants.js";
import type { SqlDriver } from "../../state/index.js";
import { grantedTools, leaseLost } from "./tool-broker-shared.js";

/** One pack tool's implementation, as the worker holds it. */
export interface PackTool {
  /** The entry's name; the tool is listed and granted as `pack:tool:<name>`. */
  readonly name: string;
  /** The description_hash of the descriptor this implementation runs: it runs only while that one is approved and current. */
  readonly description_hash: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly read_only: boolean;
  /** The call function. Gets the entry's credential here, in the worker, and nowhere else. */
  call(args: unknown, credential: Secret | null): Promise<ToolResult>;
}

/** The error codes a pack tool call returns when the broker, not the tool, answers. */
export const PACK_NOT_APPROVED = "not_approved";
export const PACK_NO_CREDENTIAL = "no_credential";
export const PACK_CREDENTIAL_IN_RESULT = "credential_in_result";

export class PackToolBroker implements ToolBroker {
  private readonly descriptors: readonly ToolDescriptor[];

  constructor(
    /** The broker for every other tool name. */
    readonly inner: ToolBroker,
    private readonly deps: {
      db: SqlDriver;
      store: Pick<FactoryStore, "getRun">;
      secrets: Pick<SecretStore, "get">;
      tools: readonly PackTool[];
      /** `packs.auto_approve_read_only`: a read-only entry with no credential counts as approved. */
      autoApproveReadOnly: boolean;
    },
  ) {
    this.descriptors = deps.tools.map((t) => ({
      name: packGrantName("tool", t.name), description: t.description, input_schema: t.input_schema, read_only: t.read_only,
    }));
  }

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return [...this.inner.listTools(grants), ...grantedTools(this.descriptors, grants)];
  }

  allTools(): readonly ToolDescriptor[] {
    return [...this.inner.allTools(), ...this.descriptors];
  }

  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const tool = this.deps.tools.find((t) => packGrantName("tool", t.name) === name);
    if (!tool) return this.inner.call(ctx, name, args);
    const lost = await leaseLost(this.deps.store, ctx);
    if (lost) return lost;
    const entry = await approvedEntry(this.deps.db, "tool", tool.name, this.deps.autoApproveReadOnly);
    if (typeof entry === "string") return { ok: false, error_code: PACK_NOT_APPROVED, message: `${name} is refused: ${entry}` };
    if (entry.description_hash !== tool.description_hash) {
      return { ok: false, error_code: PACK_NOT_APPROVED, message: `${name} is refused: the approved description is not the one this tool runs` };
    }
    let credential: Secret | null = null;
    if (entry.credential_name !== null) {
      credential = await this.deps.secrets.get(secretName(entry.credential_name));
      if (!credential) return { ok: false, error_code: PACK_NO_CREDENTIAL, message: `${name} needs ${entry.credential_name}, which has no value` };
    }
    let result: ToolResult;
    try {
      result = await tool.call(args, credential);
    } catch {
      // The thrown text could hold the credential; the agent gets only that the call failed.
      return { ok: false, error_code: "tool_error", message: `${name} failed` };
    }
    // A tool that echoes its credential back is withheld whole, whatever the egress scan's patterns know.
    if (credential && JSON.stringify(result).includes(credential.reveal())) {
      return { ok: false, error_code: PACK_CREDENTIAL_IN_RESULT, message: `${name} result withheld: it holds the tool's credential` };
    }
    return result;
  }
}
