import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_TOOLS, WRITE_TOOLS } from "../src/core/worker.js";
import { Glob, Read, TOOLS } from "../src/core/tools/index.js";
import { ENV_FILE_DENY, buildClaudeArgs, buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
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
  it("returns the expected object for the given deny_paths and writable_paths", () => {
    expect(buildHarnessSettings({ deny_paths: DENY, writable_paths: WRITABLE })).toEqual({
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", npm_config_update_notifier: "false" },
      permissions: {
        deny: [
          "Read(//home/op/.config/software-factory)",
          "Read(//home/op/.config/software-factory/**)",
          "Read(//repo/.factory/db)",
          "Read(//repo/.factory/db/**)",
          ...ENV_FILE_DENY,
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
        network: { allowLocalBinding: true },
        credentials: {
          envVars: [
            { name: "GITHUB_TOKEN", mode: "deny" },
            { name: "GH_TOKEN", mode: "deny" },
          ],
        },
      },
    });
  });

  it("the .env rules (#103): .env and .env.* globs for Read and Edit; what they match is in tests/guards.test.ts", () => {
    expect(ENV_FILE_DENY.slice(0, 2)).toEqual(["Read(**/.env)", "Read(**/.env.)"]);
    expect(ENV_FILE_DENY).toContain("Read(**/.env.????????*)");
    expect(ENV_FILE_DENY).toContain("Edit(**/.env)");
    expect(ENV_FILE_DENY.filter((r) => r.startsWith("Read("))).toHaveLength(ENV_FILE_DENY.length / 2);
  });

  it("network: localhost binding only; no host allowed, no proxy, no socket opened", () => {
    const s = buildHarnessSettings({ deny_paths: DENY, writable_paths: WRITABLE }) as {
      permissions: { deny: string[] };
      sandbox: { network: Record<string, unknown> };
    };
    // Exactly one network key: no allowedDomains (every outbound host, registry.npmjs.org included, stays denied),
    // no Unix sockets, no proxy ports.
    expect(s.sandbox.network).toEqual({ allowLocalBinding: true });
    expect(JSON.stringify(s)).not.toMatch(/allowedDomains|allowUnixSockets|allowAllUnixSockets|ProxyPort|registry\.npmjs/);
    // The deny rules are those of the snapshot above, unchanged by the network setting.
    expect(s.permissions.deny).toContain("WebFetch");
    expect(s.permissions.deny).toContain("Bash(mysql:*)");
    expect(s.permissions.deny).toContain("Read(//home/op/.config/software-factory/**)");
  });

  it("empty deny_paths and writable_paths", () => {
    const s = buildHarnessSettings({ deny_paths: [], writable_paths: [] }) as {
      permissions: { deny: string[] };
      sandbox: { filesystem: unknown };
    };
    expect(s.permissions.deny[0]).toBe("Read(**/.env)");
    expect(s.permissions.deny).toHaveLength(11 + ENV_FILE_DENY.length);
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
