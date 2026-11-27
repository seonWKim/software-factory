import type { Timestamp, UserId } from "./types.js";
import { COMMAND_TABLE } from "./command-table.js";
import permissionMode, { PERMISSION_MODES, type PermissionMode } from "../controller/settings/permission-mode.setting.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { AuthAction, AuthDecision, AuthProvider, AuthResource, ExternalIdentity, Principal } from "../interfaces/auth-provider.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/**
 * The one owner check (design 08-permissions, One owner; phase A of issue #575). Every command path (the controller
 * units, the command inbox, the local CLI, the dashboard commands and approve_tool) reaches `authorizeOwner` through
 * `OwnerAuth`: the caller's identity, resolved to a factory user, must be the store's owner (identity_owner, issue
 * #577). Anyone else is refused as `not_owner`. Each command decision, allowed or refused, writes one authz_audit row
 * with passport `none`; a read-only check (`check`: a page asking whether to show a command) writes one only when it
 * refuses (design 08-permissions). Service principals (the controller's auto mode, the worker's and outbound's tool calls) keep
 * their passport checks and never reach it.
 */

/** The owner check's refusal reason. */
export const NOT_OWNER = "not_owner";
/** The reply a command refused by the owner check gets. */
export const NOT_OWNER_REPLY = "only the owner may send this command";
/** The identity the environment gives when it names no one: never the owner. */
export const ANONYMOUS_USER = "local:anonymous" as UserId;

/**
 * Actions any caller may take: a work request is not a command, and the intake label stays its gate. Every other
 * action is the owner's.
 */
const OPEN_ACTIONS: readonly AuthAction[] = ["submit_work"];
/** A chat account no link maps to a factory user: a chat source has no intake label, so it may not file work either. */
const UNLINKED_CHAT = /^(slack|oidc):/;

/** The reply for a refused decision: the owner check's text, with the reason when it is not `not_owner`. */
export function refusalReply(reason: string): string {
  return reason === NOT_OWNER ? NOT_OWNER_REPLY : `${NOT_OWNER_REPLY} (\`${reason}\`)`;
}

export type OwnerStore = Pick<FactoryStore, "resolveLink" | "getOwner" | "claimOwner" | "recordOwnerDecision">;

/** The factory user of a local identity: the subject when it is already a user ID, else `local:<subject>`. */
export function localUserId(identity: ExternalIdentity): UserId | null {
  if (identity.provider !== "local") return null;
  return (/^[a-z]+:\S+$/.test(identity.subject) ? identity.subject : `local:${identity.subject}`) as UserId;
}

/**
 * The factory user of `identity`: its linked user first (by provider and subject only, never a display name), else
 * a local identity's own ID, else `<provider>:<subject>`, which is never the owner unless linked.
 */
export async function factoryUserOf(store: Pick<OwnerStore, "resolveLink">, identity: ExternalIdentity): Promise<UserId> {
  return (await store.resolveLink(identity.provider, identity.subject)) ?? localUserId(identity) ?? (`${identity.provider}:${identity.subject}` as UserId);
}

/**
 * The owner check: `user_id` must be the store's owner. A local user ID asked while the store has no owner
 * claims it (solo needs no setup: you are the owner on your first command); `anonymous` never does, and an account
 * of another provider never claims it. `submit_work` stays open to any caller but an unlinked chat account.
 */
export async function authorizeOwner(store: Pick<OwnerStore, "getOwner" | "claimOwner">, user_id: UserId, action: AuthAction): Promise<AuthDecision> {
  if (OPEN_ACTIONS.includes(action) && !UNLINKED_CHAT.test(user_id)) return { allow: true };
  if (user_id === ANONYMOUS_USER) return { allow: false, reason: NOT_OWNER };
  let owner = await store.getOwner();
  if (owner === null && user_id.startsWith("local:")) owner = await store.claimOwner(user_id);
  return owner === user_id ? { allow: true } : { allow: false, reason: NOT_OWNER };
}

/** The owner check as an AuthProvider: what compose gives every command path. No grant, no remote call; audited. */
export class OwnerAuth implements AuthProvider {
  constructor(private readonly store: OwnerStore) {}

  async resolve(identity: ExternalIdentity): Promise<Principal> {
    return { user_id: await factoryUserOf(this.store, identity) };
  }

  /** The resource does not matter: the owner may act on every one, anyone else on none. */
  authorize(principal: Principal, action: AuthAction, resource?: AuthResource): Promise<AuthDecision> {
    return this.decide(principal, action, resource, true);
  }

  /** A read-only check (a page load asking whether to offer a command): decided as `authorize`, audited only when refused. */
  check(principal: Principal, action: AuthAction, resource?: AuthResource): Promise<AuthDecision> {
    return this.decide(principal, action, resource, false);
  }

  private async decide(principal: Principal, action: AuthAction, resource: AuthResource | undefined, auditAllowed: boolean): Promise<AuthDecision> {
    const decision = await authorizeOwner(this.store, principal.user_id, action);
    if (decision.allow && !auditAllowed) return decision;
    await this.store.recordOwnerDecision({
      principal: principal.user_id, action, ...(resource ? { resource } : {}), allow: decision.allow, reason: decision.allow ? "allowed" : decision.reason,
    });
    return decision;
  }
}

/**
 * The permission gate (design 08-permissions, local-task-tk_cad55672). Agent writes, from a chat tool call or a
 * coordinator step, and typed commands (`human_command`, from the command inbox) go through `authorizeWrite`: the
 * guards first (a write that reads a secret, then the egress scan of its arguments), refused in every mode and for
 * both origins with their own reasons; then the mode, read from the store at this write; then `permissionGate`. An
 * agent write that runs is stored once as a handled command row (`recordAgentWrite`, keyed by `key`) with origin
 * `agent` and its mode; a held one once (`holdWrite`, keyed by `key`) for the owner's `confirm <id>`, with its mode.
 * A typed command is never gated: its row is already stored, with its mode.
 */

/** Who wrote a command: a person's typed command, or an agent (inbound_commands.write_origin). */
export type WriteOrigin = "human_command" | "agent";
/** A guard's refusal: the write reads a secret (G1: agents never read secrets). */
export const SECRET_READ = "secret_read";
/** A guard's refusal: the egress scan (G5) flagged the write's arguments; the tool gate's reason. */
export const EGRESS_BLOCKED = "egress_blocked";
/** The commands that read a secret, refused by G1 for both origins: none declares it today. */
const SECRET_COMMANDS: readonly string[] = [];
/** The gate's refusal: an agent write in a chat turn, in every mode. */
export const AGENT_WRITE_IN_CHAT = "agent_write_in_chat";

/** What the gate decides: run the write, hold it for the owner's confirm, or refuse it. */
export type GateDecision = { outcome: "run" } | { outcome: "hold" } | { outcome: "refuse"; reason: typeof AGENT_WRITE_IN_CHAT };

/**
 * The gate, a pure function: a typed command runs; an agent write in a chat turn is refused; any other agent write is
 * held in `ask_all`, held when it cannot be undone in `ask_irreversible` (a command that declares no `reversible`
 * counts as irreversible), and runs in `full`.
 */
export function permissionGate(i: { mode: PermissionMode; reversible: boolean | undefined; origin: WriteOrigin; in_chat_turn: boolean }): GateDecision {
  if (i.origin === "human_command") return { outcome: "run" };
  if (i.in_chat_turn) return { outcome: "refuse", reason: AGENT_WRITE_IN_CHAT };
  const hold = i.mode === "ask_all" || (i.mode === "ask_irreversible" && i.reversible !== true);
  return { outcome: hold ? "hold" : "run" };
}

/** The mode in force, read from the store's override at each write (never a process cache); none, or a bad one, is the default. */
export async function readPermissionMode(store: Pick<FactoryStore, "listSettingOverrides">): Promise<PermissionMode> {
  const json = (await store.listSettingOverrides()).find((r) => r.key === "permission_mode" && r.project === "")?.value;
  let value: unknown = null;
  try {
    value = json === undefined ? null : JSON.parse(json);
  } catch { /* a bad stored value reads as the default */ }
  return PERMISSION_MODES.find((m) => m === value) ?? (permissionMode.default as PermissionMode);
}

/** An agent write the gate held (controller_held_writes, pending until the owner confirms `id`) or ran (a handled inbound_commands row); `mode` is the mode it ran under. */
export interface NewHeldWrite { key: string; command: string; args: readonly string[]; actor: UserId; mode: PermissionMode }
/** `write_origin` is `agent` on every held write; null on a row held before it was stored. */
export interface HeldWrite extends Omit<NewHeldWrite, "args"> { id: string; args: string[]; write_origin: "agent" | null; status: string; created_at: Timestamp }
/**
 * The gate's rows (part of FactoryStore): a hold of a key already pending writes nothing and gives the pending row (`created` false);
 * a list reads the newest first. `recordAgentWrite` stores a run agent write once per key as a handled command row the inbox skips;
 * `refuseCommand` marks a pending command row handled with its refusal (false when it was handled already).
 */
export interface HeldWriteStore {
  holdWrite(w: NewHeldWrite): Promise<{ created: boolean; write: HeldWrite }>;
  listHeldWrites(limit: number): Promise<HeldWrite[]>;
  recordAgentWrite(w: NewHeldWrite): Promise<{ created: boolean }>;
  refuseCommand(id: string, refusal: string): Promise<boolean>;
}

/** One write to authorize: the command table's name (`merge`), its arguments, who wrote it, and the key that makes it the same write again. */
export interface WriteRequest {
  command: string;
  args: readonly string[];
  actor: UserId;
  origin: WriteOrigin;
  in_chat_turn: boolean;
  key: string;
  reads_secret?: boolean;
}
export interface WriteGateDeps {
  store: Pick<FactoryStore, "listSettingOverrides" | "holdWrite" | "recordAgentWrite">;
  scanner: Pick<EgressScanner, "scan">;
}
export type WriteDecision =
  | { outcome: "run"; mode: PermissionMode }
  | { outcome: "held"; mode: PermissionMode; id: string; reply: string }
  | { outcome: "refused"; reason: string; why: string; reply: string };

/** The guards, then the mode read now, then the gate; a held write is stored once and answered with `confirm <id>`. */
export async function authorizeWrite(d: WriteGateDeps, w: WriteRequest): Promise<WriteDecision> {
  const refused = (reason: string, why: string): WriteDecision => ({ outcome: "refused", reason, why, reply: `\`${w.command}\` was refused: ${why}` });
  if (w.reads_secret ?? SECRET_COMMANDS.includes(w.command)) return refused(SECRET_READ, "it reads a secret");
  if (!(await d.scanner.scan("tool_result", [w.command, ...w.args].join(" "))).clean) return refused(EGRESS_BLOCKED, "the leak scanner flagged it, so nothing of it was stored and nothing changed");
  const mode = await readPermissionMode(d.store);
  const gate = permissionGate({ mode, reversible: COMMAND_TABLE.find((c) => c.name === w.command)?.reversible, origin: w.origin, in_chat_turn: w.in_chat_turn });
  if (gate.outcome === "refuse") return refused(gate.reason, "an agent may not write from a chat turn; type the command instead");
  const row = { key: w.key, command: w.command, args: w.args, actor: w.actor, mode };
  if (gate.outcome === "run" && w.origin === "agent") await d.store.recordAgentWrite(row);
  if (gate.outcome === "run") return { outcome: "run", mode };
  const { write } = await d.store.holdWrite(row);
  return { outcome: "held", mode: write.mode, id: write.id, reply: `\`${w.command}\` is held under permission_mode ${write.mode}: confirm it with \`confirm ${write.id}\`` };
}
