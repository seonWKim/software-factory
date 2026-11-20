import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { API, type TaskPreview, getTaskPreview, postTaskAdd } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { t } from "../../i18n/index.js";
import { QUICK_ADD_ATTR, QUICK_ADD_KEYS, type QuickAddKey, isQuickAddSubmit } from "../../keys.js";
import { ALERT, idFor, muted } from "./shared.js";

/** How long the field waits after the last keystroke before it asks for the preview. */
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The preview of the words, `PREVIEW_DEBOUNCE_MS` after the owner stops typing: GET /api/v1/tasks/preview, the
 * server's own parser, so the preview cannot differ from what Add stores. Null for an empty field, or when the
 * read failed (the preview then stays hidden; Add still answers with the server's reason).
 */
function usePreview(words: string): TaskPreview | null {
  const [preview, setPreview] = useState<{ words: string; value: TaskPreview } | null>(null);
  useEffect(() => {
    if (words === "") return;
    let live = true;
    const timer = setTimeout(() => {
      getTaskPreview(words).then(
        (value) => live && setPreview({ words, value }),
        () => live && setPreview(null),
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [words]);
  // An answer for older words is not shown for the new ones.
  return words !== "" && preview?.words === words ? preview.value : null;
}

/**
 * The line under the field: date, time, repeat, project and priority as the parser read them ("none" when not given),
 * then the words it did not understand, which stay in the title; or its reason for refusing the words. A project tab's
 * project stands in when no `+slug` is typed, as the add does.
 */
function Preview({ preview, project }: { preview: TaskPreview; project: string | null }) {
  if (!preview.ok) return <p className={muted}>{t("tasks.previewRefused", { reason: preview.reason })}</p>;
  const none = t("tasks.previewNone");
  const projects = preview.projects.length > 0 ? preview.projects : project === null ? [] : [project];
  const fields = [
    t("tasks.previewDate", { value: preview.due_date ?? none }),
    t("tasks.previewTime", { value: preview.due_time ?? none }),
    t("tasks.previewRepeat", { value: preview.recurrence === null ? none : t("tasks.every", { recurrence: preview.recurrence }) }),
    t("tasks.previewProject", { value: projects.length === 0 ? none : projects.map((p) => `+${p}`).join(" ") }),
    t("tasks.previewPriority", { value: preview.priority === null ? none : `!${preview.priority}` }),
  ];
  return (
    <>
      <p className={`${muted} flex flex-wrap gap-x-3 gap-y-1`}>
        {fields.map((f) => (
          <span key={f} className="tabular-nums break-all">
            {f}
          </span>
        ))}
      </p>
      {preview.unread.length > 0 && (
        <p className="text-xs text-pretty break-words text-pill-warn-fg">{t("tasks.previewUnread", { words: preview.unread.join(", ") })}</p>
      )}
    </>
  );
}

/**
 * Quick add: the submit key (`addKey`, the owner's `tasks_add_key` setting: Enter, or ⌘Enter with plain Enter adding
 * nothing) or Add posts the words under an ID the page chose. The field keeps that ID, for those words, until the add
 * succeeds, so a retry after an error stores one task. On a project tab the tab's slug goes with the words (a `+slug` in them replaces it). Esc clears the field. The placeholder names the submit key.
 * Under the field, a live preview of what the words set (usePreview) shows before the owner submits.
 */
export function QuickAdd({ token, addKey, project }: { token: string | null; addKey: QuickAddKey; project: string | null }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ id: string; words: string } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = usePreview(text.trim());
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const words = text.trim();
    if (token === null || busy || words === "") return;
    const id = idFor(attempt, words);
    setBusy(true);
    setError(null);
    try {
      const r = await postTaskAdd(token, id, words, project);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      attempt.current = null;
      setText("");
      await client.invalidateQueries({ queryKey: [API.tasks] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-1">
      <div className="flex gap-2">
        <Input
          ref={input}
          {...{ [QUICK_ADD_ATTR]: "" }}
          className="flex-1"
          aria-label={t("tasks.addLabel")}
          placeholder={t("tasks.addPlaceholder", { key: QUICK_ADD_KEYS[addKey].label })}
          aria-keyshortcuts={QUICK_ADD_KEYS[addKey].aria}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText("");
              setError(null);
            } else if (e.key === "Enter") {
              // The form's own submit on Enter is replaced by the chosen key's.
              e.preventDefault();
              if (isQuickAddSubmit(e.nativeEvent, addKey)) void submit();
            }
          }}
        />
        <Button type="submit" disabled={token === null || busy}>
          {t("tasks.add")}
        </Button>
      </div>
      {preview !== null && (
        <div data-quick-add-preview="" aria-label={t("tasks.previewLabel")} aria-live="polite" role="status" className="space-y-1">
          <Preview preview={preview} project={project} />
        </div>
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * A one-line form in a row (edit, add sub-task): Enter or Save sends the words, Esc or Cancel closes it with no write.
 * `onSave` answers whether the words were stored; on a refusal the form stays open with the words.
 */
export function RowForm({ label, initial = "", placeholder, hint, busy, onSave, onClose }: {
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  busy: boolean;
  onSave: (words: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (await onSave(text.trim())) onClose();
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Input
          autoFocus
          className="min-w-0 flex-1"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <Button type="submit" disabled={busy}>
          {t("tasks.save")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
      {hint !== undefined && <p className={muted}>{hint}</p>}
    </form>
  );
}
