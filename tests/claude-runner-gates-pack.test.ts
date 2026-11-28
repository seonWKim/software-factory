import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_HOOKS_DIR, HOOK_SCRIPT, HOOK_SPEC, PATH_REFUSAL, hookScript, specFile } from "../src/impl/runner/gate-hooks.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import { PackCheckRunner } from "../src/runtime/hooks/pack-checks.js";
import { GATES, MODES, TOKEN, drive, runHook, setup } from "./helpers/gate-hooks-fixture.js";

// The on_tool_call pack checks (design §4, issue #494): a fixture check script, run as argv (no shell) by a local
// exec, in the PreToolUse hook before the allowed_paths check. A refusal, a crash or a timeout refuses the edit.

const CHECK_SCRIPT = `import { relative } from "node:path";
const [mode, allowed, tool, file] = process.argv.slice(2);
if (mode === "crash") process.kill(process.pid, "SIGKILL");
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "leak") { console.error("found " + allowed); process.exit(1); }
else if (mode === "args") { console.log(JSON.stringify(process.argv.slice(2))); process.exit(0); }
else if (mode === "scope") {
  const rel = relative(process.cwd(), file);
  if (rel.startsWith("..") || !rel.startsWith(allowed)) { console.error(tool + " " + rel + " is outside " + allowed); process.exit(1); }
}
`;

/** Runs argv as a process, no shell, in the handle's workdir with only the given env; kills it past its timeout. */
const localExec = {
  argvs: [] as string[][],
  exec: (h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> =>
    new Promise((resolve) => {
      localExec.argvs.push([...cmd]);
      const child = spawn(cmd[0]!, cmd.slice(1), { cwd: h.workdir, env: { ...o.env }, shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      const timer = setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), o.timeout_ms ?? 10_000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exit_code: code, signal, stdout, stderr, timed_out: timedOut });
      });
    }),
};

function packSetup(mode: string, allowed = "src/", timeout_ms = 5000) {
  const f = setup();
  const script = join(f.root, "check.mjs");
  writeFileSync(script, CHECK_SCRIPT);
  const checks = new PackCheckRunner([{ name: "scope-check", point: "on_tool_call", argv: [process.execPath, script, mode, allowed], timeout_ms, retries: 3 }], {
    sandbox: localExec, now: () => "2026-11-11T00:00:00.000Z",
  });
  const on_tool_call = checks.at("on_tool_call", { subject: "run_1", project_id: "p1", sandbox: f.spec.sandbox, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })!;
  f.spec = { ...f.spec, gate_hooks: { ...GATES, on_tool_call } };
  return f;
}

for (const mode of MODES) describe(`gate hooks: on_tool_call pack checks (${mode})`, () => {
  it("a fixture check refuses an Edit outside its paths before the path check; the file is not changed", async () => {
    // src/a.ts is in allowed_paths; the check allows only docs/, so the refusal is the check's own.
    const f = packSetup("scope", "docs/");
    mkdirSync(join(f.workdir, "src"));
    writeFileSync(join(f.workdir, "src", "a.ts"), "orig");
    let refusal: string | null = null;
    f.sandbox.agent = async (a) => {
      refusal = await a.write("Edit", join(a.workdir, "src", "a.ts"));
    };
    const result = await drive(f, mode);
    expect(readFileSync(join(f.workdir, "src", "a.ts"), "utf8")).toBe("orig");
    expect(refusal).toContain("The pack check scope-check refused this edit");
    expect(refusal).toMatch(/exited 1: Edit \S*src\/a\.ts is outside docs\//);
    expect(result.gate_blocks).toEqual([{ hook: "pre_tool_use", check: "pack:scope-check", attempt: 1 }]);
  });

  it("a Write outside allowed_paths is refused by the check, and not written", async () => {
    const f = packSetup("scope", "src/");
    let refusal: string | null = null;
    f.sandbox.agent = async (a) => {
      refusal = await a.write("Write", join(f.root, "outside.txt"));
    };
    await drive(f, mode);
    expect(refusal).toContain("The pack check scope-check refused this edit");
    expect(existsSync(join(f.root, "outside.txt"))).toBe(false);
  });

  it("fails closed: a check that crashes or runs past its timeout refuses the edit", async () => {
    for (const [m, why] of [["crash", "pack_check_error: killed by SIGKILL"], ["hang", "pack_check_timeout: over its 300 ms timeout"]] as const) {
      const f = packSetup(m, "src/", 300);
      let refusal: string | null = null;
      f.sandbox.agent = async (a) => {
        refusal = await a.write("Edit", join(a.workdir, "src", "a.ts"));
      };
      await drive(f, mode);
      expect(refusal, m).toContain(why);
      expect(existsSync(join(f.workdir, "src", "a.ts")), m).toBe(false);
    }
  });

  it("a refusal reason the egress scanner flags is withheld from the agent", async () => {
    const f = packSetup("leak", TOKEN);
    let refusal: string | null = null;
    f.sandbox.agent = async (a) => {
      refusal = await a.write("Edit", join(a.workdir, "src", "a.ts"));
    };
    await drive(f, mode);
    expect(refusal).toContain("The pack check scope-check refused this edit: (its output is withheld");
    expect(refusal).not.toContain(TOKEN);
  });

  it("a pass approves nothing: the allowed_paths check still refuses, and an edit inside both goes ahead", async () => {
    const f = packSetup("pass");
    const refusals: (string | null)[] = [];
    f.sandbox.agent = async (a) => {
      refusals.push(await a.write("Edit", join(a.workdir, "src", "other.ts")));
      refusals.push(await a.write("Edit", join(a.workdir, "src", "a.ts")));
    };
    await drive(f, mode);
    expect(refusals[0]).toContain(PATH_REFUSAL);
    expect(refusals[1]).toBeNull();
    expect(existsSync(join(f.workdir, "src", "other.ts"))).toBe(false);
  });

  it("the check gets the tool name and the file path after its argv, never the file content", async () => {
    localExec.argvs = [];
    const f = packSetup("args");
    f.sandbox.agent = async (a) => {
      await a.write("Write", join(a.workdir, "src", "a.ts"));
    };
    await drive(f, mode);
    expect(localExec.argvs.map((a) => a.slice(2))).toEqual([["args", "src/", "Write", join(f.workdir, "src", "a.ts")]]);
  });
});

describe("gate hooks: on_tool_call fails closed in the script", () => {
  it("with on_tool_call checks, a PreToolUse that cannot reach its host refuses; Stop still allows", async () => {
    const f = packSetup("pass");
    const spec = specFile({ ...f.spec, gate_hooks: f.spec.gate_hooks! }, join(f.root, "gone"));
    expect(spec).toMatchObject({ fail_closed: true, on_tool_call: ["scope-check"] });
    const dir = join(f.configDir, GATE_HOOKS_DIR, "run_1");
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, HOOK_SCRIPT), hookScript());
    await writeFile(join(dir, HOOK_SPEC), JSON.stringify(spec));
    const cmd = `'${process.execPath}' '${join(dir, HOOK_SCRIPT)}'`;
    const pre = await runHook(`${cmd} pre_tool_use`, { tool_name: "Edit", tool_input: { file_path: join(f.workdir, "src", "a.ts") } });
    expect(JSON.parse(pre.out)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(await runHook(`${cmd} stop`, {})).toEqual({ out: "", code: 0 });
  });

  it("the Claude Code runner declares tool-hook support", () => {
    expect(setup().runner.supports_tool_hooks).toBe(true);
  });
});
