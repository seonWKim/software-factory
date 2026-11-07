import type { FactoryConfig } from "./config.js";
import { requiredTier } from "./diff-gate.js";
import { type TriageOutput, parseTriage } from "./outputs.js";
import { SESSION_ABANDONED, SESSION_RELEASED, branchFor, effectiveTier, floorTier } from "./policy.js";
import { PrePushGitError, scopeGate, sizeAndFloor } from "./pre-push.js";
import { type LearnedSettingsSource, settingValues } from "./settings.js";
import type { Run, RunId, RunOutcome, StateChangeDetail, UserId, WorkItem, WorkItemId, WorkItemPatch, WorkerId } from "./types.js";
import { TRUSTED_GIT_ENV } from "./worker.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, StartSessionResult } from "../interfaces/factory-store.js";
import type { Sandbox, SandboxHandle } from "../interfaces/sandbox.js";
import type { ToolBroker, ToolCallContext } from "../interfaces/tool-broker.js";

// `factory session` (design 2026-11-01): a person's own LLM session on a work item, as an `interactive` run. The
// run has a lease the person's terminal renews, a run folder made through the Sandbox, and at `finish` the same
// pre-push gates as an implement run (scope, size, floor) plus the repo's test command. The push and the PR go
// only through the ToolBroker. The session's LLM runs as the person, outside the run-folder rule: a recorded
// exception, not something this code enforces.

/** Where an open session's local state lives: one record per item, under state_dir (the CLI's files). */
export interface SessionRecord {
  work_item_id: WorkItemId;
  run_id: RunId;
  lease_token: number;
  sandbox_id: string;
  workdir: string;
  branch: string;
  /** The trusted base the run folder was made against; the gates diff against it. */
  base_sha: string;
}

export interface SessionFiles {
  read(id: WorkItemId): Promise<SessionRecord | null>;
  write(record: SessionRecord): Promise<void>;
  remove(id: WorkItemId): Promise<void>;
  list(): Promise<SessionRecord[]>;
}

/** An issue of the configured repo, for an item the factory has not taken in yet. */
export interface IssueText {
  title: string;
  body: string;
}

export interface SessionDeps {
  store: FactoryStore;
  sandbox: Sandbox;
  broker: ToolBroker;
  scanner: EgressScanner;
  clock: Clock;
  /** The resolved config (project key set), with the runtime settings applied. */
  config: FactoryConfig;
  learned?: LearnedSettingsSource;
  /** Non-secret env for git and the test command in the run folder (PATH etc.). */
  toolEnv: Readonly<Record<string, string>>;
  files: SessionFiles;
  /** Reads issue `n` of the configured repo; null when there is none. */
  issue(n: number): Promise<IssueText | null>;
  /** The lease owner this terminal writes, e.g. `session:<host>:<pid>`. */
  owner: WorkerId;
}

/** What a command prints, and whether it did what it was asked (the CLI's exit code). */
export interface SessionResult {
  ok: boolean;
  lines: string[];
}

export interface StartArgs {
  /** An issue number of the configured repo, or a work item id. */
  ref: string;
  /** The person, already resolved and checked for write permission. */
  actor: UserId;
  /** The text of the `--spec` file. */
  spec?: string;
  transcript?: string;
}

/** Notes and the PR body keep at most this much of the person's text. */
const MAX_NOTE_CHARS = 4000;
/** Files of a PR kept as its pr_files, as the implement run does. */
const MAX_PR_FILES = 500;

const refused = (...lines: string[]): SessionResult => ({ ok: false, lines });

type StartPlan = { patch: WorkItemPatch; reason: string; detail: StateChangeDetail; cancel_queued_runs: boolean };

export class Sessions {
  constructor(private readonly d: SessionDeps) {}

  private get cfg(): FactoryConfig {
    return this.d.config;
  }

  async start(a: StartArgs): Promise<SessionResult & { record?: SessionRecord }> {
    const transcript = a.transcript === undefined ? null : await this.checkedUrl(a.transcript);
    if (transcript && "refuse" in transcript) return refused(transcript.refuse);
    const gates = settingValues(this.cfg.project.key, this.cfg.settings, this.d.learned);
    let spec: TriageOutput | null = null;
    if (a.spec !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(a.spec);
      } catch {
        return refused("session start refused: the --spec file is not JSON (the triage output format)");
      }
      // The same parser and size caps as a triage run's output.
      const parsed = parseTriage(raw, { max_diff_lines: gates.max_diff_lines, max_diff_files: gates.max_diff_files });
      if (!parsed.ok) return refused(`session start refused: the --spec file is not a valid spec (${parsed.error})`);
      if (parsed.value.phases) return refused("session start refused: a split spec (phases) cannot start a session; file its phases first");
      spec = parsed.value;
    }

    const found = await this.findItem(a.ref, a.actor, spec !== null);
    if ("refuse" in found) return refused(found.refuse);
    let item = found.item;

    for (let i = 0; i < 5; i++) {
      const plan = this.plan(item, spec);
      if ("refuse" in plan) return refused(`session start refused: ${plan.refuse}`);
      const r = await this.d.store.startSession({
        id: item.id,
        expected_version: item.version,
        actor: { kind: "user", id: a.actor },
        owner: this.d.owner,
        lease_ms: this.cfg.lease_ms,
        patch: plan.patch,
        reason: plan.reason,
        detail: plan.detail,
        cancel_queued_runs: plan.cancel_queued_runs,
        transcript_url: transcript?.url ?? null,
      });
      if (r.ok) return this.openFolder(r);
      if (r.reason === "version_conflict") {
        item = r.current;
        continue;
      }
      return refused(`session start refused: ${startRefusal(r)}`);
    }
    return refused("session start refused: the item kept changing; try again");
  }

  /** Renews the session's lease every heartbeat_ms until `signal` aborts or the lease is gone. */
  async keepAlive(record: SessionRecord, signal: AbortSignal): Promise<"stopped" | "ended"> {
    while (!signal.aborted) {
      await this.d.clock.sleep(this.cfg.heartbeat_ms, signal).catch(() => undefined);
      if (signal.aborted) break;
      const r = await this.d.store.heartbeat(record.run_id, record.lease_token, this.cfg.lease_ms);
      if (!r.ok) return "ended";
    }
    return "stopped";
  }

  async status(id?: string): Promise<SessionResult> {
    const rec = await this.pick(id);
    if ("refuse" in rec) return refused(rec.refuse);
    const run = await this.d.store.getRun(rec.run_id);
    const item = await this.d.store.getWorkItem(rec.work_item_id);
    if (!run || !item) return refused(`session ${rec.run_id}: not in the store`);
    const s = run.input?.session;
    const last = s?.last_finish;
    return {
      ok: true,
      lines: [
        `item: ${item.id} (${item.source.id}), ${item.stage}${item.blocked_on === "none" ? "" : `, blocked on ${item.blocked_on}: ${item.blocked_reason ?? ""}`}`,
        `run: ${run.id} (${run.kind}), ${run.status}, actor ${run.actor_id ?? "unknown"}`,
        `lease expires: ${run.lease?.expires_at ?? "none (the run ended)"}`,
        `run folder: ${rec.workdir} (branch ${rec.branch})`,
        `tokens: ${run.tokens ?? "none given"}; transcript: ${run.transcript_url ?? "none"}; notes: ${s?.notes.length ?? 0}`,
        last
          ? `last finish: ${last.at} ${last.ok ? "passed" : "refused"}${last.reasons.length ? `: ${last.reasons.join("; ")}` : ""}`
          : "last finish: none yet",
      ],
    };
  }

  async note(text: string, opts: { id?: string; tokens?: number; transcript?: string } = {}): Promise<SessionResult> {
    const rec = await this.pick(opts.id);
    if ("refuse" in rec) return refused(rec.refuse);
    const body = text.trim().slice(0, MAX_NOTE_CHARS);
    if (!body && opts.tokens === undefined && opts.transcript === undefined) return refused("session note refused: the note is empty");
    if (body) {
      const scan = await this.d.scanner.scan("run_outcome", body);
      if (!scan.clean) return refused(`session note refused by the leak scanner (${rules(scan.findings)}); nothing was stored`);
    }
    const url = opts.transcript === undefined ? null : await this.checkedUrl(opts.transcript);
    if (url && "refuse" in url) return refused(url.refuse);
    const tokens = checkTokens(opts.tokens);
    if (tokens && "refuse" in tokens) return refused(tokens.refuse);
    const r = await this.d.store.updateSession(rec.run_id, rec.lease_token, {
      ...(body ? { note: body } : {}),
      ...(tokens ? { tokens: tokens.n } : {}),
      ...(url ? { transcript_url: url.url } : {}),
    });
    if (!r.ok) return refused(`session ${rec.run_id} is no longer open; nothing was stored`);
    return { ok: true, lines: [`noted on ${rec.run_id}${tokens ? ` (tokens: ${tokens.n})` : ""}`] };
  }

  /**
   * In order: the scope gate, the size gate, the floor check, the repo's test command (all of them, so every reason
   * is listed). Any failure leaves the session open and pushes nothing. Then the push and the PR through the broker,
   * and the run completes as succeeded; the controller moves the item to REVIEW and queues its review.
   */
  async finish(opts: { id?: string; tokens?: number } = {}): Promise<SessionResult> {
    const rec = await this.pick(opts.id);
    if ("refuse" in rec) return refused(rec.refuse);
    const open = await this.openRun(rec);
    if ("refuse" in open) return refused(open.refuse);
    const tokens = checkTokens(opts.tokens);
    if (tokens && "refuse" in tokens) return refused(tokens.refuse);
    let run = open.run;
    if (tokens) {
      const r = await this.d.store.updateSession(rec.run_id, rec.lease_token, { tokens: tokens.n });
      if (!r.ok) return refused(`session ${rec.run_id} is no longer open`);
      run = r.run;
    }
    const item = (await this.d.store.getWorkItem(rec.work_item_id))!;
    const handle = await this.handle(rec);
    if (!handle) return refused(`the run folder ${rec.workdir} is gone; abandon the session and start a new one`);

    const reasons: string[] = [];
    let paths: string[] = [];
    try {
      const git = (args: string[]) => this.git(handle, args);
      const status = await git(["status", "--porcelain", "-z", "--untracked-files=normal"]);
      if (status.replace(/\0/g, "").trim() !== "") reasons.push("uncommitted changes in the run folder: commit them first (only commits are pushed)");
      const commits = (await git(["rev-list", `${rec.base_sha}..HEAD`])).split("\n").filter(Boolean);
      if (commits.length === 0) reasons.push("no commits on the branch since the session started from the base");
      // The same gates as the implement run (src/core/pre-push.ts), with the item's project's values.
      const outside = await scopeGate(git, rec.base_sha, item.allowed_paths);
      if (outside.length > 0) reasons.push(`scope: files outside the allowed paths: ${outside.join(", ")}`);
      const s = settingValues(item.project, this.cfg.settings, this.d.learned);
      const limits = { max_diff_lines: s.max_diff_lines, max_diff_files: s.max_diff_files };
      const sf = await sizeAndFloor(git, rec.base_sha, { limits, floors: s.floors, tier: item.tier });
      paths = sf.stat.paths;
      if (sf.oversize) reasons.push(`size: ${sf.oversize}`);
      if (sf.floor.length > 0) {
        reasons.push(
          `floor: ${sf.floor.map((h) => h.path).join(", ")} need tier ${requiredTier(sf.floor)} (the item is tier ${item.tier ?? 1}); ` +
            "a session cannot raise the tier, so leave these files to a factory run",
        );
      }
    } catch (err) {
      reasons.push(err instanceof PrePushGitError || err instanceof GitError ? `git: ${err.message}` : `git: ${String(err)}`);
    }
    const test = await this.d.sandbox.exec(handle, this.cfg.repo.test_command, {
      cwd: handle.workdir,
      env: { ...this.d.toolEnv },
      timeout_ms: this.cfg.run_timeout_ms,
    });
    if (test.exit_code !== 0) {
      reasons.push(`test: \`${this.cfg.repo.test_command.join(" ")}\` ${test.timed_out ? "timed out" : `exited ${test.exit_code ?? test.signal}`}`);
    }
    if (reasons.length > 0) return this.finishRefused(rec, reasons);

    const ctx: ToolCallContext = { run_id: rec.run_id, work_item_id: item.id, lease_token: rec.lease_token };
    const base = this.cfg.repo.base_branch;
    const head = (await this.git(handle, ["rev-parse", "HEAD"])).trim();
    const pushed = await this.d.broker.call(ctx, "github.push_branch", { workdir: handle.workdir, branch: rec.branch, base_ref: base });
    if (!pushed.ok) return this.finishRefused(rec, [`push: ${pushed.error_code}: ${pushed.message}`.slice(0, 500)]);
    await this.d.store.recordPushedHead(rec.run_id, rec.lease_token, head);
    const issue = item.source.id.split("#")[1];
    const pr = await this.d.broker.call(ctx, "github.open_pr", {
      branch: rec.branch,
      base_ref: base,
      title: (item.title ?? item.problem.split("\n")[0] ?? item.id).slice(0, 200),
      body: [
        `Made in an interactive session by \`${run.actor_id ?? "unknown"}\` (design 2026-11-01). The factory ran the scope, size and floor gates and \`${this.cfg.repo.test_command.join(" ")}\` before this push.`,
        "",
        ...(issue ? [`Closes #${issue}`, ""] : []),
        `Work item: \`${item.id}\``,
      ].join("\n"),
    });
    if (!pr.ok) return this.finishRefused(rec, [`pull request: ${pr.error_code}: ${pr.message}`.slice(0, 500)]);
    const number = (pr.content as { number: number }).number;
    const outcome: RunOutcome = {
      status: "succeeded",
      summary: "interactive session finished",
      data: { pr_number: number, files: paths.slice(0, MAX_PR_FILES), tokens: run.tokens ?? 0, actor_id: run.actor_id },
    };
    const scan = await this.d.scanner.scan("run_outcome", JSON.stringify(outcome));
    if (!scan.clean) return this.finishRefused(rec, [`outcome: withheld by the leak scanner (${rules(scan.findings)})`]);
    await this.d.store.updateSession(rec.run_id, rec.lease_token, { last_finish: { ok: true, reasons: [] } });
    const done = await this.d.store.completeRun(rec.run_id, rec.lease_token, outcome);
    if (!done.ok) return refused(`pushed and PR #${number} is open, but the session's lease was lost before it completed`);
    await this.d.sandbox.destroy(handle);
    await this.d.files.remove(rec.work_item_id);
    return { ok: true, lines: [`finished: PR #${number}; the factory reviews it next`] };
  }

  /** Ends the session as failed (`abandoned`). The remote branch stays; the run folder is kept for the person. */
  async abandon(opts: { id?: string; tokens?: number } = {}): Promise<SessionResult> {
    const rec = await this.pick(opts.id);
    if ("refuse" in rec) return refused(rec.refuse);
    const open = await this.openRun(rec);
    if ("refuse" in open) return refused(open.refuse);
    const tokens = checkTokens(opts.tokens);
    if (tokens && "refuse" in tokens) return refused(tokens.refuse);
    const total = tokens ? tokens.n : open.run.tokens;
    const outcome: RunOutcome = {
      status: "failed",
      error_code: SESSION_ABANDONED,
      detail: `the session was abandoned by ${open.run.actor_id ?? "its person"}`,
      infra: false,
      ...(total !== null ? { tokens: total } : {}),
    };
    const done = await this.d.store.completeRun(rec.run_id, rec.lease_token, outcome);
    if (!done.ok) return refused(`session ${rec.run_id} is no longer open`);
    await this.d.files.remove(rec.work_item_id);
    return {
      ok: true,
      lines: [
        `abandoned ${rec.run_id}; the item is released (${SESSION_RELEASED}) and nothing was pushed by this command`,
        `the run folder ${rec.workdir} is kept; delete it when you no longer need it`,
      ],
    };
  }

  // Internals

  private async findItem(ref: string, actor: UserId, hasSpec: boolean): Promise<{ item: WorkItem } | { refuse: string }> {
    if (/^wi_[A-Za-z0-9]+$/.test(ref)) {
      const item = await this.d.store.getWorkItem(ref as WorkItemId);
      return item ? { item } : { refuse: `no work item ${ref}` };
    }
    if (!/^[1-9]\d*$/.test(ref)) return { refuse: `"${ref}" is neither an issue number nor a work item id` };
    const { owner, name } = this.cfg.repo;
    const sourceId = `${owner}/${name}#${ref}`;
    const existing = await this.d.store.getWorkItemBySource("github_issue", sourceId);
    if (existing) return { item: existing };
    // A new item has no allowed paths until a spec gives them: refuse before anything is written.
    if (!hasSpec) return { refuse: `session start refused: issue #${ref} has no work item and no allowed_paths yet; give --spec <file>` };
    const issue = await this.d.issue(Number(ref));
    if (!issue) return { refuse: `no issue #${ref} in ${owner}/${name}` };
    const source = { type: "github_issue" as const, id: sourceId, link: `https://github.com/${owner}/${name}/issues/${ref}` };
    // As intake does: the same triage key, so a later poll of the issue finds the item and queues nothing.
    const { item } = await this.d.store.createWorkItem(
      {
        source,
        title: issue.title,
        requester_id: actor,
        project: this.cfg.project.key,
        problem: `${issue.title}\n\n${issue.body}`.trim(),
        resources: [source.link],
      },
      { kind: "user", id: actor },
      { enqueue: { kind: "triage", idempotency_key: `${source.type}:${source.id}:triage` } },
    );
    return { item };
  }

  /** The transition `session start` applies to `it`, or why it may not start. Pure. */
  private plan(it: WorkItem, spec: TriageOutput | null): StartPlan | { refuse: string } {
    if (it.stage === "CLOSED") return { refuse: `the item is CLOSED (${it.close_reason ?? "closed"})` };
    if (it.stage === "REVIEW") return { refuse: "the item is in REVIEW: its PR is under review; use `/revise` on the PR instead" };
    if (it.stage === "READY") {
      if (it.blocked_reason === "spec_pending" || it.blocked_reason === "max_revisions") {
        return { refuse: "the item's spec waits for approval: reply `/approve` on the issue first (the owner's `/approve` stays the spec gate)" };
      }
      return { refuse: `the item is READY and blocked on ${it.blocked_on} (${it.blocked_reason ?? ""})` };
    }
    if (it.stage === "NEW") {
      if (it.blocked_on !== "none") return { refuse: `the item is held (${it.blocked_on}: ${it.blocked_reason ?? ""})` };
      if (!spec) return { refuse: "the item has no allowed_paths yet (it is NEW); give --spec <file>" };
      const tier = effectiveTier(spec.tier, floorTier(spec.allowed_paths, settingValues(it.project, this.cfg.settings, this.d.learned).floors), it.tier);
      return {
        patch: {
          problem: spec.problem,
          done_criteria: spec.done_criteria,
          desired_output: spec.desired_output,
          scope: spec.scope,
          allowed_paths: spec.allowed_paths,
          files_to_change: spec.files_to_change,
          tier,
          stage: "RUNNING",
        },
        reason: "session_started",
        detail: { spec_source: "owner" },
        cancel_queued_runs: true,
      };
    }
    // RUNNING
    if (spec) return { refuse: "the item already has an approved spec; --spec is only for a NEW item" };
    if (it.allowed_paths.length === 0) return { refuse: "the item has no allowed_paths" };
    if (it.blocked_on !== "none" && it.blocked_on !== "human") return { refuse: `the item is blocked on ${it.blocked_on} (${it.blocked_reason ?? ""})` };
    if (it.blocked_reason === "floor_tier") return { refuse: "the item waits for `/approve` of a higher tier (floor)" };
    return {
      patch: it.blocked_on === "none" ? {} : { blocked_on: "none", blocked_reason: null },
      reason: "session_started",
      detail: { spec_source: "triage", ...(it.blocked_on === "none" ? {} : { previous_blocked_reason: it.blocked_reason }) },
      cancel_queued_runs: false,
    };
  }

  /** After the store wrote the session: the run folder on the item's branch, then the local record. */
  private async openFolder(r: Extract<StartSessionResult, { ok: true }>): Promise<SessionResult & { record?: SessionRecord }> {
    const branch = branchFor(r.item, this.cfg.branch_prefix);
    const token = r.run.lease!.token;
    let handle: SandboxHandle;
    let base: string;
    try {
      handle = await this.d.sandbox.create({ repo: this.cfg.repo.path, branch, base_ref: this.cfg.repo.base_branch });
      base = handle.base_sha ?? (await this.git(handle, ["rev-parse", "--verify", "--end-of-options", `origin/${this.cfg.repo.base_branch}^{commit}`])).trim();
    } catch (err) {
      // No folder, no session: the run ends, so the controller releases the item.
      await this.d.store.completeRun(r.run.id, token, {
        status: "failed", error_code: "sandbox_failed", detail: err instanceof Error ? err.message.slice(0, 500) : "", infra: true,
      });
      return refused(`session start failed: the run folder could not be made (${err instanceof Error ? err.message.slice(0, 200) : "unknown"})`);
    }
    const record: SessionRecord = {
      work_item_id: r.item.id, run_id: r.run.id, lease_token: token, sandbox_id: handle.id, workdir: handle.workdir, branch, base_sha: base,
    };
    await this.d.files.write(record);
    return {
      ok: true,
      record,
      lines: [
        `session started: item ${r.item.id} (${r.item.source.id}), run ${r.run.id}${r.cancelled.length ? `, cancelled ${r.cancelled.length} queued run(s)` : ""}`,
        `run folder: ${handle.workdir}`,
        `branch: ${branch} (base ${this.cfg.repo.base_branch} at ${base.slice(0, 12)})`,
        "the lease renews while this command runs; Ctrl-C stops it and the session ends when the lease expires",
      ],
    };
  }

  /** The record named by `id` (an item id), or the only open one. */
  private async pick(id?: string): Promise<SessionRecord | { refuse: string }> {
    if (id !== undefined) return (await this.d.files.read(id as WorkItemId)) ?? { refuse: `no open session for ${id} on this machine` };
    const all = await this.d.files.list();
    if (all.length === 1) return all[0]!;
    if (all.length === 0) return { refuse: "no open session on this machine" };
    return { refuse: `${all.length} open sessions: name one (${all.map((r) => r.work_item_id).join(", ")})` };
  }

  /** The record's run, while it is still a running session with the record's token. */
  private async openRun(rec: SessionRecord): Promise<{ run: Run } | { refuse: string }> {
    const run = await this.d.store.getRun(rec.run_id);
    if (!run || run.status !== "running" || run.lease?.token !== rec.lease_token) {
      if (run && run.status !== "running") await this.d.files.remove(rec.work_item_id);
      return { refuse: `session ${rec.run_id} is not open (${run ? run.status : "not in the store"}); nothing was done` };
    }
    return { run };
  }

  private async finishRefused(rec: SessionRecord, reasons: string[]): Promise<SessionResult> {
    await this.d.store.updateSession(rec.run_id, rec.lease_token, { last_finish: { ok: false, reasons } });
    return refused("session finish refused; the session stays open and nothing was pushed:", ...reasons.map((r) => `  - ${r}`));
  }

  private async handle(rec: SessionRecord): Promise<SandboxHandle | null> {
    if (!this.d.sandbox.reattach) return { id: rec.sandbox_id, workdir: rec.workdir };
    return this.d.sandbox.reattach(rec.sandbox_id);
  }

  /** A trusted git call in the run folder: the trusted env ranks above the folder's own .git/config. */
  private async git(handle: SandboxHandle, args: string[]): Promise<string> {
    const r = await this.d.sandbox.exec(handle, ["git", ...args], { cwd: handle.workdir, env: { ...this.d.toolEnv, ...TRUSTED_GIT_ENV } });
    if (r.exit_code !== 0) throw new GitError(`git ${args[0] ?? ""}: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout;
  }

  /** An http or https URL that scans clean, or why not. */
  private async checkedUrl(raw: string): Promise<{ url: string } | { refuse: string }> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { refuse: "--transcript must be an http or https URL" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { refuse: "--transcript must be an http or https URL" };
    const scan = await this.d.scanner.scan("run_outcome", raw);
    if (!scan.clean) return { refuse: `--transcript refused by the leak scanner (${rules(scan.findings)}); nothing was stored` };
    return { url: raw };
  }
}

class GitError extends Error {}

function rules(findings: readonly { rule: string }[]): string {
  return [...new Set(findings.map((f) => f.rule))].join(", ");
}

/** `--tokens`: a whole number of 0 or more. */
function checkTokens(n: number | undefined): { n: number } | { refuse: string } | null {
  if (n === undefined) return null;
  return Number.isSafeInteger(n) && n >= 0 ? { n } : { refuse: "--tokens must be a whole number of 0 or more" };
}

function startRefusal(r: Exclude<StartSessionResult, { ok: true } | { reason: "version_conflict" }>): string {
  switch (r.reason) {
    case "not_found":
      return "the work item is gone";
    case "implement_run":
      return `the item has a queued or running implement-type run (${r.run_id}); wait for it or let it finish`;
    case "session_open":
      return `the item already has an open session (${r.run_id})`;
    case "overlap":
      return `a running ${r.kind} run (${r.run_id}) of item ${r.work_item_id} overlaps this item's allowed_paths`;
  }
}
