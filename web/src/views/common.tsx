import type { ItemRow as Item } from "../api.js";
import { showsMerge } from "../api.js";
import { groupOf } from "../../../src/shared/states.js";

export * from "./display.js";
export * from "./who.js";
export * from "./item-links.js";
export * from "./why-text.js";
export * from "./run-kind.js";
export * from "./item-tables.js";

/** The items list keyed by item ID. */
export const byId = (items: readonly Item[] | undefined): Map<string, Item> => new Map((items ?? []).map((i) => [i.id, i]));

/** What a Needs-you row asks of the owner: merge a PR, approve a spec, or answer or fix (everything else). */
export type NeedGroup = "merge" | "approve" | "answer";

/**
 * The items that wait on the owner, one Needs-you row each (src/ui/needs-you.ts): the state table's Needs-you group.
 * A triage run's ask (Waiting), a failed run and a stuck item (Problem) are no row; an item started past a deadlock is
 * Blocked by another task and goes on by itself.
 */
export const needsYou = (items: readonly Item[]): Item[] => items.filter((i) => groupOf(i.item_phase) === "needs");

export function needGroup(it: Item): NeedGroup {
  if (showsMerge(it.merge) || it.item_phase === "ready_to_merge") return "merge";
  return it.item_phase === "needs_approval" || it.commands?.some((c) => c.name === "approve" && c.allowed) ? "approve" : "answer";
}
