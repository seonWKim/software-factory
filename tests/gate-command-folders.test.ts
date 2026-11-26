// Gate entries with a folder (design 04-gate-commands): an install, check or UI check entry is a plain argv, run in
// the run folder, or `{ "dir": <folder>, "argv": [...] }`, run in that folder inside the run folder, never through a
// shell. `repo.install_commands` lists several installs, run in order before the checks. A bad entry fails startup
// naming its key.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/load-config.js";
import { gateEntryConfig } from "../src/core/checks.js";
import { config } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { issue, system } from "./helpers/store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown> & {
  repo: Record<string, unknown>;
};

function root(repo: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-gate-folders-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, repo: { ...REAL.repo, ...repo }, store: { type: "sqlite" }, state_dir: "state" }));
  return dir;
}
const load = async (repo: Record<string, unknown>) => (await loadConfig(root(repo), { platform: "linux" })).config.repo;

const GRADLE = ["./gradlew", "--offline", "dependencies"];
const MIXED_INSTALLS = [{ dir: "backend", argv: GRADLE }, { dir: "frontend", argv: ["npm", "ci"] }];

describe("gate entries in config", () => {
  it("a check_commands entry with a folder validates, beside a plain argv as before", async () => {
    const repo = await load({ check_commands: [["npm", "run", "typecheck"], { dir: "frontend", argv: ["npm", "test"] }] });
    expect(repo.check_commands).toEqual([["npm", "run", "typecheck"], { dir: "frontend", argv: ["npm", "test"] }]);
    const plain = await load({ check_commands: [["npm", "test"]] });
    expect(plain.check_commands).toEqual([["npm", "test"]]);
  });

  it("install_commands naming backend (Gradle) and frontend (npm) validates; install_command stays as it is", async () => {
    const repo = await load({ install_commands: MIXED_INSTALLS });
    expect(repo.install_commands).toEqual(MIXED_INSTALLS);
    expect(repo.install_command).toEqual(["npm", "ci"]);
    expect(await load({})).not.toHaveProperty("install_commands");
  });

  it("ui_check.command takes the folder form", async () => {
    const repo = await load({ ui_check: { command: { dir: "frontend", argv: ["npm", "run", "check:responsive"] }, paths: ["frontend/"] } });
    expect(repo.ui_check).toEqual({ command: { dir: "frontend", argv: ["npm", "run", "check:responsive"] }, paths: ["frontend/"] });
  });

  it("a folder is kept relative and normalized; the run folder itself is the plain argv", () => {
    expect(gateEntryConfig("k", { dir: "./web/app/", argv: ["npm", "test"] }, "[]")).toEqual({ dir: "web/app", argv: ["npm", "test"] });
    expect(gateEntryConfig("k", { dir: "a/../b", argv: ["npm", "test"] }, "[]")).toEqual({ dir: "b", argv: ["npm", "test"] });
    expect(gateEntryConfig("k", { dir: ".", argv: ["npm", "test"] }, "[]")).toEqual(["npm", "test"]);
  });

  it("a bad entry fails startup, and the message names the entry key", async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ check_commands: [["npm", "test"], { dir: "", argv: ["npm", "test"] }] }, /repo\.check_commands\[1\]\.dir/],
      [{ check_commands: [{ dir: "..", argv: ["npm", "test"] }] }, /repo\.check_commands\[0\]\.dir/],
      [{ check_commands: [{ dir: "frontend/../..", argv: ["npm", "test"] }] }, /repo\.check_commands\[0\]\.dir/],
      [{ check_commands: [{ dir: "/srv/app", argv: ["npm", "test"] }] }, /repo\.check_commands\[0\]\.dir/],
      [{ check_commands: [{ dir: "frontend", argv: [] }] }, /repo\.check_commands\[0\]\.argv/],
      [{ check_commands: [{ dir: "frontend" }] }, /repo\.check_commands\[0\]\.argv/],
      [{ check_commands: [{ dir: "frontend", argv: ["npm", "test"], shell: true }] }, /repo\.check_commands\[0\] has unknown keys shell/],
      [{ check_commands: ["npm test"] }, /repo\.check_commands\[0\] must be an argv/],
      [{ install_commands: [] }, /repo\.install_commands must be/],
      [{ install_commands: [MIXED_INSTALLS[0], { dir: "../other", argv: ["npm", "ci"] }] }, /repo\.install_commands\[1\]\.dir/],
      [{ install_commands: [{ dir: "backend", argv: [] }] }, /repo\.install_commands\[0\]\.argv/],
      [{ ui_check: { command: { dir: "..", argv: ["npm", "run", "check:responsive"] } } }, /repo\.ui_check\.command\.dir/],
      [{ ui_check: { command: { dir: "web", argv: [] } } }, /repo\.ui_check\.command\.argv/],
    ];
    for (const [repo, why] of bad) await expect(load(repo), JSON.stringify(repo)).rejects.toThrow(why);
  });

  it("install_commands is a known repo key", async () => {
    await expect(load({ install_comands: MIXED_INSTALLS })).rejects.toThrow(/did you mean "install_commands"/);
  });
});

// The merge check run (fake sandbox): the install step and the UI check run each entry in its folder.
describe("merge check run: gate entries in their folders", () => {
  async function mergeCheckRun(repoPatch: Record<string, unknown>, changed: string[]) {
    const f = await pipeline({ config: { repo: { ...config.repo, ...repoPatch } } });
    f.sandbox.changedFiles = changed;
    const exec = f.sandbox.exec.bind(f.sandbox);
    const ran: [string, string | undefined][] = []; // each non-git command and the folder it ran in
    f.sandbox.exec = async (h, cmd, eo) => {
      if (cmd[0] !== "git") ran.push([cmd.join(" "), eo.cwd]);
      return exec(h, cmd, eo);
    };
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    const run = (await f.runs(moved.item, "merge-check"))[0]!;
    return { ran, outcome: run.outcome };
  }

  it("both installs run, in order, in their folders, before the checks, each check in its own folder", async () => {
    const r = await mergeCheckRun({
      install_commands: MIXED_INSTALLS,
      check_commands: [{ dir: "backend", argv: ["./gradlew", "--offline", "test"] }, { dir: "frontend", argv: ["npm", "test"] }, ["npm", "run", "lint"]],
    }, ["README.md"]);
    expect(r.ran).toEqual([
      ["./gradlew --offline dependencies", "backend"],
      ["npm ci", "frontend"],
      ["./gradlew --offline test", "backend"],
      ["npm test", "frontend"],
      ["npm run lint", undefined],
    ]);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });

  it("repo.ui_check's folder entry runs in that folder", async () => {
    const r = await mergeCheckRun({
      check_commands: [["npm", "test"]],
      ui_check: { command: { dir: "frontend", argv: ["npm", "run", "check:responsive"] }, paths: ["frontend/"] },
    }, ["frontend/src/App.tsx"]);
    expect(r.ran.at(-1)).toEqual(["npm run check:responsive", "frontend"]);
    expect(r.ran.slice(0, -1).every(([, cwd]) => cwd === undefined)).toBe(true);
    expect(r.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
  });
});
