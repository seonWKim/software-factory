import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/personas-schedules.mjs (docs/design/08-schedules.md, "Persona feedback schedules"): the setup step that
// gives each Gongbang persona one feedback schedule. The CLI is faked by passing `run`; the zone is passed.
interface Definition { id: string; title: string; cadence: string; spec: string; zone: string; action: string; body: string }
type Run = (args: string[]) => { code: number; stdout: string };
const setup = (await import(pathToFileURL(join(import.meta.dirname, "..", "scripts", "personas-schedules.mjs")).href)) as {
  roster(projects: Record<string, unknown>): string[];
  personaSchedules(roster: string[], zone: string, sandboxUrl?: string): Definition[];
  storedIds(listOutput: string): Set<string>;
  addArgs(d: Definition): string[];
  runSetup(o: { projectsPath: string; zone: string; sandboxUrl?: string; run: Run; log?: (line: string) => void }): string[];
};

const BUILT_IN = ["gongbang-user-en", "gongbang-user-ko", "gongbang-designer", "gongbang-developer"];
const TEAM = ["gongbang-dev-backend", "gongbang-dev-frontend", "gongbang-dev-platform"];
const ZONE = "Asia/Seoul";

/** A projects.json naming the two users' projects and the dev team, as the owner's file does. */
function projectsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "personas-schedules-"));
  const file = join(dir, "projects.json");
  const p = { project: "x", goal: "g", repo: "/r", cli: "c", dashboard: "http://127.0.0.1:1" };
  writeFileSync(file, JSON.stringify(Object.fromEntries(["gongbang-user-en", "gongbang-user-ko", ...TEAM].map((a) => [a, p]))));
  return file;
}

/** A fake `factory schedule` CLI holding stored IDs: list prints them, add stores one. */
function fakeCli(stored: string[] = []): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = (args) => {
    calls.push(args);
    if (args[0] === "list") return { code: 0, stdout: stored.length ? stored.map((id) => `${id}\tt\tnext\tidle\tfeedback`).join("\n") : "no schedules" };
    const id = args[args.indexOf("--id") + 1]!;
    stored.push(id);
    return { code: 0, stdout: `added ${id}` };
  };
  return { run, calls };
}

describe("persona schedules: one feedback schedule per roster persona", () => {
  it("the roster is the four built-in agents plus every agent key in projects.json, each once", () => {
    const r = setup.roster({ "gongbang-user-en": {}, "gongbang-dev-backend": {} });
    expect(r.slice(0, 4)).toEqual(BUILT_IN);
    expect(r).toContain("gongbang-dev-backend");
    expect(r.filter((a) => a === "gongbang-user-en")).toHaveLength(1);
  });

  it("each schedule is persona-<agent>, feedback, daily at 09:00 in the given zone, with no token cap", () => {
    const defs = setup.personaSchedules(["gongbang-designer"], ZONE);
    expect(defs).toEqual([expect.objectContaining({ id: "persona-gongbang-designer", action: "feedback", cadence: "daily", spec: "09:00", zone: ZONE })]);
    const args = setup.addArgs(defs[0]!);
    expect(args.slice(0, 3)).toEqual(["add", "--id", "persona-gongbang-designer"]);
    expect(args).not.toContain("--token-cap");
    expect(args[args.indexOf("--body") + 1]).toBe(defs[0]!.body);
  });

  it("the prompt names the persona's agent file and feedback.md and says to follow both; a sandbox URL is named when given", () => {
    const [plain] = setup.personaSchedules(["gongbang-user-ko"], ZONE);
    expect(plain!.body).toContain(".claude/agents/gongbang-user-ko.md");
    expect(plain!.body).toContain("scripts/idle-agents/feedback.md");
    expect(plain!.body).toMatch(/follow both/i);
    expect(plain!.body).not.toContain("http://");
    const [withUrl] = setup.personaSchedules(["gongbang-user-ko"], ZONE, "http://127.0.0.1:5123");
    expect(withUrl!.body).toContain("http://127.0.0.1:5123");
  });

  it("on the owner's projects.json the setup adds the seven personas' schedules", () => {
    const cli = fakeCli();
    const added = setup.runSetup({ projectsPath: projectsFile(), zone: ZONE, run: cli.run, log: () => {} });
    for (const a of [...BUILT_IN, ...TEAM]) expect(added).toContain(`persona-${a}`);
    for (const call of cli.calls.filter((c) => c[0] === "add")) expect(call).toEqual(expect.arrayContaining(["--zone", ZONE, "--action", "feedback"]));
  });

  it("a missing projects.json adds no schedule and does not throw", () => {
    const cli = fakeCli();
    const lines: string[] = [];
    expect(setup.runSetup({ projectsPath: join(tmpdir(), "no-such-dir-personas", "projects.json"), zone: ZONE, run: cli.run, log: (l) => lines.push(l) })).toEqual([]);
    expect(cli.calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/projects\.json/);
  });

  it("running the setup again adds no second schedule for an ID already stored", () => {
    const cli = fakeCli(["persona-gongbang-designer", "other"]);
    const first = setup.runSetup({ projectsPath: projectsFile(), zone: ZONE, run: cli.run, log: () => {} });
    expect(first).not.toContain("persona-gongbang-designer");
    expect(first).toContain("persona-gongbang-developer");
    const again = setup.runSetup({ projectsPath: projectsFile(), zone: ZONE, run: cli.run, log: () => {} });
    expect(again).toEqual([]);
    expect(setup.storedIds("no schedules").size).toBe(0);
  });
});
