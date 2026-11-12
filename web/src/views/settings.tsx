import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { API, type Session, type SettingRow, type SettingsView, type SettingsWrite, postSettings, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Input } from "../components/ui/input.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { ago, duration } from "../lib/format.js";
import { useNow } from "./common.js";
import { ProposalsSection, StandingSection, withNodes } from "./standing.js";

// The Settings page (design §8 and §9, issue #236): every settable key with its value, source and when a change
// applies, an edit control per key and a reset when an override exists, the PR-only keys read-only, and the
// audit history, and the standing approvals (standing.tsx), whose pending proposals come first. Every key write is POST /api/v1/settings, which runs
// the same checks as `factory settings`; a refusal is shown next to the field it came from. A per-project gate key
// also shows the configured project's learned value (design 08-settings) next to its file and override values, with
// its evidence runs, its set time and a reset that runs the same check as `factory settings reset --learned`.
// The owner notices' two keys (design 09-notifications) are edited in their own Notices section: a switch per kind
// and a quiet-hours field.

const TIERS = ["cheap", "standard", "strong"] as const;
const PR_ONLY_TITLE = t("settings.prOnlyTitle");
const SOURCE_TONE: Record<string, string> = { override: "needs_approval", file: "", default: "" };

/** message_style (design 04-agents): what it does in one line, and an example. */
const STYLE_HINT = t("settings.styleHint");
const STYLE_EXAMPLE = t("settings.styleExample");

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
      setDone(r.lines[0] ?? t("settings.saved"));
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
const summaryOf = (obj: Record<string, unknown>, key: MessageKey = "settings.keysSummary") => t(key, { count: Object.keys(obj).length, keys: Object.keys(obj).join(", ") });

/**
 * A setting value: a JSON object as one `key → value` line per entry (behind a summary of its keys when it has more
 * than SHORT_OBJECT entries, so a long value never makes its row tall), anything else as its text.
 */
function JsonValue({ text }: { text: string }) {
  const obj = asObject(text);
  if (obj === null || Object.keys(obj).length === 0) return <span className="font-mono text-xs wrap-anywhere">{text}</span>;
  const list = (
    <dl data-entries className="grid grid-cols-[auto_minmax(10ch,1fr)] gap-x-2 font-mono text-xs">
      {entries(obj).map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-text-2">{k}</dt>
          <dd className="min-w-0 wrap-anywhere">{v}</dd>
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
  const uid = useId();
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
        {value === '"auto"' ? t("settings.modeAuto") : t("settings.modeManual")}
      </span>
    );
  } else if (row.kind === "boolean") {
    control = <Switch aria-label={label} checked={value === "true"} disabled={busy} onCheckedChange={(next) => void save(String(next))} />;
  } else if (row.kind === "models") {
    const current = asObject(value) ?? {};
    const shown = tiers ?? Object.fromEntries(TIERS.map((t) => [t, typeof current[t] === "string" ? (current[t] as string) : ""]));
    control = (
      // Two columns, tier | 7rem field, so the three fields start at one x; Save in its own row 12px below.
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        <div data-tiers className="grid grid-cols-[auto_7rem] items-center gap-x-2 gap-y-3">
          {TIERS.map((t) => (
            <Fragment key={t}>
              <label htmlFor={`${uid}-${t}`} className="text-xs text-text-2">
                {t}
              </label>
              <Input id={`${uid}-${t}`} aria-label={`${label} ${t}`} className="w-full tabular-nums" value={shown[t]} onChange={(e) => setTiers({ ...shown, [t]: e.target.value })} />
            </Fragment>
          ))}
        </div>
        <ButtonRow>
          <Button type="submit" variant="secondary" disabled={busy || tiers === null} aria-label={t("settings.saveLabel", { label })}>
            {t("settings.save")}
          </Button>
        </ButtonRow>
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
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
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
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
        </Button>
      </form>
    );
    control =
      obj !== null && entries(obj).length > SHORT_OBJECT ? (
        <details>
          <summary className="cursor-pointer text-xs text-pretty break-words text-text-2">{summaryOf(obj, "settings.keysSummaryEdit")}</summary>
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
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
          {t("settings.save")}
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
      <Button variant="secondary" disabled={busy} aria-label={t(learned ? "settings.resetLearnedLabel" : "settings.resetLabel", { label })} onClick={() => void write(body)}>
        {learned ? t("settings.resetLearned") : t("settings.reset")}
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
  const label = t("settings.keyFor", { key: row.key, project: view.repo });
  const runs = learned.evidence_run_ids;
  return (
    <div data-learned className="mt-2 flex flex-wrap items-start gap-2">
      <div className="min-w-0 text-xs text-text-2">
        <p className="text-pretty">
          {t("settings.learned")} <span className="font-mono">{learned.value}</span>{" "}
          <Badge level={learned.source === "learned" ? "needs_approval" : undefined}>{learned.source === "learned" ? t("settings.inForce") : t("settings.ignoredTighter", { source: learned.source })}</Badge>{" "}
          <span className="tabular-nums">{t("settings.setAgo", { time: ago(learned.set_at, now) })}</span>
        </p>
        {runs.length > 0 && (
          <details>
            <summary className="cursor-pointer">{t(runs.length === 1 ? "settings.fromRunOne" : "settings.fromRunMany", { count: runs.length })}</summary>
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
  ["spec", t("settings.noticeSpec")],
  ["merge", t("settings.noticeMerge")],
  ["failure", t("settings.noticeFailure")],
  ["other", t("settings.noticeOther")],
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
      <span className="font-medium">{t("settings.noticeWhen")}</span>
      {NOTICE_KINDS.map(([kind, label]) => (
        <label key={kind} className="flex items-center gap-2">
          <Switch aria-label={t("settings.noticeKind", { kind })} checked={on.includes(kind)} disabled={busy} onCheckedChange={(next) => set(kind, next)} />
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
      <span className="font-medium">{t("settings.quietHours")}</span>
      <p className="text-xs text-pretty text-text-2">
        {t("settings.quietHint")}
      </p>
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Input aria-label={t("settings.quietHours")} placeholder="22:00-07:00" className="w-32 tabular-nums" value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label: t("settings.quietHours") })}>
          {t("settings.save")}
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
    <Section title={t("settings.notices")}>
      <p className="mb-2 text-sm text-pretty text-text-2">
        {t("settings.noticesIntro")}
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
            <span className="font-mono wrap-anywhere">{row.value}</span> · {t("settings.editUnderNotices")}
          </p>
        ) : (
          <Editor row={row} label={row.key} value={row.value} token={view.csrf_token} />
        )}
        <Duration settingKey={row.key} value={row.value} />
        {row.key === "workers" && row.max !== undefined && (
          <p className="mt-1 text-xs text-text-2">
            {row.capped_at ? t("settings.workersRangeCapped", { max: row.max, capped: row.capped_at }) : t("settings.workersRange", { max: row.max })}
          </p>
        )}
        {row.project_settable && (
          <div className="mt-2 border-t border-border pt-2">
            <p className="mb-1 text-xs text-text-2">
              {t("settings.forValue", { project: view.project ?? view.repo, value: own ? `${own.value} (${own.source})` : t("settings.globalValue") })}
              {view.project === null && ` · ${t("settings.noProjectLabel")}`}
            </p>
            <div className="flex flex-wrap items-start gap-2">
              <Editor row={row} label={t("settings.keyFor", { key: row.key, project: view.repo })} value={own?.value ?? row.value} token={view.csrf_token} project={view.repo} />
              {own?.source === "override" && <ResetButton row={row} label={t("settings.keyFor", { key: row.key, project: view.repo })} token={view.csrf_token} project={view.repo} />}
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
          <span className="font-mono text-xs wrap-anywhere text-text-3">{t("settings.notSetDefault", { value: row.default_value })}</span>
        ) : (
          <>
            <span className="text-xs text-text-3">{t("settings.notSetDefaultColon")}</span>
            <JsonValue text={row.default_value} />
          </>
        )}
      </Td>
      <Td className="min-w-24 text-text-2">{row.applies_at}</Td>
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
      <Section title={t("settings.commandsTitle")}>
        <p className="text-sm text-pretty text-text-2">
          {s?.actor ? (
            <>
              {withNodes("settings.cmdActsAs", { actor: <code>{s.actor}</code> }, { source: t(s.actor_source === "config" ? "settings.sourceConfig" : "settings.sourceEnvironment") })}{" "}
            </>
          ) : (
            <>{t("settings.cmdOff")} </>
          )}
          {withNodes("settings.cmdHowTo", {
            userId: <code>{"ui.user_id"}</code>,
            file: <code>{"factory.config.json"}</code>,
            example: <code>{'"ui": { "user_id": "github:12345" }'}</code>,
            ui: <code>{"factory ui"}</code>,
            cliUser: <code>{"cli_user"}</code>,
            email: <code>{"user.email"}</code>,
          })}
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
  if (!v || !mode) return <span className="text-sm text-text-2">{t("settings.modeLoading")}</span>;
  return (
    <div data-testid="mode" className="flex items-center gap-2 text-sm whitespace-nowrap">
      <span>{t("settings.mode")}</span>
      <ModeControl view={v} floating={floating} />
    </div>
  );
}

/** The mode's own control, without the top bar's "Mode" label. */
function ModeControl({ view, floating = false }: { view: SettingsView; floating?: boolean }) {
  const mode = currentMode(view);
  if (!mode) return null;
  return <Editor row={mode.row} label={t("settings.autoMode")} value={mode.value} token={view.csrf_token} floating={floating} {...(mode.project === undefined ? {} : { project: mode.project })} />;
}

/** The mode and, next to it, the auto-merge tier (design 09): what decides whether the factory merges on its own. */
function ModeSection({ view }: { view: SettingsView }) {
  const tier = view.keys.find((k) => k.key === "auto_merge_max_tier");
  return (
    <Section title={t("settings.mode")}>
      <p className="mb-2 text-sm text-pretty text-text-2">
        {t("settings.modeIntro")}
      </p>
      {/* Each label sits above its control, so a refusal under one never squeezes the other's label. */}
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div className="flex max-w-md flex-col gap-1 text-sm">
          <span className="font-medium">{t("settings.mode")}</span>
          <ModeControl view={view} />
        </div>
        {tier && (
          <div className="flex max-w-md flex-col gap-1 text-sm">
            <span className="font-medium whitespace-nowrap">{t("settings.tierLabel")}</span>
            <Editor row={tier} label={t("settings.tier")} value={tier.value} token={view.csrf_token} />
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
      <Section title={t("settings.settableKeys")} count={v.keys.length}>
        <p className="mb-2 text-sm text-pretty text-text-2">
          {withNodes("settings.settableIntro", { command: <code>{"factory settings"}</code> })}
        </p>
        <Table label={t("settings.settableKeys")} head={[t("settings.colKey"), t("settings.colValue"), t("settings.colSource"), t("settings.colFileValue"), t("settings.colAppliesAt"), ""]}>
          {v.keys.map((row) => (
            <KeyRow key={row.key} row={row} view={v} />
          ))}
        </Table>
      </Section>
      {v.ignored.length > 0 && (
        <Section title={t("settings.ignoredOverrides")} count={v.ignored.length}>
          <ul className="space-y-1 text-sm">
            {v.ignored.map((i, n) => (
              <li key={n} className="text-pretty break-words">
                <code>{i.key}</code>
                {i.project ? t("settings.forProject", { project: i.project }) : ""} = <code>{i.value}</code>: {i.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <StandingSection />
      <Section title={PR_ONLY_TITLE} count={v.pr_only.length}>
        <p className="mb-2 text-sm text-pretty text-text-2">
          {withNodes("settings.prOnlyIntro", { command: <code>{"factory settings set"}</code>, file: <code>{"factory.config.json"}</code> })}
        </p>
        <Table label={PR_ONLY_TITLE} head={[t("settings.colKey")]}>
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
      <Section title={t("settings.history")} count={v.history.length}>
        {v.history.length === 0 ? (
          <Empty>{t("settings.noHistory")}</Empty>
        ) : (
          <Table label={t("settings.history")} head={[t("col.when"), t("settings.colWho"), t("settings.colKey"), t("settings.colChange")]}>
            {v.history.map((c) => (
              <Tr key={c.seq}>
                <Td className="tabular-nums whitespace-nowrap">{t("time.ago", { time: ago(c.at, now) })}</Td>
                <Td className="font-mono text-xs">{c.actor}</Td>
                <Td className="font-mono text-xs">
                  {c.key}
                  {c.project ? t("settings.forProject", { project: c.project }) : ""}
                </Td>
                <Td className="font-mono text-xs break-all">
                  {c.new_value === null ? t("settings.resetWas", { old: String(c.old_value) }) : t("settings.changed", { old: c.old_value ?? t("settings.noOverride"), new: c.new_value })}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
