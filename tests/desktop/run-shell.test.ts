// The shell's app data folder and its wiring, with a fake home folder: the paths, the config and its default
// checkout, SF_HOME for the child, every file the shell touches (its own folder and the checkout's supervisor status
// file, never a secrets file), and attaching to a supervisor that already runs for the checkout.
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ShellFs, appDataPaths, loadShellConfig, saveQuickAddShortcut } from "../../desktop/electron/common/app-data.js";
import { pidAlive, supervisorStatusFile } from "../../desktop/electron/common/attach.js";
import { runShell } from "../../desktop/electron/common/run-shell.js";
import { quickAddShortcut } from "../../desktop/electron/macos/shortcut.js";
import { FakeAppShell, fakeSpawn, flush } from "./fakes.js";

const fakeHome = (): string => mkdtempSync(join(tmpdir(), "sf-desktop-home-"));

/** node:fs, recording the path of every call. */
function recordingFs(): { fs: ShellFs; touched: string[] } {
  const touched: string[] = [];
  const fs: ShellFs = {
    readFileSync: (p, e) => (touched.push(p), nodeFs.readFileSync(p, e)),
    writeFileSync: (p, t) => (touched.push(p), nodeFs.writeFileSync(p, t)),
    appendFileSync: (p, t) => (touched.push(p), nodeFs.appendFileSync(p, t)),
    mkdirSync: (p, o) => (touched.push(p), nodeFs.mkdirSync(p, o)),
    openSync: (p, f) => (touched.push(p), nodeFs.openSync(p, f)),
    closeSync: (fd) => nodeFs.closeSync(fd),
  };
  return { fs, touched };
}

describe("app data folder", () => {
  it("resolves under ~/Library/Application Support/software-factory/", () => {
    const p = appDataPaths("/Users/someone");
    expect(p.dir).toBe("/Users/someone/Library/Application Support/software-factory");
    expect(p.config).toBe(`${p.dir}/config.json`);
    expect(p.state).toBe(`${p.dir}/state`);
    for (const path of [p.log, p.chromium, p.notices]) expect(path.startsWith(`${p.state}/`)).toBe(true);
  });

  it("writes the default config on first start: the checkout the app was built from, port 4310, keep running, Alt+Space", () => {
    const paths = appDataPaths(fakeHome());
    const c = loadShellConfig(paths, nodeFs, "/src/software-factory");
    expect(c).toEqual({ checkout: "/src/software-factory", ui_port: 4310, keep_running_when_closed: true, app: { quick_add_shortcut: "Alt+Space" } });
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual(c);
  });

  it("reads a chosen checkout and rejects a malformed config", () => {
    const paths = appDataPaths(fakeHome());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ checkout: "/work/other", ui_port: 4400 }));
    expect(loadShellConfig(paths, nodeFs, "/src/software-factory")).toEqual({
      checkout: "/work/other", ui_port: 4400, keep_running_when_closed: true, app: { quick_add_shortcut: "Alt+Space" },
    });
    writeFileSync(paths.config, JSON.stringify({ checkout: "relative", ui_port: 0, keep_running_when_closed: "yes", app: { quick_add_shortcut: 3 } }));
    expect(() => loadShellConfig(paths, nodeFs, "/x")).toThrow(/checkout must be an absolute folder; ui_port .*; keep_running_when_closed.*; app.quick_add_shortcut/);
  });

  it("reads a chosen quick-add shortcut, and saving one keeps every other key", () => {
    const paths = appDataPaths(fakeHome());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ checkout: "/work/other", app: { quick_add_shortcut: "Control+Alt+T" } }));
    expect(loadShellConfig(paths, nodeFs, "/x").app).toEqual({ quick_add_shortcut: "Control+Alt+T" });
    saveQuickAddShortcut(paths, nodeFs, "Command+Shift+K");
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual({ checkout: "/work/other", app: { quick_add_shortcut: "Command+Shift+K" } });
  });
});

describe("runShell", () => {
  /**
   * One shell over a fake home. The dashboard answers only once a supervisor runs: `dashboardUp` (someone else's
   * supervisor) or after the shell spawned its own. `alivePids` are the pids the fake `process.kill(pid, 0)` finds.
   */
  async function run({ checkout = "/src/software-factory", dashboardUp = false, alivePids = [] as number[], config = undefined as object | undefined, taken = [] as string[] } = {}) {
    const home = fakeHome();
    if (config !== undefined) {
      mkdirSync(appDataPaths(home).dir, { recursive: true });
      writeFileSync(appDataPaths(home).config, JSON.stringify(config));
    }
    // A secrets file where the factory keeps one: the shell must never open it.
    mkdirSync(join(home, ".config", "software-factory"), { recursive: true });
    writeFileSync(join(home, ".config", "software-factory", ".env"), "SECRET=x\n");
    const rec = recordingFs();
    const sp = fakeSpawn();
    const shells: FakeAppShell[] = [];
    const fetch = async () => {
      if (!dashboardUp && sp.calls.length === 0) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ factory: { state: "running" }, needs_you: 7 }) };
    };
    const r = await runShell({
      home,
      fs: rec.fs,
      spawn: sp.spawn,
      execPath: "/App/Electron",
      env: { PATH: "/usr/bin" },
      fetch,
      defaultCheckout: checkout,
      alive: (pid) => alivePids.includes(pid as number),
      makeShell: () => {
        shells.push(new FakeAppShell(true, new Set(taken)));
        return shells[0]!;
      },
    });
    return { ...r, ...rec, ...sp, shell: shells[0]! };
  }

  /** A checkout whose supervisor status file names `pid` under `key`. */
  function checkoutWithStatus(pid: number, key = "supervisor_pid"): string {
    const checkout = mkdtempSync(join(tmpdir(), "sf-desktop-checkout-"));
    mkdirSync(join(checkout, ".factory"));
    writeFileSync(supervisorStatusFile(checkout), JSON.stringify({ state: "running", [key]: pid }));
    return checkout;
  }

  it("starts the supervisor from the checkout with SF_HOME, opens the dashboard and shows the count", async () => {
    const { calls, shell, paths, attached } = await run();
    expect(attached).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(-2)).toEqual(["/src/software-factory/dist/main.js", "dev"]);
    expect(calls[0]!.options).toMatchObject({ cwd: "/src/software-factory", env: { SF_HOME: paths.dir } });
    expect(shell.windows).toEqual(["http://127.0.0.1:4310/app/"]);
    await flush();
    expect(shell.status.needsYou).toBe(7);
  });

  /** The quick-add shortcut on a started shell, as main.js registers it. */
  function startShortcut(r: Awaited<ReturnType<typeof run>>) {
    const told: string[] = [];
    let opened = 0;
    const shortcut = quickAddShortcut({
      shell: r.shell,
      accelerator: r.config.app.quick_add_shortcut,
      onPress: () => void opened++,
      notify: (m) => told.push(m),
      save: (a) => saveQuickAddShortcut(r.paths, r.fs, a),
    });
    return { shortcut, told, opened: () => opened };
  }

  it("a config with no app.quick_add_shortcut key uses Alt+Space and starts as usual", async () => {
    const r = await run({ config: { checkout: "/src/software-factory", ui_port: 4310 } });
    expect(r.config.app.quick_add_shortcut).toBe("Alt+Space");
    expect(r.calls).toHaveLength(1);
    expect(r.shell.windows).toEqual(["http://127.0.0.1:4310/app/"]);
    const s = startShortcut(r);
    expect(s.shortcut.current()).toBe("Alt+Space");
    expect(s.told).toEqual([]);
    r.shell.shortcuts.get("Alt+Space")!();
    expect(s.opened()).toBe(1);
  });

  it("a refused shortcut at start is told, and the shell runs on with none held", async () => {
    const r = await run({ taken: ["Alt+Space"] });
    const s = startShortcut(r);
    expect(s.shortcut.current()).toBeNull();
    expect(s.told).toEqual([expect.stringContaining("Alt+Space could not be registered")]);
    expect(r.calls).toHaveLength(1);
    expect(r.shell.windows).toEqual(["http://127.0.0.1:4310/app/"]);
  });

  it("writes only its app data folder, reads only the checkout's status file, never the secrets file", async () => {
    const { touched, paths, shell, calls } = await run();
    shell.quit();
    calls[0]!.child.exit(0);
    await flush();
    expect(shell.exited).toBe(true);
    expect(touched.length).toBeGreaterThan(0);
    const outside = touched.filter((p) => p !== paths.dir && !p.startsWith(`${paths.dir}/`));
    expect(outside).toEqual([supervisorStatusFile("/src/software-factory")]);
    expect(touched.some((p) => p.includes(".env"))).toBe(false);
  });

  it("attaches to a live supervisor named in the checkout's status file: no second supervisor, Quit leaves it running", async () => {
    const { calls, shell, attached, paths } = await run({ checkout: checkoutWithStatus(4242), alivePids: [4242], dashboardUp: true });
    expect(attached).toBe(true);
    expect(calls).toHaveLength(0);
    expect(shell.windows).toEqual(["http://127.0.0.1:4310/app/"]);
    await flush();
    expect(shell.status.needsYou).toBe(7);
    expect(readFileSync(paths.log, "utf8")).toContain("attached, not starting a supervisor: supervisor_pid 4242 is alive");
    shell.quit();
    await flush();
    expect(shell.exited).toBe(true);
  });

  it("attaches to the none updater's supervisor, whose status file names only child_pid", async () => {
    const { calls, attached } = await run({ checkout: checkoutWithStatus(5151, "child_pid"), alivePids: [5151] });
    expect(attached).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("attaches when only the dashboard answers (a supervisor with another state folder)", async () => {
    const { calls, attached } = await run({ dashboardUp: true });
    expect(attached).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("starts its own supervisor when the status file names a dead pid and the dashboard does not answer", async () => {
    const { calls, attached } = await run({ checkout: checkoutWithStatus(4242), alivePids: [] });
    expect(attached).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("pidAlive", () => {
  const throwing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  it("is alive when signal 0 succeeds or is refused (EPERM: another user's process), dead on ESRCH or no pid", () => {
    expect(pidAlive(10, () => true)).toBe(true);
    expect(pidAlive(10, throwing("EPERM"))).toBe(true);
    expect(pidAlive(10, throwing("ESRCH"))).toBe(false);
    expect(pidAlive(undefined, () => true)).toBe(false);
    expect(pidAlive(0, () => true)).toBe(false);
  });
});

describe("macOS main file", () => {
  it("has no top-level await: Electron holds 'ready' until the ESM entry has loaded, so one hangs the app", () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../desktop/electron/macos/main.js"), "utf8");
    // Top-level statements sit at indentation 0, or 2 inside the single-instance if/else.
    expect(main.split("\n").filter((line) => /^ {0,2}(?:const .*= )?await\b/.test(line))).toEqual([]);
  });
});
