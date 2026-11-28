import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/environments";
import { type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { recordTestSlotWait } from "../src/impl/store/sql/test-slots.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { PROJECT_KEY } from "./helpers/store.js";
import { LEASE, json, seeded } from "./ui-api-fixtures.js";

// Phase 3 of 3 of local-28caa30d: a run waiting for a host test slot (its `waiting:<run id>` row in
// worker_test_slots) says so in `task show` and on the item page's run row, read from the store only.

const WAIT = "waiting for a test slot";

/** The seeded store with the first running run waiting for a slot; the third running run is not waiting. */
async function waitingStore() {
  const f = await seeded();
  const waiting = f.claimed;
  const plain = (await f.d.store.listRuns(f.items.running3.id))[0]!;
  await recordTestSlotWait(f.d.store, f.clock.now(), { holder: waiting.id, lease_ms: LEASE });
  return { ...f, waiting, plain };
}

describe("the store's read of the runs waiting for a test slot", () => {
  it("lists the run with a live waiting row and no run that only holds a slot", async () => {
    const { d, waiting, plain } = await waitingStore();
    expect(await d.store.takeTestSlot({ holder: plain.id, cap: 2, lease_ms: LEASE })).toBe(true);
    const waits = await d.store.listTestSlotWaits();
    expect(waits).toContain(waiting.id);
    expect(waits).not.toContain(plain.id);
  });
});

describe("task show: a run's wait for a test slot", () => {
  const show = async (d: Awaited<ReturnType<typeof waitingStore>>["d"], id: WorkItemId) => {
    let n = 0;
    const deps: LocalCliDeps = { answers: { split: splitAnswers, detail: answersDetail }, store: d.store, identity: { user: "local:me@example.com" as UserId, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `k${++n}` };
    const r = await runLocalCli(deps, { action: "show", id });
    expect(r.code).toBe(0);
    return r.lines;
  };

  it("a waiting run's line ends with the wait", async () => {
    const { d, items, waiting } = await waitingStore();
    const line = (await show(d, items.running.id)).find((l) => l.includes(waiting.id))!;
    expect(line).toBe(`  ${waiting.id}  implement  running  attempt 1  ${WAIT}`);
  });

  it("a run that is not waiting prints no wait", async () => {
    const { d, items, plain } = await waitingStore();
    const lines = await show(d, items.running3.id);
    expect(lines.find((l) => l.includes(plain.id))).toBe(`  ${plain.id}  implement  running  attempt 1`);
    expect(lines.join("\n")).not.toContain(WAIT);
  });
});

describe("the run page: a run's wait for a test slot", () => {
  // The server modules resolve file URLs at import, which vitest's jsdom environment would rewrite to http ones, so
  // this file runs in node and puts jsdom in place for the page only; the page modules load after it (variable
  // specifiers: tsconfig.test.json has no DOM or JSX, the web config checks them).
  const page = { rtl: "@testing-library/react", shell: "./ui-shell-fixtures.js" };
  let rtl: any, // the page modules are typed under the web config
    mountItem: (path: string) => unknown, teardown: (g: typeof globalThis) => unknown;
  beforeAll(async () => {
    teardown = (await builtinEnvironments.jsdom.setup(globalThis, {})).teardown;
    rtl = await import(page.rtl);
    ({ mountItem } = await import(page.shell));
  });
  afterEach(() => {
    rtl.cleanup();
    vi.unstubAllGlobals();
  });
  afterAll(() => teardown(globalThis));

  /** Mounts the item page on the item detail the API returns for `id`, and gives that detail and the Runs table. */
  async function runsOf(d: Awaited<ReturnType<typeof waitingStore>>["d"], id: string) {
    const detail = await json<{ runs: { id: string; status: string; waiting_for_slot: boolean }[] }>(d, `/api/v1/items/${id}`);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const ok = url.split("?")[0] === `/api/v1/items/${id}`;
      return new Response(JSON.stringify(ok ? detail : { error: "Not found." }), { status: ok ? 200 : 404, headers: { "content-type": "application/json" } });
    }));
    vi.stubGlobal("scrollTo", () => undefined);
    mountItem(`/app/items/${id}`);
    const table = await rtl.screen.findByRole("table", { name: "Runs" });
    return { detail, table };
  }

  it("the item detail flags the waiting run, and its row's status badge says it waits", async () => {
    const { d, items, waiting } = await waitingStore();
    const { detail, table } = await runsOf(d, items.running.id);
    expect(detail.runs.find((r) => r.id === waiting.id)).toMatchObject({ status: "running", waiting_for_slot: true });
    const badge = rtl.within(table.querySelector(`[data-run="${waiting.id}"]`)).getByText(WAIT);
    expect(badge.closest("[data-status]")?.getAttribute("data-status")).toBe("running");
  });

  it("a run that is not waiting shows no wait", async () => {
    const { d, items, plain } = await waitingStore();
    const { detail, table } = await runsOf(d, items.running3.id);
    expect(detail.runs.find((r) => r.id === plain.id)).toMatchObject({ status: "running", waiting_for_slot: false });
    expect(table.querySelector(`[data-run="${plain.id}"]`)).toBeTruthy();
    expect(table.textContent).toContain("Running");
    expect(document.body.textContent).not.toContain(WAIT);
  });
});
