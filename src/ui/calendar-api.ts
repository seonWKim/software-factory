// The Settings page's Calendar section (design 08-settings, 2026-11-13; docs/plugins/calendar-source.md). GET
// /api/v1/calendar lists each calendar plugin that has a connect hook (from the registry, so no provider is named here):
// whether the live `calendar` setting lists it, its last sync time and last error from the store, and the sign-in this
// process started for it, if any. POST /api/v1/calendar/connect and /api/v1/calendar/disconnect run the one connect flow
// the CLI runs (src/setup.ts connectCalendar, wired by compose.ts buildUiParts): the plugin's connect hook, its secrets
// through the setup writer, then the live setting and, on connect, one sync. The request guards (Host, Origin,
// Content-Type, CSRF token, body size, JSON) run in server.ts; then the owner check (the store's owner only);
// every refusal comes before the flow runs.
//
// Connect never asks the terminal. A plain connect (the plugin only) takes the hook's default sign-in: a hook that asks
// for a value then fails before any write, naming the "own client" option. With `own_client: true` (that advanced
// option) the hook's hidden questions are answered from the request's `values`, keyed by the secret name the question
// names; when the hook asks for a value the request lacks, the run stops at the browser step, before any write, and
// the answer lists the names to ask for (`needs_input`). Otherwise the answer carries the consent
// URL to open, the sign-in goes on in the background on the hook's own 127.0.0.1 listener, and the page polls GET for
// its result. A sign-in's state is held in this process only, because its listener lives here; a restart drops it and
// the owner connects again. No secret value is returned, logged or stored: errors name steps, never values.

import { type SyncOutcome, readSyncStates } from "../calendar/index.js";
import type { Loaded } from "../compose.js";
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
}

/** The connect flow as the UI composition gives it (compose.ts buildUiParts over src/setup.ts connectCalendar). */
export interface CalendarFlow {
  /** Each calendar plugin with a connect hook, in registry order, with the secret names it declares. */
  plugins: readonly { name: string; secrets: readonly string[] }[];
  /** The effective `calendar` list: the live setting, else the config file's. */
  listed(): Promise<readonly string[]>;
  /** One connect or disconnect; a refusal throws before any write. */
  run(name: string, disconnect: boolean, io: CalendarIo): Promise<{ sync: SyncOutcome | null }>;
}

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
  constructor(readonly flow: CalendarFlow) {}

  attempt(name: string): Attempt | null {
    return this.attempts.get(name) ?? null;
  }

  /** Starts a connect; resolves once the consent URL is known, the run stopped for input, or it ended. */
  async connect(name: string, values: ReadonlyMap<string, string>, secrets: readonly string[], ownClient: boolean) {
    const missing: string[] = [];
    let opened!: (url: string) => void;
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
        opened(url);
      },
      beforeWrite() {
        if (missing.length > 0) throw new NeedsInput(missing);
      },
      ownClient,
    });
    const attempt: Attempt = { state: "signing_in", events: null, error: null };
    this.attempts.set(name, attempt);
    const settled = run.then((out) => ({ out }), (err: unknown) => ({ err }));
    void settled.then((r) => this.finish(name, attempt, r));
    return Promise.race([consent.then((url) => ({ url })), settled]);
  }

  async disconnect(name: string): Promise<void> {
    const refuse = async () => {
      throw new Error("a disconnect asks nothing");
    };
    await this.flow.run(name, true, { hidden: refuse, openBrowser: refuse, beforeWrite: () => undefined, ownClient: false });
    this.attempts.delete(name);
  }

  private finish(name: string, attempt: Attempt, r: { out: { sync: SyncOutcome | null } } | { err: unknown }): void {
    if (this.attempts.get(name) !== attempt) return;
    if ("err" in r) {
      if (r.err instanceof NeedsInput) this.attempts.delete(name);
      else Object.assign(attempt, { state: "failed", error: errorText(r.err) });
      return;
    }
    const sync = r.out.sync;
    Object.assign(attempt, { state: "connected", events: sync?.ok ? sync.events : null, error: sync && !sync.ok ? sync.error : null });
  }
}

/**
 * The UI process's Calendar section (compose.ts buildUiParts): the calendar plugins with a connect hook, and the one
 * connect flow the CLI runs (src/setup.ts connectCalendar, loaded when a connect runs), writing as the Settings writer.
 */
export function uiCalendar(loaded: Loaded, o: { store: FactoryStore; actor: string; clock: ConnectContext["clock"]; base: SettingsBase }): UiCalendar {
  return new UiCalendar({
    plugins: connectHooks(loaded.registry)
      .filter((h) => h.kind === "calendar")
      .map((h) => ({ name: h.name, secrets: (loaded.registry.calendar.secrets[h.name] ?? []).map((d) => d.name) })),
    listed: async () => resolveSettings(o.base, await o.store.listSettingOverrides()).values.calendar,
    run: async (name, disconnect, io) =>
      (await import("../setup.js")).connectCalendar({
        loaded, store: o.store, actor: o.actor, clock: o.clock, name, disconnect, beforeWrite: io.beforeWrite, ownClient: io.ownClient,
        io: { ask: { hidden: io.hidden, yesNo: async (_q, dflt) => dflt }, print: () => undefined, openBrowser: io.openBrowser },
      }),
  });
}

declare module "./settings-api.js" {
  interface UiSettings {
    /** The Calendar section's routes (calendar-api.ts). Absent: GET /api/v1/calendar is a 404 and its POSTs a 405. */
    calendar?: UiCalendar;
  }
}

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
  for (const { name } of c.flow.plugins) {
    const s = states.get(name);
    const a = c.attempt(name);
    plugins.push({
      name,
      connected: listed.includes(name),
      synced_at: s?.synced_at ?? null,
      error: await text(s?.error ?? null),
      attempt: a === null ? null : { state: a.state, events: a.events, error: await text(a.error) },
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
  const first = await c.connect(plugin.name, b.values, plugin.secrets, b.ownClient);
  if ("url" in first) return { status: 202, value: { plugin: plugin.name, state: "signing_in", consent_url: first.url } };
  if ("err" in first) {
    if (first.err instanceof NeedsInput) return { status: 200, value: { plugin: plugin.name, state: "needs_input", needs: first.err.names } };
    return apiError(422, await text(errorText(first.err)));
  }
  const a = c.attempt(plugin.name);
  return { status: 200, value: { plugin: plugin.name, state: a?.state ?? "connected", events: a?.events ?? null } };
}

/** `{ plugin, own_client?, values? }` (connect; values only with own_client) or `{ plugin }` (disconnect), or why not. */
function parseBody(body: unknown, disconnect: boolean): { plugin: string; ownClient: boolean; values: ReadonlyMap<string, string> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "plugin" && (disconnect || (k !== "values" && k !== "own_client")));
  if (extra !== undefined) return { error: `unknown field "${extra}"` };
  if (typeof b.plugin !== "string" || b.plugin === "") return { error: "plugin must be a non-empty string" };
  const ownClient = b.own_client ?? false;
  if (typeof ownClient !== "boolean") return { error: "own_client must be true or false" };
  if (!ownClient && b.values !== undefined) return { error: "values are sent only with own_client: true" };
  const raw = b.values ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "values must be an object from secret name to value" };
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || v.trim() === "" || v.length > MAX_VALUE) return { error: `values.${k} must be a non-empty string of at most ${MAX_VALUE} characters` };
    values.set(k, v.trim());
  }
  return { plugin: b.plugin, ownClient, values };
}
