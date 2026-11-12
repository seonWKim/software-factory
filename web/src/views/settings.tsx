import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { API, type Session, type SettingRow, type SettingsView, type SettingsWrite, postSettings, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import { ago, duration } from "../lib/format.js";
import { useNow } from "./common.js";
import { ProposalsSection, StandingSection } from "./standing.js";

// The Settings page (design §8 and §9, issue #236): every settable key with its value, source and when a change
// applies, an edit control per key and a reset when an override exists, the PR-only keys read-only, and the
// audit history, and the standing approvals (standing.tsx), whose pending proposals come first. Every key write is POST /api/v1/settings, which runs
// the same checks as `factory settings`; a refusal is shown next to the field it came from. A per-project gate key
// also shows the configured project's learned value (design 08-settings) next to its file and override values, with
// its evidence runs, its set time and a reset that runs the same check as `factory settings reset --learned`.
// The owner notices' two keys (design 09-notifications) are edited in their own Notices section: a switch per kind
// and a quiet-hours field.

const TIERS = ["cheap", "standard", "strong"] as const;
const PR_ONLY_TITLE = "Change only in factory.config.json (by a reviewed PR)";
const SOURCE_TONE: Record<string, string> = { override: "needs_approval", file: "", default: "" };

/** message_style (design 04-agents): what it does in one line, and an example. */
const STYLE_HINT = "Added after each agent's instructions; changes only how replies, specs and summaries read.";
const STYLE_EXAMPLE = "Example: Short sentences. Plain words, no jargon. Lead with the decision.";

/** A JSON string value as its text; anything else as it is. */
function stringOf(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "string" ? v : text;
  } catch {
    return text;
  }
}

/** A write and its outcome for one field: the refusal stays next to the field until the next try. */
function useWrite(token: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const write = async (body: SettingsWrite): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await postSettings(token, body);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      setDone(r.lines[0] ?? "saved");
      await client.invalidateQueries({ queryKey: [API.settings] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, write };
}

function Outcome({ error, done }: { error: string | null; done: string | null }) {
  if (error) return <p role="alert" className="mt-1 text-xs text-pretty break-words text-pill-bad-fg">{error}</p>;
  if (done) return <p role="status" className="mt-1 text-xs text-pretty break-words text-text-2">{done}</p>;
  return null;
}

/** The JSON object in `text`, or null when it holds anything else. */
function asObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `text` pretty-printed, two spaces per level; text that is not JSON as it is. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** An object's entries as `path → value`, nested objects flattened to dotted paths ("implement.1 → standard"). */
function entries(value: unknown, path = ""): [string, string][] {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([k, v]) => entries(v, path ? `${path}.${k}` : k));
  }
  return [[path, typeof value === "string" ? value : JSON.stringify(value)]];
}

/** Up to this many entries an object is listed in full; above it, a summary that opens to the list. */
const SHORT_OBJECT = 3;

/** An object's one-line summary: its top-level keys. */
const summaryOf = (obj: Record<string, unknown>) => `${Object.keys(obj).length} keys: ${Object.keys(obj).join(", ")}`;

/**
 * A setting value: a JSON object as one `key → value` line per entry (behind a summary of its keys when it has more
 * than SHORT_OBJECT entries, so a long value never makes its row tall), anything else as its text.
 */
function JsonValue({ text }: { text: string }) {
  const obj = asObject(text);
  if (obj === null || Object.keys(obj).length === 0) return <span className="font-mono text-xs break-words">{text}</span>;
  const list = (
    <dl data-entries className="grid grid-cols-[auto_minmax(10ch,1fr)] gap-x-2 font-mono text-xs">
      {entries(obj).map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-text-2">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
  if (entries(obj).length <= SHORT_OBJECT) return list;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-pretty break-words text-text-2">{summaryOf(obj)}</summary>
      <div className="mt-1">{list}</div>
    </details>
  );
}

/**
 * The edit control for one value: a number field, a switch, a text field per tier, or JSON. No min or max on
 * the field: the server's checks decide, and their message shows next to the field.
 */
function Editor({ row, label, value, token, project, floating = false }: { row: SettingRow; label: string; value: string; token: string; project?: string; floating?: boolean }) {
  const { busy, error, done, write } = useWrite(token);
  const [draft, setDraft] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Record<string, string> | null>(null);
  const target = project === undefined ? {} : { project };
  const save = async (text: string) => {
    if (await write({ action: "set", key: row.key, value: text, ...target })) {
      setDraft(null);
      setTiers(null);
    }
  };

  let control;
  if (row.key === "mode") {
    // The mode (design 03-risk): on is auto, off is manual. JSON text, as `factory settings set mode` takes it.
    control = (
      <span className="flex items-center gap-2 text-sm">
        <Switch aria-label={label} checked={value === '"auto"'} disabled={busy} onCheckedChange={(next) => void save(JSON.stringify(next ? "auto" : "manual"))} />
        {value === '"auto"' ? "auto" : "manual"}
      </span>
    );
  } else if (row.kind === "boolean") {
    control = <Switch aria-label={label} checked={value === "true"} disabled={busy} onCheckedChange={(next) => void save(String(next))} />;
  } else if (row.kind === "models") {
    const current = asObject(value) ?? {};
    const shown = tiers ?? Object.fromEntries(TIERS.map((t) => [t, typeof current[t] === "string" ? (current[t] as string) : ""]));
    control = (
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        {TIERS.map((t) => (
          <label key={t} className="flex items-center gap-1 text-xs text-text-2">
            {t}
            <Input aria-label={`${label} ${t}`} className="w-28 tabular-nums" value={shown[t]} onChange={(e) => setTiers({ ...shown, [t]: e.target.value })} />
          </label>
        ))}
        <Button type="submit" variant="secondary" disabled={busy || tiers === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
  } else if (row.kind === "text") {
    // Free text: shown and edited as plain text, sent as a JSON string, as `factory settings set` takes it.
    const shown = draft ?? stringOf(value);
    control = (
      <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        <p className="max-w-md text-xs text-pretty text-text-2">{STYLE_HINT}</p>
        <Textarea aria-label={label} rows={3} placeholder={STYLE_EXAMPLE} className="w-full min-w-48" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <p className="max-w-md text-xs text-pretty text-text-2">{STYLE_EXAMPLE}</p>
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
  } else if (row.kind === "json") {
    // Pretty-printed, one entry per line; a long value sits behind a summary of its keys so its row stays short.
    const shown = draft ?? pretty(value);
    const lines = shown.split("\n").length;
    const obj = asObject(value);
    const form = (
      <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), void save(shown))}>
        <Textarea aria-label={label} rows={Math.min(lines, 16)} spellCheck={false} wrap="off" className="w-full min-w-64 font-mono" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
    control =
      obj !== null && entries(obj).length > SHORT_OBJECT ? (
        <details>
          <summary className="cursor-pointer text-xs text-pretty break-words text-text-2">{summaryOf(obj)} · edit</summary>
          <div className="mt-2">{form}</div>
        </details>
      ) : (
        form
      );
  } else {
    const shown = draft ?? value;
    control = (
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save(shown))}>
        <Input
          aria-label={label}
          type="number"
          className="w-32 tabular-nums"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
  }
  // In the top bar the outcome floats below the control, so a refusal never pushes the bar's other items onto two lines.
  return (
    <div className={floating ? "relative" : undefined}>
      {control}
      {floating && (error || done) ? (
        <div className="absolute top-full left-0 z-10 mt-2 w-80 rounded-control border border-border bg-surface p-2 shadow-md">
          <Outcome error={error} done={done} />
        </div>
      ) : (
        <Outcome error={error} done={done} />
      )}
    </div>
  );
}

function ResetButton({ row, label, token, project, learned = false }: { row: SettingRow; label: string; token: string; project?: string; learned?: boolean }) {
  const { busy, error, done, write } = useWrite(token);
  // A learned reset is POST { ..., learned: true }: the server runs `factory settings reset --learned`.
  const body: SettingsWrite & { learned?: true } = { action: "reset", key: row.key, ...(project === undefined ? {} : { project }), ...(learned ? { learned: true as const } : {}) };
  return (
    <div>
      <Button variant="secondary" disabled={busy} aria-label={`Reset ${learned ? "learned " : ""}${label}`} onClick={() => void write(body)}>
        {learned ? "Reset learned" : "Reset"}
      </Button>
      <Outcome error={error} done={done} />
    </div>
  );
}

/** A millisecond key's value as a duration with its unit ("1h 30m"), under its field; nothing for other keys. */
function Duration({ settingKey, value }: { settingKey: string; value: string }) {
  if (!settingKey.endsWith("_ms") || !/^\d+$/.test(value.trim())) return null;
  return <p data-duration className="mt-1 text-xs tabular-nums text-text-2">{duration(Number(value))}</p>;
}

/** What a key controls, under its name; always shown, narrow screens included. */
function Description({ text }: { text: string }) {
  return <p className="mt-1 max-w-64 text-xs text-pretty text-text-2">{text}</p>;
}

/** A learned value as GET /api/v1/settings returns it; `source` is the layer in force for its project ("learned" while it is). */
interface LearnedValue {
  project: string;
  value: string;
  source: string;
  evidence_run_ids: string[];
  set_at: string;
}

/** The configured project's learned value of a key: in force or not, its evidence runs and when it was set, and its reset. */
function LearnedLayer({ row, learned, view }: { row: SettingRow; learned: LearnedValue; view: SettingsView }) {
  const now = useNow();
  const label = `${row.key} for ${view.repo}`;
  const runs = learned.evidence_run_ids;
  return (
    <div data-learned className="mt-2 flex flex-wrap items-start gap-2">
      <div className="min-w-0 text-xs text-text-2">
        <p className="text-pretty">
          learned: <span className="font-mono">{learned.value}</span>{" "}
          <Badge level={learned.source === "learned" ? "needs_approval" : undefined}>{learned.source === "learned" ? "in force" : `ignored: ${learned.source} is tighter`}</Badge>{" "}
          <span className="tabular-nums">set {ago(learned.set_at, now)} ago</span>
        </p>
        {runs.length > 0 && (
          <details>
            <summary className="cursor-pointer">from {runs.length} failed {runs.length === 1 ? "run" : "runs"}</summary>
            <ul className="mt-1 font-mono break-all">
              {runs.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <ResetButton row={row} label={label} token={view.csrf_token} project={view.repo} learned />
    </div>
  );
}

/** The kinds of wait on the owner that `notice_kinds` lists, in its order, each with its switch's label. */
const NOTICE_KINDS = [
  ["spec", "A spec waits for approval"],
  ["merge", "A change waits for its merge"],
  ["failure", "An item failed"],
  ["other", "Anything else that needs you"],
] as const;
/** The keys the Notices section edits; their table rows point there instead of a generic editor that does not fit. */
const NOTICE_KEYS = new Set(["notice_kinds", "quiet_hours"]);

/** The strings in a JSON list; none for anything else. */
function listOf(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** A switch per kind; each change writes the whole `notice_kinds` list, kinds in their fixed order. */
function NoticeKinds({ row, token }: { row: SettingRow; token: string }) {
  const { busy, error, done, write } = useWrite(token);
  const on = listOf(row.value);
  const set = (kind: string, next: boolean) => {
    const kinds = NOTICE_KINDS.map(([k]) => k).filter((k) => (k === kind ? next : on.includes(k)));
    void write({ action: "set", key: row.key, value: JSON.stringify(kinds) });
  };
  return (
    <div className="flex max-w-md flex-col gap-2 text-sm">
      <span className="font-medium">Notice when</span>
      {NOTICE_KINDS.map(([kind, label]) => (
        <label key={kind} className="flex items-center gap-2">
          <Switch aria-label={`Notice: ${kind}`} checked={on.includes(kind)} disabled={busy} onCheckedChange={(next) => set(kind, next)} />
          <span className="text-pretty">{label}</span>
        </label>
      ))}
      <Outcome error={error} done={done} />
    </div>
  );
}

/** The quiet-hours window as plain text (`HH:MM-HH:MM`, empty for off), sent as a JSON string; the server checks it. */
function QuietHours({ row, token }: { row: SettingRow; token: string }) {
  const { busy, error, done, write } = useWrite(token);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? stringOf(row.value);
  const save = async () => {
    if (await write({ action: "set", key: row.key, value: JSON.stringify(shown.trim()) })) setDraft(null);
  };
  return (
    <div className="flex max-w-md flex-col gap-1 text-sm">
      <span className="font-medium">Quiet hours</span>
      <p className="text-xs text-pretty text-text-2">
        Local time, e.g. 22:00-07:00; empty is off. Notices inside it wait, then come as one summary.
      </p>
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Input aria-label="Quiet hours" placeholder="22:00-07:00" className="w-32 tabular-nums" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label="Save Quiet hours">
          Save
        </Button>
      </form>
      <Outcome error={error} done={done} />
    </div>
  );
}

/** Owner notices (design 09-notifications): which waits raise one, and the quiet hours that hold them. */
function NoticesSection({ view }: { view: SettingsView }) {
  const kinds = view.keys.find((k) => k.key === "notice_kinds");
  const quiet = view.keys.find((k) => k.key === "quiet_hours");
  if (!kinds && !quiet) return null;
  return (
    <Section title="Notices">
      <p className="mb-2 text-sm text-pretty text-text-2">
        The macOS app shows a notice when an item starts waiting on you. Changes apply on the next notifications pass.
      </p>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        {kinds && <NoticeKinds row={kinds} token={view.csrf_token} />}
        {quiet && <QuietHours row={quiet} token={view.csrf_token} />}
      </div>
    </Section>
  );
}

function KeyRow({ row, view }: { row: SettingRow; view: SettingsView }) {
  const own = view.project === null ? undefined : row.projects.find((p) => p.project === view.project);
  const learned = view.project === null ? undefined : ((row as SettingRow & { learned?: LearnedValue[] }).learned ?? []).find((l) => l.project === view.project);
  return (
    <Tr data-key={row.key}>
      <Td>
        <span className="font-mono text-xs whitespace-nowrap">{row.key}</span>
        <Description text={row.description} />
      </Td>
      <Td className="min-w-56">
        {NOTICE_KEYS.has(row.key) ? (
          <p className="text-xs text-pretty text-text-2">
            <span className="font-mono break-words">{row.value}</span> · edit under Notices
          </p>
        ) : (
          <Editor row={row} label={row.key} value={row.value} token={view.csrf_token} />
        )}
        <Duration settingKey={row.key} value={row.value} />
        {row.key === "workers" && row.max !== undefined && (
          <p className="mt-1 text-xs text-text-2">
            1 to {row.max} (max_workers){row.capped_at ? `; the stored value runs as ${row.capped_at}` : ""}
          </p>
        )}
        {row.project_settable && (
          <div className="mt-2 border-t border-border pt-2">
            <p className="mb-1 text-xs text-text-2">
              for {view.project ?? view.repo}: {own ? `${own.value} (${own.source})` : "the global value"}
              {view.project === null && " · no project label stored yet; use factory settings --project on the command line"}
            </p>
            <div className="flex items-start gap-2">
              <Editor row={row} label={`${row.key} for ${view.repo}`} value={own?.value ?? row.value} token={view.csrf_token} project={view.repo} />
              {own?.source === "override" && <ResetButton row={row} label={`${row.key} for ${view.repo}`} token={view.csrf_token} project={view.repo} />}
            </div>
            <Duration settingKey={row.key} value={own?.value ?? row.value} />
            {learned && <LearnedLayer row={row} learned={learned} view={view} />}
          </div>
        )}
      </Td>
      <Td>
        <Badge level={SOURCE_TONE[row.source] || undefined}>{row.source}</Badge>
      </Td>
      <Td className="min-w-40">
        {row.file_value !== null ? (
          <JsonValue text={row.file_value} />
        ) : asObject(row.default_value) === null ? (
          <span className="font-mono text-xs break-words text-text-3">not set (default {row.default_value})</span>
        ) : (
          <>
            <span className="text-xs text-text-3">not set; default:</span>
            <JsonValue text={row.default_value} />
          </>
        )}
      </Td>
      <Td className="min-w-32 text-text-2">{row.applies_at}</Td>
      <Td>{row.source === "override" && <ResetButton row={row} label={row.key} token={view.csrf_token} />}</Td>
    </Tr>
  );
}

/**
 * Who the page's item commands act as, and what to set when they are off (design 09): the item page's "Commands
 * are off" notice links here (#page-commands). `ui.user_id` is a config-file key, not a settable one (#445).
 */
function PageCommands() {
  const session = useApi<Session>(API.session, false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash === "#page-commands") ref.current?.scrollIntoView();
  }, []);
  const s = session.data;
  return (
    <div id="page-commands" ref={ref} className="mt-6 first:mt-0">
      <Section title="Commands from the page">
        <p className="text-sm text-pretty text-text-2">
          {s?.actor ? (
            <>
              Item commands act as <code>{s.actor}</code> (from {s.actor_source === "config" ? "config" : "environment"}).{" "}
            </>
          ) : (
            <>Item commands are off: this server is not on loopback, so it needs a user to act as. </>
          )}
          To act as another user, set <code>ui.user_id</code> in <code>factory.config.json</code> to a factory user ID (e.g.{" "}
          <code>{'"ui": { "user_id": "github:12345" }'}</code>) and restart <code>factory ui</code>. Without it, a server on
          127.0.0.1 acts as the CLI identity: <code>cli_user</code>, else git <code>user.email</code>, else the OS user.
        </p>
      </Section>
    </div>
  );
}

/** The configured project's mode (design 03-risk): its own value when it has one, else the global one. */
function currentMode(v: SettingsView): { row: SettingRow; value: string; project?: string } | null {
  const row = v.keys.find((k) => k.key === "mode");
  if (!row) return null;
  const own = v.project === null ? undefined : row.projects.find((p) => p.project === v.project);
  return own ? { row, value: own.value, project: v.repo } : { row, value: row.value };
}

/**
 * The mode switch of the top bar and the Settings page (design 09): manual or auto for the configured project, written
 * through POST /api/v1/settings like any key, so it needs approve_merge and writes one audit row; a refusal shows beside it.
 */
export function ModeSwitch({ floating = false }: { floating?: boolean }) {
  const settings = useApi<SettingsView>(API.settings);
  const v = settings.data;
  const mode = v ? currentMode(v) : null;
  if (!v || !mode) return <span className="text-sm text-text-2">Mode …</span>;
  return (
    <div data-testid="mode" className="flex items-center gap-2 text-sm whitespace-nowrap">
      <span>Mode</span>
      <ModeControl view={v} floating={floating} />
    </div>
  );
}

/** The mode's own control, without the top bar's "Mode" label. */
function ModeControl({ view, floating = false }: { view: SettingsView; floating?: boolean }) {
  const mode = currentMode(view);
  if (!mode) return null;
  return <Editor row={mode.row} label="Auto mode" value={mode.value} token={view.csrf_token} floating={floating} {...(mode.project === undefined ? {} : { project: mode.project })} />;
}

/** The mode and, next to it, the auto-merge tier (design 09): what decides whether the factory merges on its own. */
function ModeSection({ view }: { view: SettingsView }) {
  const tier = view.keys.find((k) => k.key === "auto_merge_max_tier");
  return (
    <Section title="Mode">
      <p className="mb-2 text-sm text-pretty text-text-2">
        Auto approves specs below tier 4 with no owner-only decision and merges reviewed local changes up to the auto-merge
        tier; tier 4 and the gate list always wait for a person. A red main, a failure alarm or a budget checkpoint sets it
        back to manual. Changing either needs approve_merge.
      </p>
      {/* Each label sits above its control, so a refusal under one never squeezes the other's label. */}
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div className="flex max-w-md flex-col gap-1 text-sm">
          <span className="font-medium">Mode</span>
          <ModeControl view={view} />
        </div>
        {tier && (
          <div className="flex max-w-md flex-col gap-1 text-sm">
            <span className="font-medium whitespace-nowrap">Auto-merge tier (0 to 3)</span>
            <Editor row={tier} label="Auto-merge tier" value={tier.value} token={view.csrf_token} />
          </div>
        )}
      </div>
    </Section>
  );
}

export function SettingsPage() {
  const now = useNow();
  const settings = useApi<SettingsView>(API.settings);
  if (settings.isError) return <ErrorNote error={settings.error} />;
  if (!settings.data) return <Loading rows={8} />;
  const v = settings.data;
  return (
    <>
      <ProposalsSection />
      <ModeSection view={v} />
      <NoticesSection view={v} />
      <PageCommands />
      <Section title="Settable keys" count={v.keys.length}>
        <p className="mb-2 text-sm text-pretty text-text-2">
          A change is stored as an override and applies with no restart; the same checks as <code>factory settings</code> run first.
        </p>
        <Table label="Settable keys" head={["Key", "Value", "Source", "File value", "Applies at", ""]}>
          {v.keys.map((row) => (
            <KeyRow key={row.key} row={row} view={v} />
          ))}
        </Table>
      </Section>
      {v.ignored.length > 0 && (
        <Section title="Ignored overrides" count={v.ignored.length}>
          <ul className="space-y-1 text-sm">
            {v.ignored.map((i, n) => (
              <li key={n} className="text-pretty break-words">
                <code>{i.key}</code>
                {i.project ? ` for ${i.project}` : ""} = <code>{i.value}</code>: {i.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <StandingSection />
      <Section title={PR_ONLY_TITLE} count={v.pr_only.length}>
        <p className="mb-2 text-sm text-pretty text-text-2">
          These keys set the guards, secrets, permissions, plugins and what agents may read, so a person must review every
          change: this page and <code>factory settings set</code> refuse them. To change one, edit it in{" "}
          <code>factory.config.json</code> in a pull request and merge it after review.
        </p>
        <Table label={PR_ONLY_TITLE} head={["Key"]}>
          {v.pr_only.map((p) => (
            <Tr key={p.key} data-key={p.key}>
              <Td>
                <span className="font-mono text-xs">{p.key}</span>
                <Description text={p.description} />
              </Td>
            </Tr>
          ))}
        </Table>
      </Section>
      <Section title="History" count={v.history.length}>
        {v.history.length === 0 ? (
          <Empty>No settings changes yet.</Empty>
        ) : (
          <Table label="History" head={["When", "Who", "Key", "Change"]}>
            {v.history.map((c) => (
              <Tr key={c.seq}>
                <Td className="tabular-nums whitespace-nowrap">{ago(c.at, now)} ago</Td>
                <Td className="font-mono text-xs">{c.actor}</Td>
                <Td className="font-mono text-xs">
                  {c.key}
                  {c.project ? ` for ${c.project}` : ""}
                </Td>
                <Td className="font-mono text-xs break-all">
                  {c.new_value === null ? `reset (was ${c.old_value})` : `${c.old_value ?? "(no override)"} → ${c.new_value}`}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
