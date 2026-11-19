import { useQueryClient } from "@tanstack/react-query";
import { createContext, useState } from "react";
import { API, type ProjectChoice, type TaskAction, type TaskRow, postProject, postTaskAction } from "../../api.js";

export const muted = "text-xs text-pretty text-text-2";

/**
 * What every row needs: the CSRF token for its actions (null with no commands actor), each open task's title by ID,
 * and `completed`, which keeps a task the row completed for ⌘Z.
 */
export const Rows = createContext<{ token: string | null; titles: ReadonlyMap<string, string>; projects: readonly ProjectChoice[]; completed: (task: TaskRow) => void }>({
  token: null, titles: new Map(), projects: [], completed: () => {},
});

export const ALERT = "text-xs text-pretty break-words text-pill-bad-fg";

/** A new ID: the prefix (`tk_` for a task, `pj_` for a project) and 32 hex characters, inside the routes' 8 to 64 URL-safe ones. */
export const newId = (prefix: "tk_" | "pj_"): string => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;

/** The ID for these words: the one kept for them since the last success, so a retry after an error stores one task (or project). */
export function idFor(attempt: { current: { id: string; words: string } | null }, words: string, prefix: "tk_" | "pj_" = "tk_"): string {
  if (attempt.current?.words !== words) attempt.current = { id: newId(prefix), words };
  return attempt.current.id;
}

/** Creates the project under the ID kept for these words (a retry stores one project); the kept ID goes on success. A refusal comes back as `{ ok: false, error }`. */
export async function createProject(token: string, attempt: { current: { id: string; words: string } | null }, words: string) {
  const r = await postProject(token, idFor(attempt, words, "pj_"), words);
  if (r.ok) attempt.current = null;
  return r;
}

/** One row action at a time: its POST, the error it answered, and a reload of the tasks on success. */
export function useTaskAction(token: string | null) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: TaskAction, body: Record<string, string>): Promise<boolean> => {
    if (token === null || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const r = await postTaskAction(token, action, body);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      await client.invalidateQueries({ queryKey: [API.tasks] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
