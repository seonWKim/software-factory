import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import type { RunKind } from "../../../src/core/types.js";
import { StatusBadge } from "../components/ui/badge.js";

/** A run kind as people read it: an `interactive` run is an interactive task (a person handles the item in their own session). */
const RUN_KIND_LABEL: Record<RunKind, MessageKey> = {
  triage: "workers.kind.triage",
  implement: "workers.kind.implement",
  review: "workers.kind.review",
  resolve: "workers.kind.resolve",
  "merge-check": "workers.kind.mergeCheck",
  interactive: "run.interactive",
  update: "run.update",
  manual: "run.manual",
  improve: "run.improve",
  restart: "run.restart",
  screenshot: "run.screenshot",
  judge: "run.judge",
  routine: "run.routine",
};
/** A step's name from the catalog; a kind the API sends that is not a RunKind reads "Other", never its raw text. */
export const runKindLabel = (kind: string): string => {
  const key = Object.hasOwn(RUN_KIND_LABEL, kind) ? RUN_KIND_LABEL[kind as RunKind] : "workers.kind.other";
  return t(key);
};
/** A run's try, counted from 1: a queued run is stored as attempt 0 until it is claimed. */
export const tryOf = (attempt: number): number => Math.max(attempt, 1);

/** Whether a person is handling the item right now through this run: an interactive task that is running. */
export const isInteractiveRun = (run: { kind: string; status: string } | null | undefined): boolean => run?.kind === "interactive" && run.status === "running";

/** The badge an item shows while a person handles it as an interactive task. */
export function InteractiveBadge() {
  return <StatusBadge state="running">{t("run.interactive")}</StatusBadge>;
}

/** A run as a row names it: its kind and attempt, "Implement #2". */
export const runTitle = (run: { kind: string; attempt: number }): string => {
  return t("item.runTitle", { kind: runKindLabel(run.kind), attempt: tryOf(run.attempt) });
};
