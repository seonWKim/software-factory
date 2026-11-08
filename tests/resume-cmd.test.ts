import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import type { Timestamp } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
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
    return runResume({ store, actor: "local:owner", log }, a);
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
