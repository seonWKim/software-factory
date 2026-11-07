import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type SettingRow, type SettingsView, type SettingsWrite, postSettings, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/cn.js";
import { ago, duration } from "../lib/format.js";
import { useNow } from "./common.js";

// The Settings page (design §8 and §9, issue #236): every settable key with its value, source and when a change
// applies, an edit control per key and a reset when an override exists, the PR-only keys read-only, and the
// audit history. Every write is POST /api/v1/settings, which runs the same checks as `factory settings`; a
// refusal is shown next to the field it came from.

const TIERS = ["cheap", "standard", "strong"] as const;
const SOURCE_TONE: Record<string, string> = { override: "needs_approval", file: "", default: "" };

const input =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900 " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600";
const textButton = "h-8 w-auto px-2";

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
  if (error) return <p role="alert" className="mt-1 text-xs text-pretty break-words text-red-700 dark:text-red-300">{error}</p>;
  if (done) return <p role="status" className="mt-1 text-xs text-pretty break-words text-zinc-600 dark:text-zinc-400">{done}</p>;
  return null;
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The edit control for one value: a number field, a switch, a text field per tier, or JSON. No min or max on
 * the field: the server's checks decide, and their message shows next to the field.
 */
function Editor({ row, label, value, token, project }: { row: SettingRow; label: string; value: string; token: string; project?: string }) {
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
  if (row.kind === "boolean") {
    control = <Switch aria-label={label} checked={value === "true"} disabled={busy} onCheckedChange={(next) => void save(String(next))} />;
  } else if (row.kind === "models") {
    const current = parseObject(value);
    const shown = tiers ?? Object.fromEntries(TIERS.map((t) => [t, typeof current[t] === "string" ? (current[t] as string) : ""]));
    control = (
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save(JSON.stringify(shown)))}>
        {TIERS.map((t) => (
          <label key={t} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            {t}
            <input aria-label={`${label} ${t}`} className={cn(input, "w-28")} value={shown[t]} onChange={(e) => setTiers({ ...shown, [t]: e.target.value })} />
          </label>
        ))}
        <Button type="submit" variant="outline" className={textButton} disabled={busy || tiers === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
  } else if (row.kind === "model_by") {
    const shown = draft ?? value;
    control = (
      <form className="flex flex-col items-start gap-2" onSubmit={(e) => (e.preventDefault(), void save(shown))}>
        <textarea aria-label={label} rows={4} spellCheck={false} className={cn(input, "w-full min-w-72 font-mono text-xs")} value={shown} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="outline" className={textButton} disabled={busy || draft === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
  } else {
    const shown = draft ?? value;
    control = (
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void save(shown))}>
        <input
          aria-label={label}
          type="number"
          className={cn(input, "w-32")}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="outline" className={textButton} disabled={busy || draft === null} aria-label={`Save ${label}`}>
          Save
        </Button>
      </form>
    );
  }
  return (
    <div>
      {control}
      <Outcome error={error} done={done} />
    </div>
  );
}

function ResetButton({ row, label, token, project }: { row: SettingRow; label: string; token: string; project?: string }) {
  const { busy, error, done, write } = useWrite(token);
  return (
    <div>
      <Button variant="outline" className={textButton} disabled={busy} aria-label={`Reset ${label}`} onClick={() => void write({ action: "reset", key: row.key, ...(project === undefined ? {} : { project }) })}>
        Reset
      </Button>
      <Outcome error={error} done={done} />
    </div>
  );
}

/** A millisecond key's value as a duration with its unit ("1h 30m"), under its field; nothing for other keys. */
function Duration({ settingKey, value }: { settingKey: string; value: string }) {
  if (!settingKey.endsWith("_ms") || !/^\d+$/.test(value.trim())) return null;
  return <p data-duration className="mt-1 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">{duration(Number(value))}</p>;
}

/** What a key controls, under its name; always shown, narrow screens included. */
function Description({ text }: { text: string }) {
  return <p className="mt-1 max-w-64 text-xs text-pretty text-zinc-600 dark:text-zinc-400">{text}</p>;
}

function KeyRow({ row, view }: { row: SettingRow; view: SettingsView }) {
  const own = view.project === null ? undefined : row.projects.find((p) => p.project === view.project);
  return (
    <Tr data-key={row.key}>
      <Td>
        <span className="font-mono text-xs whitespace-nowrap">{row.key}</span>
        <Description text={row.description} />
      </Td>
      <Td className="min-w-48">
        <Editor row={row} label={row.key} value={row.value} token={view.csrf_token} />
        <Duration settingKey={row.key} value={row.value} />
        {row.key === "workers" && row.max !== undefined && (
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            1 to {row.max} (max_workers){row.capped_at ? `; the stored value runs as ${row.capped_at}` : ""}
          </p>
        )}
        {row.project_settable && (
          <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <p className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">
              for {view.project ?? view.repo}: {own ? `${own.value} (${own.source})` : "the global value"}
              {view.project === null && " · no project label stored yet; use factory settings --project on the command line"}
            </p>
            <div className="flex items-start gap-2">
              <Editor row={row} label={`${row.key} for ${view.repo}`} value={own?.value ?? row.value} token={view.csrf_token} project={view.repo} />
              {own?.source === "override" && <ResetButton row={row} label={`${row.key} for ${view.repo}`} token={view.csrf_token} project={view.repo} />}
            </div>
            <Duration settingKey={row.key} value={own?.value ?? row.value} />
          </div>
        )}
      </Td>
      <Td>
        <Badge level={SOURCE_TONE[row.source] || undefined}>{row.source}</Badge>
      </Td>
      <Td className="font-mono text-xs break-all">{row.file_value ?? <span className="text-zinc-500">not set (default {row.default_value})</span>}</Td>
      <Td className="text-zinc-600 dark:text-zinc-400">{row.applies_at}</Td>
      <Td>{row.source === "override" && <ResetButton row={row} label={row.key} token={view.csrf_token} />}</Td>
    </Tr>
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
      <Section title="Settable keys" count={v.keys.length}>
        <p className="mb-2 text-sm text-pretty text-zinc-600 dark:text-zinc-400">
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
      <Section title="Changes by PR only" count={v.pr_only.length}>
        <Table label="Changes by PR only" head={["Key", ""]}>
          {v.pr_only.map((p) => (
            <Tr key={p.key} data-key={p.key}>
              <Td>
                <span className="font-mono text-xs">{p.key}</span>
                <Description text={p.description} />
              </Td>
              <Td className="text-zinc-600 dark:text-zinc-400">{p.note}</Td>
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
