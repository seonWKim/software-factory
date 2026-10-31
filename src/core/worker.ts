import type { FactoryConfig, Prompts } from "./config.js";
import type { Logger } from "./log.js";
import {
  IMPLEMENT_SCHEMA,
  REVIEW_SCHEMA,
  TRIAGE_SCHEMA,
  parseImplement,
  parseReview,
  parseTriage,
} from "./outputs.js";
import { branchFor, scopeViolations } from "./policy.js";
import type { Run, RunKind, RunOutcome, WorkItem, WorkerId } from "./types.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../interfaces/agent-runner.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { KeepAwake } from "../interfaces/keep-awake.js";
import type { Sandbox, SandboxHandle } from "../interfaces/sandbox.js";
import type { SharedStorage } from "../interfaces/shared-storage.js";
import type { ToolBroker, ToolCallContext } from "../interfaces/tool-broker.js";

export interface WorkerDeps {
  id: WorkerId;
  store: FactoryStore;
  sandbox: Sandbox;
  runner: AgentRunner;
  broker: ToolBroker;
  scanner: EgressScanner;
  storage: SharedStorage;
  clock: Clock;
  config: FactoryConfig;
  prompts: Prompts;
  log: Logger;
  /** Non-secret env for the worker's own git commands inside the sandbox (PATH etc.). */
  toolEnv: Readonly<Record<string, string>>;
  /** Held while a claimed run executes, released after; never held while idle. */
  awake: KeepAwake;
}

const KINDS: readonly RunKind[] = ["triage", "implement", "review", "update"];
const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

class RunFailure extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly infra = false,
  ) {
    super(detail);
  }
}

/**
 * Agent plane host: claims runs, executes them in a Sandbox, reports outcomes. Never decides a
 * transition; the controller does that from the outcome. Holds nothing between runs.
 */
export class Worker {
  constructor(private readonly d: WorkerDeps) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.tick().catch((err: unknown) => {
        this.d.log.error("worker tick failed", { error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
        return false;
      });
      if (!worked) await this.d.clock.sleep(this.d.config.tick_ms, signal).catch(() => undefined);
    }
  }

  /** Claims and executes at most one run. Returns whether it found one. */
  async tick(): Promise<boolean> {
    const run = await this.d.store.claimRun({ worker_id: this.d.id, kinds: KINDS, lease_ms: this.d.config.lease_ms });
    if (!run?.lease) return false;
    await this.d.awake.hold().catch((err: unknown) => this.awakeFailed("hold", err));
    try {
      await this.execute(run, run.lease.token);
    } finally {
      await this.d.awake.release().catch((err: unknown) => this.awakeFailed("release", err));
    }
    return true;
  }

  /** KeepAwake must not throw, but if one does, the run goes on: staying awake is best effort. */
  private awakeFailed(op: string, err: unknown): void {
    this.d.log.warn(`keep-awake ${op} failed`, { error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
  }

  private async execute(run: Run, token: number): Promise<void> {
    const log = { run_id: run.id, work_item_id: run.work_item_id, kind: run.kind, attempt: run.attempt };
    this.d.log.info("run start", log);
    const lease = new AbortController();
    const stopHeartbeat = new AbortController();
    const heartbeat = this.heartbeat(run, token, lease, stopHeartbeat.signal);

    let outcome: RunOutcome;
    try {
      const item = await this.d.store.getWorkItem(run.work_item_id);
      if (!item) throw new RunFailure("work_item_missing", run.work_item_id);
      const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id, lease_token: token };
      const data = await this.role(run, item, ctx, lease.signal);
      outcome = { status: "succeeded", summary: `${run.kind} done`, data };
    } catch (err) {
      outcome =
        err instanceof RunFailure
          ? { status: "failed", error_code: err.code, detail: err.message.slice(0, 500), infra: err.infra }
          : { status: "failed", error_code: "exception", detail: err instanceof Error ? err.message.slice(0, 500) : "", infra: true };
    } finally {
      stopHeartbeat.abort();
      await heartbeat;
    }

    // G5: the outcome is stored and later rendered on GitHub by the controller.
    const scan = await this.d.scanner.scan("run_outcome", JSON.stringify(outcome));
    if (!scan.clean) {
      outcome = { status: "failed", error_code: "egress_blocked", detail: scan.findings.map((f) => f.rule).join(","), infra: false };
    }
    const done = await this.d.store.completeRun(run.id, token, outcome);
    if (!done.ok) this.d.log.warn("lease lost before completion; outcome dropped", log);
    else this.d.log.info("run done", { ...log, status: outcome.status });
  }

  /**
   * Sleep, then renew. After a host sleep the timer fires late and the renewal goes out at once, with no
   * extra heartbeat_ms wait. The store renews an expired lease as long as the run is still `running` with our
   * token (nobody reaped or reclaimed it), so a late wake keeps the run instead of counting a new attempt.
   * Timers always fire a little late, so only a gap over 2 * heartbeat_ms is logged as late; renewal is unconditional.
   */
  private async heartbeat(run: Run, token: number, lease: AbortController, stop: AbortSignal): Promise<void> {
    const { heartbeat_ms, lease_ms } = this.d.config;
    while (!stop.aborted) {
      const slept = this.d.clock.now().getTime();
      try {
        await this.d.clock.sleep(heartbeat_ms, stop);
      } catch {
        return;
      }
      const gap = this.d.clock.now().getTime() - slept;
      if (gap > 2 * heartbeat_ms) this.d.log.warn("heartbeat late; renewing now", { run_id: run.id, gap_ms: gap, lease_ms });
      const r = await this.d.store.heartbeat(run.id, token, lease_ms);
      if (!r.ok) {
        this.d.log.warn("lease lost; aborting run", { run_id: run.id });
        lease.abort(new Error("lease_lost"));
        return;
      }
    }
  }

  private async role(run: Run, item: WorkItem, ctx: ToolCallContext, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (run.kind === "update") return this.update(run, item, ctx, signal);
    const { repo } = this.d.config;
    const branch = run.kind === "triage" ? null : branchFor(item, this.d.config.branch_prefix);
    const handle = await this.d.sandbox.create({ repo: repo.path, branch, base_ref: repo.base_branch });
    try {
      if (run.kind === "triage") return await this.triage(run, item, handle, signal);
      if (run.kind === "implement") return await this.implement(run, item, handle, ctx, signal);
      return await this.review(run, item, handle, ctx, signal);
    } finally {
      await this.d.sandbox.destroy(handle);
    }
  }

  private async triage(run: Run, item: WorkItem, handle: SandboxHandle, signal: AbortSignal) {
    const result = await this.agent(run, item, handle, signal, {
      system_prompt: this.d.prompts.triage,
      prompt: renderWorkItem(item, { includeSpec: false }),
      harness_tools: READ_TOOLS,
      model_class: "cheap",
      output_schema: TRIAGE_SCHEMA,
    });
    const spec = parseTriage(result.output);
    if (!spec.ok) throw new RunFailure("invalid_output", spec.error);
    return { spec: spec.value, tokens: tokensOf(result) };
  }

  private async implement(run: Run, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, signal: AbortSignal) {
    const base = this.d.config.repo.base_branch;
    const start = (await this.git(handle, ["rev-parse", "HEAD"])).trim();
    // Resolved before the agent runs: its writable git dir includes refs, so it could move origin/<base>.
    const baseSha = (await this.git(handle, ["rev-parse", "--verify", "--end-of-options", `origin/${base}^{commit}`])).trim();
    const gitDir = (await this.git(handle, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const previous = await this.previousContext(item);

    const result = await this.agent(run, item, handle, signal, {
      system_prompt: this.d.prompts.implement,
      prompt: [renderWorkItem(item, { includeSpec: true }), previous].filter(Boolean).join("\n\n"),
      harness_tools: WRITE_TOOLS,
      model_class: "strong",
      output_schema: IMPLEMENT_SCHEMA,
      writable_paths: [gitDir],
      env_allowlist: gitIdentity(this.d.config.agent_git_identity),
    });
    const out = parseImplement(result.output);
    if (!out.ok) throw new RunFailure("invalid_output", out.error);

    const commits = (await this.git(handle, ["rev-list", "--reverse", `${start}..HEAD`])).split("\n").filter(Boolean);
    if (commits.length === 0) throw new RunFailure("no_commits", "the implementer made no commits");
    await this.scopeGate(run, item, handle, ctx, baseSha);
    for (const sha of commits) {
      const subject = (await this.git(handle, ["log", "-1", "--format=%s", sha])).trim();
      const h = await this.d.store.appendHandoff(
        { run_id: run.id, work_item_id: item.id, commit_sha: sha, worked_on: subject, next_steps: out.value.next_steps },
        ctx.lease_token,
      );
      if (!h.ok) throw new RunFailure("lease_lost", "lease lost while writing handoffs", true);
    }

    const branch = branchFor(item, this.d.config.branch_prefix);
    const pushed = await this.d.broker.call(ctx, "github.push_branch", { workdir: handle.workdir, branch, base_ref: base });
    if (!pushed.ok) throw new RunFailure(pushed.error_code, pushed.message);
    const issue = item.source.id.split("#")[1];
    const pr = await this.d.broker.call(ctx, "github.open_pr", {
      branch,
      base_ref: base,
      title: `factory: ${firstLine(item.problem).slice(0, 80)}`,
      body: `${out.value.summary}\n\nCloses #${issue}\n\nWork item: \`${item.id}\``,
    });
    if (!pr.ok) throw new RunFailure(pr.error_code, pr.message);
    const content = pr.content as { number: number };
    return { pr_number: content.number, commits: commits.length, tokens: tokensOf(result) };
  }

  /**
   * Scope gate (design §4): runs before every push. Checks the cumulative branch diff against the base SHA
   * (three-dot, so files only base changed are left out) with the same coverage rule as triage. Not a dial.
   */
  private async scopeGate(run: Run, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, baseSha: string) {
    const diff = await this.git(handle, ["diff", "--name-only", "-z", "--no-renames", `${baseSha}...HEAD`]);
    const outside = scopeViolations(diff, item.allowed_paths);
    if (outside.length === 0) return;
    const body = [
      "## Factory scope check: push blocked",
      "",
      "The implementer changed files outside the approved allowed paths, so the branch was not pushed:",
      "",
      ...outside.map((p) => `- \`${p}\``),
    ].join("\n");
    const posted = await this.d.broker.call(ctx, "github.comment", {
      number: Number(item.source.id.split("#")[1]),
      body,
      marker: `<!-- factory:scope:${run.id} -->`,
    });
    if (!posted.ok) {
      this.d.log.warn("scope violation comment failed", { run_id: run.id, error_code: posted.error_code });
    }
    throw new RunFailure("scope_violation", `files outside allowed_paths: ${outside.join(", ")}`.slice(0, 500));
  }

  private async review(run: Run, item: WorkItem, handle: SandboxHandle, ctx: ToolCallContext, signal: AbortSignal) {
    if (item.pr_number === null) throw new RunFailure("no_pr", "work item has no PR");
    const diff = await this.git(handle, ["diff", `origin/${this.d.config.repo.base_branch}...HEAD`]);
    // Blind pass: work item + diff only, no implementer transcript (design §4).
    const result = await this.agent(run, item, handle, signal, {
      system_prompt: this.d.prompts.review,
      prompt: `${renderWorkItem(item, { includeSpec: true })}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``,
      harness_tools: WRITE_TOOLS,
      model_class: "strong",
      output_schema: REVIEW_SCHEMA,
      env_allowlist: gitIdentity(this.d.config.agent_git_identity),
    });
    const review = parseReview(result.output);
    if (!review.ok) throw new RunFailure("invalid_output", review.error);

    const v = review.value;
    const body = [
      `## Factory review: ${v.verdict === "pass" ? "pass" : "bugs found"}`,
      "",
      v.summary,
      ...(v.findings.length ? ["", ...v.findings.map((f) => `- ${f}`)] : []),
      "",
      `Tier recheck: ${v.tier}`,
    ].join("\n");
    const posted = await this.d.broker.call(ctx, "github.comment", {
      number: item.pr_number,
      body,
      marker: `<!-- factory:review:${run.id} -->`,
    });
    if (!posted.ok) throw new RunFailure(posted.error_code, posted.message);
    return { review: v, tokens: tokensOf(result) };
  }

  /**
   * Merges origin/<base> into the PR branch in a fresh worktree, runs the test command, and pushes only a clean,
   * passing merge (never a force push). No agent. Conflicts and failing tests are reported on the PR and in
   * `result`; the controller decides the state. Git and push errors fail the run.
   */
  private async update(run: Run, item: WorkItem, ctx: ToolCallContext, signal: AbortSignal) {
    if (item.pr_number === null) throw new RunFailure("no_pr", "work item has no PR");
    const { repo, branch_prefix } = this.d.config;
    const branch = branchFor(item, branch_prefix);
    const baseRef = `origin/${repo.base_branch}`;
    const handle = await this.d.sandbox.create({ repo: repo.path, branch, base_ref: repo.base_branch }).catch((err: unknown) => {
      throw new RunFailure("git_failed", `worktree: ${err instanceof Error ? err.message : "unknown"}`, true);
    });
    const comment = async (body: string) => {
      const r = await this.d.broker.call(ctx, "github.comment", {
        number: item.pr_number,
        body,
        marker: `<!-- factory:update:${run.id} -->`,
      });
      if (!r.ok) throw new RunFailure(r.error_code, r.message);
    };
    try {
      // The sandbox starts a missing branch from base; an update must only ever touch the PR's own branch.
      await this.git(handle, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
      const head_sha = (await this.git(handle, ["rev-parse", "HEAD"])).trim();
      const base_sha = (await this.git(handle, ["rev-parse", baseRef])).trim();

      const ancestor = await this.gitRaw(handle, ["merge-base", "--is-ancestor", baseRef, "HEAD"]);
      if (ancestor.exit_code === 0) return { result: "up_to_date", head_sha, base_sha };
      if (ancestor.exit_code !== 1) throw new RunFailure("git_failed", `git merge-base: ${ancestor.stderr.trim()}`, true);

      const merge = await this.gitRaw(
        handle,
        ["merge", "--no-ff", "--no-edit", "-m", `Merge ${baseRef} into ${branch}`, baseRef],
        gitIdentity(this.d.config.agent_git_identity),
      );
      if (merge.exit_code !== 0) {
        const conflicts = (await this.git(handle, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
        if (conflicts.length === 0) throw new RunFailure("git_failed", `git merge: ${merge.stderr.trim()}`, true);
        await comment([
          `PR #${item.pr_number} could not be updated with ${repo.base_branch}: merging \`${baseRef}\` conflicts in these files.`,
          "Nothing was pushed. A human needs to resolve them.",
          "",
          ...conflicts.map((f) => `- \`${f}\``),
        ].join("\n"));
        return { result: "conflict", conflicts, head_sha, base_sha };
      }

      const cmd = repo.test_command;
      const tests = await this.d.sandbox
        .exec(handle, cmd, { env: this.d.toolEnv, timeout_ms: this.d.config.run_timeout_ms, signal })
        .catch((err: unknown) => {
          throw new RunFailure("test_command_failed", err instanceof Error ? err.message : "unknown");
        });
      if (signal.aborted) throw new RunFailure("lease_lost", "run aborted", true);
      if (tests.exit_code !== 0) {
        const how = tests.timed_out ? "timed out" : `exited ${tests.exit_code ?? tests.signal ?? "abnormally"}`;
        await comment([
          `PR #${item.pr_number} was not updated with ${repo.base_branch}: \`${baseRef}\` merged cleanly, but the tests failed on the updated branch (\`${cmd.join(" ")}\` ${how}).`,
          "Nothing was pushed. A human needs to look.",
        ].join("\n"));
        return { result: "tests_failed", exit_code: tests.exit_code, timed_out: tests.timed_out, head_sha, base_sha };
      }

      const pushed = await this.d.broker.call(ctx, "github.push_branch", {
        workdir: handle.workdir,
        branch,
        base_ref: repo.base_branch,
      });
      if (!pushed.ok) throw new RunFailure(pushed.error_code, pushed.message);
      const merge_sha = (await this.git(handle, ["rev-parse", "HEAD"])).trim();
      await comment(
        `PR #${item.pr_number} updated with ${repo.base_branch}: merged \`${baseRef}\` (${base_sha.slice(0, 8)}) cleanly and \`${cmd.join(" ")}\` passed. A human merge is still required.`,
      );
      return { result: "pushed", merge_sha, head_sha, base_sha };
    } finally {
      await this.d.sandbox.destroy(handle);
    }
  }

  private async agent(
    run: Run,
    item: WorkItem,
    handle: SandboxHandle,
    signal: AbortSignal,
    role: Pick<AgentRunSpec, "system_prompt" | "prompt" | "harness_tools" | "model_class" | "output_schema"> &
      Partial<Pick<AgentRunSpec, "writable_paths" | "env_allowlist">>,
  ): Promise<AgentRunResult> {
    const result = await this.d.runner.run({
      run_id: run.id,
      work_item_id: item.id,
      role: run.kind,
      sandbox: handle,
      tool_grants: [],
      lease_token: run.lease!.token,
      deny_paths: this.d.config.deny_paths,
      writable_paths: [],
      env_allowlist: {},
      timeout_ms: this.d.config.run_timeout_ms,
      signal,
      ...role,
    });

    // G5 before the transcript is stored anywhere.
    const scan = await this.d.scanner.scan("log", result.transcript);
    if (!scan.clean) throw new RunFailure("egress_blocked", scan.findings.map((f) => f.rule).join(","));
    await this.d.storage.put(`transcripts/${item.id}/${run.id}.json`, new TextEncoder().encode(result.transcript));

    if (result.status === "aborted") throw new RunFailure("lease_lost", "run aborted", true);
    if (result.status !== "completed") throw new RunFailure(`agent_${result.status}`, result.error ?? "", result.status === "timed_out");
    return result;
  }

  /** Reviewer findings and handoffs from earlier loops, for a resumed or re-looped implementer. */
  private async previousContext(item: WorkItem): Promise<string> {
    const runs = await this.d.store.listRuns(item.id);
    const lastReview = runs.filter((r) => r.kind === "review" && r.outcome?.status === "succeeded").at(-1);
    const parts: string[] = [];
    if (lastReview?.outcome?.status === "succeeded") {
      const v = parseReview(lastReview.outcome.data.review);
      if (v.ok && v.value.verdict === "bug") {
        parts.push("## Reviewer findings to fix", "", v.value.summary, ...v.value.findings.map((f) => `- ${f}`));
      }
    }
    const handoffs = await this.d.store.listHandoffs(item.id);
    if (handoffs.length) {
      parts.push("", "## Earlier commits on this branch", ...handoffs.map((h) => `- ${h.commit_sha.slice(0, 8)} ${h.worked_on}`));
      parts.push("", `Last noted next steps: ${handoffs.at(-1)!.next_steps}`);
    }
    return parts.join("\n").trim();
  }

  private async git(handle: SandboxHandle, args: string[]): Promise<string> {
    const r = await this.gitRaw(handle, args);
    if (r.exit_code !== 0) throw new RunFailure("git_failed", `git ${args[0]}: ${r.stderr.trim()}`, true);
    return r.stdout;
  }

  private gitRaw(handle: SandboxHandle, args: string[], env: Record<string, string> = {}) {
    return this.d.sandbox.exec(handle, ["git", ...args], { env: { ...this.d.toolEnv, ...env, GIT_TERMINAL_PROMPT: "0" } });
  }
}

function renderWorkItem(item: WorkItem, opts: { includeSpec: boolean }): string {
  const lines = [`# Work item ${item.id}`, "", `Source: ${item.source.link}`, "", "## Problem", "", item.problem];
  if (opts.includeSpec) {
    lines.push(
      "",
      "## Done criteria",
      ...(item.done_criteria ?? []).map((c) => `- ${c}`),
      "",
      `## Desired output\n\n${item.desired_output ?? ""}`,
      "",
      `## Scope\n\n${item.scope ?? ""}`,
      "",
      "## Allowed paths (do not change files outside these)",
      ...item.allowed_paths.map((p) => `- ${p}`),
    );
  }
  return lines.join("\n");
}

function gitIdentity(id: { name: string; email: string }): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}

function tokensOf(r: AgentRunResult): number {
  return r.usage.input_tokens + r.usage.output_tokens;
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}
