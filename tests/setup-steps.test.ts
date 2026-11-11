// `factory setup` steps (issue #501): one frame for every step (title, why, question with its default, ✓/✗), the
// secrets the selected plugins declare asked with hidden input (GitHub's never with GitHub off, even when the
// config diff is declined), `--yes` reading nothing, and the progress record with "Continue from step N?".

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultsAsk, terminalAsk } from "../src/cli/handlers/setup/ask.js";
import { type GuidedState, SETUP_STEPS, runSetup, terminalIo } from "../src/cli/handlers/setup/guided.js";
import { progressFile } from "../src/cli/handlers/setup/progress.js";
import { loadConfig } from "../src/compose.js";
import {
  type SetupIo,
  type SetupStep,
  anthropicKeyCheck,
  checkLine,
  doctorChecks,
  markedLine,
  neededSecrets,
  runStep,
  secretFileStep,
  secretsToPrompt,
} from "../src/setup.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const GITHUB = ["GITHUB_APP_ID", "GITHUB_TOKEN"];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Every GitHub plugin off (what "Sync with GitHub? no" writes), `github_auth` kept; SQLite, no Slack. */
const localOnly = (githubAuth: string) => ({
  ...REAL,
  store: { type: "sqlite" },
  auth: "local",
  permissions: { grants: ["static"] },
  plugins: { ...(REAL.plugins as object), source: ["local"], broker: "local", github_auth: githubAuth },
});

/**
 * A throwaway repo root with `config`, prompts, the real .env.example and a state dir. The secret file is a path in
 * its own folder, holding `secrets` (or not there yet when null). Returns the GuidedState setup would build.
 */
async function state(config: Record<string, unknown>, secrets: string | null = "# nothing yet\n"): Promise<GuidedState> {
  const dir = mkdtempSync(join(tmpdir(), "sf-setup-steps-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  copyFileSync(join(REPO_ROOT, ".env.example"), join(dir, ".env.example"));
  writeFileSync(join(dir, "factory.config.json"), `${JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }, null, 2)}\n`);
  const secretsFile = join(mkdtempSync(join(tmpdir(), "sf-setup-steps-cfg-")), "software-factory", ".env");
  if (secrets !== null) {
    mkdirSync(join(secretsFile, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(secretsFile, secrets, { mode: 0o600 });
  }
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", secretsFile);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const load = () => loadConfig(dir, { platform: "linux" });
  const loaded = await load();
  return { loaded, github: loaded.config.local_only !== true, rotate: [], ctx: { name: "setup", usage: "", load } };
}

/**
 * A fake terminal: `answers` are typed in order (a prompt with none left fails the test), `secrets` pasted at the
 * hidden prompts. `out` is the screen: each question with its typed answer on one line.
 */
function terminal(answers: string[], secrets: string[] | ((prompt: string) => string) = []) {
  const out: string[] = [];
  const secretPrompts: string[] = [];
  const print = (line: string) => out.push(...line.split("\n"));
  const io: SetupIo = {
    ask: terminalAsk(async (prompt) => {
      if (answers.length === 0) throw new Error(`unexpected question: ${prompt}`);
      const a = answers.shift()!;
      out.push(`${prompt}${a}`);
      return a;
    }, print),
    secret: async (prompt) => {
      secretPrompts.push(prompt);
      out.push(prompt);
      return typeof secrets === "function" ? secrets(prompt) : (secrets.shift() ?? "");
    },
    print,
  };
  return { io, out, secretPrompts };
}

/** `--yes`: every default, and a hidden prompt fails the test. */
function defaults() {
  const out: string[] = [];
  const print = (line: string) => out.push(...line.split("\n"));
  const io: SetupIo = {
    ask: defaultsAsk(print),
    secret: async (prompt) => {
      throw new Error(`--yes read a secret: ${prompt}`);
    },
    print,
  };
  return { io, out };
}

const step = (name: string): SetupStep<GuidedState> => SETUP_STEPS.find((s) => s.name === name)!;

class MapSecrets implements SecretStore {
  constructor(private readonly values: Record<string, string>) {}
  async get(name: SecretName): Promise<Secret | null> {
    const v = this.values[name];
    return v === undefined ? null : { name, reveal: () => v, toJSON: () => `[secret ${name}]` };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(this.values);
  }
}

describe("one step frame", () => {
  it("pins the frame: title, one line on why, the question with its default, then the ✓ line", async () => {
    const s = await state(localOnly("app"), null);
    const { io, out } = terminal([""]);
    const r = await runStep(3, secretFileStep, s, io);
    const file = s.loaded.secretsFile;
    expect(r.ok).toBe(true);
    expect(out).toEqual([
      "",
      "3. Secret file",
      "   Holds every credential, outside the repository, readable only by you (folder 700, file 600).",
      `   Create or update ${file}? [Y/n] `,
      `   ✓ ${file} is ready (folder 700, file 600, outside the repository)`,
    ]);
  });

  it("a ✗ result is marked ✗; a step that succeeds without asking anything is refused", async () => {
    const s = await state(localOnly("app"), null);
    const { io, out } = terminal(["n"]);
    expect((await runStep(1, secretFileStep, s, io)).ok).toBe(false);
    expect(out.at(-1)).toMatch(/^ {3}✗ secret file not written/);
    const silent: SetupStep<GuidedState> = { name: "silent", title: "Silent", why: "w", run: async () => ({ ok: true, line: "done" }) };
    await expect(runStep(1, silent, s, defaults().io)).rejects.toThrow(/asked no question/);
  });

  it("every step has a unique name, a title and one line on why", () => {
    const names = SETUP_STEPS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SETUP_STEPS) {
      expect(s.title.trim(), s.name).not.toBe("");
      expect(s.why.trim(), s.name).not.toBe("");
      expect(s.why, s.name).not.toContain("\n");
    }
    // The order setup runs them in.
    const at = (n: string) => names.indexOf(n);
    const order = ["plugins", "secret-file", "secrets", "database", "you", "mode", "checks", "canary"];
    for (const [a, b] of order.slice(1).map((n, i) => [order[i]!, n] as const)) {
      expect(at(a), `${a} before ${b}`).toBeGreaterThanOrEqual(0);
      expect(at(a), `${a} before ${b}`).toBeLessThan(at(b));
    }
    // The store is SQLite (design 05-coordination.md): setup asks no store question.
    expect(names).not.toContain("store");
  });

  it("a solo run under --yes: each step from Plugins to Mode prints its title, why, a question with its default and a ✓/✗ line", async () => {
    const s = await state(localOnly("app"), null);
    const { io, out } = defaults();
    const steps = SETUP_STEPS.slice(0, SETUP_STEPS.findIndex((x) => x.name === "mode") + 1);
    await runSetup(steps, s, io);
    steps.forEach((st, i) => {
      const start = out.indexOf(`${i + 1}. ${st.title}`);
      expect(start, st.name).toBeGreaterThan(0);
      expect(out[start + 1], st.name).toBe(`   ${st.why}`);
      const end = i + 1 < steps.length ? out.indexOf(`${i + 2}. ${steps[i + 1]!.title}`) : out.length;
      const body = out.slice(start + 2, end);
      // defaultsAsk prints each question with the default it took.
      expect(body.some((l) => /\?? (yes|no|manual|auto|\d)$|\]$/.test(l) || l.includes("display name")), st.name).toBe(true);
      expect(body.filter((l) => /^ {3}[✓✗] /.test(l)), st.name).toHaveLength(1);
    });
  });
});

describe("secrets: asked when a selected plugin declares them, with hidden input", () => {
  it("solo (no GitHub, no Slack) needs the model credential only; team (GitHub, Slack) adds the GitHub App ID and Slack, never MYSQL_PASSWORD", async () => {
    const solo = (await state(localOnly("app"))).loaded;
    const soloNeeded = neededSecrets(solo).map((d) => d.name);
    expect(soloNeeded).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]));
    for (const name of [...GITHUB, "MYSQL_PASSWORD", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) expect(soloNeeded, name).not.toContain(name);

    const team = (await state(REAL)).loaded;
    expect(team.store.type).toBe("sqlite");
    const teamNeeded = neededSecrets(team).map((d) => d.name);
    expect(teamNeeded).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_APP_ID", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]));
    expect(teamNeeded).not.toContain("MYSQL_PASSWORD");

    // Asked: one per model credential group, each other missing one.
    const asked = async (loaded: typeof solo) => (await secretsToPrompt(neededSecrets(loaded), new MapSecrets({}), [])).map((d) => d.name);
    expect(await asked(solo)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(await asked(solo)).not.toContain("ANTHROPIC_API_KEY");
    expect(await asked(team)).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_APP_ID", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]));
  });

  it("team: every missing one is asked in this run with hidden input and written to the secret file", async () => {
    const s = await state(REAL);
    const { io, out, secretPrompts } = terminal([""], (prompt) => `value-of-${/Paste (\w+)/.exec(prompt)![1]}`);
    const r = await runStep(4, step("secrets"), s, io);
    expect(r.ok).toBe(true);
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_APP_ID", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]) {
      expect(secretPrompts, name).toContain(`   Paste ${name} (hidden): `);
    }
    const file = readFileSync(s.loaded.secretsFile, "utf8");
    expect(file).toContain("GITHUB_APP_ID=value-of-GITHUB_APP_ID");
    expect(file).toContain("SLACK_BOT_TOKEN=value-of-SLACK_BOT_TOKEN");
    // Values go to the file only, never to the screen.
    expect(out.join("\n")).not.toContain("value-of-");
  });
});

describe("GitHub off: GITHUB_APP_ID and GITHUB_TOKEN are neither asked for nor a FAIL", () => {
  for (const githubAuth of ["app", "token"]) {
    it(`local_only, github_auth "${githubAuth}": setup's Secrets step and Checks, and doctor`, async () => {
      const s = await state(localOnly(githubAuth));
      expect(s.loaded.config.local_only).toBe(true);
      const { io, out, secretPrompts } = terminal([""], ["oauth-value"]);
      await runStep(4, step("secrets"), s, io);
      expect(secretPrompts).toEqual(["   Paste CLAUDE_CODE_OAUTH_TOKEN (hidden): "]);
      expect(out.join("\n")).not.toMatch(/GITHUB_APP_ID|GITHUB_TOKEN/);
      for (const checks of [await doctorChecks(s.loaded), await doctorChecks(s.loaded, { github: s.github })]) {
        expect(checks.filter((c) => /GITHUB_APP_ID|GITHUB_TOKEN/.test(c.msg))).toEqual([]);
      }
    });
  }

  it("GitHub answered no and the config diff declined: the file still selects GitHub, but no GitHub secret is asked or a FAIL", async () => {
    const s = await state({ ...REAL, store: { type: "sqlite" } });
    const before = readFileSync(s.loaded.configFile, "utf8");
    expect(neededSecrets(s.loaded).map((d) => d.name)).toContain("GITHUB_APP_ID");
    // Sync with GitHub? n. Slack? n. Write them? n.
    const plugins = terminal(["n", "n", "n"]);
    expect((await runStep(2, step("plugins"), s, plugins.io)).ok).toBe(true);
    expect(readFileSync(s.loaded.configFile, "utf8")).toBe(before);
    expect(s.github).toBe(false);

    const { io, secretPrompts } = terminal([""], ["oauth-value", "xapp-value", "xoxb-value"]);
    await runStep(4, step("secrets"), s, io);
    for (const name of GITHUB) expect(secretPrompts.join("\n"), name).not.toContain(name);
    expect(secretPrompts).toContain("   Paste CLAUDE_CODE_OAUTH_TOKEN (hidden): ");
    const checks = await doctorChecks(s.loaded, { github: s.github });
    expect(checks.filter((c) => /GITHUB_APP_ID|GITHUB_TOKEN/.test(c.msg))).toEqual([]);
  });
});

describe("--yes reads nothing from the terminal", () => {
  it("a missing secret is reported, not asked; the hidden prompt is never called", async () => {
    const s = await state(localOnly("app"));
    const { io, out } = defaults();
    const r = await runStep(4, step("secrets"), s, io);
    expect(r.ok).toBe(false);
    expect(out).toContain("   Paste CLAUDE_CODE_OAUTH_TOKEN now (hidden input)? no");
    expect(out.at(-1)).toBe("   ✗ missing, not asked under --yes: CLAUDE_CODE_OAUTH_TOKEN (run npm run setup in a terminal to paste them)");
  });

  it("the --yes terminal never touches stdin, and its hidden prompt refuses", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const on = vi.spyOn(process.stdin, "on");
    const io = terminalIo(true);
    expect(io.ask.interactive).toBe(false);
    expect(await io.ask.yesNo("Run it now?", true)).toBe(true);
    await expect(io.secret("Paste (hidden): ")).rejects.toThrow(/--yes never reads the terminal/);
    const s = await state(localOnly("app"));
    await runStep(4, step("secrets"), s, io);
    expect(on).not.toHaveBeenCalled();
  });
});

describe("progress record", () => {
  /** Steps that each ask one yes/no; `stopAt` fails and stops. */
  const fakeSteps = (ran: string[], stopAt: string | null): SetupStep<GuidedState>[] =>
    ["a", "b", "c", "d"].map((name) => ({
      name,
      title: `Step ${name}`,
      why: `why ${name}`,
      async run(_s, io) {
        await io.ask.yesNo(`   Do ${name}?`, true);
        ran.push(name);
        return name === stopAt ? { ok: false, stop: true, line: `${name} failed` } : { ok: true, line: `${name} done` };
      },
    }));

  it("a stop at step 3 keeps steps 1 and 2; the next run asks \"Continue from step 3?\" and runs from there", async () => {
    const s = await state(localOnly("app"));
    const ran: string[] = [];
    expect(await runSetup(fakeSteps(ran, "c"), s, defaults().io)).toBe(1);
    expect(ran).toEqual(["a", "b", "c"]);
    const file = progressFile(s.loaded.stateDir);
    expect(file).toBe(join(s.loaded.stateDir, "setup-progress.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ done: ["a", "b"], github: false });

    ran.length = 0;
    const { io, out } = terminal(["", "", ""]);
    expect(await runSetup(fakeSteps(ran, null), s, io)).toBe(0);
    expect(out).toContain("The last setup run stopped before step 3 (Step c).");
    expect(out).toContain("Continue from step 3? [yes] / start over: ");
    expect(ran).toEqual(["c", "d"]);
    expect(out).toContain("3. Step c");
    // A finished setup deletes the record.
    expect(existsSync(file)).toBe(false);
  });

  it("\"start over\" runs from step 1", async () => {
    const s = await state(localOnly("app"));
    const ran: string[] = [];
    await runSetup(fakeSteps(ran, "c"), s, defaults().io);
    ran.length = 0;
    const { io, out } = terminal(["start over", "", "", "", ""]);
    expect(await runSetup(fakeSteps(ran, null), s, io)).toBe(0);
    expect(ran).toEqual(["a", "b", "c", "d"]);
    expect(out).toContain("1. Step a");
    expect(existsSync(progressFile(s.loaded.stateDir))).toBe(false);
  });

  it("the record holds step names and the GitHub answer, never a secret value", async () => {
    const s = await state(localOnly("app"));
    const value = "planted-value-7f3a9c";
    const stop: SetupStep<GuidedState> = { name: "stop", title: "Stop", why: "w", async run(_s, io) {
      await io.ask.yesNo("   Stop?", true);
      return { ok: false, stop: true, line: "stopped" };
    } };
    const { io } = terminal(["", "", ""], [value]);
    expect(await runSetup([secretFileStep, step("secrets"), stop], s, io)).toBe(1);
    expect(readFileSync(s.loaded.secretsFile, "utf8")).toContain(value);
    const text = readFileSync(progressFile(s.loaded.stateDir), "utf8");
    expect(JSON.parse(text)).toEqual({ done: ["secret-file", "secrets"], github: false });
    expect(text).not.toContain(value);
  });
});

describe("check lines say what they check, and a FAIL how to fix it", () => {
  it("ANTHROPIC_API_KEY: unset is ✓ and says why that is good; set is a FAIL that says to unset it", () => {
    expect(markedLine(anthropicKeyCheck(undefined))).toBe("✓ ANTHROPIC_API_KEY not set (good: agents use CLAUDE_CODE_OAUTH_TOKEN)");
    const set = anthropicKeyCheck("sk-test-not-a-real-key");
    expect(markedLine(set)).toBe("✗ ANTHROPIC_API_KEY is set in this shell: run `unset ANTHROPIC_API_KEY` (agents must use CLAUDE_CODE_OAUTH_TOKEN)");
    expect(checkLine(set)).toMatch(/^FAIL {2}ANTHROPIC_API_KEY is set in this shell: run `unset ANTHROPIC_API_KEY`/);
    expect(set.msg).not.toContain("sk-test");
  });

  it("a FAIL whose text is reported as it came carries its fix on the line", () => {
    const c = { ok: false, msg: "claude CLI: not found", fix: "install Claude Code and put `claude` on PATH" };
    expect(checkLine(c)).toBe("FAIL  claude CLI: not found (fix: install Claude Code and put `claude` on PATH)");
    expect(markedLine(c)).toBe("✗ claude CLI: not found (fix: install Claude Code and put `claude` on PATH)");
    expect(markedLine({ ...c, ok: true, msg: "claude CLI: 2.1.0" })).toBe("✓ claude CLI: 2.1.0");
  });

  it("every doctor FAIL on a fresh solo setup says how to fix it", async () => {
    const s = await state(localOnly("app"), "CLAUDE_CODE_OAUTH_TOKEN=\n");
    const failed = (await doctorChecks(s.loaded)).filter((c) => !c.ok && !c.warn);
    expect(failed.length).toBeGreaterThan(0);
    for (const c of failed) expect(checkLine(c), c.msg).toMatch(/\((run|fix): |: run |\(move it out/);
  });
});
