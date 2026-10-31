import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureSecretFile, setSecret } from "../src/setup.js";

describe("setup: secret file writes", () => {
  it("creates the file from the template with private modes, and replaces only the named line", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = mkdtempSync(join(tmpdir(), "sf-setup-"));
    const template = join(root, ".env.example");
    writeFileSync(template, "# comment\nCLAUDE_CODE_OAUTH_TOKEN=\nGITHUB_TOKEN=\n");
    const file = join(root, "cfg", "software-factory", ".env");

    await ensureSecretFile(file, template);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "cfg", "software-factory")).mode & 0o777).toBe(0o700);

    await setSecret(file, "GITHUB_TOKEN", "github_pat_abc");
    await setSecret(file, "GITHUB_TOKEN", "github_pat_def");
    const text = readFileSync(file, "utf8");
    expect(text).toBe("# comment\nCLAUDE_CODE_OAUTH_TOKEN=\nGITHUB_TOKEN=github_pat_def\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    await ensureSecretFile(file, template); // existing file is kept
    expect(readFileSync(file, "utf8")).toContain("github_pat_def");
  });

  it("refuses empty or whitespace values", async () => {
    await expect(setSecret("/nonexistent", "GITHUB_TOKEN", "a b")).rejects.toThrow(/nothing written/);
  });
});
