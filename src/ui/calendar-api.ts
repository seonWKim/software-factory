// The Settings page's Calendar section (design 08-settings, 2026-11-13; docs/plugins/calendar-source.md). GET
// /api/v1/calendar lists each calendar plugin that has a connect hook (from the registry, so no provider is named here):
// whether the live `calendar` setting lists it, its last sync time and last error from the store, and the sign-in this
// process started for it, if any. POST /api/v1/calendar/connect and /api/v1/calendar/disconnect run the one connect flow
// the CLI runs (src/setup.ts connectCalendar, wired by compose.ts buildUiParts): the plugin's connect hook, its secrets
// through the setup writer, then the live setting and, on connect, one sync. The request guards (Host, Origin,
// Content-Type, CSRF token, body size, JSON) run in server.ts; then the owner check (the store's owner only);
// every refusal comes before the flow runs.
//
// POST /api/v1/calendar/sync {from, to} (design 02-tasks-calendar, 2026-11-22), the Calendar page's Sync, passes the
// same guards and owner check, then the range check (the read's rangeError), and stores a request to sync every
// source for those local days, which the controller's calendar unit runs on its next poll. While a request for the
// range waits, it is answered again and no row is written.
//
// GET also says, per plugin, whether this build carries the default sign-in a plain connect takes (`default_client`,
// from the hook's `hasDefault`), so the page offers no Connect that can only fail.
//
// Connect never asks the terminal. A plain connect (the plugin only) takes the hook's default sign-in: a hook that asks
// for a value then fails before any write, naming the "own client" option. A connect that ends before its consent
// page opens (a refusal, or a stop for input) keeps no attempt: its reply carries the outcome, said once. With `own_client: true` (that advanced
// option) the hook's hidden questions are answered from the request's `values`, keyed by the secret name the question
// names; when the hook asks for a value the request lacks, the run stops at the browser step, before any write, and
// the answer lists the names to ask for (`needs_input`). Otherwise the answer carries the consent
// URL to open, the sign-in goes on in the background on the hook's own 127.0.0.1 listener, and the page polls GET for
// its result. A sign-in's state is held in this process only, because its listener lives here; a restart drops it and
// the owner connects again. No secret value is returned, logged or stored: errors name steps, never values.
//
// With `write: true` the connect asks for write access (design 02-tasks-calendar, copy to a connected calendar): the
// hook's write question is answered yes, so a plugin that can copy the owner's local events asks for that scope.
// `ports` hands the local-event routes each listed calendar's sync port (src/calendar/calendar-write.ts), built once
// per process from the plugin and dropped on each connect or disconnect, so a reconnect's new grant is read afresh.
// Whether a calendar takes writes is stored state (calendar-write.ts, `calendar_write_access`): a connect from here
// stores what it asked for once it passes, a disconnect forgets it, and each copy write stores its port's answer. The
// reads (`copyTarget` for the calendar read, `write_access` on GET /api/v1/calendar) answer from it and never call
// the provider; nothing stored reads as read-only, which the Settings reconnect with write access sets.

import { type LocalEvents, type SyncOutcome, localEvents, rangeError, readSyncStates, requestCalendarSync } from "../calendar/index.js";
import type { Loaded } from "../load-config.js";
import type { connectCalendar } from "../setup.js";
import { errorText } from "../core/log.js";
import { type SettingsBase, resolveSettings } from "../core/settings.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type ConnectContext, connectHooks } from "../plugin-api.js";
import { type ApiResult, apiError } from "./api.js";
import type { PauseDeps } from "./pause-api.js";
import { ownerOf } from "./rules-api.js";
import { Withholder } from "./withhold.js";

export const CALENDAR_PATH = "/api/v1/calendar";
export const CALENDAR_CONNECT_PATH = "/api/v1/calendar/connect";
export const CALENDAR_DISCONNECT_PATH = "/api/v1/calendar/disconnect";
export const CALENDAR_SYNC_PATH = "/api/v1/calendar/sync";
/** The longest value a connect takes for one asked secret. */
const MAX_VALUE = 4096;
/** What a hidden question gets when the request lacks its value: the run stops before any write uses it. */
const NOT_GIVEN = "not-given";

/** How the flow asks and opens the consent page for the dashboard; it never prints. */
export interface CalendarIo {
  hidden(prompt: string): Promise<string>;
  openBrowser(url: string): Promise<void>;
  /** Called before the flow writes a secret: throws to stop the write. */
  beforeWrite(): void;
  /** The "use my own client" option: the hook asks for its client instead of using a default one. */
  ownClient: boolean;
  /** The "with write access" option: the hook's write question is answered yes. */
  write: boolean;
}

/** The connect flow as the UI composition gives it (compose.ts buildUiParts over src/setup.ts connectCalendar). */
export interface CalendarFlow {
  /**
   * Each calendar plugin with a connect hook, in registry order, with the secret names it declares and whether this
   * build carries the default sign-in its plain connect takes (absent, as on the ConnectHook: it does).
   */
  plugins: readonly { name: string; secrets: readonly string[]; hasDefault?(): Promise<boolean> }[];
  /** The effective `calendar` list: the live setting, else the config file's. */
  listed(): Promise<readonly string[]>;
  /** One connect or disconnect; a refusal throws before any write. */
  run(name: string, disconnect: boolean, io: CalendarIo): Promise<{ sync: SyncOutcome | null }>;
  /** The sync port of calendar plugin `name`, freshly built; null when it has none. A throw: it cannot be built. Absent: none has one. */
  port?(name: string): Promise<SyncPort | null>;
  /** The stored write access of each calendar (LocalEvents.writeAccess). Absent: none is stored, every calendar reads as read-only. */
  access?: LocalEvents["writeAccess"];
}

/** The local-event write's sync ports (src/calendar/calendar-write.ts), as the calendar component's index offers them. */
type SyncPorts = Parameters<LocalEvents["copy"]>[1]["ports"];
type SyncPort = NonNullable<Awaited<ReturnType<SyncPorts>>>["port"];

/** A sign-in this process started, and how it ended. */
interface Attempt {
  state: "signing_in" | "connected" | "failed";
  /** The first sync's event count; null until it ran, or when the plugin synced in the last 5 minutes already. */
  events: number | null;
  /** Why it failed, or why its first sync failed. Never a secret value. */
  error: string | null;
}

/** The section's routes over one flow, with the sign-ins this process started. */
export class UiCalendar {
  private readonly attempts = new Map<string, Attempt>();
  /** Each plugin's built sync port, so its access token is reused; dropped on a connect or disconnect. */
  private readonly built = new Map<string, Promise<SyncPort | null>>();
  constructor(readonly flow: CalendarFlow) {}

  /** The listed calendar named `name` (null: the first listed that has one) with its sync port, or null. */
  readonly ports: SyncPorts = async (name) => {
    for (const n of await this.flow.listed()) {
      if (name !== null && n !== name) continue;
      if (!this.built.has(n)) this.built.set(n, (this.flow.port?.(n) ?? Promise.resolve(null)).catch((err: unknown) => (this.built.delete(n), Promise.reject(err))));
      const port = await this.built.get(n)!;
      if (port !== null) return { name: n, port };
    }
    return null;
  };

  /** The calendar a new local event is copied to, and whether it takes writes (stored, never asked of the provider); null when none can. */
  async copyTarget(): Promise<{ label: string; writable: boolean } | null> {
    const target = await this.ports(null).catch(() => null);
    if (target === null) return null;
    return { label: target.port.label, writable: await this.writable(target.name) };
  }

  /** Whether listed calendar `name` takes writes, from stored state; null when it has no sync port (or is not listed). */
  async writeAccess(name: string): Promise<boolean | null> {
    const target = await this.ports(name).catch(() => null);
    return target === null ? null : this.writable(name);
  }

  private async writable(name: string): Promise<boolean> {
    return (await this.flow.access?.get(name)) ?? false;
  }

  attempt(name: string): Attempt | null {
    return this.attempts.get(name) ?? null;
  }

  /** Starts a connect; resolves once the consent URL is known, the run stopped for input, or it ended. */
  async connect(name: string, values: ReadonlyMap<string, string>, secrets: readonly string[], ownClient: boolean, write = false) {
    this.built.delete(name);
    const missing: string[] = [];
    let opened!: (url: string) => void;
    let consenting = false;
    const consent = new Promise<string>((resolve) => (opened = resolve));
    const run = this.flow.run(name, false, {
      async hidden(prompt) {
        const asked = askedName(prompt, secrets);
        if (!ownClient) throw new Error(`the sign-in asks for ${asked}, which only the "use my own client" option sends: nothing stored`);
        const given = values.get(asked);
        if (given !== undefined) return given;
        missing.push(asked);
        return NOT_GIVEN;
      },
      async openBrowser(url) {
        if (missing.length > 0) throw new NeedsInput(missing);
        consenting = true;
        opened(url);
      },
      beforeWrite() {
        if (missing.length > 0) throw new NeedsInput(missing);
      },
      ownClient,
      write,
    });
    const attempt: Attempt = { state: "signing_in", events: null, error: null };
    this.attempts.set(name, attempt);
    // The connect passed only if the grant holds the scope asked for: store whether it takes writes.
    const stored = run.then(async (out) => (await this.flow.access?.set(name, write), out));
    const settled = stored.then((out) => ({ out }), (err: unknown) => ({ err }));
    void settled.then((r) => this.finish(name, attempt, r, consenting));
    return Promise.race([consent.then((url) => ({ url })), settled]);
  }

  async disconnect(name: string): Promise<void> {
    const refuse = async () => {
      throw new Error("a disconnect asks nothing");
    };
    this.built.delete(name);
    await this.flow.run(name, true, { hidden: refuse, openBrowser: refuse, beforeWrite: () => undefined, ownClient: false, write: false });
    await this.flow.access?.set(name, null);
    this.attempts.delete(name);
  }

  /** `consenting`: the consent page opened. A run that failed before it answered its POST with the error: no attempt stays. */
  private finish(name: string, attempt: Attempt, r: { out: { sync: SyncOutcome | null } } | { err: unknown }, consenting: boolean): void {
    if (this.attempts.get(name) !== attempt) return;
    if ("err" in r) {
      if (!consenting) this.attempts.delete(name);
      else Object.assign(attempt, { state: "failed", error: errorText(r.err) });
      return;
    }
    const sync = r.out.sync;
    Object.assign(attempt, { state: "connected", events: sync?.ok ? sync.events : null, error: sync && !sync.ok ? sync.error : null });
  }
}

/**
 * The UI process's Calendar section (compose.ts buildUiParts): the calendar plugins with a connect hook, and the one
 * connect flow the CLI runs (`connect`: src/setup.ts connectCalendar, which the composition root passes in so this
 * route never imports setup.ts or the root; RFC 0023 §5 step 2), writing as the Settings writer.
 */
export function uiCalendar(
  loaded: Loaded,
  o: { store: FactoryStore; actor: string; clock: ConnectContext["clock"]; base: SettingsBase; connect: typeof connectCalendar },
): UiCalendar {
  return new UiCalendar({
    plugins: connectHooks(loaded.registry)
      .filter((h) => h.kind === "calendar")
      .map((h) => ({
        name: h.name,
        secrets: (loaded.registry.calendar.secrets[h.name] ?? []).map((d) => d.name),
        ...(h.hook.hasDefault ? { hasDefault: h.hook.hasDefault.bind(h.hook) } : {}),
      })),
    listed: async () => resolveSettings(o.base, await o.store.listSettingOverrides()).values.calendar,
    run: async (name, disconnect, io) =>
      o.connect({
        loaded, store: o.store, actor: o.actor, clock: o.clock, name, disconnect, beforeWrite: io.beforeWrite, ownClient: io.ownClient,
        io: { ask: { hidden: io.hidden, yesNo: async (q, dflt) => (WRITE_QUESTION.test(q) ? io.write : dflt) }, print: () => undefined, openBrowser: io.openBrowser },
      }),
    port: async (name) => {
      const [{ createPlugin }, { Plugins }] = await Promise.all([import("../plugins.js"), import("../plugin-set.js")]); // loaded when asked: the registry loads every plugin
      const selected = new Plugins({ ...loaded, plugins: { ...loaded.plugins, calendars: [name] } });
      const source = await createPlugin(loaded.registry, "calendar", name, { ...selected.base, secrets: await selected.secrets(), clock: o.clock });
      return source.sync ?? null;
    },
    access: localEvents(storeSql(o.store)).writeAccess,
  });
}

declare module "./settings-api.js" {
  interface UiSettings {
    /** The Calendar section's routes (calendar-api.ts). Absent: GET /api/v1/calendar is a 404 and its POSTs a 405. */
    calendar?: UiCalendar;
  }
}

/** How a connect hook's write question starts: the dashboard answers it from the request's `write`. */
const WRITE_QUESTION = /^\s*Allow writes\b/;

/** The hook asked for a value the request did not carry: nothing was written, the page asks for `names`. */
class NeedsInput extends Error {
  constructor(readonly names: readonly string[]) {
    super(`needs ${names.join(", ")}`);
  }
}

/** The declared secret a hidden question names (the longest that appears in it). */
function askedName(prompt: string, secrets: readonly string[]): string {
  const found = [...secrets].sort((a, b) => b.length - a.length).find((n) => prompt.includes(n));
  if (found === undefined) throw new Error("the connect asked for a value that is none of the plugin's declared secrets; connect from the terminal");
  return found;
}

/** GET /api/v1/calendar. Store reads only; every stored text leaves through the Withholder. */
export async function readCalendarStatus(d: PauseDeps): Promise<ApiResult> {
  const c = d.settings?.calendar;
  if (!c) return apiError(404, "Not found.");
  const w = new Withholder(d.scanner);
  const text = async (v: string | null) => (v === null ? null : (await w.plain(v)).text);
  const listed = await c.flow.listed();
  const states = new Map((await readSyncStates(storeSql(d.store))).map((s) => [s.source, s]));
  const plugins = [];
  for (const { name, hasDefault } of c.flow.plugins) {
    const s = states.get(name);
    const a = c.attempt(name);
    plugins.push({
      name,
      connected: listed.includes(name),
      default_client: hasDefault ? await hasDefault() : true,
      synced_at: s?.synced_at ?? null,
      error: await text(s?.error ?? null),
      attempt: a === null ? null : { state: a.state, events: a.events, error: await text(a.error) },
      ...(listed.includes(name) ? { write_access: await c.writeAccess(name) } : {}),
    });
  }
  return { status: 200, value: { plugins } };
}

/** POST /api/v1/calendar/connect and /disconnect, after server.ts's guards: the owner check, the body, then the flow. */
export async function writeCalendar(d: PauseDeps, path: string, body: unknown): Promise<ApiResult> {
  const c = d.settings?.calendar;
  if (!c) return apiError(404, "Not found.");
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const disconnect = path === CALENDAR_DISCONNECT_PATH;
  const who = d.pauses ? await ownerOf(d, d.pauses, disconnect ? "disconnects a calendar" : "connects a calendar") : { error: "The page has no owner check: calendar connect is off." };
  if ("error" in who) return apiError(403, await text(who.error));
  const b = parseBody(body, disconnect);
  if ("error" in b) return apiError(400, b.error);
  const plugin = c.flow.plugins.find((p) => p.name === b.plugin);
  if (!plugin) return apiError(400, `No calendar plugin "${b.plugin}" connects here; the plugins are ${c.flow.plugins.map((p) => p.name).join(", ") || "none"}.`);
  const unknown = [...b.values.keys()].find((k) => !plugin.secrets.includes(k));
  if (unknown !== undefined) return apiError(400, `"${unknown}" is not a secret ${plugin.name} declares.`);
  if (c.attempt(plugin.name)?.state === "signing_in") {
    return apiError(409, `A sign-in for ${plugin.name} is open already: finish it in the browser, or wait for it to end (5 minutes).`);
  }
  if (disconnect) {
    try {
      await c.disconnect(plugin.name);
    } catch (err) {
      return apiError(422, await text(errorText(err)));
    }
    return { status: 200, value: { plugin: plugin.name, connected: false } };
  }
  const first = await c.connect(plugin.name, b.values, plugin.secrets, b.ownClient, b.write);
  if ("url" in first) return { status: 202, value: { plugin: plugin.name, state: "signing_in", consent_url: first.url } };
  if ("err" in first) {
    if (first.err instanceof NeedsInput) return { status: 200, value: { plugin: plugin.name, state: "needs_input", needs: first.err.names } };
    return apiError(422, await text(errorText(first.err)));
  }
  const a = c.attempt(plugin.name);
  return { status: 200, value: { plugin: plugin.name, state: a?.state ?? "connected", events: a?.events ?? null } };
}

/** `{ plugin, own_client?, values?, write? }` (connect; values only with own_client) or `{ plugin }` (disconnect), or why not. */
function parseBody(body: unknown, disconnect: boolean): { plugin: string; ownClient: boolean; write: boolean; values: ReadonlyMap<string, string> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "plugin" && (disconnect || !["values", "own_client", "write"].includes(k)));
  if (extra !== undefined) return { error: `unknown field "${extra}"` };
  if (typeof b.plugin !== "string" || b.plugin === "") return { error: "plugin must be a non-empty string" };
  const ownClient = b.own_client ?? false;
  if (typeof ownClient !== "boolean") return { error: "own_client must be true or false" };
  const write = b.write ?? false;
  if (typeof write !== "boolean") return { error: "write must be true or false" };
  if (!ownClient && b.values !== undefined) return { error: "values are sent only with own_client: true" };
  const raw = b.values ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "values must be an object from secret name to value" };
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || v.trim() === "" || v.length > MAX_VALUE) return { error: `values.${k} must be a non-empty string of at most ${MAX_VALUE} characters` };
    values.set(k, v.trim());
  }
  return { plugin: b.plugin, ownClient, write, values };
}

/** POST /api/v1/calendar/sync, after server.ts's guards: 403 for a non-owner, 400 for a bad body or range, else 202 with the request. */
export async function writeCalendarSync(d: PauseDeps, body: unknown): Promise<ApiResult> {
  const who = d.pauses ? await ownerOf(d, d.pauses, "syncs the calendars") : { error: "The page has no owner check: calendar sync is off." };
  if ("error" in who) return apiError(403, (await new Withholder(d.scanner).plain(who.error)).text);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return apiError(400, "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "from" && k !== "to");
  if (extra !== undefined) return apiError(400, `unknown field "${extra}"`);
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const [from, to] = [text(b.from), text(b.to)];
  const error = rangeError(from, to);
  if (error !== null) return apiError(400, error);
  const { request, created } = await requestCalendarSync(storeSql(d.store), { from: from!, to: to!, by: who.user, nowMs: d.clock.now().getTime() });
  return { status: 202, value: { id: request.id, from: request.from, to: request.to, state: "pending", created } };
}
