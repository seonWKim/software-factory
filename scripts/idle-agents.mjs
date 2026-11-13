#!/usr/bin/env node
// Idle-time agents (local development process for this repository, not a factory feature; CLAUDE.md "Factory
// feature or local development process"). Runs the agents in .claude/agents/gongbang-*.md headless with Claude Code,
// one per pass, each at most once a day. The developer and designer run only when this factory has no open work;
// the two users run daily, each owning a project built through its own, separate Gongbang instance (the map is the
// git-ignored .factory/idle-agents/projects.json: agent → { project, goal, repo, cli, dashboard }). Each one files
// at most two evidence-backed tasks for this factory through `factory task create` (scripts/idle-agents/feedback.md).
//
//   node scripts/idle-agents.mjs run [--agent <name>] [--force]   one pass: idle check, pick an agent, run it
//   node scripts/idle-agents.mjs loop [--every <minutes>]         a pass every N minutes (default 30)
//   node scripts/idle-agents.mjs status                           last runs, whether the factory is idle
//
// Start the loop the way the supervisor is started: detached, from a terminal (launchd cannot read ~/Desktop under
// macOS privacy rules, so a launchd job would fail here):
//   nohup node scripts/idle-agents.mjs loop >> .factory/idle-agents/loop.log 2>&1 < /dev/null & disown
//
// The due agent that ran longest ago goes first. Each run is capped by
// IDLE_AGENTS_BUDGET_USD (default 3) and gets a throwaway sandbox Gongbang (scripts/idle-agents/sandbox.mjs) to
// click through. State, notes, drafts and logs live in .factory/idle-agents/ (git-ignored).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(REPO, ".factory", "idle-agents");
const STATE = join(DIR, "state.json");
const LOCK = join(DIR, "run.lock");
const API = "http://127.0.0.1:4310/api/v1/items";
const AGENTS = ["gongbang-user-en", "gongbang-user-ko", "gongbang-designer", "gongbang-developer"];
/** Agents that run only while this factory is idle; the others run daily on their own project. */
const IDLE_ONLY = new Set(["gongbang-designer", "gongbang-developer"]);
const PROJECTS = join(DIR, "projects.json");
/** Work-item levels that still count as idle: only items parked behind another item. */
const IDLE_LEVELS = new Set(["blocked_by_task"]);
const BUDGET = process.env.IDLE_AGENTS_BUDGET_USD || "3";

const READ = ["Read", "Grep", "Glob", "Write(.factory/idle-agents/**)", "Edit(.factory/idle-agents/**)"];
const SHELL = [
  "curl -s http://127.0.0.1", "npm run -s factory -- task create", "npm run -s factory -- task list", "npm run -s factory -- task show",
  "npm run -s factory -- help", "mkdir -p .factory/idle-agents", "ls", "cat", "wc", "grep", "date", "git log", "git show", "git diff",
].map((c) => `Bash(${c}:*)`);
const BROWSER = ["mcp__playwright"];
const TOOLS = {
  "gongbang-user-en": [...READ, ...SHELL, ...BROWSER],
  "gongbang-user-ko": [...READ, ...SHELL, ...BROWSER],
  "gongbang-designer": [...READ, ...SHELL, ...BROWSER, "Bash(npm run -s check:responsive:*)"],
  "gongbang-developer": [
    ...READ, ...SHELL,
    ...["sqlite3 -readonly", "npm run -s typecheck", "npm test", "node scripts/slowest-files.mjs"].map((c) => `Bash(${c}:*)`),
  ],
};

const log = (msg) => console.log(`${new Date().toISOString()} idle-agents: ${msg}`);
const today = () => new Date().toISOString().slice(0, 10);
const readProjects = () => (existsSync(PROJECTS) ? JSON.parse(readFileSync(PROJECTS, "utf8")) : {});
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { last: {} });

/** The open work items that keep the factory busy, or null when the dashboard does not answer. */
async function busyItems() {
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.items;
    return items.filter((i) => !IDLE_LEVELS.has(i.level));
  } catch {
    return null;
  }
}

/** Whether a project's own Gongbang answers. */
async function answers(dashboard) {
  try {
    return (await fetch(new URL("/api/v1/items", dashboard), { signal: AbortSignal.timeout(10_000) })).ok;
  } catch {
    return false;
  }
}

/** The agent to run now: not run today, allowed now, longest ago first; null when none is due. */
function pick(state, allowed) {
  const due = AGENTS.filter((a) => allowed(a) && (state.last[a] ?? "").slice(0, 10) !== today());
  due.sort((a, b) => (state.last[a] ?? "").localeCompare(state.last[b] ?? ""));
  return due[0] ?? null;
}

/** Builds, starts the sandbox, and resolves with its URL and a stop function. */
async function startSandbox() {
  await exec("npm", ["run", "--silent", "build"]);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(REPO, "scripts/idle-agents/sandbox.mjs")], { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the sandbox did not start within 60 s")), 60_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("SANDBOX_URL=")) {
        clearTimeout(timer);
        resolve(line.slice("SANDBOX_URL=".length));
      }
    });
    child.on("exit", (code) => reject(new Error(`the sandbox exited ${code}`)));
  });
  return { url, stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

async function runAgent(agent, url, project) {
  mkdirSync(join(DIR, "logs"), { recursive: true });
  mkdirSync(join(DIR, "drafts"), { recursive: true });
  const logFile = join(DIR, "logs", `${today()}-${agent}.log`);
  const prompt = [
    `You are the ${agent} idle-time agent. Today is ${today()}.`,
    `Your sandbox Gongbang is ${url}/app/ (GONGBANG_SANDBOX_URL); the real dashboard is http://127.0.0.1:4310/app/ (look only).`,
    ...(project
      ? [
          `Your project: ${project.project}. Goal: ${project.goal}`,
          `Repository: ${project.repo} (read only for you). Its Gongbang: ${project.dashboard} (yours). Its CLI: ${project.cli} <command>.`,
        ]
      : []),
    "Read scripts/idle-agents/feedback.md and your notes file, do one focused pass as your agent file describes, file at most two tasks for the software-factory, then append to your notes.",
  ].join("\n");
  const tools = [...TOOLS[agent]];
  const extra = [];
  if (project) {
    tools.push(`Bash(${project.cli}:*)`, ...["log", "show", "diff", "status"].map((c) => `Bash(git -C ${project.repo} ${c}:*)`));
    // The project's own operations scripts (start, stop, status of its production service) live in bin/.
    tools.push(`Bash(${join(project.repo, "bin")}/:*)`);
    extra.push("--add-dir", project.repo);
  }
  const args = ["-p", prompt, "--agent", agent, "--max-budget-usd", BUDGET, ...extra, "--allowedTools", ...tools];
  log(`running ${agent} (budget $${BUDGET}), log ${logFile}`);
  const out = openSync(logFile, "a");
  await exec(process.env.CLAUDE_BIN || "claude", args, { stdio: ["ignore", out, out], env: { ...process.env, GONGBANG_SANDBOX_URL: url } });
}

async function runOnce({ agent, force }) {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    try {
      process.kill(pid, 0);
      return log(`a run is already going (pid ${pid})`);
    } catch {
      unlinkSync(LOCK);
    }
  }
  const busy = await busyItems();
  if (busy === null) return log("the dashboard on 4310 does not answer; skipped");
  const idle = busy.length === 0 || force;
  const projects = readProjects();
  const up = {};
  for (const [a, p] of Object.entries(projects)) up[a] = await answers(p.dashboard);
  const allowed = (a) => (IDLE_ONLY.has(a) ? idle : Boolean(projects[a] && up[a]));
  const state = readState();
  const chosen = agent ?? pick(state, allowed);
  if (!chosen) return log(`nothing due (factory ${idle ? "idle" : `busy, ${busy.length} open items`})`);
  if (!AGENTS.includes(chosen)) throw new Error(`unknown agent ${chosen}; agents: ${AGENTS.join(", ")}`);
  if (!IDLE_ONLY.has(chosen) && !up[chosen]) return log(`${chosen}: its project's Gongbang does not answer; skipped`);
  writeFileSync(LOCK, String(process.pid));
  let sandbox = null;
  try {
    sandbox = await startSandbox();
    await runAgent(chosen, sandbox.url, projects[chosen]);
    state.last[chosen] = new Date().toISOString();
    writeFileSync(STATE, JSON.stringify(state, null, 2));
    log(`${chosen} done`);
  } catch (err) {
    log(`${chosen} failed: ${err.message}`);
    appendFileSync(join(DIR, "errors.log"), `${new Date().toISOString()} ${chosen}: ${err.message}\n`);
  } finally {
    await sandbox?.stop();
    if (existsSync(LOCK)) unlinkSync(LOCK);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
if (cmd === "run") await runOnce({ agent: flag("agent"), force: rest.includes("--force") });
else if (cmd === "loop") {
  const every = Number(flag("every") ?? 30) * 60_000;
  for (;;) {
    await runOnce({});
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === "status") {
  const busy = await busyItems();
  console.log(busy === null ? "dashboard: not answering" : busy.length ? `factory: busy (${busy.length} open items)` : "factory: idle");
  const state = readState();
  const projects = readProjects();
  for (const a of AGENTS) {
    const p = projects[a];
    const where = p ? `, project ${p.project} (${(await answers(p.dashboard)) ? "up" : "down"})` : IDLE_ONLY.has(a) ? ", when idle" : ", no project";
    console.log(`${a}: last run ${state.last[a] ?? "never"}${where}`);
  }
} else {
  console.log("usage: node scripts/idle-agents.mjs run [--agent <name>] [--force] | loop [--every <minutes>] | status");
  process.exit(cmd ? 1 : 0);
}
