import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SYNC_MS, syncCalendars } from "../../src/calendar/index.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_HTTP_TIMEOUT_MS, GOOGLE_REFRESH_TOKEN, timedFetch } from "../../src/calendar/plugins/google-calendar/google-calendar.plugin.js";
import { GoogleCalendarSource } from "../../src/calendar/plugins/google-calendar/google-calendar-source.js";
import type { NewTask } from "../../src/core/tasks.js";
import type { UserId } from "../../src/core/types.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeSource, cleanScanner, config, silent } from "../helpers/fakes.js";
import { newStore } from "../helpers/store.js";
import { FakeCalendarSource, calendarEvent } from "./fakes.js";

// A calendar outage never blocks a task action (design 02-tasks, calendar): the sync runs apart from task handling,
// a source that fails or never answers costs only its own sync, and its error stays on its calendar_sync_state row.

const USER = "local:dev@example.com" as UserId;
const task = (id: string, over: Partial<NewTask> = {}): NewTask => ({
  id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: USER, ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that never answers, as a provider that accepts the connection and then hangs would; only an abort ends it. */
function hungFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: { signal?: AbortSignal }) => {
    calls.push(url);
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  });
  return calls;
}

const SECRET_VALUES: Record<string, string> = { [GOOGLE_REFRESH_TOKEN]: "r", [GOOGLE_CLIENT_ID]: "i", [GOOGLE_CLIENT_SECRET]: "s" };
const secrets = { get: async (name: string) => ({ reveal: () => SECRET_VALUES[name]! }) };

/** Every task action the store offers, in order; each must succeed. */
async function everyTaskAction(store: Awaited<ReturnType<typeof newStore>>["store"]): Promise<void> {
  expect((await store.addTask(task("tk_a", { due: { date: "2026-11-12" } }))).id).toBe("tk_a");
  expect(await store.addSubTask("tk_a", task("tk_sub"))).toMatchObject({ ok: true });
  expect(await store.updateTask("tk_a", { title: "renamed" })).toMatchObject({ ok: true, task: { title: "renamed" } });
  expect(await store.completeTask("tk_sub")).toMatchObject({ ok: true, completed: true });
  expect(await store.completeTask("tk_a")).toMatchObject({ ok: true, completed: true });
  expect((await store.addTask(task("tk_b"))).id).toBe("tk_b");
  expect(await store.deleteTask("tk_b")).toMatchObject({ ok: true });
  expect((await store.listTasks(100)).map((t) => t.id)).toEqual([]);
}

describe("calendar outage", () => {
  it("with every source failing, the controller's calendar step returns and every task action succeeds", async () => {
    const { store, clock } = await newStore();
    const down = new FakeCalendarSource([calendarEvent("a")]);
    down.failWith = "calendar provider unreachable";
    const role = new ControllerRole({
      store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, calendar: [{ name: "work", source: down }],
    });
    await (await role.unit("calendar")).calendarStep();
    expect(down.windows).toHaveLength(1);
    await everyTaskAction(store);
    expect(await store.db.all("SELECT source, error FROM calendar_sync_state")).toEqual([{ source: "work", error: "calendar provider unreachable" }]);
  });

  it("Google never answering: task actions run while its sync waits, and the sync gives up after the HTTP timeout", async () => {
    const { store, clock } = await newStore();
    const calls = hungFetch();
    const google = new GoogleCalendarSource({
      http: timedFetch(50), now: () => clock.now(), secrets, names: { refreshToken: GOOGLE_REFRESH_TOKEN, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }, calendarIds: [],
    });
    const ok = new FakeCalendarSource([calendarEvent("z")]);
    const sync = syncCalendars(store.db, [{ name: "google-calendar", source: google }, { name: "ok", source: ok }], clock.now().getTime());
    await everyTaskAction(store);
    expect(await sync).toEqual([
      { source: "google-calendar", ok: false, error: "google-calendar: token refresh failed (no answer)" },
      { source: "ok", ok: true, events: 1 },
    ]);
    expect(calls).toHaveLength(1);
    expect(await store.db.all("SELECT source, error FROM calendar_sync_state ORDER BY source")).toEqual([
      { source: "google-calendar", error: "google-calendar: token refresh failed (no answer)" },
      { source: "ok", error: null },
    ]);
  });

  it("the plugin's HTTP calls give up well inside one sync period", () => {
    expect(GOOGLE_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GOOGLE_HTTP_TIMEOUT_MS).toBeLessThan(CALENDAR_SYNC_MS);
  });
});
