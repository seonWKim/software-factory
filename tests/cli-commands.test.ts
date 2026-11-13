import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCommands } from "../src/cli/index.js";

// RFC 0015 M2: commands are found under src/cli/handlers/, never listed in main.ts.

describe("CLI command discovery", () => {
  it("finds every command, each with its help block", async () => {
    const commands = await loadCommands();
    for (const name of ["setup", "dev", "controller", "worker", "status", "stats", "workers", "resume", "link-code", "settings", "mode", "ui", "migrate", "doctor", "llm-check", "canary", "improve", "session", "task", "approve", "retry", "revise", "reject", "resolve", "merge", "help", "issue", "golden"]) {
      expect(commands.get(name), name).toBeDefined();
    }
    // `factory users` is gone (one owner, issue #577): no command claims the word.
    expect(commands.get("users")).toBeUndefined();
    for (const c of new Set(commands.values())) {
      expect(c.usage.split("\n").every((l) => l.startsWith("  ")), c.names[0]).toBe(true);
      expect(c.usage.includes(`  ${c.names[0]}`) || c.names.length > 1, c.names[0]).toBe(true);
    }
  });

  it("refuses two commands that claim one word", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-cli-"));
    const api = join(import.meta.dirname, "../src/cli/command.ts").replaceAll("\\", "/");
    for (const dir of ["a", "b"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, `${dir}.command.ts`), `import { defineCommand } from "${api}";\nexport default defineCommand({ names: ["same"], usage: "  same", run: async () => 0 });\n`);
    }
    await expect(loadCommands(root)).rejects.toThrow(/"same" is defined twice/);
  });
});
