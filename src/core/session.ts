import { checkedLines, commandText, runChecks } from "./checks.js";
import type { FactoryConfig } from "./config.js";
import { requiredTier } from "./diff-gate.js";
import type { Logger } from "./log.js";
import { parseTriage } from "./outputs.js";
import {
  IMPLEMENT_KINDS, INTERACTIVE, SESSION_ABANDONED, SESSION_RELEASED, branchFor, effectiveTier, floorTier,
} from "./policy.js";
import { NumstatError, diffGates, scopeGate } from "./pre-push.js";
import { type LearnedSettingsSource, settingValues } from "./settings.js";
import type { Run, RunId, SourceRef, WorkItem, WorkItemId, WorkItemPatch } from "./types.js";
import { TRUSTED_GIT_ENV } from "./worker.js";
import type { AuthProvider, ExternalIdentity } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, SessionUpdate } from "../interfaces/factory-store.js";
import type { Sandbox, SandboxHandle } from "../interfaces/sandbox.js";
import type { ToolBroker, ToolCallContext } from "../interfaces/tool-broker.js";

// `factory session` (design §5, 2026-11-01): work the owner does with an LLM in their own terminal, recorded as
// one `interactive` run on a work item. `start` takes the item (lease, run folder on the item's branch), `note`
// records notes, tokens and a transcript link, `finish` runs the same pre-push gates as a worker (scope, size,
// floor) plus `repo.test_command`, then pushes and opens the PR only through the broker, and `abandon` ends it.
// The controller applies the end like any run outcome. The session's LLM runs as the owner, outside the run-folder
// rule: the design records that as an exception, and these gates at finish are what the factory checks.

/** The local record of an open session, kept under state_dir by the CLI. A fencing token, never a credential. */
export interface SessionFile {
  work_item_id: WorkItemId;
  run_id: RunId;
  /** The run's lease token: every write on the run is fenced by it. */
  token: number;
  branch: string;
  folder: { id: string; workdir: string; base_sha: string | null };
}

/** Where open sessions are recorded on this machine, keyed by item id. */
export interface SessionFiles {
  read(id: WorkItemId): Promise<SessionFile | null>;
  list(): Promise<SessionFile[]>;
  write(file: SessionFile): Promise<void>;
  remove(id: WorkItemId): Promise<void>;
}

/** An issue as `session start` needs it to create its work item. */
export interface SessionIssue {
  source: SourceRef;
  title: string;
  body: string;
  author: ExternalIdentity;
}

export interface IssueLookup {
  /** The issue with this number in the configured repo, or null when there is none. */
  issue(number: number): Promise<SessionIssue | null>;
}

export interface SessionDeps {
  store: FactoryStore;
  sandbox: Sandbox;
  broker: ToolBroker;
  scanner: EgressScanner;
  auth: AuthProvider;
  clock: Clock;
  config: FactoryConfig;
  log: Logger;
  files: SessionFiles;
  issues: IssueLookup;
  /** Non-secret env for git and the test command in the run folder (PATH etc.). */
  toolEnv: Readonly<Record<string, string>>;
  /** The lease owner of sessions this process starts, e.g. `session:<host>:<pid>`. Never a worker id. */
  owner: string;
  learned?: LearnedSettingsSource;
}

/** What every command prints, line by line. `ok: false`: refused, and nothing it would have written was written. */
export interface SessionResult {
  ok: boolean;
  lines: string[];
}

export interface StartInput {
  /** An issue number (`12` or `#12`) or a work item id. */
  target: string;
  /** The person, as their GitHub account: mapped to a user ID the way commands map commenters. */
  person: ExternalIdentity;
  /** The text of `--spec <file>`: the triage output format, checked by the same parser. */
  spec?: string;
  transcript?: string;
}

export interface NoteInput {
  id?: WorkItemId;
  text?: string;
  tokens?: number;
  transcript?: string;
}

export interface EndInput {
  id?: WorkItemId;
  tokens?: number;
  /** Stops the test command (Ctrl-C). Absent: never. */
  signal?: AbortSignal;
}

/** The state change reason of a session start. */
export const SESSION_STARTED = "session_started";
/** Where a session's spec came from, recorded on the start's state change. */
export type SpecSource = "owner" | "triage";

/** Files of a PR kept as its pr_files, as the worker does. */
const MAX_PR_FILES = 500;
/** Notes listed in the PR body. */
const PR_NOTES = 20;

const refused = (...lines: string[]): SessionResult => ({ ok: false, lines });

export class Sessions {
  constructor(private readonly d: SessionDeps) {}

  // start

  /**
   * Takes the item for a session, or refuses with nothing changed. On success the session is open: its run is
   * running with a lease, its folder exists, and `file` is recorded. The caller keeps the lease with `heartbeat`.
   */
  async start(o: StartInput): Promise<SessionResult & { file?: SessionFile }> {
    const cfg = this.d.config;
    const settings = (it: { project: string }) => settingValues(it.project, cfg.settings, this.d.learned);

    // The spec first: an invalid file refuses before anything is read or created.
    let spec: ReturnType<typeof parseTriage> | null = null;
    if (o.spec !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(o.spec);
      } catch {
        return refused("refused: the --spec file is not JSON (use the triage output format)");
      }
      const s = settings({ project: cfg.project.key });
      spec = parseTriage(raw, { max_diff_lines: s.max_diff_lines, max_diff_files: s.max_diff_files });
      if (!spec.ok) return refused(`refused: the --spec file is not a valid spec: ${spec.error}`);
      if (spec.value.phases) return refused("refused: the --spec file splits the work into phases; a session takes one spec, not phases");
    }
    let transcript: string | null = null;
    if (o.transcript !== undefined) {
      const t = await this.transcript(o.transcript);
      if ("refuse" in t) return refused(t.refuse);
      transcript = t.url;
    }

    const principal = await this.d.auth.resolve(o.person);
    if (!principal) return refused("refused: your GitHub account is not linked to a factory user");
    const allowed = await this.d.auth.authorize(principal, "approve_spec", { kind: "project", id: cfg.project.key });
    if (!allowed.allow) return refused(`refused: a session needs write permission on the repository (${allowed.reason})`);
    const actor = { kind: "user" as const, id: principal.user_id };

    const target = parseTarget(o.target);
    if (!target) return refused(`refused: ${JSON.stringify(o.target)} is neither an issue number nor a work item id`);
    let item: WorkItem | null;
    let created = false;
    if (target.kind === "item") {
      item = await this.d.store.getWorkItem(target.id);
      if (!item) return refused(`refused: no work item ${target.id}`);
    } else {
      item = await this.d.store.getWorkItemBySource("github_issue", `${cfg.repo.owner}/${cfg.repo.name}#${target.number}`);
      if (!item) {
        // A new item needs a spec to start: without one it would have no allowed_paths.
        if (!spec) return refused(`refused: issue #${target.number} has no work item yet and a session needs allowed_paths: pass --spec <file>`);
        const issue = await this.d.issues.issue(target.number);
        if (!issue) return refused(`refused: there is no issue #${target.number} in ${cfg.repo.owner}/${cfg.repo.name}`);
        const author = await this.d.auth.resolve(issue.author);
        // Created as intake creates it, triage queued: if the start is refused below, triage simply goes on.
        const r = await this.d.store.createWorkItem(
          {
            source: issue.source,
            title: issue.title,
            requester_id: author?.user_id ?? principal.user_id,
            project: cfg.project.key,
            problem: `${issue.title}\n\n${issue.body}`.trim(),
            resources: [issue.source.link],
          },
          actor,
          { enqueue: { kind: "triage", idempotency_key: `${issue.source.type}:${issue.source.id}:triage` } },
        );
        item = r.item;
        created = r.created;
      }
    }

    const why = await this.startRefusal(item, spec !== null);
    if (why) return refused(`refused: ${why}`);

    let patch: WorkItemPatch;
    let source: SpecSource;
    if (item.stage === "NEW") {
      const v = spec!.ok ? spec!.value : null;
      if (!v) return refused("refused: the --spec file is not a valid spec");
      const tier = effectiveTier(v.tier, floorTier(v.allowed_paths, settings(item).floors), item.tier);
      patch = {
        problem: v.problem,
        done_criteria: v.done_criteria,
        desired_output: v.desired_output,
        scope: v.scope,
        allowed_paths: v.allowed_paths,
        files_to_change: v.files_to_change,
        tier,
        stage: "RUNNING",
        blocked_on: "none",
        blocked_reason: null,
      };
      source = "owner";
    } else {
      patch = { blocked_on: "none", blocked_reason: null };
      source = await this.specSource(item.id);
    }
    const paths = patch.allowed_paths ?? item.allowed_paths;
    if (paths.length === 0) return refused("refused: the item has no allowed_paths, so a session could not pass the scope gate");

    const branch = branchFor(item, cfg.branch_prefix);
    const handle = await this.d.sandbox.create({ repo: cfg.repo.path, branch, base_ref: cfg.repo.base_branch });
    const r = await this.d.store.startSession({
      id: item.id,
      expected_version: item.version,
      actor,
      patch,
      reason: SESSION_STARTED,
      detail: { spec_source: source },
      owner: this.d.owner,
      lease_ms: cfg.lease_ms,
      transcript_url: transcript,
    });
    if (!r.ok) {
      await this.d.sandbox.destroy(handle).catch(() => undefined);
      return refused(`refused: ${await this.storeRefusal(r)}`);
    }
    const file: SessionFile = {
      work_item_id: item.id,
      run_id: r.run.id,
      token: r.run.lease!.token,
      branch,
      folder: { id: handle.id, workdir: handle.workdir, base_sha: handle.base_sha ?? null },
    };
    await this.d.files.write(file);
    this.d.log.info("session started", { work_item_id: item.id, run_id: r.run.id, actor_id: actor.id, spec_source: source });
    return {
      ok: true,
      file,
      lines: [
        ...(created ? [`created work item ${item.id} for ${item.source.id}`] : []),
        `session started on ${item.id} (${item.source.id}), run ${r.run.id}, actor ${actor.id}`,
        `spec: ${source}${r.cancelled.length > 0 ? `; the queued triage run was cancelled` : ""}`,
        `branch: ${branch}`,
        `run folder: ${handle.workdir}`,
        `lease until ${r.run.lease!.expires_at}; this command keeps it while it runs. Ctrl-C stops it: the lease then expires and the item is released.`,
        `finish with: factory session finish ${item.id}`,
      ],
    };
  }

  /** Why the item cannot take a session now, or null. Reads only. */
  private async startRefusal(item: WorkItem, withSpec: boolean): Promise<string | null> {
    if (item.stage === "CLOSED") return `the item is closed (${item.close_reason ?? "no reason"})`;
    if (item.stage === "REVIEW") {
      return `the item is in review${item.pr_number !== null ? ` (PR #${item.pr_number})` : ""}; send changes as \`/revise <feedback>\` on the PR`;
    }
    if (item.stage === "READY") {
      return "the item waits for its spec to be approved: reply `/approve` on the issue first (or `/revise` to change the spec)";
    }
    if (item.stage === "NEW" && item.blocked_on !== "none") return `the item is held (${item.blocked_on}: ${item.blocked_reason ?? ""})`;
    if (item.stage === "NEW" && !withSpec) return "the item has no spec yet: pass --spec <file>, or wait for triage and `/approve`";
    if (item.stage === "RUNNING" && item.blocked_on !== "none" && item.blocked_on !== "human") {
      return `the item is blocked on ${item.blocked_on} (${item.blocked_reason ?? ""})`;
    }
    if (item.stage !== "NEW" && withSpec) return "the item already has an approved spec; --spec applies only to a NEW item";
    const runs = await this.d.store.listRuns(item.id);
    const open = runs.find((r) => r.kind === INTERACTIVE && r.status === "running");
    if (open) return `the item already has an open session (run ${open.id})`;
    const writer = runs.find((r) => IMPLEMENT_KINDS.includes(r.kind) && (r.status === "queued" || r.status === "running"));
    if (writer) return `the item has a ${writer.status} ${writer.kind} run (${writer.id}); a session and a worker never write one branch`;
    return null;
  }

  private async storeRefusal(r: Exclude<Awaited<ReturnType<FactoryStore["startSession"]>>, { ok: true }>): Promise<string> {
    switch (r.reason) {
      case "not_found":
        return "the item is gone";
      case "version_conflict":
        return "the item changed while the session was starting; run the command again";
      case "session_open":
        return `the item already has an open session (run ${r.run_id})`;
      case "implement_run":
        return `the item has an implement-type run (${r.run_id}); a session and a worker never write one branch`;
      case "overlap": {
        const other = await this.d.store.getWorkItem(r.work_item_id);
        return `running work on ${other?.source.id ?? r.work_item_id} (run ${r.run_id}) overlaps the allowed_paths: ${r.paths.join(", ")}`;
      }
    }
  }

  /** `owner` when the item's spec was set by a session start, else `triage`. */
  private async specSource(id: WorkItemId): Promise<SpecSource> {
    const last = (await this.d.store.listStateChanges(id)).filter((c) => c.changes.done_criteria !== undefined).at(-1);
    return last?.reason === SESSION_STARTED ? "owner" : "triage";
  }

  /**
   * Keeps the lease until `signal` aborts ("stopped") or the store refuses a renewal ("ended": finished,
   * abandoned, reaped or cancelled elsewhere). Stopping does not end the run: its lease runs out and the reaper
   * ends it as `session_lost`.
   */
  async heartbeat(file: SessionFile, signal: AbortSignal): Promise<"stopped" | "ended"> {
    while (!signal.aborted) {
      try {
        await this.d.clock.sleep(this.d.config.heartbeat_ms, signal);
      } catch {
        return "stopped";
      }
      const r = await this.d.store.heartbeat(file.run_id, file.token, this.d.config.lease_ms);
      if (!r.ok) {
        await this.d.files.remove(file.work_item_id);
        return "ended";
      }
    }
    return "stopped";
  }

  // status, note

  async status(id?: WorkItemId): Promise<SessionResult> {
    const f = await this.pick(id);
    if ("refuse" in f) return refused(f.refuse);
    const run = await this.d.store.getRun(f.file.run_id);
    const item = await this.d.store.getWorkItem(f.file.work_item_id);
    if (!run || !item) return refused(`the session's ${run ? "item" : "run"} is gone from the store`);
    const last = run.last_finish;
    return {
      ok: true,
      lines: [
        `item: ${item.id} (${item.source.id}) ${item.stage}${item.blocked_on !== "none" ? `, blocked on ${item.blocked_on}: ${item.blocked_reason ?? ""}` : ""}`,
        `run: ${run.id} ${run.status}, actor ${run.actor_id ?? "unknown"}`,
        `lease: ${run.lease ? `expires ${run.lease.expires_at}` : "none (the session has ended)"}`,
        `branch: ${f.file.branch}`,
        `run folder: ${f.file.folder.workdir}`,
        `tokens: ${run.session_tokens ?? "none reported"}; notes: ${run.session_notes.length}; transcript: ${run.transcript_url ?? "none"}`,
        last === null
          ? "last finish: none yet"
          : last.ok
            ? `last finish: ${last.at} passed${last.pr_number !== null ? `, PR #${last.pr_number}` : ""}`
            : `last finish: ${last.at} refused: ${last.reasons.join("; ")}`,
      ],
    };
  }

  /** `session note`: a note (egress-scanned), and/or `--tokens`, and/or `--transcript`. A finding stores nothing. */
  async note(o: NoteInput): Promise<SessionResult> {
    if (o.text === undefined && o.tokens === undefined && o.transcript === undefined) {
      return refused("refused: give a note text, --tokens or --transcript");
    }
    const open = await this.open(o.id);
    if ("refuse" in open) return refused(open.refuse);
    const update: SessionUpdate = {};
    if (o.text !== undefined) {
      const text = o.text.trim();
      if (!text) return refused("refused: the note is empty");
      const scan = await this.d.scanner.scan("comment", text);
      if (!scan.clean) {
        return refused(`refused: the note was blocked by the leak scanner (${scan.findings.map((x) => x.rule).join(", ")}); nothing was stored`);
      }
      update.note = text;
    }
    if (o.tokens !== undefined) {
      if (!isTokenCount(o.tokens)) return refused("refused: --tokens takes a whole number of 0 or more");
      update.tokens = o.tokens;
    }
    if (o.transcript !== undefined) {
      const t = await this.transcript(o.transcript);
      if ("refuse" in t) return refused(t.refuse);
      update.transcript_url = t.url;
    }
    const r = await this.d.store.updateSession(open.file.run_id, open.file.token, update);
    if (!r.ok) return refused("refused: the session has ended; nothing was stored");
    return { ok: true, lines: [`stored on run ${r.run.id}${update.note ? ": note" : ""}${update.tokens !== undefined ? `, tokens ${update.tokens}` : ""}${update.transcript_url ? ", transcript" : ""}`] };
  }

  // finish, abandon

  /**
   * The gates in order: scope, size, floor, then `repo.test_command` in the run folder. Any failure lists the
   * reasons, records them as the last finish, keeps the session open and pushes nothing. All pass: push and PR
   * through the broker only, then the run completes as succeeded; the controller moves the item to REVIEW and
   * queues its review run. Safe to run again after a failed push: the broker reuses the branch's open PR.
   */
  async finish(o: EndInput): Promise<SessionResult> {
    const open = await this.open(o.id);
    if ("refuse" in open) return refused(open.refuse);
    const { file, item } = open;
    if (o.tokens !== undefined) {
      if (!isTokenCount(o.tokens)) return refused("refused: --tokens takes a whole number of 0 or more");
      const t = await this.d.store.updateSession(file.run_id, file.token, { tokens: o.tokens });
      if (!t.ok) return refused("refused: the session has ended");
    }
    const handle = await this.handle(file);
    if (!handle) return refused(`refused: the run folder ${file.folder.workdir} is gone`);
    const git = (args: string[]) => this.git(handle, args);
    const cfg = this.d.config;
    const s = settingValues(item.project, cfg.settings, this.d.learned);

    const reasons: string[] = [];
    const lines: string[] = [];
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
      const gates = await diffGates(git, base, item, s);
      paths = gates.paths;
      if (gates.size !== null) reasons.push(`size: ${gates.size}`);
      if (gates.floor) {
        const need = requiredTier(gates.floor);
        reasons.push(
          `floor: ${gates.floor.map((h) => h.path).join(", ")} need tier ${need} (the item is tier ${item.tier ?? 1}); a session cannot raise the tier`,
        );
      }
    } catch (err) {
      const why = err instanceof NumstatError || err instanceof GitError ? err.message : "git failed";
      return this.refuseFinish(file, [`git: ${why}`.slice(0, 500)]);
    }
    let checked: Awaited<ReturnType<typeof runChecks>> | null = null;
    if (reasons.length === 0) {
      checked = await runChecks({
        sandbox: this.d.sandbox,
        handle,
        commands: [cfg.repo.test_command],
        env: { ...this.d.toolEnv },
        timeout_ms: cfg.run_timeout_ms,
        signal: o.signal ?? new AbortController().signal,
        redact: [],
      });
      if (o.signal?.aborted) return this.refuseFinish(file, ["tests: stopped before they finished"]);
      if (checked.failed) reasons.push(`tests: \`${commandText(checked.failed.command)}\` ${checked.failed.how}`);
    } else {
      lines.push(`tests: \`${commandText(cfg.repo.test_command)}\` not run (an earlier gate failed)`);
    }
    if (reasons.length > 0) return this.refuseFinish(file, reasons, lines);

    // Every gate passed: push and PR through the broker, which fences on this run's lease and scans what it sends.
    const ctx: ToolCallContext = { run_id: file.run_id, work_item_id: item.id, lease_token: file.token };
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const pushed = await this.d.broker.call(ctx, "github.push_branch", { workdir: handle.workdir, branch: file.branch, base_ref: cfg.repo.base_branch });
    if (!pushed.ok) return this.refuseFinish(file, [`push: ${pushed.error_code}: ${pushed.message}`.slice(0, 500)]);
    // The factory's own push, so the next poll does not record it as a person's (design 2026-11-01).
    const rec = await this.d.store.recordPushedHead(file.run_id, file.token, head);
    if (!rec.ok) return refused("refused: the session ended while pushing; the branch is on the forge, nothing else changed");
    const run = (await this.d.store.getRun(file.run_id))!;
    const pr = await this.d.broker.call(ctx, "github.open_pr", {
      branch: file.branch,
      base_ref: cfg.repo.base_branch,
      title: prTitle(item),
      body: prBody(item, run, checked ? checkedLines(checked.results, { fixed: false, skipped: null }) : []),
    });
    if (!pr.ok) return this.refuseFinish(file, [`pr: ${pr.error_code}: ${pr.message}`.slice(0, 500)]);
    const number = Number((pr.content as { number?: unknown }).number);
    await this.d.store.updateSession(file.run_id, file.token, { last_finish: { ok: true, reasons: [], pr_number: number } });
    const done = await this.d.store.completeRun(file.run_id, file.token, {
      status: "succeeded",
      summary: "interactive session finished",
      data: { pr_number: number, commits, files: paths.slice(0, MAX_PR_FILES) },
    });
    if (!done.ok) return refused("refused: the session ended before it could complete; the PR is open, run `factory session status`");
    await this.d.files.remove(item.id);
    // Everything in the folder is on the forge now.
    await this.d.sandbox.destroy(handle).catch(() => undefined);
    this.d.log.info("session finished", { work_item_id: item.id, run_id: file.run_id, pr_number: number });
    return {
      ok: true,
      lines: [
        ...lines,
        ...(checked ? checkedLines(checked.results, { fixed: false, skipped: null }) : []),
        `pushed ${file.branch} and opened PR #${number}`,
        "the controller moves the item to review and queues the factory's review run",
      ],
    };
  }

  /** `session abandon`: the run fails `abandoned`. The remote branch and the run folder are kept. */
  async abandon(o: EndInput): Promise<SessionResult> {
    const open = await this.open(o.id);
    if ("refuse" in open) return refused(open.refuse);
    const { file } = open;
    if (o.tokens !== undefined) {
      if (!isTokenCount(o.tokens)) return refused("refused: --tokens takes a whole number of 0 or more");
      const t = await this.d.store.updateSession(file.run_id, file.token, { tokens: o.tokens });
      if (!t.ok) return refused("refused: the session has ended");
    }
    const done = await this.d.store.completeRun(file.run_id, file.token, {
      status: "failed",
      error_code: SESSION_ABANDONED,
      detail: "the person abandoned the session",
      infra: false,
    });
    if (!done.ok) return refused("refused: the session has already ended");
    await this.d.files.remove(file.work_item_id);
    this.d.log.info("session abandoned", { work_item_id: file.work_item_id, run_id: file.run_id });
    return {
      ok: true,
      lines: [
        `abandoned the session on ${file.work_item_id}; the controller releases the item (${SESSION_RELEASED})`,
        `the remote branch ${file.branch}, if pushed, is kept; the run folder ${file.folder.workdir} is kept too`,
      ],
    };
  }

  private async refuseFinish(file: SessionFile, reasons: string[], lines: string[] = []): Promise<SessionResult> {
    await this.d.store.updateSession(file.run_id, file.token, { last_finish: { ok: false, reasons, pr_number: null } });
    return refused(...lines, "finish refused; the session stays open and nothing was pushed:", ...reasons.map((r) => `- ${r}`));
  }

  // helpers

  /** The one session the command means: `id`, else the only open one on this machine. */
  private async pick(id?: WorkItemId): Promise<{ file: SessionFile } | { refuse: string }> {
    if (id) {
      const file = await this.d.files.read(id);
      return file ? { file } : { refuse: `no open session on ${id} on this machine` };
    }
    const all = await this.d.files.list();
    if (all.length === 0) return { refuse: "no open session on this machine" };
    if (all.length > 1) return { refuse: `several open sessions; name one: ${all.map((f) => f.work_item_id).join(", ")}` };
    return { file: all[0]! };
  }

  /** The session, still running with our token. An ended one is forgotten locally and refused. */
  private async open(id?: WorkItemId): Promise<{ file: SessionFile; run: Run; item: WorkItem } | { refuse: string }> {
    const f = await this.pick(id);
    if ("refuse" in f) return { refuse: `refused: ${f.refuse}` };
    const run = await this.d.store.getRun(f.file.run_id);
    const item = await this.d.store.getWorkItem(f.file.work_item_id);
    if (!run || !item || run.status !== "running" || run.lease?.token !== f.file.token) {
      await this.d.files.remove(f.file.work_item_id);
      return { refuse: `refused: the session on ${f.file.work_item_id} has already ended${run ? ` (${run.status})` : ""}` };
    }
    return { file: f.file, run, item };
  }

  private async handle(file: SessionFile): Promise<SandboxHandle | null> {
    const stored: SandboxHandle = { id: file.folder.id, workdir: file.folder.workdir, ...(file.folder.base_sha ? { base_sha: file.folder.base_sha } : {}) };
    if (!this.d.sandbox.reattach) return stored;
    return this.d.sandbox.reattach(file.folder.id);
  }

  /** Trusted git in the run folder: the env ranks above the folder's own git config (as the worker's calls). */
  private async git(handle: SandboxHandle, args: string[]): Promise<string> {
    const r = await this.d.sandbox.exec(handle, ["git", ...args], { env: { ...this.d.toolEnv, ...TRUSTED_GIT_ENV } });
    if (r.exit_code !== 0) throw new GitError(`git ${args[0] ?? ""}: ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** An http or https URL that scans clean, or why not. */
  private async transcript(raw: string): Promise<{ url: string } | { refuse: string }> {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return { refuse: "refused: --transcript takes an http or https URL" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { refuse: "refused: --transcript takes an http or https URL" };
    const scan = await this.d.scanner.scan("comment", url.href);
    if (!scan.clean) return { refuse: `refused: the transcript URL was blocked by the leak scanner (${scan.findings.map((x) => x.rule).join(", ")}); nothing was stored` };
    return { url: url.href };
  }
}

class GitError extends Error {}

/** `12`, `#12` → an issue number; `wi_…` → a work item id. */
export function parseTarget(s: string): { kind: "issue"; number: number } | { kind: "item"; id: WorkItemId } | null {
  const t = s.trim();
  const n = /^#?(\d+)$/.exec(t);
  if (n) return { kind: "issue", number: Number(n[1]) };
  if (/^wi_[A-Za-z0-9]+$/.test(t)) return { kind: "item", id: t as WorkItemId };
  return null;
}

export function isTokenCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

function prTitle(item: WorkItem): string {
  const title = item.title?.replace(/\s+/g, " ").trim();
  return title ? `factory: ${title}` : `factory: ${(item.problem.split("\n")[0] ?? "").slice(0, 80)}`;
}

function prBody(item: WorkItem, run: Run, checked: string[]): string {
  const issue = item.source.id.split("#")[1];
  const notes = run.session_notes.slice(-PR_NOTES).map((n) => `- ${n.text.replace(/\s+/g, " ").slice(0, 300)}`);
  return [
    `Made in an interactive session by \`${run.actor_id ?? "unknown"}\` (design §5, 2026-11-01). It passed the factory's scope, size and floor gates and the test command before this push.`,
    ...(notes.length ? ["", "Session notes:", ...notes] : []),
    ...(run.transcript_url ? ["", `Transcript: ${run.transcript_url}`] : []),
    "",
    ...checked,
    "",
    ...(issue ? [`Closes #${issue}`, ""] : []),
    `Work item: \`${item.id}\``,
  ].join("\n");
}
