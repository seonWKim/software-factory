// A missing model credential is one setup state (design §5 Restarts, RFC 0024 WP1): with an empty secret file no
// worker claims an agent run, queued items say they wait for a model credential, Needs you shows one row with the
// fix, and the queued run starts by itself once the credential is in the file, with no restart and no /retry.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelCredentialCheck, modelCredentialDialog } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { EnvFileSecretStore, RELOAD_MS } from "../src/impl/secrets/env-file-secret-store.js";
import { declaredSecretNames, type Selection } from "../src/plugin-api.js";
import { REGISTRY } from "../src/plugins.js";
import { RESUMABLE_PAUSES, parseResumeArgs } from "../src/resume-cmd.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import { MODEL_CREDENTIAL_PATH } from "../src/ui/model-credential-api.js";
import { resumePause } from "../src/ui/pause-api.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { Worker } from "../src/worker/index.js";
import { whyText } from "../web/src/lib/format.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { alice, config as baseConfig, issueRef, prompts, recordingLog, triageSpec } from "./helpers/fakes/config.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { newStore } from "./helpers/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A secret-like value built from parts, so no literal credential sits in the repository. */
const TOKEN = ["sk", "ant", "oat01", "x".repeat(24)].join("-");
const SELECTION = { runner: "claude-code" } as Selection;

async function factory() {
  const dir = mkdtempSync(join(tmpdir(), "sf-model-credential-"));
  dirs.push(dir);
  const file = join(dir, ".env");
  writeFileSync(file, "", { mode: 0o600 }); // an empty secret file, never the owner's
  const clock = new FakeClock();
  const secrets = new EnvFileSecretStore(file, declaredSecretNames(REGISTRY, SELECTION), [], () => clock.now().getTime());
  const check = modelCredentialCheck({ registry: REGISTRY, plugins: SELECTION }, secrets)!;
  const config: FactoryConfig = { ...baseConfig, dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 } };
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const runner = new FakeRunner({ triage: () => ({ output: triageSpec }) });
  const log = recordingLog();
  const scanner = new PatternEgressScanner(() => secrets.valuesForScan());
  const controller = new ControllerRole({ store, source, forge: new FakeForge(), auth: new FakeAuth(), clock, config, log, scanner, repeated_failure_rule: false });
  const worker = (id: string) =>
    new Worker({
      id: id as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner, toolEnv: {}, awake: new NoKeepAwake(),
      modelCredential: async () => (await check()) === null,
    });
  const [w1, w2] = [worker("w1"), worker("w2")];
  source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
  await controller.tickIntake();
  const item = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  /** One tick of each worker, then the controller applies what they stored. */
  const tick = async () => {
    await w1.tick();
    await w2.tick();
    await controller.tickRuns();
  };
  const d: ApiDeps = { store, scanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
  const get = async <T>(url: string) => JSON.parse((await respond(d, { method: "GET", url, host: "127.0.0.1:4310" })).body) as T;
  const overview = () => get<{ needs_you: number; system_actions: { code: string; text: string; command: string }[] }>("/api/v1/overview");
  const row = async () => (await get<{ items: { id: string; why: Parameters<typeof whyText>[0] }[] }>("/api/v1/items")).items.find((r) => r.id === item.id)!;
  return { dir, file, clock, store, runner, log, item, tick, d, overview, row, check };
}

describe("a missing model credential (design §5 Restarts, setup state)", () => {
  // Bug: every queued run is claimed and fails as `exception`, is retried, and one missing setting shows as a failed
  // item, a zero-token alarm and a model_stall pause in Needs you.
  it("an empty secret file: two ticks claim no agent run, fail nothing, and Needs you shows one row with the fix", async () => {
    const f = await factory();
    await f.tick();
    await f.tick();
    expect(f.runner.specs).toEqual([]);
    expect(await f.store.listRunsFinishedWithin(3_600_000)).toEqual([]);
    expect((await f.store.listRuns(f.item.id)).map((r) => [r.kind, r.status])).toEqual([["triage", "queued"]]);
    const o = await f.overview();
    expect(o.system_actions).toEqual([{ code: "model_credential", text: "Add a model credential", command: "Add model credential, or npm run setup", until: null }]);
    expect(o.needs_you).toBe(1);
    expect(whyText((await f.row()).why)).toBe("Waiting for a model credential");
    // One warning for the store-wide pause, from the tick that started it, not one per tick or per worker.
    expect(f.log.lines.filter((l) => l.msg.startsWith("model credential missing"))).toHaveLength(1);
  });

  // Bug: the secret file is read once per process, or the pause never ends, so the queued run waits for a restart
  // or a `/retry` after the owner ran `npm run setup`.
  it("once the credential is in the file, the next tick ends the pause and claims the queued run, with no /retry", async () => {
    const f = await factory();
    await f.tick();
    const [queued] = await f.store.listRuns(f.item.id);
    writeFileSync(f.file, `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    f.clock.advance(RELOAD_MS);
    await f.tick();
    expect(await f.store.getClaimPause("model_credential")).toBeNull();
    expect((await f.store.getRun(queued!.id))!.status).toBe("succeeded");
    expect(f.runner.specs.map((s) => s.role)).toEqual(["triage"]);
    expect((await f.overview()).system_actions).toEqual([]);
    expect(await f.store.listStateChanges(f.item.id)).not.toContainEqual(expect.objectContaining({ reason: "run_retry_scheduled" }));
  });

  // Bug: the dashboard says a credential is missing but cannot add one; the owner must open a terminal for `npm run setup`.
  it("the dashboard's Add model credential writes the secret file (made when absent), Needs you clears, and the next tick claims the run", async () => {
    const f = await factory();
    await f.tick();
    const [queued] = await f.store.listRuns(f.item.id);
    const owner = "local:owner@example.com" as UserId;
    await f.store.claimOwner(owner);
    rmSync(f.file); // no secret file: the dialog makes it, as `npm run setup` would
    const dialog = modelCredentialDialog({ registry: REGISTRY, plugins: SELECTION, secretsFile: f.file })!;
    expect(dialog.secrets).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    const csrfToken = newCsrfToken();
    const settings = { base: {} as never, repo: { owner: "o", name: "r" }, actor: owner, resolveProject: async () => null, csrfToken, modelCredential: dialog };
    const pauses = { principal: async () => owner, authorize: async () => ({ allow: true as const }), csrfToken, log: f.log };
    const d: ApiDeps = { ...f.d, settings, pauses };
    const r = await respond(d, {
      method: "POST", url: MODEL_CREDENTIAL_PATH, host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310", contentType: "application/json", csrfToken,
      body: JSON.stringify({ values: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }),
    });
    expect(JSON.parse(r.body)).toEqual({ saved: ["CLAUDE_CODE_OAUTH_TOKEN"], resumed: true });
    expect(r.body).not.toContain(TOKEN);
    expect(readFileSync(f.file, "utf8")).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect((await f.overview()).system_actions).toEqual([]);
    // The workers' secret store reads the file again within RELOAD_MS: no restart.
    f.clock.advance(RELOAD_MS);
    await f.tick();
    expect((await f.store.getRun(queued!.id))!.status).toBe("succeeded");
    expect(f.log.lines.map((l) => JSON.stringify(l))).not.toContainEqual(expect.stringContaining(TOKEN));
  });

  // Bug: Resume now (or `factory resume`) ends the pause while no credential exists, so the next claims fail.
  it("factory resume and the Needs-you Resume action refuse model_credential, and the pause stays", async () => {
    const f = await factory();
    await f.tick();
    expect(RESUMABLE_PAUSES).not.toContain("model_credential");
    expect(parseResumeArgs(["model_credential"])).toHaveProperty("error");
    expect(parseResumeArgs(["--all"])).toEqual({ pauses: expect.not.arrayContaining(["model_credential"]) });
    const pauses = { principal: async () => null, authorize: async () => ({ allow: true }), csrfToken: "t", log: f.log } as never;
    const r = await resumePause(f.d, pauses, { name: "model_credential" });
    expect(r.status).toBe(400);
    expect(await f.store.getClaimPause("model_credential")).not.toBeNull();
  });
});
