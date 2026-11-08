import { checkedLines, commandText, runChecks } from "./checks.js";
import type { FactoryConfig } from "./config.js";
import { requiredTier } from "./diff-gate.js";
import type { Logger } from "./log.js";
import { parseTriage } from "./outputs.js";
import { IMPLEMENT_KINDS, INTERACTIVE, SESSION_ABANDONED, SESSION_RELEASED, branchFor, effectiveTier, floorTier } from "./policy.js";
import { NumstatError, diffGates, scopeGate } from "./pre-push.js";
import { type LearnedSettingsSource, settingValues } from "./settings.js";
import type { Run, RunId, SourceRef, SourceType, WorkItem, WorkItemId, WorkItemPatch } from "./types.js";
import { type LocalRoute, TRUSTED_GIT_ENV, hasTool, prTitle, routeFor } from "./worker-deps.js";
import type { AuthProvider, ExternalIdentity } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, SessionUpdate, StartSessionResult } from "../interfaces/factory-store.js";
import type { Sandbox, SandboxHandle } from "../interfaces/sandbox.js";
import type { ToolBroker, ToolCallContext } from "../interfaces/tool-broker.js";

// `factory session` (design §5, 2026-11-01): the owner's own LLM session on an item, as one `interactive` run. `finish`
// runs the worker's pre-push gates and `repo.test_command`, then pushes and opens the PR only through the broker (a local
// item: commits its local branch through the local broker, no PR, as the worker does); the
// controller applies the end like any run outcome. The LLM runs as the owner, outside the run-folder rule (an exception).

/** The local record of an open session (under state_dir). Holds a lease token, never a credential. */
export interface SessionFile { work_item_id: WorkItemId; run_id: RunId; token: number; branch: string; folder: { id: string; workdir: string; base_sha: string | null } }
export interface SessionFiles {
  read(id: WorkItemId): Promise<SessionFile | null>; list(): Promise<SessionFile[]>; write(file: SessionFile): Promise<void>; remove(id: WorkItemId): Promise<void>;
}

export interface SessionIssue { source: SourceRef; title: string; body: string; author: ExternalIdentity }
/** The configured repo's issue `number`, or null when there is none: `session start` creates its item. `type`: its items' source type. */
export interface IssueLookup { type: SourceType; issue(number: number): Promise<SessionIssue | null> }

/**
 * `toolEnv`: non-secret env for git and the test command. `owner`: the lease owner, `session:<host>:<pid>`, never a worker id.
 * `local`: the local broker and sandbox for local items, as the worker's (routeFor); absent: `broker` and `sandbox` serve every item.
 */
export interface SessionDeps {
  store: FactoryStore; sandbox: Sandbox; broker: ToolBroker; scanner: EgressScanner; auth: AuthProvider; clock: Clock; config: FactoryConfig; log: Logger;
  files: SessionFiles; issues: IssueLookup; toolEnv: Readonly<Record<string, string>>; owner: string; learned?: LearnedSettingsSource; local?: LocalRoute;
}

/** `ok: false`: refused, and nothing the command would write was written (a finish records its reasons only). */
export interface SessionResult { ok: boolean; lines: string[] }

export const SESSION_STARTED = "session_started";
const MAX_PR_FILES = 500;
const refused = (...lines: string[]): SessionResult => ({ ok: false, lines });
const LOCAL_NEEDS_LOCAL_BROKER = "a local item is committed only through the local broker, and this session was given only the forge's; nothing goes to the forge for it";

export class Sessions {
  constructor(private readonly d: SessionDeps) {}

  /** Opens a session on an issue number (`12`, `#12`) or a work item id, or refuses with nothing changed. */
  async start(o: { target: string; person: ExternalIdentity; spec?: string; transcript?: string }): Promise<SessionResult & { file?: SessionFile }> {
    const cfg = this.d.config;
    const settings = (project: string) => settingValues(project, cfg.settings, this.d.learned);
    // The spec first, with the triage parser: an invalid file refuses before anything is read or created.
    let spec = null;
    if (o.spec !== undefined) {
      const raw = jsonOrNull(o.spec);
      if (raw === null) return refused("refused: the --spec file is not JSON (use the triage output format)");
      const parsed = parseTriage(raw, settings(cfg.project.key));
      if (!parsed.ok) return refused(`refused: the --spec file is not a valid spec: ${parsed.error}`);
      if (parsed.value.phases) return refused("refused: the --spec file splits the work into phases; a session takes one spec");
      spec = parsed.value;
    }
    const transcript = o.transcript === undefined ? null : await this.transcript(o.transcript);
    if (transcript && "refuse" in transcript) return refused(transcript.refuse);

    const principal = await this.d.auth.resolve(o.person);
    if (!principal) return refused("refused: your account is not linked to a factory user");
    const allowed = await this.d.auth.authorize(principal, "approve_spec", { kind: "project", id: cfg.project.key });
    if (!allowed.allow) return refused(`refused: a session needs write permission on the repository (${allowed.reason})`);
    const actor = { kind: "user" as const, id: principal.user_id };

    const target = parseTarget(o.target);
    if (!target) return refused(`refused: ${JSON.stringify(o.target)} is neither an issue number nor a work item id`);
    let item = target.kind === "item"
      ? await this.d.store.getWorkItem(target.id)
      : await this.d.store.getWorkItemBySource(this.d.issues.type, `${cfg.repo.owner}/${cfg.repo.name}#${target.number}`);
    let created = false;
    if (!item && target.kind === "item") return refused(`refused: no work item ${target.id}`);
    if (!item && target.kind === "issue") {
      if (!spec) return refused(`refused: issue #${target.number} has no work item yet and a session needs allowed_paths: pass --spec <file>`);
      const issue = await this.d.issues.issue(target.number);
      if (!issue) return refused(`refused: there is no issue #${target.number} in ${cfg.repo.owner}/${cfg.repo.name}`);
      const author = await this.d.auth.resolve(issue.author);
      // Created as intake creates it, triage queued: if the start is refused below, triage goes on as usual.
      const fields = { source: issue.source, title: issue.title, requester_id: author?.user_id ?? principal.user_id, project: cfg.project.key, resources: [issue.source.link] };
      ({ item, created } = await this.d.store.createWorkItem({ ...fields, problem: `${issue.title}\n\n${issue.body}`.trim() }, actor, {
        enqueue: { kind: "triage", idempotency_key: `${issue.source.type}:${issue.source.id}:triage` },
      }));
    }
    const it = item!;
    const why = await this.startRefusal(it, spec !== null);
    if (why) return refused(`refused: ${why}`);

    // A NEW item takes the owner's spec (as triage would write it); a RUNNING one keeps its approved spec.
    const patch: WorkItemPatch = spec
      ? {
          problem: spec.problem, done_criteria: spec.done_criteria, desired_output: spec.desired_output, scope: spec.scope,
          allowed_paths: spec.allowed_paths, files_to_change: spec.files_to_change, stage: "RUNNING", blocked_on: "none", blocked_reason: null,
          tier: effectiveTier(spec.tier, floorTier(spec.allowed_paths, settings(it.project).floors), it.tier),
        }
      : { blocked_on: "none", blocked_reason: null };
    const source = spec ? "owner" : await this.specSource(it.id);
    if ((patch.allowed_paths ?? it.allowed_paths).length === 0) return refused("refused: the item has no allowed_paths, so a session could not pass the scope gate");

    const branch = branchFor(it, cfg.branch_prefix);
    const handle = await routeFor(this.d, it).sandbox.create({ repo: cfg.repo.path, branch, base_ref: cfg.repo.base_branch });
    const r = await this.d.store.startSession({ id: it.id, expected_version: it.version, actor, patch, reason: SESSION_STARTED, detail: { spec_source: source }, owner: this.d.owner, lease_ms: cfg.lease_ms, transcript_url: transcript?.url ?? null });
    if (!r.ok) {
      await this.d.sandbox.destroy(handle).catch(() => undefined);
      return refused(`refused: ${await this.storeRefusal(r)}`);
    }
    const file: SessionFile = { work_item_id: it.id, run_id: r.run.id, token: r.run.lease!.token, branch, folder: { id: handle.id, workdir: handle.workdir, base_sha: handle.base_sha ?? null } };
    await this.d.files.write(file);
    this.d.log.info("session started", { work_item_id: it.id, run_id: r.run.id, actor_id: actor.id, spec_source: source });
    const lines = [`session started on ${it.id} (${it.source.id}), run ${r.run.id}, actor ${actor.id}`, `spec: ${source}${r.cancelled.length > 0 ? "; the queued triage run was cancelled" : ""}`];
    lines.push(`branch: ${branch}`, `run folder: ${handle.workdir}`, `lease until ${r.run.lease!.expires_at}; kept while this runs. Ctrl-C: the lease expires and the item is released.`);
    return { ok: true, file, lines: [...(created ? [`created work item ${it.id} for ${it.source.id}`] : []), ...lines, `finish with: factory session finish ${it.id}`] };
  }

  private async startRefusal(item: WorkItem, withSpec: boolean): Promise<string | null> {
    const { stage, blocked_on: on } = item;
    if (this.forgeForLocal(item)) return LOCAL_NEEDS_LOCAL_BROKER;
    if (stage === "CLOSED") return `the item is closed (${item.close_reason ?? "no reason"})`;
    if (stage === "REVIEW") return `the item is in review${item.change_ref !== null ? ` (PR #${item.change_ref})` : ""}; send changes as \`/revise <feedback>\` on the PR`;
    if (stage === "READY") return "the item waits for its spec to be approved: reply `/approve` on the issue first (or `/revise` to change the spec)";
    if (stage === "NEW" && on !== "none") return `the item is held (${on}: ${item.blocked_reason ?? ""})`;
    if (stage === "NEW" && !withSpec) return "the item has no spec yet: pass --spec <file>, or wait for triage and `/approve`";
    if (stage === "RUNNING" && on !== "none" && on !== "human") return `the item is blocked on ${on} (${item.blocked_reason ?? ""})`;
    if (stage !== "NEW" && withSpec) return "the item already has an approved spec; --spec applies only to a NEW item";
    const runs = await this.d.store.listRuns(item.id);
    const open = runs.find((r) => r.kind === INTERACTIVE && r.status === "running");
    if (open) return `the item already has an open session (run ${open.id})`;
    const w = runs.find((r) => IMPLEMENT_KINDS.includes(r.kind) && (r.status === "queued" || r.status === "running"));
    return w ? `the item has a ${w.status} ${w.kind} run (${w.id}); a session and a worker never write one branch` : null;
  }

  private async storeRefusal(r: Exclude<StartSessionResult, { ok: true }>): Promise<string> {
    if (r.reason === "overlap") {
      const other = await this.d.store.getWorkItem(r.work_item_id);
      return `running work on ${other?.source.id ?? r.work_item_id} (run ${r.run_id}) overlaps the allowed_paths: ${r.paths.join(", ")}`;
    }
    if (r.reason === "not_found" || r.reason === "version_conflict") return "the item changed while the session was starting; run the command again";
    return r.reason === "session_open" ? `the item already has an open session (run ${r.run_id})` : `the item has an implement-type run (${r.run_id})`;
  }

  /** `owner` when the item's spec was set by a session start, else `triage`. */
  private async specSource(id: WorkItemId): Promise<"owner" | "triage"> {
    const last = (await this.d.store.listStateChanges(id)).filter((c) => c.changes.done_criteria !== undefined).at(-1);
    return last?.reason === SESSION_STARTED ? "owner" : "triage";
  }

  /**
   * Keeps the lease until `signal` aborts ("stopped") or a renewal is refused ("ended": finished, abandoned, reaped
   * or cancelled elsewhere). Stopping does not end the run: its lease runs out and the reaper writes `session_lost`.
   */
  async heartbeat(file: SessionFile, signal: AbortSignal): Promise<"stopped" | "ended"> {
    while (await this.d.clock.sleep(this.d.config.heartbeat_ms, signal).then(() => true, () => false)) {
      if ((await this.d.store.heartbeat(file.run_id, file.token, this.d.config.lease_ms)).ok) continue;
      await this.d.files.remove(file.work_item_id);
      return "ended";
    }
    return "stopped";
  }

  async status(id?: WorkItemId): Promise<SessionResult> {
    const f = await this.pick(id);
    if ("refuse" in f) return refused(f.refuse);
    const [run, item] = [await this.d.store.getRun(f.file.run_id), await this.d.store.getWorkItem(f.file.work_item_id)];
    if (!run || !item) return refused("the session's run or item is gone from the store");
    const last = run.last_finish;
    const blocked = item.blocked_on !== "none" ? `, blocked on ${item.blocked_on}: ${item.blocked_reason ?? ""}` : "";
    const finish = !last ? "none yet" : last.ok ? `${last.at} passed, PR #${last.pr_number}` : `${last.at} refused: ${last.reasons.join("; ")}`;
    return { ok: true, lines: [
      `item: ${item.id} (${item.source.id}) ${item.stage}${blocked}`, `run: ${run.id} ${run.status}, actor ${run.actor_id ?? "unknown"}`,
      `lease: ${run.lease ? `expires ${run.lease.expires_at}` : "none (the session has ended)"}`, `branch: ${f.file.branch}; run folder: ${f.file.folder.workdir}`,
      `tokens: ${run.session_tokens ?? "none reported"}; notes: ${run.session_notes.length}; transcript: ${run.transcript_url ?? "none"}`, `last finish: ${finish}`,
    ] };
  }

  /** A note (egress-scanned), `--tokens` and/or `--transcript` on the open session. A finding stores nothing. */
  async note(o: { id?: WorkItemId; text?: string; tokens?: number; transcript?: string }): Promise<SessionResult> {
    if (o.text === undefined && o.tokens === undefined && o.transcript === undefined) return refused("refused: give a note text, --tokens or --transcript");
    const open = await this.open(o.id);
    if ("refuse" in open) return refused(open.refuse);
    const update: SessionUpdate = {};
    if (o.text !== undefined) {
      const text = o.text.trim();
      if (!text) return refused("refused: the note is empty");
      const scan = await this.d.scanner.scan("comment", text);
      if (!scan.clean) return refused(`refused: the note was blocked by the leak scanner (${scan.findings.map((x) => x.rule).join(", ")}); nothing was stored`);
      update.note = text;
    }
    if (o.tokens !== undefined && !isTokenCount(o.tokens)) return refused("refused: --tokens takes a whole number of 0 or more");
    if (o.tokens !== undefined) update.tokens = o.tokens;
    if (o.transcript !== undefined) {
      const t = await this.transcript(o.transcript);
      if ("refuse" in t) return refused(t.refuse);
      update.transcript_url = t.url;
    }
    const r = await this.d.store.updateSession(open.file.run_id, open.file.token, update);
    return r.ok ? { ok: true, lines: [`stored on run ${r.run.id}: ${Object.keys(update).join(", ")}`] } : refused("refused: the session has ended; nothing was stored");
  }

  /**
   * The gates in order: scope, size, floor, then `repo.test_command` in the run folder (skipped after a failed gate).
   * A failure lists the reasons, records them as the last finish, keeps the session open and pushes nothing. All
   * pass: push and PR through the item's broker only (a local item: its local branch, no PR), then the run completes
   * as succeeded and the controller moves the item to REVIEW with a review run. Safe to run again after a failed
   * push: the broker reuses the branch's open PR.
   */
  async finish(o: { id?: WorkItemId; tokens?: number; signal?: AbortSignal }): Promise<SessionResult> {
    const open = await this.tokens(o);
    if ("refuse" in open) return refused(open.refuse);
    const { file, item } = open;
    const stored: SandboxHandle = { id: file.folder.id, workdir: file.folder.workdir };
    const handle = this.d.sandbox.reattach ? await this.d.sandbox.reattach(file.folder.id) : stored;
    if (!handle) return refused(`refused: the run folder ${file.folder.workdir} is gone`);
    const git = (args: string[]) => this.git(handle, args);
    const cfg = this.d.config;
    const reasons: string[] = [];
    let paths: string[] = [];
    let commits = 0;
    try {
      const base = file.folder.base_sha ?? (await git(["rev-parse", "--verify", "--end-of-options", `origin/${cfg.repo.base_branch}^{commit}`])).trim();
      const dirty = await git(["status", "--porcelain", "-z", "--untracked-files=normal"]);
      if (dirty.replace(/\0/g, "").trim() !== "") reasons.push("uncommitted changes in the run folder: commit or remove them (only commits are pushed)");
      commits = (await git(["rev-list", `${base}..HEAD`])).split("\n").filter(Boolean).length;
      if (commits === 0) reasons.push("no commits on the branch");
      const outside = await scopeGate(git, base, item.allowed_paths);
      if (outside.length > 0) reasons.push(`scope: files outside allowed_paths: ${outside.join(", ")}`);
      const gates = await diffGates(git, base, item, settingValues(item.project, cfg.settings, this.d.learned));
      paths = gates.paths;
      if (gates.size !== null) reasons.push(`size: ${gates.size}`);
      if (gates.floor) {
        const hit = gates.floor.map((h) => h.path).join(", ");
        reasons.push(`floor: ${hit} need tier ${requiredTier(gates.floor)} (the item is tier ${item.tier ?? 1}); a session cannot raise the tier`);
      }
    } catch (err) {
      return this.refuseFinish(file, [`git: ${err instanceof NumstatError || err instanceof GitError ? err.message : "git failed"}`.slice(0, 500)]);
    }
    const test = commandText(cfg.repo.test_command);
    if (reasons.length > 0) return this.refuseFinish(file, reasons, [`tests: \`${test}\` not run (an earlier gate failed)`]);
    const signal = o.signal ?? new AbortController().signal;
    const checked = await runChecks({ sandbox: this.d.sandbox, handle, commands: [cfg.repo.test_command], env: { ...this.d.toolEnv }, timeout_ms: cfg.run_timeout_ms, signal, redact: [] });
    if (o.signal?.aborted) return this.refuseFinish(file, ["tests: stopped before they finished"]);
    if (checked.failed) return this.refuseFinish(file, [`tests: \`${test}\` ${checked.failed.how}`]);

    if (this.forgeForLocal(item)) return this.refuseFinish(file, [LOCAL_NEEDS_LOCAL_BROKER]);
    // Every gate passed: push and PR through the broker, which fences on this run's lease and scans what it sends.
    const ctx: ToolCallContext = { run_id: file.run_id, work_item_id: item.id, lease_token: file.token };
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const { broker } = routeFor(this.d, item);
    const pushed = await broker.call(ctx, "github.push_branch", { workdir: handle.workdir, branch: file.branch, base_ref: cfg.repo.base_branch });
    if (!pushed.ok) return this.refuseFinish(file, [`push: ${pushed.error_code}: ${pushed.message}`.slice(0, 500)]);
    // The factory's own push, so the next poll does not take it for a person's (design 2026-11-01).
    if (!(await this.d.store.recordPushedHead(file.run_id, file.token, head)).ok) return refused("refused: the session ended while pushing");
    const lines = checkedLines(checked.results, { fixed: false, skipped: null });
    const body = prBody(item, (await this.d.store.getRun(file.run_id))!, lines);
    // A broker with no PR tool (the local one): the local branch is the review's input and `factory merge` its merge.
    let number: number | null = null;
    let pr_url: string | null = null;
    if (hasTool(broker, "github.open_pr")) {
      const pr = await broker.call(ctx, "github.open_pr", { branch: file.branch, base_ref: cfg.repo.base_branch, title: prTitle(item), body });
      if (!pr.ok) return this.refuseFinish(file, [`pr: ${pr.error_code}: ${pr.message}`.slice(0, 500)]);
      const opened = pr.content as { number?: unknown; url?: unknown };
      number = Number(opened.number);
      // The forge's PR link, stored as the item's change_url (design 02).
      pr_url = typeof opened.url === "string" ? opened.url : null;
    }
    await this.d.store.updateSession(file.run_id, file.token, { last_finish: { ok: true, reasons: [], pr_number: number } });
    const done = await this.d.store.completeRun(file.run_id, file.token, { status: "succeeded", summary: "interactive session finished", data: { pr_number: number, pr_url, commits, files: paths.slice(0, MAX_PR_FILES) } });
    if (!done.ok) return refused(`refused: the session ended before it could complete; ${number === null ? "the branch is committed" : "the PR is open"}`);
    await this.d.files.remove(item.id);
    await this.d.sandbox.destroy(handle).catch(() => undefined); // everything in it is on its branch now
    this.d.log.info("session finished", { work_item_id: item.id, run_id: file.run_id, pr_number: number });
    const sent = number === null ? `committed the local branch ${file.branch} (no push, no PR)` : `pushed ${file.branch} and opened PR #${number}`;
    return { ok: true, lines: [...lines, `${sent}; the item goes to review next`] };
  }

  /** The run fails `abandoned`; the controller releases the item. The remote branch and the run folder are kept. */
  async abandon(o: { id?: WorkItemId; tokens?: number }): Promise<SessionResult> {
    const open = await this.tokens(o);
    if ("refuse" in open) return refused(open.refuse);
    const { file } = open;
    const done = await this.d.store.completeRun(file.run_id, file.token, { status: "failed", error_code: SESSION_ABANDONED, detail: "the person abandoned the session", infra: false });
    if (!done.ok) return refused("refused: the session has already ended");
    await this.d.files.remove(file.work_item_id);
    return { ok: true, lines: [`abandoned the session on ${file.work_item_id}; the controller releases the item (${SESSION_RELEASED})`, `the remote branch ${file.branch}, if pushed, and the run folder ${file.folder.workdir} are kept`] };
  }

  private async refuseFinish(file: SessionFile, reasons: string[], lines: string[] = []): Promise<SessionResult> {
    await this.d.store.updateSession(file.run_id, file.token, { last_finish: { ok: false, reasons, pr_number: null } });
    return refused(...lines, "finish refused; the session stays open and nothing was pushed:", ...reasons.map((r) => `- ${r}`));
  }

  /** Whether a local item would reach the forge's broker: no local route given and the broker opens PRs. Never allowed. */
  private forgeForLocal(item: WorkItem): boolean {
    const route = routeFor(this.d, item);
    return route.local && hasTool(route.broker, "github.open_pr");
  }

  /** The one session meant: `id`, else the only open one on this machine. */
  private async pick(id?: WorkItemId): Promise<{ file: SessionFile } | { refuse: string }> {
    const all = id ? [await this.d.files.read(id)].filter((f) => f !== null) : await this.d.files.list();
    if (all.length === 0) return { refuse: `no open session${id ? ` on ${id}` : ""} on this machine` };
    if (all.length > 1) return { refuse: `several open sessions; name one: ${all.map((f) => f.work_item_id).join(", ")}` };
    return { file: all[0]! };
  }

  /** The session, still running with our token; an ended one is forgotten locally and refused. */
  private async open(id?: WorkItemId): Promise<{ file: SessionFile; run: Run; item: WorkItem } | { refuse: string }> {
    const f = await this.pick(id);
    if ("refuse" in f) return { refuse: `refused: ${f.refuse}` };
    const [run, item] = [await this.d.store.getRun(f.file.run_id), await this.d.store.getWorkItem(f.file.work_item_id)];
    if (run && item && run.status === "running" && run.lease?.token === f.file.token) return { file: f.file, run, item };
    await this.d.files.remove(f.file.work_item_id);
    return { refuse: `refused: the session on ${f.file.work_item_id} has already ended${run ? ` (${run.status})` : ""}` };
  }

  /** open(), then `--tokens` stored as the run's latest total. */
  private async tokens(o: { id?: WorkItemId; tokens?: number }) {
    const open = await this.open(o.id);
    if ("refuse" in open || o.tokens === undefined) return open;
    if (!isTokenCount(o.tokens)) return { refuse: "refused: --tokens takes a whole number of 0 or more" };
    const t = await this.d.store.updateSession(open.file.run_id, open.file.token, { tokens: o.tokens });
    return t.ok ? open : { refuse: "refused: the session has ended" };
  }

  /** Trusted git in the run folder: the env ranks above the folder's own git config, as for the worker's calls. */
  private async git(handle: SandboxHandle, args: string[]): Promise<string> {
    const r = await this.d.sandbox.exec(handle, ["git", ...args], { env: { ...this.d.toolEnv, ...TRUSTED_GIT_ENV } });
    if (r.exit_code !== 0) throw new GitError(`git ${args[0] ?? ""}: ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** An http or https URL that scans clean, or why not. */
  private async transcript(raw: string): Promise<{ url: string } | { refuse: string }> {
    const url = URL.canParse(raw.trim()) ? new URL(raw.trim()) : null;
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return { refuse: "refused: --transcript takes an http or https URL" };
    const scan = await this.d.scanner.scan("comment", url.href);
    if (scan.clean) return { url: url.href };
    return { refuse: `refused: the transcript URL was blocked by the leak scanner (${scan.findings.map((x) => x.rule).join(", ")}); nothing was stored` };
  }
}

class GitError extends Error {}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `12`, `#12` → an issue number; `wi_…` → a work item id. */
export function parseTarget(s: string): { kind: "issue"; number: number } | { kind: "item"; id: WorkItemId } | null {
  const t = s.trim();
  const n = /^#?(\d+)$/.exec(t);
  if (n) return { kind: "issue", number: Number(n[1]) };
  return /^wi_[A-Za-z0-9]+$/.test(t) ? { kind: "item", id: t as WorkItemId } : null;
}

export function isTokenCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}


function prBody(item: WorkItem, run: Run, checked: string[]): string {
  const issue = item.source.id.split("#")[1];
  const notes = run.session_notes.slice(-20).map((n) => `- ${n.text.replace(/\s+/g, " ").slice(0, 300)}`);
  return [
    `Made in an interactive session by \`${run.actor_id ?? "unknown"}\` (design §5, 2026-11-01). It passed the scope, size and floor gates and the test command before this push.`,
    ...(notes.length ? ["", "Session notes:", ...notes] : []),
    ...(run.transcript_url ? ["", `Transcript: ${run.transcript_url}`] : []),
    "", ...checked, "",
    ...(issue ? [`Closes #${issue}`, ""] : []),
    `Work item: \`${item.id}\``,
  ].join("\n");
}
