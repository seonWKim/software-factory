// The supervisor child: started from the checkout, started again after it exits, drained on Quit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAIN_TIMEOUT_MS } from "../../desktop/electron/common/quit-drain.js";
import { RESTART_DELAY_MS, startSupervisor, supervisorCommand } from "../../desktop/electron/common/supervisor.js";
import { fakeSpawn } from "./fakes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const cmd = supervisorCommand({ execPath: "/App/Electron", checkout: "/repo", env: { PATH: "/usr/bin" }, sfHome: "/home/x/sf" });

function started() {
  const s = fakeSpawn();
  const sup = startSupervisor({ spawn: s.spawn, ...cmd });
  return { ...s, sup };
}

describe("supervisor child", () => {
  it("runs dist/main.js dev from the chosen checkout, with SF_HOME and the shell's runtime as Node", () => {
    expect(cmd.command).toBe("/App/Electron");
    expect(cmd.args.slice(-2)).toEqual(["/repo/dist/main.js", "dev"]);
    expect(cmd.options.cwd).toBe("/repo");
    expect(cmd.options.env).toMatchObject({ PATH: "/usr/bin", SF_HOME: "/home/x/sf", ELECTRON_RUN_AS_NODE: "1" });
    const { calls } = started();
    expect(calls.map((c) => c.args)).toEqual([cmd.args]);
  });

  it("is started again after it exits", async () => {
    const { calls } = started();
    calls[0]!.child.exit(1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(cmd.args);
    calls[1]!.child.emit("error", new Error("spawn ENOENT"));
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    expect(calls).toHaveLength(3);
  });

  it("Quit sends SIGTERM and waits for the supervisor to exit, and starts no new one", async () => {
    const { calls, sup } = started();
    let result: string | null = null;
    void sup.stop(DRAIN_TIMEOUT_MS).then((r) => (result = r));
    expect(calls[0]!.child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    calls[0]!.child.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe("drained");
    expect(calls[0]!.child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * 2);
    expect(calls).toHaveLength(1);
  });

  it("kills the supervisor when it has not exited after the drain timeout", async () => {
    const { calls, sup } = started();
    let result: string | null = null;
    void sup.stop(DRAIN_TIMEOUT_MS).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
    expect(calls[0]!.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toBeNull();
    calls[0]!.child.exit(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe("killed");
  });

  it("the drain timeout is 60 seconds", () => {
    expect(DRAIN_TIMEOUT_MS).toBe(60_000);
  });

  it("Quit while waiting to restart cancels the restart", async () => {
    const { calls, sup } = started();
    calls[0]!.child.exit(1);
    expect(await sup.stop(DRAIN_TIMEOUT_MS)).toBe("not-running");
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * 2);
    expect(calls).toHaveLength(1);
  });
});
