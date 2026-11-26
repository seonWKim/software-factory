import type { WorkItem, WorkItemId } from "./types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { MERGE_COMMAND } from "./local-merge.js";
import { CLOSED_REFUSAL, approveRefusal, settleHeldSkillVersion, helpReply, itemCommandState, latestSpec, overCap, overCapApproval, refusalText } from "./commands.js";
import { COORDINATOR_LIMIT_KEY, type CoordinatorLimitAnswer, LIMIT_ALERTS_SCAN, coordinatorLimitAnswer, usd } from "./spend.js";
import type { NoteAnswers } from "./request-transition.js";
import { verdictRefusal } from "./verdict.js";
import { CONFIRM_COMMAND } from "./interpret.js";
import { needsDueDate } from "./quick-add.js"; import { type Project, projectSlug } from "./projects.js";
export { storedProjectCaps } from "./size-cap.js"; // the project's size caps for `approve` (LocalCliDeps.caps), for the CLI handler
import { ProjectRefused, projectRefusal, taskLine } from "./tasks.js";
import { NO_PROJECT_KEY, buildTask, createLocalItem, createProjectTask, dependsOnId, localItemOf, withDependsOn } from "./task-build.js";
import { type DraftTerminal, runScheduleWords } from "./schedule-draft.js";
import { ANONYMOUS_USER, CLI_KEY_PREFIX, type CliIdentity, DEFAULT_CLI_NAME } from "./local-cli-identity.js";
import { type CliAction as ParsedAction, parseLocalCliArgs } from "./local-cli-parse.js";
/**
 * Every action runLocalCli runs: the parser's, and a bare `approve` (`value`: a dollar amount) or `reject`, which answers
 * today's open coordinator limit question, else settles the newest held skill version (parseLocalCliArgs in local-cli.ts).
 */
export type CliAction = ParsedAction | { action: "settle"; command: "approve" | "reject"; value?: string };
/** `task create`'s last line: what happens to the new item next. */ export const CREATE_NEXT_STEP = "triage queued; you'll be asked to approve the spec";
const UI_PORT = 4310; // `ui.port` unset: compose.ts DEFAULT_UI_PORT, which core cannot import

/** One project as `project` prints it: `+slug`, its name, and `archived` for an archived one. */
const projectLine = (p: Project) => [`+${p.slug}`, p.name, ...(p.archived_at === null ? [] : ["archived"])].join("\t");

/** The store write's ProjectRefused as a failed result (its reason), anything else thrown again. */
async function orRefused(fail: (line: string) => CliResult, run: () => Promise<CliResult>): Promise<CliResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ProjectRefused) return fail(err.message);
    throw err;
  }
}

export interface LocalCliDeps extends DraftTerminal { // DraftTerminal: `schedule draft` and `improve`'s model, scanner and y/N ask
  store: Pick<
    FactoryStore,
    "createWorkItem" | "getWorkItem" | "findWorkItemIds" | "listWorkItems" | "listPhases" | "listRuns" | "listStateChanges" | "listItemMessages" | "appendCliCommand"
    | "claimOwner" | "addTask" | "listTasks" | "completeTask" | "reopenTask" | "listCommandProposals"
    | "getTask" | "linkTask" | "updateTask" | "deleteTask" | "addSubTask"
    | "createProject" | "listProjects" | "renameProject" | "archiveProject" | "restoreProject" | "deleteProject" | "getProjectBySlug"
    | "addTaskToProject" | "removeTaskFromProject" | "moveTaskToProject" | "listTaskProjectSlugs" | "listSchedules" | "listScheduleRuns" | "addSchedule" | "updateSchedule" | "deleteSchedule" | "scheduleNow"
    | "listHeldSkillVersionGates" | "settleSkillVersionGate" | "listAlerts"
  >;
  /** Who every command acts as (`cliIdentity`). */
  identity: CliIdentity;
  /** The configured repo's project key from the store, or null when none is stored yet. Only `create` asks. */
  project: () => Promise<string | null>;
  /** Reads a body file. */
  read: (path: string) => Promise<string>;
  /** A new random ID: a local item's source ID, a task's ID, a command's idempotency key. */
  newId: () => string;
  origin?: string; // the source type the command was typed in, when not the CLI (a chat, design 05-sources): its items' rows are not mirrored there; absent: the CLI
  caps?: (project: string) => Promise<{ max_diff_lines: number; max_diff_files: number }>; // the project's size caps as the controller reads them (storedProjectCaps): `approve` refuses an over-cap approval with no note before any write; absent (chat): the controller does
  cli?: string; // the hints' command name (cliName); absent: DEFAULT_CLI_NAME, as chat callers leave it
  ui?: { port?: number }; // factory.config.json's `ui` (validated at load): `task create` prints the item's loopback link on its port; absent: no link (chat)
  clock?: () => Promise<{ now(): Date }>; // today's UTC day, for the coordinator limit question a bare `approve <usd>` or `reject` answers (design 06-spend); absent (chat): those settle a held skill version only
  answers: NoteAnswers<{ question: string; answer: string | null; accepted_default: boolean }>; // splitAnswers, answersDetail (src/shared/command-notes.ts)
}

export interface CliResult { code: number; lines: string[] }

/** A work item's short ID, as the dashboard shows it: the 8 hex characters after `wi_`; any other ID as it is. */
export const shortItemId = (id: string): string => /^wi_([0-9a-f]{8})/.exec(id)?.[1] ?? id;
/**
 * The item a token names, for `task show`, every item command and `help` (design 05-sources, short IDs): the token, `wi_`
 * optional, is a prefix of its ID; one with no hex after `wi_` reads nothing. None or several (listed) is a refusal.
 */
export async function resolveItem(store: Pick<FactoryStore, "findWorkItemIds" | "getWorkItem">, token: string): Promise<WorkItem | CliResult> {
  const rest = token.replace(/^wi_/, "");
  const ids = /[0-9a-f]/.test(rest) ? await store.findWorkItemIds(`wi_${rest}`) : [];
  const item = ids.length === 1 ? await store.getWorkItem(ids[0]!) : null;
  return item ?? { code: 1, lines: ids.length > 1 ? [`${token} names ${ids.length} work items; give more of its ID:`, ...ids.map((id) => `  ${id}\t${shortItemId(id)}`)] : [`no work item ${token}`] };
}

/** The most items, and the most open tasks, `task list` reads. */ export const TASK_LIST_LIMIT = 200;

export async function runLocalCli(d: LocalCliDeps, a: CliAction): Promise<CliResult> {
  const fail = (line: string): CliResult => ({ code: 1, lines: [line] });
  const user = d.identity.user;
  const cli = d.cli ?? DEFAULT_CLI_NAME;
  const link = (id: WorkItemId) => (d.ui ? [`http://127.0.0.1:${d.ui.port ?? UI_PORT}/app/items/${id}`] : []);
  const created = (id: WorkItemId, ...rest: string[]): CliResult => ({ code: 0, lines: [id, shortItemId(id), ...rest, ...link(id), CREATE_NEXT_STEP] }); // the ID first (scripts read it), then its short ID
  // The first identity to write becomes the local owner (issue #318); anonymous never does.
  const claim = async () => (user === ANONYMOUS_USER ? null : d.store.claimOwner(user));
  switch (a.action) {
    case "create": {
      const project = await d.project();
      if (project === null) return fail(NO_PROJECT_KEY);
      const dep = a.depends_on === undefined ? null : await localItemOf(d.store, a.depends_on);
      if (a.depends_on !== undefined && !dep) return fail(`--depends-on ${a.depends_on} names no local work item or built task, so nothing was created`);
      // The line names the item's full wi_ ID, so a short ID given here resolves the same way for the local source.
      const body = withDependsOn((await d.read(a.bodyFile)).trim(), a.depends_on !== undefined && dep ? [dependsOnId(a.depends_on, dep)] : []);
      if (a.project !== undefined) {
        const r = await createProjectTask(d.store, { task_id: `tk_${d.newId()}`, title: a.title, body, slug: a.project, project, user });
        if (!r.ok) return fail(r.reason);
        await claim();
        return created(r.item.id, `task ${r.task.id} in +${a.project}`);
      }
      await claim();
      const { item } = await createLocalItem(d.store, { source_id: `local-${d.newId()}`, title: a.title, body, project, user });
      return created(item.id);
    }
    case "build": {
      const r = await buildTask(d.store, a.id, await d.project(), user);
      if (!r.ok) return fail(r.reason);
      if (r.created) await claim();
      return { code: 0, lines: [r.created ? `built ${a.id} as ${r.item.id}` : `${a.id} was already built as ${r.item.id}`] };
    }
    case "add":
      return orRefused(fail, async () => {
        const task = await d.store.addTask({ ...a.task, id: `tk_${d.newId()}`, created_by: user });
        await claim();
        return { code: 0, lines: [taskLine(task)] };
      });
    case "done": {
      const r = await d.store.completeTask(a.id);
      if (!r.ok) return fail(`no task ${a.id}`);
      const done = r.completed ? `done ${a.id}` : `${a.id} was already done`;
      return { code: 0, lines: [done, ...(r.next ? [`next: ${taskLine(r.next)}`] : [])] };
    }
    case "reopen": {
      const r = await d.store.reopenTask(a.id);
      if (!r.ok) return fail(r.reason === "next_done" ? `${a.id}'s next occurrence ${r.next.id} is done: reopen that one first` : `no task ${a.id}`);
      if (!r.reopened) return { code: 0, lines: [`${a.id} was not done`] };
      return { code: 0, lines: [`reopened ${a.id}`, ...(r.removed_next ? [`removed its next occurrence ${r.removed_next}`] : [])] };
    }
    case "edit":
      return orRefused(fail, async () => {
        const r = await d.store.updateTask(a.id, a.edit);
        if (r.ok) return { code: 0, lines: [`edited ${taskLine(r.task)}`] };
        if (r.reason === "needs_due_date") return fail(needsDueDate(r.recurrence));
        return fail(r.reason === "done" ? `${a.id} is done: a done task cannot be edited` : `no task ${a.id}`);
      });
    case "delete": {
      const r = await d.store.deleteTask(a.id);
      if (r.ok) return { code: 0, lines: [`deleted ${a.id}`, ...(r.detached.length > 0 ? [`detached done sub-tasks: ${r.detached.map((t) => t.id).join(", ")}`] : [])] };
      if (r.reason === "open_sub_tasks") return fail(`${a.id} has open sub-tasks: ${r.sub_tasks.map((t) => t.id).join(", ")}; complete or delete them first`);
      return fail(`no task ${a.id}`);
    }
    case "sub":
      return orRefused(fail, async () => {
        const r = await d.store.addSubTask(a.parent, { ...a.task, id: `tk_${d.newId()}`, created_by: user });
        if (r.ok) {
          await claim();
          return { code: 0, lines: [taskLine(r.task)] };
        }
        return fail(r.reason === "nested" ? `${a.parent} is a sub-task: a sub-task cannot have sub-tasks` : `no task ${a.parent}`);
      });
    case "list": {
      if (a.project !== undefined) {
        // A task project's slug, never the repository `owner/name` the settings commands' --project takes.
        const project = await d.store.getProjectBySlug(projectSlug(a.project) ?? "");
        if (project === null) return fail(projectRefusal(a.project, "not_found"));
        if (project.archived_at !== null) return fail(projectRefusal(project.slug, "archived"));
        const open = await d.store.listTasks(TASK_LIST_LIMIT);
        const links = await d.store.listTaskProjectSlugs(open.map((t) => t.id));
        const tasks = open.filter((t) => links[t.id]?.includes(project.slug));
        return { code: 0, lines: tasks.length === 0 ? [`no open tasks in +${project.slug}`] : tasks.map((t) => taskLine(t, links[t.id] ?? [])) };
      }
      const items = (await d.store.listWorkItems(TASK_LIST_LIMIT)).filter((i) => i.source.type === "local");
      const tasks = await d.store.listTasks(TASK_LIST_LIMIT);
      const links = await d.store.listTaskProjectSlugs(tasks.map((t) => t.id));
      const lines = items.length === 0 ? ["no local work items"] : items.map((i) => [i.id, shortItemId(i.id), i.title ?? "", i.stage, i.blocked_reason ?? "-"].join("\t"));
      // Plain tasks in their own section after the work items (design 02-tasks), only when there are any.
      return { code: 0, lines: tasks.length === 0 ? lines : [...lines, "", "Tasks", ...tasks.map((t) => taskLine(t, links[t.id] ?? []))] };
    }
    case "task_project": {
      const project = await d.store.getProjectBySlug(a.slug);
      if (project === null) return fail(projectRefusal(a.slug, "not_found"));
      if (!a.add) {
        const removed = await d.store.removeTaskFromProject(project.id, a.id);
        return { code: 0, lines: [removed ? `took ${a.id} out of +${a.slug}` : `${a.id} was not in +${a.slug}`] };
      }
      const r = await d.store.addTaskToProject(project.id, a.id);
      if (!r.ok) return fail(r.reason === "task_not_found" ? `no task ${a.id}` : projectRefusal(a.slug, r.reason === "archived" ? "archived" : "not_found"));
      if (r.changed) await claim();
      return { code: 0, lines: [r.changed ? `added ${a.id} to +${a.slug}` : `${a.id} was already in +${a.slug}`] };
    }
    case "task_move": {
      const from = await d.store.getProjectBySlug(a.from);
      if (from === null) return fail(projectRefusal(a.from, "not_found"));
      const to = await d.store.getProjectBySlug(a.to);
      if (to === null) return fail(projectRefusal(a.to, "not_found"));
      const r = await d.store.moveTaskToProject(a.id, from.id, to.id);
      if (!r.ok) {
        if (r.reason === "task_not_found") return fail(`no task ${a.id}`);
        return fail(r.reason === "not_linked" ? `${a.id} was not in +${a.from}` : projectRefusal(a.to, r.reason === "archived" ? "archived" : "not_found"));
      }
      if (r.changed) await claim();
      return { code: 0, lines: [r.changed ? `moved ${a.id} from +${a.from} to +${a.to}` : `${a.id} was already moved from +${a.from} to +${a.to}`] };
    }
    case "project":
      return runProject(d, a, fail, claim);
    case "schedule": // A write first claims the owner, as every write does, and is refused for anyone else.
      return runScheduleWords(d, a.command, user, async () => (await claim()) === user);
    case "show": {
      const item = await resolveItem(d.store, a.id);
      if ("lines" in item) return item;
      return { code: 0, lines: await showLines(d, item) };
    }
    case "command": {
      const item = await resolveItem(d.store, a.id);
      if ("lines" in item) return item;
      const name = a.command === MERGE_COMMAND ? `${cli} merge` : `/${a.command}`;
      // The controller's phase check, before any write: the same refusal it would post (issues #528, #523).
      const runs = a.command === "approve" ? await d.store.listRuns(item.id) : [], capped = a.command === "approve" && d.caps ? overCapApproval(overCap(item, runs, await d.store.listStateChanges(item.id), latestSpec(runs), await d.caps(item.project)), { kind: "user", id: user }, a.text, null) : null; // over the caps: the controller's own refusal (design 04-split-specs)
      const refused = a.command === "approve" ? approveRefusal(item) ?? capped?.refuse ?? null : a.command === "verdict" ? verdictRefusal(item) : a.command === "note" && item.stage === "CLOSED" ? CLOSED_REFUSAL : null;
      if (refused !== null) return fail(refusalText(name, refused));
      // `approve`'s `N: <answer>` lines, read as the controller will (issue #526): a bad line stores nothing; each decision is printed.
      const ans = d.answers.split(a.text, a.command === "approve" ? latestSpec(runs)?.decision_items ?? [] : []);
      if ("refuse" in ans) return fail(ans.refuse);
      await claim();
      const args: Record<string, unknown> = { item: item.id, ...(a.text !== "" ? { text: a.text } : {}) };
      // An item of a sync source gets the command mirrored on its issue later; a local item has no other surface, and
      // a command typed in the item's own thread is already there. A verdict changes no state and a merge answers on
      // its own (design 04-gate-commands), so neither is mirrored.
      const mirror = a.command !== "verdict" && a.command !== MERGE_COMMAND && item.source.type !== "local" && item.source.type !== d.origin;
      const { command } = await d.store.appendCliCommand({ key: `${CLI_KEY_PREFIX}${d.newId()}`, actor: user, command: a.command, args, ...(mirror ? { mirror } : {}) });
      const decisions = "answers" in d.answers.detail(ans.answers) ? ans.answers.map((x, i) => `${i + 1}. ${x.question} → ${x.answer === null ? "(no answer and no default)" : `${x.answer} (${x.accepted_default ? "default taken" : "your answer"})`}`) : [];
      return { code: 0, lines: [`stored \`${name}\` for ${item.id} as ${user} (command ${command.seq}); the controller applies it on its next poll, see \`${cli} task show ${item.id}\``, ...decisions] };
    }
    case "confirm": {
      const rows = await d.store.listCommandProposals(a.proposal);
      if (rows.length === 0) return fail(`no proposal ${a.proposal}`);
      const pending = rows.filter((r) => r.status === "pending");
      if (pending.length === 0) return { code: 0, lines: [`nothing was applied: every command of ${a.proposal} was already applied or answered`, ...rows.map((r) => `  ${r.work_item_id}\t/${r.command}${r.args ? ` ${r.args}` : ""}\t${r.status}`)] };
      await claim();
      // The controller's confirm path (src/controller/units/commands/proposals.ts) claims and applies each pending row,
      // and answers a refusal in the thread of the first pending command's item.
      const args = { item: pending[0]!.work_item_id, proposal: a.proposal };
      const { command } = await d.store.appendCliCommand({ key: `${CLI_KEY_PREFIX}${d.newId()}`, actor: user, command: CONFIRM_COMMAND, args });
      const n = pending.length === 1 ? "its pending command" : `its ${pending.length} pending commands`;
      return { code: 0, lines: [`stored \`${cli} confirm ${a.proposal}\` as ${user} (command ${command.seq}); the controller applies ${n} on its next poll`] };
    }
    case "settle": {
      // Today's open coordinator limit question (design 06-spend) takes `approve <usd>` and `reject`, stored for the
      // controller, which checks and applies it (the commands unit's answerLimit). A bare `approve` settles a held skill
      // version first: the question needs an amount.
      const value = a.value ?? null;
      const limit = d.clock ? coordinatorLimitAnswer(await d.store.listAlerts({ limit: LIMIT_ALERTS_SCAN }), (await d.clock()).now().getTime(), a.command, value) : null;
      if (limit !== null && !(a.command === "approve" && value === null)) return storeLimitAnswer(d, limit, a.command, value, user, cli, async () => (await claim()) === user);
      // `approve <usd>` with no question open: the item command it reads as.
      if (a.value !== undefined) {
        const p = parseLocalCliArgs(a.command, [a.value]);
        return "error" in p ? { code: 1, lines: p.error.split("\n") } : runLocalCli(d, p);
      }
      // No held version and the question open: a bare approve's refusal names the amount it needs.
      const r = await settleHeldSkillVersion(d.store, a.command, user);
      if (r === null && limit !== null && "refused" in limit) return fail(limit.refused);
      // No held version: the parser's refusal of a bare item command, word for word, as before (design 07-self-improvement).
      if (r === null) { const p = parseLocalCliArgs(a.command, []); return { code: 1, lines: "error" in p ? p.error.split("\n") : [] }; }
      const v = `version ${r.gate.version} of skill ${r.gate.ref_id}`;
      if (!r.settled) return { code: 0, lines: [`${v} was settled already`] };
      await claim();
      return { code: 0, lines: [a.command === "approve" ? `approved held ${v}: it is current unless a newer version passed` : `rejected held ${v}: the version current before it stays current`] };
    }
    case "help": {
      if (a.id === null) return { code: 0, lines: helpReply(null).split("\n") };
      const item = await resolveItem(d.store, a.id);
      if ("lines" in item) return item;
      return { code: 0, lines: helpReply(itemCommandState(item, await d.store.listRuns(item.id))).split("\n") };
    }
  }
}

/**
 * `approve <usd>` or `reject` on today's coordinator limit question, after the checks the controller makes again
 * (coordinatorLimitAnswer, the owner check): one command row naming the question's key, which the controller applies
 * (the setting through the settings path, the alert dismissed by the owner). A refusal stores nothing.
 */
async function storeLimitAnswer(
  d: LocalCliDeps, limit: CoordinatorLimitAnswer, command: "approve" | "reject", value: string | null, user: CliIdentity["user"], cli: string, isOwner: () => Promise<boolean>,
): Promise<CliResult> {
  if ("refused" in limit) return { code: 1, lines: [limit.refused] };
  if (!(await isOwner())) return { code: 1, lines: [`only the owner answers the coordinator limit question; you are ${user}`] };
  const args = { coordinator_limit: limit.alert.pattern_key, ...(value !== null ? { text: value } : {}) };
  const { command: row } = await d.store.appendCliCommand({ key: `${CLI_KEY_PREFIX}${d.newId()}`, actor: user, command, args });
  const next = limit.set_usd === null
    ? `leaves ${COORDINATOR_LIMIT_KEY} as it is, so coordinator cycles stay stopped until the UTC day ends`
    : `sets ${COORDINATOR_LIMIT_KEY} to ${usd(limit.set_usd)}, so coordinator cycles run again once today's coordinator spend is below it`;
  return { code: 0, lines: [`stored \`${cli} ${command}${value !== null ? ` ${value}` : ""}\` on the coordinator limit question as ${user} (command ${row.seq}); on its next poll the controller ${next}`] };
}

/** `factory project <verb>`: the task projects' store methods, a slug looked up active or archived. */
async function runProject(
  d: LocalCliDeps, a: Extract<CliAction, { action: "project" }>, fail: (line: string) => CliResult, claim: () => Promise<unknown>,
): Promise<CliResult> {
  const ok = (...lines: string[]): CliResult => ({ code: 0, lines });
  if (a.verb === "list") {
    const projects = await d.store.listProjects(a.archived ? "archived" : "active");
    return ok(...(projects.length === 0 ? [a.archived ? "no archived projects" : "no projects"] : projects.map(projectLine)));
  }
  if (a.verb === "create") {
    const r = await d.store.createProject({ id: `pj_${d.newId()}`, name: a.name, created_by: d.identity.user });
    if (!r.ok) return fail(r.reason === "invalid_name" ? r.error : `project "${r.project.slug}" exists already${r.project.archived_at === null ? "" : " (archived)"}`);
    await claim();
    return ok(projectLine(r.project));
  }
  const project = await d.store.getProjectBySlug(a.slug);
  if (project === null) return fail(projectRefusal(a.slug, "not_found"));
  await claim();
  switch (a.verb) {
    case "rename": {
      const r = await d.store.renameProject(project.id, a.name);
      if (r.ok) return ok(`renamed +${a.slug} to ${projectLine(r.project)}`);
      return fail(r.reason === "invalid_name" ? r.error : r.reason === "slug_taken" ? `project "${r.project.slug}" exists already` : projectRefusal(a.slug, "not_found"));
    }
    case "archive":
    case "restore": {
      const r = a.verb === "archive" ? await d.store.archiveProject(project.id) : await d.store.restoreProject(project.id);
      if (!r.ok) return fail(projectRefusal(a.slug, "not_found"));
      const done = a.verb === "archive" ? "archived" : "restored";
      return ok(r.changed ? `${done} +${a.slug}` : `+${a.slug} was already ${a.verb === "archive" ? "archived" : "active"}`);
    }
    case "delete": {
      const r = await d.store.deleteProject(project.id);
      if (!r.ok) return fail(projectRefusal(a.slug, "not_found"));
      return ok(`deleted +${a.slug}`, ...(r.unlinked.length > 0 ? [`took out its tasks: ${r.unlinked.join(", ")}`] : []));
    }
  }
}

async function showLines(d: LocalCliDeps, item: WorkItem): Promise<string[]> {
  const out: string[] = [
    `${item.id}  ${item.title ?? ""}`, "", "State", `  stage: ${item.stage}`, `  blocked_on: ${item.blocked_on}`, `  blocked_reason: ${item.blocked_reason ?? "-"}`,
    `  close_reason: ${item.close_reason ?? "-"}`, `  tier: ${item.tier ?? "-"}`, `  change_ref: ${item.change_ref ?? "-"}`, `  version: ${item.version}`, "", "Spec",
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
