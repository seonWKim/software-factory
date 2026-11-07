// Project labels and keys in the store (design 2026-11-01, 2026-11-07): one cursor row per project key,
// `project_label:<key>` → `<host>/owner/name`, and one per configured repo, `project_key:<owner>/<name>` →
// its key. Written once the forge resolved the repo, read by the status page and at startup, so neither a page
// load nor a start calls the forge. Every write is a conditional set, so two replicas starting at once are safe.

import type { FactoryStore } from "../interfaces/factory-store.js";
import { type ProjectRef, UNKNOWN_PROJECT_LABEL, isProjectKey, projectKeyCursor, projectLabelCursor } from "./project.js";

const SAVE_ATTEMPTS = 5;

type CursorStore = Pick<FactoryStore, "getCursor" | "advanceCursor">;

/** Sets cursor `name` to `value` unless it already holds it. Returns true when this call changed it. */
async function setCursor(store: CursorStore, name: string, value: string, what: string): Promise<boolean> {
  for (let i = 0; i < SAVE_ATTEMPTS; i++) {
    const current = await store.getCursor(name);
    if (current === value) return false;
    if (await store.advanceCursor(name, current, value)) return true;
  }
  throw new Error(`could not store ${what}: it kept changing under this write`);
}

/**
 * Stores `ref.label` as the label of `ref.key`, replacing an older one (a rename). A no-op when it is already
 * stored. Returns true when this call changed it.
 */
export function saveProjectLabel(store: CursorStore, ref: ProjectRef): Promise<boolean> {
  return setCursor(store, projectLabelCursor(ref.key), ref.label, `the label of project ${ref.label}`);
}

/** Stores the configured repo's key and label, as the forge resolved them. Returns true when the key changed. */
export async function saveProject(store: CursorStore, repo: { owner: string; name: string }, ref: ProjectRef): Promise<boolean> {
  await saveProjectLabel(store, ref);
  return setCursor(store, projectKeyCursor(repo), ref.key, `the project key of ${repo.owner}/${repo.name}`);
}

/** The configured repo's stored key, with its stored label; null when the forge never resolved it here. */
export async function readStoredProject(store: Pick<FactoryStore, "getCursor">, repo: { owner: string; name: string }): Promise<ProjectRef | null> {
  const key = await store.getCursor(projectKeyCursor(repo));
  if (key === null || !isProjectKey(key)) return null;
  return { key, label: await readProjectLabel(store, key) };
}

/** The stored label of a project key. What to show when there is none: never the key itself. */
export async function readProjectLabel(store: Pick<FactoryStore, "getCursor">, key: string): Promise<string> {
  if (!isProjectKey(key)) return UNKNOWN_PROJECT_LABEL;
  return (await store.getCursor(projectLabelCursor(key))) ?? UNKNOWN_PROJECT_LABEL;
}
