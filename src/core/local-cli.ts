import type { UserId, WorkItem, WorkItemId } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/**
 * The writer side of local intake (issue #200; design 05-sources.md, "CLI intake"). `factory task create`
 * creates a local work item with its triage run queued; `task list` and `task show` read the store; `approve`,
 * `retry`, `revise` and `reject` append one row to the CLI command log (`cli_commands`) and change no item
 * state. The `local` source reads that log and the controller applies each command with the same authorize
 * check and the same replies as the GitHub comment. Every command acts as `cli_user` (factory.config.json),
 * a factory user ID; with none configured each command fails. No GitHub call.
 */

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
];

/** The top-level words `factory` hands to this module. */
export const CLI_TOP_WORDS = ["task", "approve", "retry", "revise", "reject"] as const;

export type ItemCommand = "approve" | "retry" | "revise" | "reject";

export type CliAction =
  | { action: "create"; title: string; bodyFile: string }
  | { action: "list" }
  | { action: "show"; id: WorkItemId }
  | { action: "command"; command: ItemCommand; id: WorkItemId; text: string };

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
  if (word === "approve" || word === "retry" || word === "revise" || word === "reject") {
    const [id, ...rest] = args;
    if (!id) return bad(`${word} needs a work item ID`);
    const text = rest.join(" ").trim();
    return { action: "command", command: word, id: id as WorkItemId, text };
  }
  return bad(`unknown command ${JSON.stringify(word)}`);
}

export interface LocalCliDeps {
  store: Pick<
    FactoryStore,
    "createWorkItem" | "getWorkItem" | "listWorkItems" | "listRuns" | "listItemMessages" | "appendCliCommand"
  >;
  /** `cli_user` from factory.config.json, or null when none is configured. */
  user: UserId | null;
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

export const NO_CLI_USER =
  "no CLI user configured: set `cli_user` in factory.config.json to your factory user ID (e.g. github:12345)";

/** The most items `task list` reads. */
export const TASK_LIST_LIMIT = 200;

export async function runLocalCli(d: LocalCliDeps, a: CliAction): Promise<CliResult> {
  const fail = (line: string): CliResult => ({ code: 1, lines: [line] });
  if (d.user === null) return fail(NO_CLI_USER);
  const user = d.user;
  switch (a.action) {
    case "create": {
      const project = await d.project();
      if (project === null) {
        return fail("no project is stored yet: start the factory once (`npm run factory -- dev`) so it records the configured repo");
      }
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
      if (item.source.type !== "local") return fail(`${a.id} is not a local work item: reply \`/${a.command}\` on its issue instead`);
      const args: Record<string, unknown> = { item: item.id, ...(a.text !== "" ? { text: a.text } : {}) };
      const { command } = await d.store.appendCliCommand({ key: `cli:${d.newId()}`, actor: user, command: a.command, args });
      return {
        code: 0,
        lines: [`stored \`/${a.command}\` for ${item.id} (command ${command.seq}); the controller applies it on its next poll, see \`factory task show ${item.id}\``],
      };
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
