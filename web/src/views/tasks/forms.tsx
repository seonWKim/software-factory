import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { API, postTaskAdd } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { t } from "../../i18n/index.js";
import { QUICK_ADD_ATTR, QUICK_ADD_KEYS, type QuickAddKey, isQuickAddSubmit } from "../../keys.js";
import { ALERT, idFor, muted } from "./shared.js";

/**
 * Quick add: the submit key (`addKey`, the owner's `tasks_add_key` setting: Enter, or ⌘Enter with plain Enter adding
 * nothing) or Add posts the words under an ID the page chose. The field keeps that ID, for those words, until the add
 * succeeds, so a retry after an error stores one task. On a project tab the tab's slug goes with the words (a `+slug` in them replaces it). Esc clears the field. The placeholder names the submit key.
 */
export function QuickAdd({ token, addKey, project }: { token: string | null; addKey: QuickAddKey; project: string | null }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ id: string; words: string } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
