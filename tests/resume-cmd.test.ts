import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { Loaded } from "../src/load-config.js";
import type { LogFields, Logger } from "../src/core/log.js";
import type { CliEnvironment } from "../src/core/local-cli.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { REGISTRY } from "../src/plugins.js";
import { RESUMABLE_PAUSES, RESUME_USAGE, parseResumeArgs, runResume } from "../src/resume-cmd.js";
import { newStore } from "./helpers/store.js";

class MemLog implements Logger {
  lines: { msg: string; fields?: LogFields | undefined }[] = [];
  info(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  warn(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
  error(msg: string, fields?: LogFields) {
    this.lines.push({ msg, fields });
  }
}

async function setup() {
  const { store, clock } = await newStore();
  const at = new Date(clock.now().getTime() + 60_000).toISOString() as Timestamp;
  for (const p of RESUMABLE_PAUSES) await store.pauseClaims(at, p);
  const log = new MemLog();
  const resume = async (...args: string[]) => {
    const a = parseResumeArgs(args);
    if ("error" in a) return { code: 1, lines: [a.error, RESUME_USAGE] };
    return runResume({ store, actor: "local:owner", log, refusal: async () => null }, a);
  };
  return { store, log, resume };
}

const active = async (store: FactoryStore) => {
  const out: string[] = [];
  for (const p of RESUMABLE_PAUSES) if ((await store.getClaimPause(p)) !== null) out.push(p);
  return out;
};

describe("factory resume", () => {
  it("with no name ends rate_limit only, and says what it ended", async () => {
    const { store, resume } = await setup();
    expect(await resume()).toEqual({ code: 0, lines: ["ended the rate_limit pause"] });
    expect(await active(store)).toEqual(["forge_auth", "preflight_access", "model_stall"]);
  });

  it("with a name ends that pause; again prints no pause in effect, exit 0", async () => {
    const { store, resume } = await setup();
    expect(await resume("forge_auth")).toEqual({ code: 0, lines: ["ended the forge_auth pause"] });
    expect(await active(store)).not.toContain("forge_auth");
    expect(await resume("forge_auth")).toEqual({ code: 0, lines: ["forge_auth: no pause in effect"] });
  });

  it("--all ends all four", async () => {
    const { store, resume } = await setup();
    const r = await resume("--all");
    expect(r.code).toBe(0);
    for (const p of RESUMABLE_PAUSES) expect(r.lines).toContain(`ended the ${p} pause`);
    expect(await active(store)).toEqual([]);
    expect(await store.getClaimPause("model_stall_since")).toBeNull();
  });

  it("an unknown name, or a part of model_stall, exits 1 and writes nothing", async () => {
    const { store, log, resume } = await setup();
    const before = (await store.listTableRows({ table: "worker_claim_pauses", limit: 200 }))!.rows;
    for (const bad of ["nope", "model_stall_since", "model_answered"]) {
      const r = await resume(bad);
      expect(r.code).toBe(1);
      expect(r.lines[0]).toContain("unknown pause");
    }
    expect((await resume("rate_limit", "forge_auth")).code).toBe(1);
    expect((await store.listTableRows({ table: "worker_claim_pauses", limit: 200 }))!.rows).toEqual(before);
    expect(log.lines).toEqual([]);
  });

  it("writes one log line per pause with the actor ID", async () => {
    const { log, resume } = await setup();
    await resume("preflight_access");
    expect(log.lines).toEqual([{ msg: "claim pause ended", fields: { pause: "preflight_access", actor: "local:owner", ended: true } }]);
    await resume("preflight_access");
    expect(log.lines[1]!.fields).toEqual({ pause: "preflight_access", actor: "local:owner", ended: false });
  });
});

describe("factory resume: the owner check and the CLI identity", () => {
  afterEach(() => vi.restoreAllMocks());

  const FIXED: CliEnvironment = { gitEmail: "Me@Example.com", osUser: "os-login" };

  /** Runs the real `resume` command with a fixed environment, over `store` (kept open after the command). */
  async function command(store: FactoryStore, env: CliEnvironment, ...args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "sf-resume-"));
    const loaded = {
      root: dir, stateDir: dir, file: {}, config: { repo: { owner: "o", name: "r" }, local_only: true }, registry: REGISTRY, plugins: { clock: "system" },
    } as unknown as Loaded;
    const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
    const out: string[] = [], logs: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
    vi.spyOn(console, "error").mockImplementation((l: string) => void out.push(l));
    vi.spyOn(process.stderr, "write").mockImplementation((l: string | Uint8Array) => (logs.push(JSON.parse(String(l)) as Record<string, unknown>), true));
    const resume = (await loadCommands()).get("resume")!;
    const code = await resume.run(args, { name: "resume", usage: "", load: async () => loaded, environment: async () => env, openStore: async () => kept });
    vi.restoreAllMocks();
    return { code, out, logs };
  }

  it("logs the CLI identity's user as the actor (git user.email before the OS user), never the OS login read directly", async () => {
    const { store } = await setup();
    const r = await command(store, FIXED, "forge_auth");
    expect(r).toMatchObject({ code: 0, out: ["ended the forge_auth pause"] });
    expect(r.logs).toEqual([expect.objectContaining({ msg: "claim pause ended", pause: "forge_auth", actor: "local:me@example.com" })]);
    expect(await active(store)).not.toContain("forge_auth");
  });

  it("an identity the owner check refuses gets the refusal, exit 1, and ends no pause", async () => {
    const { store } = await setup();
    await store.claimOwner("local:owner@example.com" as UserId);
    const before = (await store.listTableRows({ table: "worker_claim_pauses", limit: 200 }))!.rows;
    const r = await command(store, FIXED, "--all");
    expect(r).toMatchObject({ code: 1, out: ["not resumed: not_owner"], logs: [] });
    expect((await store.listTableRows({ table: "worker_claim_pauses", limit: 200 }))!.rows).toEqual(before);
    expect(await active(store)).toEqual([...RESUMABLE_PAUSES]);
  });
});
