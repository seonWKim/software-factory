import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
import { type ProbeExec, type SandboxEnforcement, checkoutDenial, probeOsSandbox } from "../src/impl/runner/os-sandbox.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { loadConfig } from "../src/load-config.js";
import { type SettingsDeps, parseSettingsArgs, runSettings } from "../src/settings-cmd.js";
import { checkLine, doctorChecks } from "../src/setup.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiDeps } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, writeSettings } from "../src/ui/settings-api.js";
import { PROJECT } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// OS deny-read for owner secrets, auto needs the sandbox (design 05-sandbox.md, RFC 0024 WP2 step A). Every path here is
// a temp folder with planted fixture files; nothing reads the owner's real secret file or home.

const REPO = new URL("..", import.meta.url).pathname;
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sf-deny-${name}-`)));
const put = (path: string, text = "x") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

let fakeHome: string;
beforeEach(() => {
  fakeHome = tmp("home");
  vi.stubEnv("HOME", fakeHome);
  // The secret file is a path in the temp home: doctor stats a file that does not exist and stops there.
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(fakeHome, ".config", "software-factory", ".env"));
});
afterEach(() => vi.unstubAllEnvs());

describe("the read denial built from deny_paths", () => {
  it("adds ~/.gnupg; the earlier home entries stay as they were", async () => {
    const deny = (await loadConfig(REPO)).config.deny_paths;
    const home = deny.filter((p) => p.startsWith(`${fakeHome}/`)).map((p) => p.slice(fakeHome.length + 1));
    expect(home).toEqual([
      ".config/software-factory", // the secret file's folder: .env, the Google client JSON, github-app.pem
      ".ssh", ".aws", ".config/gh", ".claude", ".gitconfig", ".git-credentials", ".netrc", ".my.cnf", ".mylogin.cnf",
      ".gnupg",
    ]);
  });
});

/** A live checkout with a run folder in `.worktrees/`, run homes and the harness config dir in its state dir. */
function checkoutFixture() {
  const checkout = tmp("checkout");
  for (const f of ["src/a.ts", ".env", ".git/config", ".git/objects/ab/cdef", ".git/refs/heads/main", ".worktrees/sbx_me/README.md",
    ".worktrees/sbx_other/README.md", ".worktrees/.hooks/.keep", ".factory/db/factory.db", ".factory/agents/homes/run_me/tmp/x",
    ".factory/agents/homes/run_other/x", ".factory/agents/claude-config/x", ".factory/agents/llm/x"]) put(join(checkout, f));
  const at = (p: string) => join(checkout, p);
  return { checkout, at, run: at(".worktrees/sbx_me"), home: at(".factory/agents/homes/run_me"), config: at(".factory/agents/claude-config") };
}

describe("the live checkout's denial", () => {
  it("denies the checkout; carves out the run folder, its home, the harness config dir and .git/objects", async () => {
    const f = checkoutFixture();
    const d = await checkoutDenial(f.checkout, [f.run, f.home, f.config], [f.at(".factory/agents/homes")]);
    expect(d?.checkout).toBe(f.checkout);
    expect(d?.carve_outs).toEqual([f.run, f.home, f.config, f.at(".git/objects")]);
    // The native file tools get a Read deny for every other entry: other runs' folders, the store, the checkout's
    // source and .env, its git config and refs. Other runs' homes stay to the OS denial (one entry per past run).
    expect(d?.read_denies.sort()).toEqual(
      [".env", ".factory/agents/llm", ".factory/db", ".git/config", ".git/refs", ".worktrees/.hooks", ".worktrees/sbx_other", "src"].map(f.at).sort(),
    );
  });

  it("goes into the harness settings: denyRead, allowRead and Read deny rules; a carve-out over a denied path is dropped", async () => {
    const f = checkoutFixture();
    const d = await checkoutDenial(f.checkout, [f.run, f.home, f.config]);
    const store = f.at(".factory/db");
    const s = buildHarnessSettings({ deny_paths: [store], writable_paths: [] }, f.run, [], d && { ...d, carve_outs: [...d.carve_outs, store] }) as {
      permissions: { deny: string[] }; sandbox: { filesystem: { denyRead: string[]; allowRead?: string[] } };
    };
    expect(s.sandbox.filesystem.denyRead).toEqual([store, f.checkout]);
    expect(s.sandbox.filesystem.allowRead).toEqual([f.run, f.home, f.config, f.at(".git/objects")]);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${f.at("src")})`, `Read(/${f.at("src")}/**)`, `Read(/${f.at(".worktrees/sbx_other")}/**)`]));
    expect(s.permissions.deny.filter((r) => r.startsWith(`Read(/${f.run}`) || r === `Read(/${f.checkout}/**)`)).toEqual([]);
  });

  it("no checkout: the settings are as before, with no allowRead key", () => {
    const s = buildHarnessSettings({ deny_paths: ["/d"], writable_paths: [] }, "/run") as { sandbox: { filesystem: Record<string, unknown> } };
    expect(s.sandbox.filesystem).toEqual({ denyRead: ["/d"], allowWrite: [] });
  });
});

/**
 * The Seatbelt rules Claude Code's sandbox applies on macOS for these settings: reads denied under each denyRead
 * entry, then allowed again under each allowRead entry (allowRead takes precedence), and a directory's metadata
 * readable (its profile's `(allow file-read-metadata (vnode-type DIRECTORY))`), so git can resolve the alternates
 * path through the denied checkout. Writes are left as they are.
 */
function seatbelt(fs: { denyRead: string[]; allowRead?: string[] }): string {
  const q = (p: string) => JSON.stringify(p);
  const deny = fs.denyRead.map((p) => `(deny file-read* (subpath ${q(p)}))`);
  return ["(version 1)(allow default)", ...deny, "(allow file-read-metadata (vnode-type DIRECTORY))", ...(fs.allowRead ?? []).map((p) => `(allow file-read* (subpath ${q(p)}))`)].join("");
}

/**
 * Why the Seatbelt tests cannot run here, or null when they can: not macOS, no sandbox-exec, or this process already
 * runs inside a sandbox (a reviewer's or an agent's own Seatbelt), where a nested sandbox-exec cannot apply a profile.
 */
function seatbeltUnavailable(): string | null {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return "no Seatbelt (macOS sandbox-exec) on this host";
  // A profile with a rule: a nested sandbox-exec applies an allow-only profile as a no-op and refuses one that denies.
  const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(join(tmpdir(), "sf-no-such-folder"))}))`;
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"], { encoding: "utf8" });
  return r.status === 0 ? null : `already inside a sandbox: a nested sandbox-exec fails (${(r.stderr || r.error?.message || `exit ${r.status}`).trim()})`;
}
const NO_SEATBELT = seatbeltUnavailable();
const SEATBELT = NO_SEATBELT === null;
const skipNote = NO_SEATBELT === null ? "" : ` (skipped: ${NO_SEATBELT})`;

describe.skipIf(!SEATBELT)(`a child process of npm test in a run, under the OS sandbox (macOS)${skipNote}`, () => {
  it("cannot open a planted file under ~/.gnupg or the live checkout; its own folder and git still work", async () => {
    // The checkout: a real repo; the run folder: a clone borrowing its objects, as NoOpSandbox makes it.
    const checkout = tmp("live");
    put(join(checkout, "planted.txt"), "checkout-secret");
    git(checkout, "init", "--quiet", "-b", "main");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "base");
    const run = join(checkout, ".worktrees", "sbx_me");
    const hooks = join(checkout, ".worktrees", ".hooks");
    mkdirSync(hooks, { recursive: true });
    git(join(checkout, ".worktrees"), "init", "--quiet", "--template=", run);
    put(join(run, ".git", "objects", "info", "alternates"), `${join(checkout, ".git", "objects")}\n`);
    git(run, "config", "core.hooksPath", hooks);
    git(run, "fetch", "--quiet", checkout, "+refs/heads/*:refs/remotes/origin/*");
    git(run, "checkout", "--quiet", "-B", "work", "origin/main");
    const home = join(checkout, ".factory", "agents", "homes", "run_me");
    mkdirSync(join(home, "tmp"), { recursive: true });
    put(join(fakeHome, ".gnupg", "private-keys-v1.d", "planted.key"), "gnupg-secret");

    const denial = await checkoutDenial(checkout, [run, home]);
    const s = buildHarnessSettings({ deny_paths: [join(fakeHome, ".gnupg")], writable_paths: [] }, run, [], denial) as {
      sandbox: { filesystem: { denyRead: string[]; allowRead?: string[] } };
    };
    // `npm test` -> sh -> cat: the grandchild opens each file; the commit runs git over the borrowed objects.
    const script = [
      `cat ${JSON.stringify(join(fakeHome, ".gnupg", "private-keys-v1.d", "planted.key"))} && echo READ-GNUPG`,
      `cat ${JSON.stringify(join(checkout, "planted.txt"))} && echo READ-CHECKOUT`,
      `cat planted.txt && echo READ-OWN`,
      `echo note > note.txt && git add note.txt && git -c user.name=t -c user.email=t@example.com commit --quiet -m note && git log --oneline | wc -l | tr -d ' '`,
    ].join("; ");
    const child = `require("child_process").spawnSync("sh",["-c",${JSON.stringify(script)}],{stdio:"inherit",env:{...process.env,TMPDIR:${JSON.stringify(join(home, "tmp"))}}})`;
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", seatbelt(s.sandbox.filesystem), process.execPath, "-e", child], { cwd: run, env: GIT_ENV, encoding: "utf8" });
    expect(r.stdout).not.toContain("READ-GNUPG");
    expect(r.stdout).not.toContain("gnupg-secret");
    expect(r.stdout).not.toContain("READ-CHECKOUT");
    expect(r.stdout).toContain("READ-OWN"); // the run folder's own copy of the tracked file
    expect(r.stdout.trim().split("\n").pop()).toBe("2"); // base + note: git read the checkout's objects and ran no hook
    expect(r.stderr).toMatch(/Operation not permitted/);
  });

  it("the real probe reports all three lines OS-enforced on this host", async () => {
    const e = await probeOsSandbox({ runners: ["claude-code"] });
    expect(Object.values(e).map((l) => l.enforced)).toEqual([true, true, true]);
  });
});

/** A probe exec: the `claude sandbox status` answer, then the wrapped command run as given or with the wrapper cut off. */
function fakeExec(status: Record<string, unknown> | null, wrapper: "keep" | "drop" | "fail"): ProbeExec {
  return async (cmd) => {
    if (cmd.includes("status")) return status && { exit_code: 0, stdout: `${JSON.stringify(status)}\n` };
    if (wrapper === "fail") return { exit_code: 71, stdout: "" };
    const argv = wrapper === "drop" ? cmd.slice(cmd.indexOf(process.execPath)) : cmd;
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
    return { exit_code: r.status, stdout: r.stdout };
  };
}
const ON = { enabled: true, supported: true, unavailableReason: null, filesystemPolicy: "strict" };

describe("the OS sandbox probe (doctor and the mode check)", () => {
  it("a runner chain with a runner that has no OS sandbox: nothing is enforced, and the reason names it", async () => {
    const e = await probeOsSandbox({ runners: ["claude-code", "openai-compatible"], exec: fakeExec(ON, "keep") });
    expect(e.reads).toEqual({ enforced: false, why: "the openai-compatible runner has no OS sandbox" });
    expect(e.network.enforced).toBe(false);
  });

  it("Claude Code reporting its sandbox off or unsupported, or no answer: nothing is enforced", async () => {
    const off = await probeOsSandbox({ runners: ["claude-code"], exec: fakeExec({ ...ON, supported: false, unavailableReason: "bubblewrap not installed" }, "keep") });
    expect(off.writes).toEqual({ enforced: false, why: "Claude Code's sandbox is off on this host: bubblewrap not installed" });
    const none = await probeOsSandbox({ runners: ["claude-code"], exec: fakeExec(null, "keep") });
    expect(none.reads.why).toContain("gave no answer");
  });

  // A plain host only: inside another sandbox the outer profile may refuse the probe's own read, write or connect.
  it.skipIf(!SEATBELT)(`a wrapper that lets the denied read, write and connect through is not enforced${skipNote}`, async () => {
    const e = await probeOsSandbox({ runners: ["claude-code"], platform: "darwin", exec: fakeExec(ON, "drop") });
    expect(e).toEqual({
      reads: { enforced: false, why: "a probe read of a denied file went through" },
      writes: { enforced: false, why: "a probe write to a denied folder went through" },
      network: { enforced: false, why: "a probe connect went through" },
    });
  });

  it("a wrapper that cannot start the probe (a nested sandbox, no bwrap) is not enforced, not read as refusals", async () => {
    const e = await probeOsSandbox({ runners: ["claude-code"], platform: "linux", exec: fakeExec(ON, "fail") });
    expect(e.reads).toEqual({ enforced: false, why: "the OS sandbox (bwrap) could not run a probe command on this host" });
    const unknown = await probeOsSandbox({ runners: ["claude-code"], platform: "win32", exec: fakeExec(ON, "keep") });
    expect(unknown.network.why).toBe("no OS sandbox the factory knows on win32");
  });

  it.skipIf(!SEATBELT)(`a relaxed filesystem policy leaves reads and writes not enforced; the network line stands on its probe${skipNote}`, async () => {
    const e = await probeOsSandbox({ runners: ["claude-code"], exec: fakeExec({ ...ON, filesystemPolicy: "relaxed" }, "keep") });
    expect(e.reads).toEqual({ enforced: false, why: "Claude Code's filesystem policy is relaxed, not strict" });
    expect(e.writes.enforced).toBe(false);
    expect(e.network).toEqual({ enforced: true, why: "a probe connect was refused" });
  });
});

const READS_OFF: SandboxEnforcement = {
  reads: { enforced: false, why: "no bubblewrap" },
  writes: { enforced: true, why: "a probe write to a denied folder was refused" },
  network: { enforced: false, why: "no bubblewrap" },
};

describe("factory doctor's sandbox lines", () => {
  it("are exactly reads, writes and network, each OS-enforced or a warn that says auto mode is refused", async () => {
    const lines = (await doctorChecks(await loadConfig(REPO), { sandbox: async () => READS_OFF })).filter((c) => c.msg.startsWith("sandbox ")).map(checkLine);
    expect(lines).toEqual([
      "warn  sandbox reads: not OS-enforced, so auto mode is refused (no bubblewrap)",
      "ok    sandbox writes: OS-enforced (a probe write to a denied folder was refused)",
      "warn  sandbox network: not OS-enforced, so auto mode is refused (no bubblewrap)",
    ]);
  });
});

describe("mode auto needs the OS sandbox, through the settings path the CLI and the dashboard share", () => {
  const base = { file: {}, layers: { defaults: {}, projects: {} } };
  const deps = (store: SettingsDeps["store"], sandbox: SettingsDeps["sandbox"]): SettingsDeps => ({
    store, base, repo: { owner: "o", name: "r" }, resolveProject: async () => PROJECT, actor: "local:owner", ...(sandbox ? { sandbox } : {}),
  });
  const set = (d: SettingsDeps, value: string) => {
    const a = parseSettingsArgs(["set", "mode", value]);
    if ("error" in a) throw new Error(a.error);
    return runSettings(d, a);
  };
  const REFUSAL =
    'refused: auto mode needs the OS sandbox, and on this host reads, network are not OS-enforced (reads: no bubblewrap; network: no bubblewrap); mode stays "manual". See factory doctor';

  it("refuses auto with a reason naming each line that is not enforced, and stores nothing", async () => {
    const { store } = await newStore();
    expect(await set(deps(store, async () => READS_OFF), "auto")).toEqual({ ok: false, lines: [REFUSAL] });
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("the dashboard's settings write gets the same refusal", async () => {
    const { store, clock } = await newStore();
    const settings: UiSettings = { base, repo: { owner: "o", name: "r" }, actor: "local:owner", resolveProject: async () => PROJECT, csrfToken: newCsrfToken(), sandbox: async () => READS_OFF };
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
    expect(await writeSettings(d, settings, { action: "set", key: "mode", value: '"auto"' })).toEqual({ status: 422, value: { error: REFUSAL } });
    expect(await store.listSettingChanges(10)).toEqual([]);
  });

  it("sets auto when all three are enforced; manual is never asked about, whatever the sandbox", async () => {
    const { store } = await newStore();
    const all = { reads: READS_OFF.writes, writes: READS_OFF.writes, network: READS_OFF.writes };
    expect((await set(deps(store, async () => all), "auto")).ok).toBe(true);
    let asked = 0;
    const off = deps(store, async () => (asked++, READS_OFF));
    expect((await set(off, "manual")).ok).toBe(true);
    expect(asked).toBe(0);
  });
});
