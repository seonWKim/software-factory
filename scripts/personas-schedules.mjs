#!/usr/bin/env node
// Setup step for this repository's Gongbang personas (a local development process, not a factory feature; design
// 08-schedules, "Persona feedback schedules"): gives each persona one feedback schedule, `persona-<agent>`, daily at
// 09:00 in this machine's zone. The roster is the four built-in agents plus every agent key in the owner's
// git-ignored .factory/idle-agents/projects.json; with no projects.json it adds nothing. An ID already stored is
// left alone, so running it again adds nothing twice. Each run of a schedule is the factory's read-only feedback
// action, which files the persona's findings (scripts/idle-agents/feedback.md).
//
//   node scripts/personas-schedules.mjs [--sandbox-url <url>]
//
// --sandbox-url names a sandbox Gongbang the owner started by hand (scripts/idle-agents/sandbox.mjs) in each prompt.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_IN = ["gongbang-user-en", "gongbang-user-ko", "gongbang-designer", "gongbang-developer"];

/** The built-in agents plus every agent projects.json names, each once. */
export const roster = (projects) => [...BUILT_IN, ...Object.keys(projects).filter((a) => !BUILT_IN.includes(a))];

/** One feedback schedule definition per persona in `agents`. */
export function personaSchedules(agents, zone, sandboxUrl) {
  return agents.map((agent) => ({
    id: `persona-${agent}`,
    title: `Persona feedback: ${agent}`,
    cadence: "daily",
    spec: "09:00",
    zone,
    action: "feedback",
    body: [
      `You are the ${agent} persona. Read your agent file, .claude/agents/${agent}.md, and scripts/idle-agents/feedback.md, and follow both.`,
      ...(sandboxUrl ? [`The sandbox Gongbang is ${sandboxUrl}/app/; this run has no browser, so read its code instead.`] : []),
    ].join("\n"),
  }));
}

/** The schedule IDs `factory schedule list` printed (its first column). */
export const storedIds = (listOutput) =>
  new Set(listOutput.split("\n").filter((l) => l.includes("\t")).map((l) => l.split("\t")[0]));

/** The `factory schedule` words that add `d`; the token cap is left at its default. */
export const addArgs = (d) =>
  ["add", "--id", d.id, "--title", d.title, "--cadence", d.cadence, "--spec", d.spec, "--zone", d.zone, "--action", d.action, "--body", d.body];

/**
 * Adds every persona schedule not stored yet through `run` (the `factory schedule` words → exit code and stdout) and
 * returns the IDs it added. A missing projects.json adds nothing.
 */
export function runSetup({ projectsPath, zone, sandboxUrl, run, log = console.log }) {
  if (!existsSync(projectsPath)) {
    log(`no ${projectsPath}: no persona schedules added`);
    return [];
  }
  const list = run(["list"]);
  if (list.code !== 0) throw new Error(`factory schedule list failed: ${list.stdout}`);
  const stored = storedIds(list.stdout);
  const added = [];
  for (const d of personaSchedules(roster(JSON.parse(readFileSync(projectsPath, "utf8"))), zone, sandboxUrl)) {
    if (stored.has(d.id)) {
      log(`${d.id}: already stored`);
      continue;
    }
    const r = run(addArgs(d));
    if (r.code !== 0) throw new Error(`factory schedule add ${d.id} failed: ${r.stdout}`);
    log(r.stdout.trim());
    added.push(d.id);
  }
  return added;
}

/** Runs `npm run -s factory -- schedule <args>` in this checkout. */
function factorySchedule(args) {
  try {
    return { code: 0, stdout: execFileSync("npm", ["run", "-s", "factory", "--", "schedule", ...args], { cwd: REPO, encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--sandbox-url");
  const sandboxUrl = i === -1 ? undefined : args[i + 1];
  if ((i !== -1 && !sandboxUrl) || args.length !== (i === -1 ? 0 : 2)) {
    console.log("usage: node scripts/personas-schedules.mjs [--sandbox-url <url>]");
    process.exit(1);
  }
  try {
    runSetup({
      projectsPath: join(REPO, ".factory", "idle-agents", "projects.json"),
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sandboxUrl: sandboxUrl?.replace(/\/+$/, ""),
      run: factorySchedule,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
