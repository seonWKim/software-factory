// Project labels in the store (design 2026-11-01): one cursor row per project key, `project_label:<key>` →
// `github.com/owner/name`. Written at startup from what the forge says now, read by the status page, so a page
// load never calls the forge. Every write is a conditional set, so two replicas starting at once are safe.

import type { FactoryStore } from "../interfaces/factory-store.js";
import { type ProjectRef, UNKNOWN_PROJECT_LABEL, isProjectKey, projectLabelCursor } from "./project.js";

const SAVE_ATTEMPTS = 5;

/**
 * Stores `ref.label` as the label of `ref.key`, replacing an older one (a rename). A no-op when it is already
 * stored. Returns true when this call changed it.
 */
export async function saveProjectLabel(store: Pick<FactoryStore, "getCursor" | "advanceCursor">, ref: ProjectRef): Promise<boolean> {
  const name = projectLabelCursor(ref.key);
  for (let i = 0; i < SAVE_ATTEMPTS; i++) {
    const current = await store.getCursor(name);
    if (current === ref.label) return false;
    if (await store.advanceCursor(name, current, ref.label)) return true;
  }
  throw new Error(`could not store the label of project ${ref.label}: it kept changing under this write`);
}

/** The stored label of a project key. What to show when there is none: never the key itself. */
export async function readProjectLabel(store: Pick<FactoryStore, "getCursor">, key: string): Promise<string> {
  if (!isProjectKey(key)) return UNKNOWN_PROJECT_LABEL;
  return (await store.getCursor(projectLabelCursor(key))) ?? UNKNOWN_PROJECT_LABEL;
}
