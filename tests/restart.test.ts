import { describe, expect, it } from "vitest";
import { NO_RESTART_COMMAND, RESTART_COMMAND, requestRestart, restartRefusal, restartReply, runHint } from "../src/core/restart.js";
import type { Run, UserId, WorkItem, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { type UiCommands, commandsPost, itemCommands, parseCommand } from "../src/ui/commands.js";
import type { UiDeps } from "../src/ui/deps.js";
import { HealthMonitor } from "../src/ui/health.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { cleanScanner } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The `restart` item command (design 04-gate-commands, restart): who may ask, on which item, what the page and the
// CLI store, and what the thread says about a finished run or a merge with no run command.

const ME = "local:me@example.com" as UserId;
const CMD = ["bin/restart"];
const MERGED: WorkItemPatch = { stage: "CLOSED", close_reason: "completed", merge_sha: "m1", blocked_on: "none", blocked_reason: null };
const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

async function itemIn(patch: WorkItemPatch) {
  const { store, clock } = await newStore();
  const actor = { kind: "system" as const, id: "system:test" };
  const { item } = await store.createWorkItem({ source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch });
  if (!r.ok) throw new Error("setup failed");
  return { store, clock, item: r.item };
}

const succeeded = (data: Record<string, unknown>): Pick<Run, "outcome" | "work_item_id"> =>
  ({ work_item_id: "wi_1" as WorkItemId, outcome: { status: "succeeded", summary: "restart done", data } });

describe("restartRefusal", () => {
  it("needs the command set and the item merged into the base", () => {
    const merged = { stage: "CLOSED", merge_sha: "m1" } as Pick<WorkItem, "stage" | "merge_sha">;
    expect(restartRefusal(merged, CMD)).toBeNull();
    expect(restartRefusal(merged, undefined)).toBe(NO_RESTART_COMMAND);
    expect(restartRefusal({ stage: "REVIEW", merge_sha: null }, CMD)).toMatch(/not merged into the base/);
    // Closed without a merge (rejected): not merged either.
    expect(restartRefusal({ stage: "CLOSED", merge_sha: null }, CMD)).toMatch(/not merged into the base/);
  });
});

describe("restartReply", () => {
  it("a command that exited 0: its command and its output tail, fenced", () => {
    const body = restartReply(succeeded({ result: "ok", command: ["bin/restart"], exit_code: 0, timed_out: false, output_tail: "listening on :8080" }));
    expect(body).toContain("Restarted the app: `bin/restart` exited 0 in the base checkout.");
    expect(body).toContain("listening on :8080");
    expect(body).not.toContain("unchanged");
  });

  it("a non-zero exit, a timeout and a command that could not start each say how, and that the item is unchanged", () => {
    const ends: [Record<string, unknown>, string][] = [
      [{ result: "failed", exit_code: 3, timed_out: false }, "exited 3"],
      [{ result: "failed", exit_code: null, timed_out: true }, "timed out"],
      [{ result: "not_started", start_error: "spawn bin/restart ENOENT" }, "could not start: spawn bin/restart ENOENT"],
    ];
    for (const [end, how] of ends) {
      const body = restartReply(succeeded({ command: ["bin/restart"], output_tail: null, ...end }));
      expect(body).toContain(`The restart failed: \`bin/restart\` ${how}. The item is unchanged.`);
      expect(body).toContain("factory restart wi_1");
    }
  });

  it("a withheld tail is said, never shown; a run that failed before the command names its error", () => {
    expect(restartReply(succeeded({ result: "failed", command: ["bin/restart"], exit_code: 1, output_tail: null, output_withheld: true }))).toContain("withheld");
    const failed = restartReply({ work_item_id: "wi_1" as WorkItemId, outcome: { status: "failed", error_code: "no_host_exec", detail: "no host", infra: true } });
    expect(failed).toContain("The restart did not run (`no_host_exec`: no host). The item is unchanged.");
    // The key removed after the request: nothing ran, and the reply says why.
    expect(restartReply(succeeded({ result: "not_set", command: null }))).toContain(`the restart command did not run: ${NO_RESTART_COMMAND}`);
  });
});

describe("runHint (the merge reply with no run command)", () => {
  it("names README.md and bin/ when they exist, each alone too, and always says no run command is set", () => {
    const both = runHint(["README.md", "bin"]);
    expect(both).toContain("see `README.md` and the scripts in `bin/` in the repository");
    expect(runHint(["bin"])).toContain("see the scripts in `bin/`");
    expect(runHint(["README.md"])).toContain("see `README.md` in");
    for (const hint of [both, runHint([])]) expect(hint).toContain("No run command is set");
    expect(runHint([])).not.toContain("README");
    expect(runHint([])).toContain("`repo.restart_command`");
  });
});

describe("factory restart <id> and the Restart app button store the same request", () => {
  const page = (store: UiDeps["store"], clock: FakeClock, commands: Partial<UiCommands> = {}): UiDeps => ({
    store, scanner: cleanScanner, clock, lease_ms: 1, health: new HealthMonitor(async () => [], clock),
    commands: { actor: ME, source: "environment", token: "tok", ...commands },
  });

  it("command `restart`, the item ID, no note: one app request each, as the CLI identity and the page's actor", async () => {
    const { store, clock, item } = await itemIn(MERGED);
    const cli = await requestRestart({ store, user: ME, command: CMD, newKey: () => "app:cli-1" }, item.id);
    expect(cli.code).toBe(0);
    expect(cli.lines[0]).toContain(`stored \`factory restart\` for ${item.id} as ${ME}`);
    const posted = await commandsPost(page(store, clock), item.id, {
      host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080", contentType: "application/json", csrfToken: "tok", body: JSON.stringify({ command: "restart" }),
    });
    expect(posted.status).toBe(202);
    const [b, a] = await store.listAppCommandRequestsForItem(item.id, 10);
    for (const r of [a!, b!]) expect(r).toMatchObject({ actor: ME, command: RESTART_COMMAND, args: { work_item_id: item.id }, handled_at: null });
  });

  it("the CLI refuses before any write: an unknown item, an item not merged, no command set", async () => {
    const { store, item } = await itemIn(MERGE_PENDING);
    const ask = (command: readonly string[] | undefined, id: string = item.id) => requestRestart({ store, user: ME, command, newKey: () => "app:k" }, id);
    expect(await ask(CMD, "wi_nope")).toEqual({ code: 1, lines: ["no work item wi_nope"] });
    expect((await ask(CMD)).lines[0]).toMatch(/^`factory restart` was not applied: the item is not merged into the base/);
    expect((await ask(undefined)).lines[0]).toContain(NO_RESTART_COMMAND);
    expect(await store.listAppCommandRequestsForItem(item.id, 10)).toEqual([]);
  });

  it("the page's restart takes no note", () => {
    expect(parseCommand({ command: "restart" })).toEqual({ command: "restart" });
    expect(parseCommand({ command: "restart", note: "now" })).toEqual({ error: "restart takes no note" });
    expect(parseCommand({ command: "merge", note: "now" })).toEqual({ error: "merge takes no note" });
  });
});

describe("the item API's `restart` row (the Restart app button)", () => {
  const text = async (v: string) => v;

  it("a merged item gets it when the server offers it, allowed or refused with the item commands' grant", async () => {
    const { item } = await itemIn(MERGED);
    const rows = await itemCommands(item, [], { allow: true, restart: true }, text);
    expect(rows.find((c) => c.name === "restart")).toMatchObject({ allowed: true, reason: null });
    const refused = await itemCommands(item, [], { allow: false, reason: "only the owner", restart: true }, text);
    expect(refused.find((c) => c.name === "restart")).toMatchObject({ allowed: false, reason: "only the owner" });
  });

  it("no row without the command, or on an item not merged", async () => {
    const merged = (await itemIn(MERGED)).item;
    const waiting = (await itemIn(MERGE_PENDING)).item;
    expect((await itemCommands(merged, [], { allow: true }, text)).map((c) => c.name)).not.toContain("restart");
    expect((await itemCommands(waiting, [], { allow: true, restart: true }, text)).map((c) => c.name)).not.toContain("restart");
  });
});
