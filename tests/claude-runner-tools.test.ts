import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_TOOLS, WRITE_TOOLS } from "../src/core/worker.js";
import { Glob, Read, TOOLS } from "../src/core/tools/index.js";
import { buildClaudeArgs, buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";

// Snapshot of the Claude Code runner's tool flags and settings: moving them onto the shared tool specs and
// guard policy (#89) must not change the runner's output for the same input.

const DENY = ["/home/op/.config/software-factory", "/repo/.factory/db"];
const WRITABLE = ["/home/op/.cache/run"];

function spec(tools: AgentRunSpec["tools"]): AgentRunSpec {
  return {
    tools,
    deny_paths: DENY,
    writable_paths: WRITABLE,
    system_prompt: "s",
    sandbox: { id: "sbx", workdir: "/runs/r1" },
  } as unknown as AgentRunSpec;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe("claude-code runner tool flags (snapshot)", () => {
  it("write set: --tools and --allowedTools are exactly Bash,Read,Edit,Write,Glob,Grep", () => {
    const args = buildClaudeArgs(spec(WRITE_TOOLS), "m");
    expect(flag(args, "--tools")).toBe("Bash,Read,Edit,Write,Glob,Grep");
    expect(flag(args, "--allowedTools")).toBe("Bash,Read,Edit,Write,Glob,Grep");
  });

  it("read set: --tools and --allowedTools are exactly Read,Glob,Grep", () => {
    const args = buildClaudeArgs(spec(READ_TOOLS), "m");
    expect(flag(args, "--tools")).toBe("Read,Glob,Grep");
    expect(flag(args, "--allowedTools")).toBe("Read,Glob,Grep");
  });

  it("--allowedTools lists exactly the names in spec.tools and nothing else", () => {
    for (const tools of [[Read], [Glob, Read], TOOLS, READ_TOOLS, WRITE_TOOLS]) {
      const args = buildClaudeArgs(spec(tools), "m");
      expect(flag(args, "--allowedTools")!.split(",")).toEqual(tools.map((t) => t.name));
      expect(flag(args, "--tools")!.split(",")).toEqual(tools.map((t) => t.name));
    }
  });

  it("no tools: empty --tools and no --allowedTools", () => {
    const args = buildClaudeArgs(spec([]), "m");
    expect(flag(args, "--tools")).toBe("");
    expect(args).not.toContain("--allowedTools");
  });
});

describe("buildHarnessSettings (snapshot)", () => {
  it("returns the same object as before for the same deny_paths and writable_paths", () => {
    expect(buildHarnessSettings({ deny_paths: DENY, writable_paths: WRITABLE })).toEqual({
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
      permissions: {
        deny: [
          "Read(//home/op/.config/software-factory)",
          "Read(//home/op/.config/software-factory/**)",
          "Read(//repo/.factory/db)",
          "Read(//repo/.factory/db/**)",
          "Read(**/.env)",
          "Read(**/.env.*)",
          "Bash(gh:*)",
          "Bash(security:*)",
          "Bash(git push:*)",
          "Bash(git credential:*)",
          "Bash(printenv:*)",
          "Bash(env)",
          "Bash(mysql:*)",
          "Bash(mysqldump:*)",
          "Bash(mysqladmin:*)",
          "WebFetch",
          "WebSearch",
        ],
      },
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyRead: DENY, allowWrite: WRITABLE },
        credentials: {
          envVars: [
            { name: "GITHUB_TOKEN", mode: "deny" },
            { name: "GH_TOKEN", mode: "deny" },
          ],
        },
      },
    });
  });

  it("empty deny_paths and writable_paths", () => {
    const s = buildHarnessSettings({ deny_paths: [], writable_paths: [] }) as {
      permissions: { deny: string[] };
      sandbox: { filesystem: unknown };
    };
    expect(s.permissions.deny[0]).toBe("Read(**/.env)");
    expect(s.permissions.deny).toHaveLength(13);
    expect(s.sandbox.filesystem).toEqual({ denyRead: [], allowWrite: [] });
  });
});

describe("claude-code runner source", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "impl", "runner", "claude-code-runner.ts"), "utf8");

  it("takes path rules from the shared guard policy, not its own copy", () => {
    expect(src).toContain("guardPolicy(");
    expect(src).not.toMatch(/const FORBIDDEN_ENV\s*=/);
    expect(src).not.toMatch(/spec\.deny_paths\.flatMap/);
  });
});

describe("run spec tool sets", () => {
  it("the read set has no write or exec tool", () => {
    expect(READ_TOOLS.filter((t) => t.capability !== "read")).toEqual([]);
  });
});
