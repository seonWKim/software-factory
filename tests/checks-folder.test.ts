// runChecks runs each gate entry in its own folder (design 04-gate-commands): a `{ dir, argv }` entry passes `dir` as
// the exec's cwd, a plain argv runs in the run folder (no cwd), and the argv goes to exec as it is, with no shell.

import { describe, expect, it } from "vitest";
import { checkedLines, commandText, runChecks } from "../src/core/checks.js";
import type { GateEntry } from "../src/core/config.js";
import type { ExecResult, Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";

function recording(exits: Record<string, number> = {}) {
  const calls: { argv: string[]; cwd: string | undefined }[] = [];
  const sandbox = {
    exec: async (_h: SandboxHandle, argv: string[], o: { cwd?: string }): Promise<ExecResult> => {
      calls.push({ argv: [...argv], cwd: o.cwd });
      return { exit_code: exits[argv.join(" ")] ?? 0, stdout: "", stderr: "", timed_out: false } as ExecResult;
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
}

const handle = { id: "h1", workdir: "/runs/r1" } as SandboxHandle;
const run = (sandbox: Sandbox, commands: readonly GateEntry[], cwd?: string) =>
  runChecks({ sandbox, handle, commands, env: {}, timeout_ms: 1000, signal: new AbortController().signal, redact: [], ...(cwd === undefined ? {} : { cwd }) });

describe("runChecks: each entry in its folder", () => {
  it("passes each entry's folder as cwd per command; a plain argv runs in the run folder", async () => {
    const { sandbox, calls } = recording();
    const round = await run(sandbox, [{ dir: "backend", argv: ["./gradlew", "test"] }, ["npm", "run", "lint"], { dir: "frontend", argv: ["npm", "test"] }]);
    expect(calls).toEqual([
      { argv: ["./gradlew", "test"], cwd: "backend" },
      { argv: ["npm", "run", "lint"], cwd: undefined },
      { argv: ["npm", "test"], cwd: "frontend" },
    ]);
    expect(round.failed).toBeNull();
    expect(round.results.map((r) => r.dir)).toEqual(["backend", undefined, "frontend"]);
  });

  it("a folder entry under a given cwd runs in that folder inside it", async () => {
    const { sandbox, calls } = recording();
    await run(sandbox, [{ dir: "frontend", argv: ["npm", "test"] }, ["npm", "ci"]], "sub");
    expect(calls.map((c) => c.cwd)).toEqual(["sub/frontend", "sub"]);
  });

  it("the failed entry keeps its folder, and the text names it", async () => {
    const { sandbox } = recording({ "npm test": 1 });
    const round = await run(sandbox, [["npm", "ci"], { dir: "frontend", argv: ["npm", "test"] }]);
    expect(round.failed).toMatchObject({ command: ["npm", "test"], dir: "frontend", ok: false, how: "exited 1" });
    expect(commandText({ dir: "frontend", argv: ["npm", "test"] })).toBe("npm test (in frontend/)");
    expect(commandText(["npm", "test"])).toBe("npm test");
    expect(checkedLines(round.results, { fixed: false })).toContain("Checked before push: `npm test (in frontend/)` exited 1");
  });
});
