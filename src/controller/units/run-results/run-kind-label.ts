// A run kind's plain label for owner text (issue #810): comments and notices name a run "the Merge check run", never
// by its stored kind. Stored codes (`run_failed:<kind>:<code>`, `run_kind` keys) keep the raw kind. The words are the
// dashboard's (web/src/i18n/en). A record over every RunKind, so a new kind without a label fails the typecheck.
// Reached through run-results.unit.ts: the other units get it from `c.unit("run-results").kindLabel`.

import type { RunKind } from "./run-results.unit.js";

const RUN_KIND_LABELS: Record<RunKind, string> = {
  triage: "Triage",
  implement: "Implement",
  review: "Review",
  update: "Update",
  resolve: "Resolve",
  manual: "Manual",
  interactive: "Interactive task",
  improve: "Improve",
  "merge-check": "Merge check",
  restart: "Restart",
  screenshot: "Screenshot",
  judge: "Judge",
  routine: "Routine",
};

/** The plain label of a run kind, as the owner reads it ("Merge check" for `merge-check`). */
export const runKindLabel = (kind: RunKind): string => RUN_KIND_LABELS[kind];
