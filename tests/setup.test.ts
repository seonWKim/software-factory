import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/compose.js";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import { type SecretStore, secretName } from "../src/interfaces/secret-store.js";
import { createLabels } from "../src/impl/github/github-issue-source.js";
import { checkStatus, ensureSecretFile, setSecret, statusLabelChecks, tokenExpiryCheck } from "../src/setup.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";

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

    await setSecret(file, secretName("GITHUB_TOKEN"), "github_pat_abc");
    await setSecret(file, secretName("GITHUB_TOKEN"), "github_pat_def");
    const text = readFileSync(file, "utf8");
    expect(text).toBe("# comment\nCLAUDE_CODE_OAUTH_TOKEN=\nGITHUB_TOKEN=github_pat_def\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    await ensureSecretFile(file, template); // existing file is kept
    expect(readFileSync(file, "utf8")).toContain("github_pat_def");

    // A key added to the template later is appended empty; existing values stay.
    writeFileSync(template, "CLAUDE_CODE_OAUTH_TOKEN=\nGITHUB_TOKEN=\nMYSQL_HOST=\nMYSQL_PASSWORD=\n");
    await ensureSecretFile(file, template);
    expect(readFileSync(file, "utf8")).toBe(
      "# comment\nCLAUDE_CODE_OAUTH_TOKEN=\nGITHUB_TOKEN=github_pat_def\nMYSQL_HOST=\nMYSQL_PASSWORD=\n",
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses empty or whitespace values", async () => {
    await expect(setSecret("/nonexistent", secretName("GITHUB_TOKEN"), "a b")).rejects.toThrow(/nothing written/);
  });
});

/** Repo labels in memory: GET by name (404 if absent), POST creates (422 already_exists if present). */
class LabelsClient extends GitHubClient {
  names = new Set<string>();
  failOn: string | null = null;
  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method === "GET") {
      const name = decodeURIComponent(path.split("/labels/")[1]!);
      if (!this.names.has(name)) throw new GitHubError(404, `GitHub GET ${path} → 404`);
      return {} as T;
    }
    const name = (body as { name: string }).name;
    if (name === this.failOn) throw new GitHubError(403, `GitHub POST ${path} → 403 forbidden`);
    if (this.names.has(name)) throw new GitHubError(422, `GitHub POST ${path} → 422 {"errors":[{"code":"already_exists"}]}`);
    this.names.add(name);
    return {} as T;
  }
}

describe("setup and doctor: status labels", () => {
  const repo = { owner: "o", name: "r" };

  it("doctor warns (never FAILs) for each missing status label", async () => {
    const client = new LabelsClient();
    client.names.add("sf: triaging");
    const checks = await statusLabelChecks(client, repo, "sf: ");
    // Eight status labels and the PR flag label `incomplete` (issue #229).
    expect(checks).toHaveLength(9);
    expect(checks[0]).toEqual({ ok: true, msg: 'status label "sf: triaging" exists' });
    const missing = checks.filter((c) => !c.ok);
    expect(missing).toHaveLength(8);
    expect(missing.map((c) => c.msg)).toContain('status label "sf: incomplete" exists (run: npm run setup)');
    expect(missing.every((c) => c.warn === true)).toBe(true);
    expect(missing.map((c) => c.msg)).toContain('status label "sf: needs approval" exists (run: npm run setup)');
  });

  it("setup creates every label and reports created / already exists / could not create", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log.mockClear();
    const client = new LabelsClient();
    client.names.add("factory");
    client.failOn = "sf: done";
    await createLabels(client, repo, [
      { name: "factory", color: "5319e7", description: "d" },
      { name: "sf: triaging", color: "c5def5", description: "d" },
      { name: "sf: done", color: "cccccc", description: "d" },
    ]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe('   "factory": already exists');
    expect(lines[1]).toBe('   "sf: triaging": created');
    expect(lines[2]).toMatch(/^ {3}"sf: done": could not create it: .*403/);
    log.mockRestore();
  });
});

describe("config: status_label_prefix", () => {
  it("defaults to 'sf: ' when factory.config.json does not set it", async () => {
    const loaded = await loadConfig(join(import.meta.dirname, ".."));
    expect(loaded.file.status_label_prefix).toBeUndefined();
    expect(loaded.config.status_label_prefix).toBe("sf: ");
  });
});

/** A GitHub client whose token expires at `expires` (null: never); counts the expiry reads. */
class ExpiryClient extends GitHubClient {
  reads = 0;
  constructor(private readonly expires: Date | null) {
    super({} as GitHubCredentials, "http://unused");
  }
  override async tokenExpiration(): Promise<Date | null> {
    this.reads++;
    return this.expires;
  }
}

describe("doctor: GitHub token expiry thresholds (design §9 Health)", () => {
  const repo = { owner: "o", name: "r" };
  const NOW = new Date("2026-11-07T12:00:00.000Z");
  const inDays = (d: number, extraMs = 0) => new Date(NOW.getTime() + d * 86_400_000 + extraMs);
  const check = (exp: Date | null) => tokenExpiryCheck(new ExpiryClient(exp), repo, NOW);

  it("0 days or less is fail, 1 or 2 days warn, 3 days or more ok", async () => {
    expect(checkStatus(await check(inDays(-1)))).toBe("fail");
    expect(checkStatus(await check(inDays(0)))).toBe("fail");
    // Under a whole day left counts as 0 days.
    expect(checkStatus(await check(inDays(0, 23 * 3_600_000)))).toBe("fail");
    expect(checkStatus(await check(inDays(1)))).toBe("warn");
    expect(checkStatus(await check(inDays(2, 3_600_000)))).toBe("warn");
    expect(checkStatus(await check(inDays(3)))).toBe("ok");
    expect(checkStatus(await check(inDays(90)))).toBe("ok");
  });

  it("says how many days are left and carries the number; a soon-expiring token names the rotate command", async () => {
    expect(await check(inDays(2))).toEqual({ ok: false, warn: true, token_days: 2, msg: "GitHub token expires in 2 days (run: npm run setup -- --rotate-github)" });
    expect(await check(inDays(0))).toEqual({ ok: false, token_days: 0, msg: "GitHub token expires in 0 days (run: npm run setup -- --rotate-github)" });
    expect((await check(inDays(10))).token_days).toBe(10);
  });

  it("a token that never expires stays a warn", async () => {
    expect(checkStatus(await check(null))).toBe("warn");
  });

  it("an App grant expiring in one hour is ok with no token_days and no GitHub read", async () => {
    const client = new ExpiryClient(null);
    const c = await tokenExpiryCheck(client, repo, NOW, { expires_at: inDays(0, 3_600_000) });
    expect(c).toEqual({ ok: true, msg: "GitHub App token minted (renewed automatically)" });
    expect(c.token_days).toBeUndefined();
    expect(client.reads).toBe(0);
  });
});
