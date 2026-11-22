// The update range helpers (design 08-self-update): the commit count and subjects between previous_rev and rev,
// from a fake exec (no git runs).
import { describe, expect, it } from "vitest";
import { UPDATE_SUBJECTS, revListCount, updateChanges } from "../src/impl/updater/code-origin.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";

const ok = (stdout: string): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
const failed: ExecResult = { exit_code: 128, signal: null, stdout: "", stderr: "fatal: bad revision", timed_out: false };

/** A fake git: answers by its first argument after `git`, recording each command. */
function fakeGit(answers: Record<string, ExecResult>) {
  const calls: string[] = [];
  const exec = async (cmd: readonly string[]) => {
    calls.push(cmd.join(" "));
    return answers[cmd[1]!] ?? failed;
  };
  return { calls, exec };
}

describe("code origin: the update range", () => {
  it("revListCount runs git rev-list --count from..to; a failure or bad output is null", async () => {
    const g = fakeGit({ "rev-list": ok("12\n") });
    expect(await revListCount(g.exec, "c0147", "3dc0029")).toBe(12);
    expect(g.calls).toContain("git rev-list --count c0147..3dc0029");
    expect(await revListCount(fakeGit({}).exec, "a", "b")).toBeNull();
    expect(await revListCount(fakeGit({ "rev-list": ok("nope") }).exec, "a", "b")).toBeNull();
  });

  it("updateChanges counts and lists the subjects of previous..rev, newest first, at most UPDATE_SUBJECTS", async () => {
    const g = fakeGit({ "rev-list": ok("2\n"), log: ok("Second change\nFirst change\n") });
    const changes = updateChanges(g.exec);
    expect(await changes("c0147", "3dc0029")).toEqual({ count: 2, subjects: ["Second change", "First change"] });
    expect(g.calls).toContain(`git log --format=%s --max-count=${UPDATE_SUBJECTS} c0147..3dc0029`);
  });

  it("is cached per revision pair: a second read of the same pair runs no git; a new pair does", async () => {
    const g = fakeGit({ "rev-list": ok("2\n"), log: ok("x\n") });
    const changes = updateChanges(g.exec);
    await changes("a1", "b2");
    const ran = g.calls.length;
    await changes("a1", "b2");
    expect(g.calls.length).toBe(ran);
    await changes("b2", "c3");
    expect(g.calls.length).toBeGreaterThan(ran);
  });

  it("a git failure gives no count and no subjects", async () => {
    const changes = updateChanges(fakeGit({}).exec);
    expect(await changes("a1", "b2")).toEqual({ count: null, subjects: [] });
  });
});
