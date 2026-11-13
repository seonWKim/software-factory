import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API, type FileKeysView, type ItemDetail, type SettingsView, type SettingsWrite, postSettings, useApi } from "../api.js";
import { Badge, Section } from "../components/ui/parts.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { MergeButton } from "./item-commands.js";
import { withNodes } from "./standing.js";

// The Settings page's write pieces (useWrite, Outcome) and its typed form of the file-only keys (design 08-settings,
// phase 3 of "Settings without editing factory.config.json"). Each file-only key has a typed control; Save sends
// `edit-file`, so the server's file writer puts the change on a new local branch filed as one local item, and the
// page then shows the branch and that item's Merge button (a local merge, no forge call). A guard, a floor, a
// permission or a dial asks first in the shared danger Dialog; Cancel sends nothing, Confirm sends the confirm flag.
// The read-only keys show their value and why they stay in the file.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A write and its outcome for one field: the refusal stays next to the field until the next try. */
export function useWrite(token: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ item: string; branch: string } | null>(null);
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
      setFiled(r.filed ?? null);
      await client.invalidateQueries({ queryKey: [API.settings] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, filed, write, fail: setError };
}

export function Outcome({ error, done }: { error: string | null; done: string | null }) {
  if (error) return <p role="alert" className="mt-1 text-xs text-pretty break-words text-pill-bad-fg">{error}</p>;
  if (done) return <p role="status" className="mt-1 text-xs text-pretty break-words text-text-2">{done}</p>;
  return null;
}

/**
 * How one value is edited. `argv`: one command as a line of arguments; `pairs`: an object of strings as KEY=VALUE
 * lines; `fields`: an object's named members (any other member of the file's object is kept); `list`: an ordered
 * list with Add and Remove.
 */
type Spec =
  | { kind: "text" | "number" | "bool" | "argv" | "json" | "pairs" }
  | { kind: "choice"; choices: readonly string[]; placeholder?: string }
  | { kind: "list"; item: Spec }
  | { kind: "fields"; fields: Readonly<Record<string, Spec>>; labels?: Readonly<Record<string, string>> };

/** A control's draft: text for the text-like kinds, a boolean for a switch, one draft per item or member. */
type Draft = string | boolean | Draft[] | { [k: string]: Draft };

const TEXT: Spec = { kind: "text" };
const NUMBER: Spec = { kind: "number" };
const ARGV: Spec = { kind: "argv" };
const list = (item: Spec): Spec => ({ kind: "list", item });
const fields = (f: Record<string, Spec>): Spec => ({ kind: "fields", fields: f });

/** The model classes a role picks from (design 04-agents). */
const TIERS = ["cheap", "standard", "strong"] as const;

/** model_by's shape, from its value: a class select per role and tier, a switch for `retry_up`. */
function tierSpec(v: Json | undefined): Spec {
  if (isObject(v)) return fields(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tierSpec(x)])));
  return typeof v === "boolean" ? { kind: "bool" } : { kind: "choice", choices: TIERS };
}

/** The typed control of each file-only key (owner list, design 08-settings); model_by and plugins are built from their values. */
const SPECS: Readonly<Record<string, Spec>> = {
  models: fields(Object.fromEntries(TIERS.map((k) => [k, TEXT]))),
  slack: fields({ channels: list(TEXT), dashboard_url: TEXT, notify_channel: TEXT }),
  "repo.install_command": ARGV,
  "repo.test_command": ARGV,
  "repo.check_commands": list(ARGV),
  "repo.path": TEXT,
  toolchain: fields({ caches: list(TEXT), env: { kind: "pairs" }, warm_command: ARGV }),
  dials: fields({ spec_gate_min_tier: NUMBER, auto_merge_max_tier: NUMBER }),
  floors: list(fields({ prefix: TEXT, tier: NUMBER })),
  permissions: fields({ grants: list(TEXT), static: { kind: "json" } }),
  hotspot_paths: list(TEXT),
  mechanical_paths: list(TEXT),
  path_companions: list(fields({ when: TEXT, also: list(TEXT) })),
};

/** Keys whose change asks first in the danger Dialog: floors, permissions and (decision 3) dials; the guards by plugin. */
const DANGER_KEYS = new Set(["floors", "permissions", "dials"]);

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parse(text: string | null): Json | undefined {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** One argument as typed: bare when it has no space or quote, else a JSON string. */
const ARG = /^[^\s"\\]+$/;
export const joinArgs = (argv: readonly Json[]): string => argv.map((a) => (typeof a === "string" && ARG.test(a) ? a : JSON.stringify(a))).join(" ");
/** The inverse of joinArgs: words split at spaces, a "quoted" word read as a JSON string. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"(?:[^"\\]|\\.)*"|\S+/g)].map(([w]) => (w.startsWith('"') && w.endsWith('"') && w.length > 1 ? (JSON.parse(w) as string) : w));
}

function toDraft(spec: Spec, v: Json | undefined): Draft {
  switch (spec.kind) {
    case "text":
    case "choice":
      return typeof v === "string" ? v : "";
    case "number":
      return typeof v === "number" ? String(v) : "";
    case "bool":
      return v === true;
    case "argv":
      return Array.isArray(v) ? joinArgs(v) : "";
    case "json":
      return v === undefined ? "" : JSON.stringify(v, null, 2);
    case "pairs":
      return isObject(v) ? Object.entries(v).map(([k, x]) => `${k}=${typeof x === "string" ? x : JSON.stringify(x)}`) : [];
    case "list":
      return Array.isArray(v) ? v.map((x) => toDraft(spec.item, x)) : [];
    case "fields":
      return Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, toDraft(s, isObject(v) ? v[k] : undefined)]));
  }
}

/** The value a draft writes; undefined leaves the member out. A json field that does not parse throws. */
function fromDraft(spec: Spec, d: Draft): Json | undefined {
  const s = typeof d === "string" ? d : "";
  switch (spec.kind) {
    case "text":
    case "choice":
      return s === "" ? undefined : s;
    case "number":
      return s.trim() === "" ? undefined : Number(s);
    case "bool":
      return d === true;
    case "argv":
      return splitArgs(s);
    case "json":
      return s.trim() === "" ? undefined : (JSON.parse(s) as Json);
    case "pairs":
      return Object.fromEntries((d as string[]).filter((p) => p.includes("=")).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    case "list":
      return (d as Draft[]).map((x) => fromDraft(spec.item, x)).filter((x): x is Json => x !== undefined);
    case "fields": {
      const out: Record<string, Json> = {};
      for (const [k, sub] of Object.entries(spec.fields)) {
        const v = fromDraft(sub, (d as Record<string, Draft>)[k] ?? toDraft(sub, undefined));
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
  }
}

/** One control for `spec`, labelled `label` (a list item's label adds its place, a member's its name). */
function Control({ spec, draft, label, id, onChange }: { spec: Spec; draft: Draft; label: string; id?: string; onChange: (d: Draft) => void }) {
  const text = typeof draft === "string" ? draft : "";
  switch (spec.kind) {
    case "text":
    case "argv":
      return <Input id={id} aria-label={label} className="w-full min-w-48 font-mono text-xs" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return <Input id={id} aria-label={label} type="number" step="any" className="w-24 tabular-nums" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "bool":
      return <Switch id={id} aria-label={label} checked={draft === true} onCheckedChange={(next) => onChange(next)} />;
    case "json":
      return <Textarea id={id} aria-label={label} rows={Math.min(text.split("\n").length, 12)} spellCheck={false} wrap="off" className="w-full min-w-64 font-mono" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "choice":
      return (
        <Select id={id} aria-label={label} value={text} onChange={(e) => onChange(e.target.value)}>
          {text === "" && (
            <option value="" disabled>
              {spec.placeholder ?? t("settings.file.notSet")}
            </option>
          )}
          {spec.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      );
    case "pairs":
    case "list":
      return <ListControl item={spec.kind === "list" ? spec.item : TEXT} draft={draft as Draft[]} label={label} onChange={onChange} />;
    case "fields":
      return <FieldsControl spec={spec} draft={draft as Record<string, Draft>} label={label} onChange={onChange} />;
  }
}

/** An ordered list: each item's control and its Remove, then Add. */
function ListControl({ item, draft, label, onChange }: { item: Spec; draft: Draft[]; label: string; onChange: (d: Draft) => void }) {
  return (
    <div className="flex w-full flex-col items-start gap-2">
      {draft.length > 0 && (
        <ol className="flex w-full flex-col gap-2">
          {draft.map((d, i) => {
            const itemLabel = `${label} ${i + 1}`;
            return (
              <li key={i} data-list-item className="flex w-full flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Control spec={item} draft={d} label={itemLabel} onChange={(next) => onChange(draft.map((x, j) => (j === i ? next : x)))} />
                </div>
                <Button size="sm" variant="ghost" aria-label={t("settings.file.removeLabel", { label: itemLabel })} onClick={() => onChange(draft.filter((_, j) => j !== i))}>
                  {t("settings.file.remove")}
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <Button size="sm" variant="secondary" aria-label={t("settings.file.addLabel", { label })} onClick={() => onChange([...draft, toDraft(item, undefined)])}>
        {t("settings.file.add")}
      </Button>
    </div>
  );
}

/** An object's named members, each a Field with its name above its control. */
function FieldsControl({ spec, draft, label, onChange }: { spec: Extract<Spec, { kind: "fields" }>; draft: Record<string, Draft>; label: string; onChange: (d: Draft) => void }) {
  const uid = useId();
  return (
    <div className="flex w-full flex-wrap items-start gap-x-4 gap-y-3">
      {Object.entries(spec.fields).map(([k, sub], i) => (
        <Field key={k} label={<span className="font-mono text-xs">{spec.labels?.[k] ?? k}</span>} htmlFor={`${uid}-${i}`} className={sub.kind === "list" || sub.kind === "pairs" || sub.kind === "json" || sub.kind === "fields" ? "w-full" : ""}>
          <Control spec={sub} id={`${uid}-${i}`} draft={draft[k] ?? toDraft(sub, undefined)} label={`${label} ${k}`} onChange={(next) => onChange({ ...draft, [k]: next })} />
        </Field>
      ))}
    </div>
  );
}

/** The filed change: its branch, and its item's Merge button (the item API's merge readiness; a local merge). */
function Filed({ item, branch }: { item: string; branch: string }) {
  const detail = useApi<ItemDetail>(API.item(item));
  const merge = detail.data?.item.merge ?? { enabled: false, reason: t("settings.file.checking") };
  return (
    <div data-filed={item} className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-2">
      <span className="text-pretty break-words">{withNodes("settings.file.filed", { branch: <code className="font-mono">{branch}</code> })}</span>
      <MergeButton id={item} source="local" merge={merge} />
    </div>
  );
}

/**
 * One file-only key: its control, Save, and the outcome. Save sends `edit-file` with the whole new value; a danger
 * key (or a guard, by `danger`) opens the danger Dialog first, whose Cancel sends nothing.
 */
function FileKey({ name, spec, value, token, danger }: { name: string; spec: Spec; value: Json | undefined; token: string; danger: (next: Json) => boolean }) {
  const { busy, error, done, filed, write, fail } = useWrite(token);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The value the danger Dialog asks about; null while it is closed. */
  const [asking, setAsking] = useState<{ next: Json } | null>(null);
  const shown = draft ?? toDraft(spec, value);
  const send = async (next: Json, confirm: boolean): Promise<boolean> => {
    const ok = await write({ action: "edit-file", key: name, value: JSON.stringify(next), confirm });
    if (ok) setDraft(null);
    return ok;
  };
  const save = () => {
    let next: Json;
    try {
      const made = fromDraft(spec, shown) ?? null;
      // Members of the file's object this form does not name stay as they are.
      next = spec.kind === "fields" && isObject(value) && isObject(made) ? { ...value, ...made } : made;
    } catch (err) {
      fail(t("settings.file.badJson", { key: name, message: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (danger(next)) setAsking({ next });
    else void send(next, false);
  };
  return (
    <li data-file-key={name} className="border-t border-border py-3 first:border-t-0 first:pt-0">
      <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), save())}>
        <span className="font-mono text-xs font-medium">{name}</span>
        <Control spec={spec} draft={shown} label={name} onChange={setDraft} />
        <ButtonRow>
          <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label: name })}>
            {t("settings.save")}
          </Button>
        </ButtonRow>
      </form>
      <Outcome error={error} done={done} />
      {filed && <Filed item={filed.item} branch={filed.branch} />}
      {asking !== null && (
        <Dialog
          danger
          title={t("settings.file.dangerTitle", { key: name })}
          consequence={t("settings.file.dangerConsequence", { key: name })}
          confirmLabel={t("settings.file.dangerConfirm")}
          confirmDisabled={busy}
          error={error}
          onConfirm={() => void send(asking.next, true).then((ok) => ok && setAsking(null))}
          onClose={() => setAsking(null)}
        >
          <pre className="max-h-48 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-xs break-all whitespace-pre-wrap">{JSON.stringify(asking.next, null, 2)}</pre>
        </Dialog>
      )}
    </li>
  );
}

/** The plugins form: a select of the registered names per interface; a list for an interface the file lists several of. */
function pluginsSpec(view: FileKeysView, file: Json | undefined): Spec {
  const f: Record<string, Spec> = {};
  const labels: Record<string, string> = {};
  for (const p of view.plugins) {
    const choice: Spec = { kind: "choice", choices: p.names, placeholder: t("settings.file.inForce", { name: p.selected ?? t("settings.file.notSet") }) };
    f[p.kind] = isObject(file) && Array.isArray(file[p.kind]) ? list(choice) : choice;
    labels[p.kind] = p.guard ? t("settings.file.guardLabel", { name: p.interface, kind: p.kind }) : t("settings.file.pluginLabel", { name: p.interface, kind: p.kind });
  }
  return { kind: "fields", fields: f, labels };
}

/** The read-only keys: each value and why it stays in the file, and the line saying how to change it. */
function ReadOnlyKeys({ keys }: { keys: FileKeysView["read_only"] }) {
  return (
    <ul aria-label={t("settings.file.readOnlyTitle")} className="flex flex-col gap-2">
      {keys.map((k) => (
        <li key={k.key} data-read-only={k.key} className="text-xs">
          <span className="font-mono font-medium">{k.key}</span> <code className="font-mono wrap-anywhere">{k.value ?? t("settings.file.notSet")}</code>
          <p className="text-pretty text-text-2">
            {t(`settings.file.why.${k.key}` as MessageKey)} {t("settings.file.readOnlyLine")}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** The file-only keys: a typed control for each the page edits, then the read-only ones. Null without a file writer. */
export function FileKeysSection({ view }: { view: SettingsView }) {
  const fk = view.file_keys;
  if (!fk) return null;
  const file = (key: string) => parse(fk.editable.find((e) => e.key === key)?.value ?? null);
  const plugins = file("plugins");
  const guards = fk.plugins.filter((p) => p.guard).map((p) => p.kind);
  const guardChanged = (next: Json) => guards.some((g) => JSON.stringify(isObject(next) ? next[g] : undefined) !== JSON.stringify(isObject(plugins) ? plugins[g] : undefined));
  // model_by's shape: the file's value, else the built-in default the settable row carries.
  const modelByShape = file("model_by") ?? parse(view.keys.find((k) => k.key === "model_by")?.default_value ?? null);
  const specOf = (key: string): Spec | undefined => (key === "plugins" ? pluginsSpec(fk, plugins) : key === "model_by" ? tierSpec(modelByShape) : SPECS[key]);
  return (
    <Section title={t("settings.file.title")} count={fk.editable.length}>
      <p className="mb-2 text-sm text-pretty text-text-2">{withNodes("settings.file.intro", { file: <code>{"factory.config.json"}</code> })}</p>
      <ul className="flex flex-col">
        {fk.editable.map(({ key }) => {
          const spec = specOf(key);
          if (!spec) return null;
          const danger = key === "plugins" ? guardChanged : () => DANGER_KEYS.has(key);
          return <FileKey key={key} name={key} spec={spec} value={file(key)} token={view.csrf_token} danger={danger} />;
        })}
      </ul>
      <h3 className="mt-4 mb-2 text-sm font-semibold">{t("settings.file.readOnlyTitle")}</h3>
      <ReadOnlyKeys keys={fk.read_only} />
    </Section>
  );
}

/** The PR-only keys the typed form now edits: they leave the PR-only table. */
export function editableKeys(view: SettingsView): Set<string> {
  const fk = view.file_keys;
  if (!fk) return new Set();
  return new Set([...fk.editable.map((e) => e.key), ...fk.plugins.filter((p) => p.guard).map((p) => p.kind)]);
}
