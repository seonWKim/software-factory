import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API, type FileKeysView, type ItemDetail, type SettingsView, type SettingsWrite, postSettings, useApi } from "../api.js";
import { Table } from "../components/ui/parts.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { KeyValue, ValueBlock } from "../components/ui/key-value.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { termLabel } from "../lib/format.js";
import { keyHelp, keyLabel } from "../lib/key-label.js";
import { MergeButton } from "./merge-button.js";
import { SettingsRow } from "./settings-row.js";
import { withNodes } from "./standing.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Card, CardSection } from "../components/ui/card.js";

// The Settings page's write pieces (useWrite, Outcome) and its typed form of the file-only keys (design 08-settings,
// phase 3 of "Settings without editing factory.config.json"). Each file-only key has a typed control and a restart
// note; Save opens the shared Dialog with the key's old and new value, and only its confirm sends `edit-file`, so the
// server's file writer puts the change on a new local branch filed as one local item, and the page then shows the
// branch and that item's Merge button (a local merge, no forge call). Cancel sends nothing. A guard, a floor, a
// permission or a dial asks in the danger form of the Dialog, whose confirm sends the confirm flag.
// The read-only keys show their value and the reason the page does not edit them.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A value sent with a set, in plain words: text as typed, a list joined by commas; "" for an empty or nested value. */
function plainValue(sent: string): string {
  const v = parse(sent);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ");
  return "";
}

/** The confirmation, composed from the request: the setting's label and the value sent, never the CLI's line. */
function confirmation(body: SettingsWrite, named?: string): string {
  if (body.action === "project-label") return t("settings.savedPlain", { label: t("settings.projectLabel") });
  const label = named ?? keyLabel(body.key);
  if (body.action === "reset") return t("settings.resetDone", { label });
  if (body.action === "edit-file") return t("settings.savedFile", { label });
  const value = plainValue(body.value);
  return value === "" ? t("settings.savedPlain", { label }) : t("settings.savedValue", { label, value });
}

/** A write and its outcome for one field (`named` is a row's label when the key's own differs, as a plugin kind's): the refusal stays next to the field until the next try. */
export function useWrite(token: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ item: string; branch: string } | null>(null);
  const write = async (body: SettingsWrite, named?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await postSettings(token, body);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      setDone(confirmation(body, named));
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
  | { kind: "fields"; fields: Readonly<Record<string, Spec>> };

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

/** An ordered list of strings: each item's text box and its Remove, then Add (the Settings page's list kind). */
export function StringListControl({ draft, label, onChange }: { draft: string[]; label: string; onChange: (d: string[]) => void }) {
  return <ListControl item={TEXT} draft={draft} label={label} onChange={(d) => onChange(d as string[])} />;
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
        <Field key={k} label={<span className="text-xs">{termLabel(k)}</span>} htmlFor={`${uid}-${i}`} className={sub.kind === "list" || sub.kind === "pairs" || sub.kind === "json" || sub.kind === "fields" ? "w-full" : ""}>
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

/** A value as the confirm Dialog shows it: pretty JSON, or "not set" when the file leaves it out. */
const shownJson = (v: Json | undefined): string => (v === undefined ? t("settings.file.notSet") : JSON.stringify(v, null, 2));

/** The raw key name behind a Details toggle, under a row's human label; a guard plugin's Details also says "guard". */
export function KeyNameDetails({ name, guard }: { name: string; guard?: boolean }) {
  return (
    <Disclosure data-raw summary={t("settings.details")}>
      <KeyValue
        className="mt-1"
        items={[
          { key: "key", term: t("settings.detailKey"), value: name, code: true },
          ...(guard ? [{ key: "guard", term: t("settings.file.guard"), value: "" }] : []),
        ]}
      />
    </Disclosure>
  );
}

/**
 * One file-only key as a shared settings row: its control, Save and restart note in the control cell, its key name in
 * Details. Save opens the confirm Dialog with the old and new value; its confirm sends `edit-file` with the whole new
 * value, its Cancel sends nothing. A danger key (or a guard plugin) uses the Dialog's danger form, and its confirm sends
 * the confirm flag. A `member` row edits one member of the key's object (one plugin kind of `plugins`) and writes the
 * object whole, its other members kept.
 */
function FileKey({ name, member, label, help, spec, value, token, danger, guard }: { name: string; member?: string; label: string; help: string; spec: Spec; value: Json | undefined; token: string; danger: boolean; guard?: boolean }) {
  const { busy, error, done, filed, write, fail } = useWrite(token);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The value the confirm Dialog asks about; null while it is closed. */
  const [asking, setAsking] = useState<Json | null>(null);
  const own = member === undefined ? value : isObject(value) ? value[member] : undefined;
  const shown = draft ?? toDraft(spec, own);
  const send = async (next: Json): Promise<boolean> => {
    const ok = await write({ action: "edit-file", key: name, value: JSON.stringify(next), confirm: danger }, label);
    if (ok) setDraft(null);
    return ok;
  };
  const save = () => {
    let next: Json;
    try {
      const made = fromDraft(spec, shown);
      if (member !== undefined) {
        const rest = isObject(value) ? { ...value } : {};
        if (made === undefined) delete rest[member];
        else rest[member] = made;
        next = rest;
      } else {
        // Members of the file's object this form does not name stay as they are.
        next = spec.kind === "fields" && isObject(value) && isObject(made) ? { ...value, ...made } : (made ?? null);
      }
    } catch (err) {
      fail(t("settings.file.badJson", { key: label, message: err instanceof Error ? err.message : String(err) }));
      return;
    }
    setAsking(next);
  };
  return (
    <SettingsRow
      attrs={{ "data-file-key": member === undefined ? name : `${name}.${member}` }}
      name={label}
      description={help}
      details={<KeyNameDetails name={member === undefined ? name : `${name}.${member}`} {...(guard ? { guard } : {})} />}
      control={
        <>
          <form className="flex flex-col items-start gap-3" onSubmit={(e) => (e.preventDefault(), save())}>
            <Control spec={spec} draft={shown} label={label} onChange={setDraft} />
            <ButtonRow>
              <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label })}>
                {t("settings.save")}
              </Button>
            </ButtonRow>
            <p data-restart-note className="text-xs text-pretty text-text-2">
              {t("settings.file.restartNote")}
            </p>
          </form>
          <Outcome error={error} done={done} />
          {filed && <Filed item={filed.item} branch={filed.branch} />}
          {asking !== null && (
            <Dialog
              danger={danger}
              title={t("settings.file.dangerTitle", { key: label })}
              consequence={danger ? t("settings.file.dangerConsequence", { key: label }) : t("settings.file.confirmConsequence")}
              confirmLabel={t("settings.file.dangerConfirm")}
              confirmDisabled={busy}
              error={error}
              onConfirm={() => void send(asking).then((ok) => ok && setAsking(null))}
              onClose={() => setAsking(null)}
            >
              <KeyValue
                stacked
                items={[
                  { key: "old", term: t("settings.file.oldValue"), value: <ValueBlock>{shownJson(value)}</ValueBlock>, valueProps: { "data-old-value": true } },
                  { key: "new", term: t("settings.file.newValue"), value: <ValueBlock>{shownJson(asking)}</ValueBlock>, valueProps: { "data-new-value": true } },
                ]}
              />
            </Dialog>
          )}
        </>
      }
    />
  );
}

/** One plugin kind's control: a select of the registered names; a list of selects for a kind the file lists several of. */
function pluginSpec(p: FileKeysView["plugins"][number], file: Json | undefined): Spec {
  const choice: Spec = { kind: "choice", choices: p.names, placeholder: t("settings.file.inForce", { name: p.selected ?? t("settings.file.notSet") }) };
  return isObject(file) && Array.isArray(file[p.kind]) ? list(choice) : choice;
}

/** The three columns every settings row fills: name and description, value, Details. */
const head = () => [t("settings.colKey"), t("settings.colValue"), t("settings.details")];

/** The read-only keys: each value and the reason the page does not edit it, in the same row layout. */
function ReadOnlyKeys({ keys }: { keys: FileKeysView["read_only"] }) {
  return (
    <Table label={t("settings.file.readOnlyTitle")} head={head()}>
      {keys.map((k) => (
        <SettingsRow
          key={k.key}
          attrs={{ "data-read-only": k.key }}
          name={keyLabel(k.key)}
          description={t(`settings.file.why.${k.key}` as MessageKey)}
          control={<code className="font-mono text-xs wrap-anywhere">{k.value ?? t("settings.file.notSet")}</code>}
          details={<KeyNameDetails name={k.key} />}
        />
      ))}
    </Table>
  );
}

/** The file-only keys: a typed row for each the page edits (`plugins` as one row per plugin kind), then the read-only ones. Null without a file writer. */
export function FileKeysSection({ view }: { view: SettingsView }) {
  const fk = view.file_keys;
  if (!fk) return null;
  const file = (key: string) => parse(fk.editable.find((e) => e.key === key)?.value ?? null);
  const plugins = file("plugins");
  // model_by's shape: the file's value, else the built-in default the settable row carries.
  const modelByShape = file("model_by") ?? parse(view.keys.find((k) => k.key === "model_by")?.default_value ?? null);
  const specOf = (key: string): Spec | undefined => (key === "model_by" ? tierSpec(modelByShape) : SPECS[key]);
  const common = { token: view.csrf_token };
  return (
    <Card title={t("settings.file.title")} count={fk.editable.length}>
      <p className="mb-2 text-sm text-pretty text-text-2">{t("settings.file.intro")}</p>
      <Table label={t("settings.file.title")} head={head()}>
        {fk.editable.flatMap(({ key }) => {
          if (key === "plugins") {
            return fk.plugins.map((p) => (
              <FileKey key={`plugins.${p.kind}`} {...common} name="plugins" member={p.kind} label={keyLabel(`plugin.${p.kind}`)} help={t("settings.file.pluginHelp")} spec={pluginSpec(p, plugins)} value={plugins} danger={p.guard} guard={p.guard} />
            ));
          }
          const spec = specOf(key);
          if (!spec) return [];
          return [<FileKey key={key} {...common} name={key} label={keyLabel(key)} help={keyHelp(key, "")} spec={spec} value={file(key)} danger={DANGER_KEYS.has(key)} />];
        })}
      </Table>
      <CardSection title={t("settings.file.readOnlyTitle")}>
        <ReadOnlyKeys keys={fk.read_only} />
      </CardSection>
    </Card>
  );
}

/** The PR-only keys the typed form now edits: they leave the PR-only table. */
export function editableKeys(view: SettingsView): Set<string> {
  const fk = view.file_keys;
  if (!fk) return new Set();
  return new Set([...fk.editable.map((e) => e.key), ...fk.plugins.filter((p) => p.guard).map((p) => p.kind)]);
}
