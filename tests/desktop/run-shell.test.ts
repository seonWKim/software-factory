// The shell's app data folder and its wiring, with a fake home folder: the paths, the config and its default
// checkout, SF_HOME for the child, and every file the shell touches inside its own folder (never a secrets file).
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ShellFs, appDataPaths, loadShellConfig } from "../../desktop/electron/common/app-data.js";
import { runShell } from "../../desktop/electron/common/run-shell.js";
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
    for (const path of [p.log, p.chromium]) expect(path.startsWith(`${p.state}/`)).toBe(true);
  });

  it("writes the default config on first start: the checkout the app was built from, port 4310, keep running", () => {
    const paths = appDataPaths(fakeHome());
    const c = loadShellConfig(paths, nodeFs, "/src/software-factory");
    expect(c).toEqual({ checkout: "/src/software-factory", ui_port: 4310, keep_running_when_closed: true });
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual(c);
  });

  it("reads a chosen checkout and rejects a malformed config", () => {
    const paths = appDataPaths(fakeHome());
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ checkout: "/work/other", ui_port: 4400 }));
    expect(loadShellConfig(paths, nodeFs, "/src/software-factory")).toEqual({ checkout: "/work/other", ui_port: 4400, keep_running_when_closed: true });
    writeFileSync(paths.config, JSON.stringify({ checkout: "relative", ui_port: 0, keep_running_when_closed: "yes" }));
    expect(() => loadShellConfig(paths, nodeFs, "/x")).toThrow(/checkout must be an absolute folder; ui_port .*; keep_running_when_closed/);
  });
});

describe("runShell", () => {
  function run() {
    const home = fakeHome();
    // A secrets file where the factory keeps one: the shell must never open it.
    mkdirSync(join(home, ".config", "software-factory"), { recursive: true });
    writeFileSync(join(home, ".config", "software-factory", ".env"), "SECRET=x\n");
    const rec = recordingFs();
    const sp = fakeSpawn();
    const shells: FakeAppShell[] = [];
    const fetch = async () => ({ ok: true, json: async () => ({ factory: { state: "running" }, needs_you: 7 }) });
    const r = runShell({
      home,
      fs: rec.fs,
      spawn: sp.spawn,
      execPath: "/App/Electron",
      env: { PATH: "/usr/bin" },
      fetch,
      defaultCheckout: "/src/software-factory",
      makeShell: () => {
        shells.push(new FakeAppShell());
        return shells[0]!;
      },
    });
    return { ...r, ...rec, ...sp, shell: shells[0]! };
  }

  it("starts the supervisor from the checkout with SF_HOME, opens the dashboard and shows the count", async () => {
    const { calls, shell, paths } = run();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(-2)).toEqual(["/src/software-factory/dist/main.js", "dev"]);
    expect(calls[0]!.options).toMatchObject({ cwd: "/src/software-factory", env: { SF_HOME: paths.dir } });
    expect(shell.windows).toEqual(["http://127.0.0.1:4310/app/"]);
    await flush();
    expect(shell.status.needsYou).toBe(7);
  });

  it("touches only its app data folder, never the secrets file", async () => {
    const { touched, paths, shell, calls } = run();
    shell.quit();
    calls[0]!.child.exit(0);
    await flush();
    expect(shell.exited).toBe(true);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((p) => p !== paths.dir && !p.startsWith(`${paths.dir}/`))).toEqual([]);
    expect(touched.some((p) => p.includes(".env"))).toBe(false);
  });
});
