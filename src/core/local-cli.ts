import type { UserId, WorkItem, WorkItemId } from "./types.js";
import type { ExternalIdentity } from "../interfaces/auth-provider.js";
import type { FactoryStore, LocalRole } from "../interfaces/factory-store.js";

/**
 * The writer side of local intake (issue #200; design 05-sources.md, "CLI intake"). `factory task create`
 * creates a local work item with its triage run queued; `task list` and `task show` read the store; `approve`,
 * `retry`, `revise`, `reject` and `resolve` append one row to the CLI command log (`command_inbox`) and change no item
 * state, for an item of any source. The controller reads that log and applies each command with the same
 * authorize check and the same replies as the GitHub comment, through the auth plugin for local commands (`local`
 * by default, issue #318); a command on a GitHub item is also mirrored to its issue, best effort, once GitHub
 * answers (design 05-sources, CLI intake). Every command acts as the CLI identity (`cliIdentity`). The first identity to run a
 * writing command becomes the local owner; `users` lets the owner give others roles. No GitHub call.
 */

/** Where the CLI identity came from, for `users list`. */
export type CliIdentitySource = "cli_user" | "git user.email" | "OS user" | "anonymous";

export interface CliIdentity {
  /** The factory user ID every CLI command acts as: `cli_user`, or `local:<value>`. */
  user: UserId;
  from: CliIdentitySource;
}

/** What the environment says about the operator; each null when unavailable. Read by main.ts, never here. */
export interface CliEnvironment {
  gitEmail: string | null;
  osUser: string | null;
}

/** The identity used when nothing in the environment names the operator. */
export const ANONYMOUS = "anonymous";

/**
 * The CLI identity (issue #318): `cli_user` from factory.config.json when set; else `local:<git user.email>`;
 * else `local:<OS user name>`; else `local:anonymous`. Keys only (an email or a login name), never a display
 * name such as git's `user.name`. A value with whitespace is skipped.
 */
export function cliIdentity(cliUser: UserId | null, env: CliEnvironment): CliIdentity {
  if (cliUser !== null) return { user: cliUser, from: "cli_user" };
  const ok = (v: string | null): v is string => v !== null && /^\S+$/.test(v.trim());
  if (ok(env.gitEmail)) return { user: `local:${env.gitEmail.trim().toLowerCase()}` as UserId, from: "git user.email" };
  if (ok(env.osUser)) return { user: `local:${env.osUser.trim()}` as UserId, from: "OS user" };
  return { user: `local:${ANONYMOUS}` as UserId, from: "anonymous" };
}

/** The identity a CLI command's actor has at intake: provider `local`, subject the actor after `local:`. */
export function localIdentity(actor: string): ExternalIdentity {
  return { provider: "local", subject: actor.startsWith("local:") ? actor.slice("local:".length) : actor };
}

const ANONYMOUS_USER = `local:${ANONYMOUS}` as UserId;
const CLI_KEY_PREFIX = "cli:";

/** Whether a command inbox key (or the comment id of its event) is a CLI command's: `cli:<random id>`. */
export function isCliCommandKey(key: string): boolean {
  return key.startsWith(CLI_KEY_PREFIX);
}
const USER_ID = /^[a-z]+:\S+$/;

export interface CliCommandSpec {
  /** The words after `factory`, e.g. `task create`. */
  name: string;
  /** As typed after `factory`. */
  usage: string;
  /** One line. */
  description: string;
}

/** Every CLI command for local tasks. The usage text, the `/help` line and the SET_UP.md list come from it. */
export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  { name: "task create", usage: "task create --title <t> --body-file <f>", description: "Create a local work item from a title and a body file; prints its work item ID" },
  { name: "task list", usage: "task list", description: "List local work items: ID, title, stage and blocked reason" },
  { name: "task show", usage: "task show <id>", description: "Print a work item's state, spec, runs and stored messages" },
  { name: "approve", usage: "approve <id> [notes]", description: "Store `/approve` for the item; the controller applies it" },
  { name: "retry", usage: "retry <id> [text]",description: "Store `/retry` for the item; the controller applies it" },
  { name: "revise", usage: "revise <id> <feedback>", description: "Store `/revise` for the item; the controller applies it" },
  { name: "reject", usage: "reject <id> <reason>", description: "Store `/reject` for the item; the controller applies it" },
  { name: "resolve", usage: "resolve <id> [notes]", description: "Store `/resolve` for the item; the controller applies it" },
  { name: "users list", usage: "users list", description: "Print your CLI identity and every local user with its role (owner, approver, requester)" },
  { name: "users add", usage: "users add <user_id> --role approver|requester", description: "Owner only: give a local user a role, e.g. `local:dev@example.com`" },
  { name: "users remove", usage: "users remove <user_id>", description: "Owner only: remove a local user's role" },
];

/** The top-level words `factory` hands to this module. */
export const CLI_TOP_WORDS = ["task", "approve", "retry", "revise", "reject", "resolve", "users"] as const;

const ITEM_COMMANDS = ["approve", "retry", "revise", "reject", "resolve"] as const;

export type ItemCommand = (typeof ITEM_COMMANDS)[number];

export type CliAction =
  | { action: "create"; title: string; bodyFile: string }
  | { action: "list" }
  | { action: "show"; id: WorkItemId }
  | { action: "command"; command: ItemCommand; id: WorkItemId; text: string }
  | { action: "users_list" }
  | { action: "users_add"; user: UserId; role: Exclude<LocalRole, "owner"> }
  | { action: "users_remove"; user: UserId };

export function cliUsage(): string {
  return ["usage: npm run factory -- <command>", ...CLI_COMMANDS.map((c) => `  ${c.usage}`)].join("\n");
}

/** The `/help` line naming the CLI commands (src/core/commands.ts). */
export function cliHelpLine(): string {
  return `From the command line on a local item: ${CLI_COMMANDS.map((c) => `\`factory ${c.usage}\``).join(", ")}.`;
}

/** The SET_UP.md list, one bullet per command. tests/local-cli.test.ts fails when SET_UP.md differs. */
export function cliCommandListMarkdown(): string {
  return CLI_COMMANDS.map((c) => `- \`factory ${c.usage}\`: ${c.description}.`).join("\n");
}

/** The action, or an error line for anything incomplete or unknown (nothing is read or written). */
export function parseLocalCliArgs(word: string, args: readonly string[]): CliAction | { error: string } {
  const bad = (why: string) => ({ error: `${why}\n${cliUsage()}` });
  if (word === "task") {
    const [sub, ...rest] = args;
    if (sub === "list") return rest.length === 0 ? { action: "list" } : bad("task list takes no arguments");
    if (sub === "show") return rest.length === 1 && rest[0] ? { action: "show", id: rest[0] as WorkItemId } : bad("task show needs one work item ID");
    if (sub === "create") {
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i += 2) {
        const k = rest[i]!;
        const v = rest[i + 1];
        if ((k !== "--title" && k !== "--body-file") || v === undefined || k in flags) return bad(`task create: unexpected ${JSON.stringify(k)}`);
        flags[k] = v;
      }
      const title = flags["--title"]?.trim();
      const bodyFile = flags["--body-file"];
      if (!title || !bodyFile) return bad("task create needs --title <t> and --body-file <f>");
      return { action: "create", title, bodyFile };
    }
    return bad(`unknown task command ${JSON.stringify(sub ?? "")}`);
  }
  if ((ITEM_COMMANDS as readonly string[]).includes(word)) {
    const [id, ...rest] = args;
    if (!id) return bad(`${word} needs a work item ID`);
    const text = rest.join(" ").trim();
    return { action: "command", command: word as ItemCommand, id: id as WorkItemId, text };
  }
  if (word === "users") {
    const [sub, user, ...rest] = args;
    if (sub === "list") return user === undefined ? { action: "users_list" } : bad("users list takes no arguments");
    if (sub !== "add" && sub !== "remove") return bad(`unknown users command ${JSON.stringify(sub ?? "")}`);
    if (!user || !USER_ID.test(user)) return bad(`users ${sub} needs a factory user ID such as local:dev@example.com`);
    if (sub === "remove") return rest.length === 0 ? { action: "users_remove", user: user as UserId } : bad("users remove takes one user ID");
    const [flag, role, ...extra] = rest;
    if (flag !== "--role" || (role !== "approver" && role !== "requester") || extra.length > 0) {
      return bad("users add needs --role approver or --role requester");
    }
    return { action: "users_add", user: user as UserId, role };
  }
  return bad(`unknown command ${JSON.stringify(word)}`);
}

export interface LocalCliDeps {
  store: Pick<
    FactoryStore,
    "createWorkItem" | "getWorkItem" | "listWorkItems" | "listPhases" | "listRuns" | "listItemMessages" | "appendCliCommand"
    | "claimLocalOwner" | "listLocalUsers" | "setLocalUserRole" | "removeLocalUser"
  >;
  /** Who every command acts as (`cliIdentity`). */
  identity: CliIdentity;
  /** The configured repo's project key from the store, or null when none is stored yet. Only `create` asks. */
  project: () => Promise<string | null>;
  /** Reads a body file. */
  read: (path: string) => Promise<string>;
  /** A new random ID: a local item's source ID, a command's idempotency key. */
  newId: () => string;
}

export interface CliResult {
  code: number;
  lines: string[];
}

/** The most items `task list` reads. */
export const TASK_LIST_LIMIT = 200;

export async function runLocalCli(d: LocalCliDeps, a: CliAction): Promise<CliResult> {
  const fail = (line: string): CliResult => ({ code: 1, lines: [line] });
  const user = d.identity.user;
  // The first identity to write becomes the local owner (issue #318); anonymous never does.
  const claim = async () => (user === ANONYMOUS_USER ? null : d.store.claimLocalOwner(user));
  switch (a.action) {
    case "create": {
      const project = await d.project();
      if (project === null) {
        return fail("no project is stored yet: start the factory once (`npm run factory -- dev`) so it records the configured repo");
      }
      await claim();
      const body = (await d.read(a.bodyFile)).trim();
      const sid = `local-${d.newId()}`;
      const source = { type: "local" as const, id: sid, link: `local:${sid}` };
      const { item } = await d.store.createWorkItem(
        { source, title: a.title, requester_id: user, project, problem: `${a.title}\n\n${body}`.trim(), resources: [source.link] },
        { kind: "user", id: user },
        { enqueue: { kind: "triage", idempotency_key: `${source.type}:${source.id}:triage` } },
      );
      return { code: 0, lines: [item.id] };
    }
    case "list": {
      const items = (await d.store.listWorkItems(TASK_LIST_LIMIT)).filter((i) => i.source.type === "local");
      if (items.length === 0) return { code: 0, lines: ["no local work items"] };
      return { code: 0, lines: items.map((i) => [i.id, i.title ?? "", i.stage, i.blocked_reason ?? "-"].join("\t")) };
    }
    case "show": {
      const item = await d.store.getWorkItem(a.id);
      if (!item) return fail(`no work item ${a.id}`);
      return { code: 0, lines: await showLines(d, item) };
    }
    case "command": {
      const item = await d.store.getWorkItem(a.id);
      if (!item) return fail(`no work item ${a.id}`);
      await claim();
      const args: Record<string, unknown> = { item: item.id, ...(a.text !== "" ? { text: a.text } : {}) };
      // An item of a sync source (GitHub) gets the command mirrored on its issue later; a local item has no other surface.
      const mirror = item.source.type !== "local";
      const { command } = await d.store.appendCliCommand({ key: `${CLI_KEY_PREFIX}${d.newId()}`, actor: user, command: a.command, args, ...(mirror ? { mirror } : {}) });
      return {
        code: 0,
        lines: [`stored \`/${a.command}\` for ${item.id} as ${user} (command ${command.seq}); the controller applies it on its next poll, see \`factory task show ${item.id}\``],
      };
    }
    case "users_list": {
      const users = await d.store.listLocalUsers();
      return {
        code: 0,
        lines: [
          `you are ${user} (from ${d.identity.from})`,
          ...(users.length === 0 ? ["no local users yet: the first identity to run a writing command becomes the owner"] : []),
          ...users.map((u) => [u.user_id, u.role, `added by ${u.added_by}`].join("\t")),
        ],
      };
    }
    case "users_add":
    case "users_remove": {
      const owner = await claim();
      if (owner?.user_id !== user) return fail(`only the local owner (${owner?.user_id ?? "none yet"}) can change roles; you are ${user}`);
      if (a.action === "users_remove") {
        const r = await d.store.removeLocalUser(a.user);
        if (r === "owner") return fail("the owner cannot be removed");
        return { code: 0, lines: [r === "removed" ? `removed ${a.user}` : `${a.user} had no role`] };
      }
      if (a.user === ANONYMOUS_USER && a.role !== "requester") return fail("anonymous gets read and create only: it cannot be an approver");
      const r = await d.store.setLocalUserRole(a.user, a.role, user);
      if (!r.ok) return fail(`${a.user} is the owner; the owner's role does not change`);
      return { code: 0, lines: [`${a.user} is now ${a.role === "approver" ? "an approver" : "a requester"}`] };
    }
  }
}

async function showLines(d: LocalCliDeps, item: WorkItem): Promise<string[]> {
  const out: string[] = [
    `${item.id}  ${item.title ?? ""}`,
    "",
    "State",
    `  stage: ${item.stage}`,
    `  blocked_on: ${item.blocked_on}`,
    `  blocked_reason: ${item.blocked_reason ?? "-"}`,
    `  close_reason: ${item.close_reason ?? "-"}`,
    `  tier: ${item.tier ?? "-"}`,
    `  pr_number: ${item.pr_number ?? "-"}`,
    `  version: ${item.version}`,
    "",
    "Spec",
  ];
  if (item.done_criteria === null) out.push("  (no spec yet)", `  problem: ${item.problem}`);
  else {
    out.push(`  problem: ${item.problem}`, "  done criteria:", ...item.done_criteria.map((c) => `    - ${c}`));
    out.push(`  desired output: ${item.desired_output ?? "-"}`, `  scope: ${item.scope ?? "-"}`, `  allowed paths: ${item.allowed_paths.join(", ")}`);
  }
  out.push("", "Sub-tasks");
  const subs = await d.store.listPhases(item.id);
  if (subs.length === 0) out.push("  (none)");
  for (const p of subs) out.push(`  ${p.phase ?? "-"}. ${p.id}\t${p.title ?? ""}\t${p.stage}\t${p.blocked_reason ?? "-"}`);
  out.push("", "Runs");
  const runs = await d.store.listRuns(item.id);
  if (runs.length === 0) out.push("  (none)");
  for (const r of runs) out.push(`  ${r.id}  ${r.kind}  ${r.status}  attempt ${r.attempt}`);
  out.push("", "Messages");
  const messages = await d.store.listItemMessages(item.id);
  if (messages.length === 0) out.push("  (none)");
  for (const m of messages) out.push(`  [${m.seq}] ${m.created_at}`, ...m.body.split("\n").map((l) => `    ${l}`));
  return out;
}
