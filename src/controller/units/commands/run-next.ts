// Run next (design 05-coordination, 2026-11-22): the item page's Run next button and `factory run-next <id>` store the
// same app request (command `run-next`). The controller checks the owner (approve_spec), moves the item's queued runs
// first in claim order (FactoryStore.runNext) and posts where its run now stands, once per request. It starts nothing:
// a run held by a busy item, a dependency, a coordination hold, paused claims or a rate limit stays queued, and the
// item's why line says why. No item field changes. Not offered in chat (the command table's `no_chat`).

import type { Ctx } from "../context.js";

type Item = NonNullable<Awaited<ReturnType<Ctx["k"]["reader"]["getWorkItem"]>>>;
type UserId = Parameters<Ctx["k"]["d"]["store"]["recordAppCommandRequest"]>[0]["actor"];

/** The app request's command and the CLI word. */
export const RUN_NEXT_COMMAND = "run-next";
/** Why a Run next changed nothing. */
export const NO_QUEUED_RUN = "the item has no queued run, so nothing changed";
/** Queued runs read to find the moved run's position: it is first, so the first page is enough. */
const POSITION_READ = 50;

/** The thread reply of an applied Run next: the run's kind and its queue position now. */
export function runNextReply(kind: string, position: number): string {
  return [
    `Run next: the queued ${kind} run is now at queue position ${position}.`,
    "It starts when a worker slot is free. A busy item, a dependency, a coordination hold, paused claims or a rate limit still keep it queued; then the item's status says why.",
  ].join(" ");
}

/** Applies a Run next app request; the refusal (the owner check's, or NO_QUEUED_RUN), or null once it is applied and answered. */
export async function runNext(c: Ctx, item: Item, user_id: UserId, key: string): Promise<string | null> {
  const principal = await c.unit("auth").allowed({ user_id }, "approve_spec", item.id);
  if ("refuse" in principal) return principal.refuse;
  const moved = await c.k.d.store.runNext(item.id);
  if (moved.length === 0) return NO_QUEUED_RUN;
  const position = (await c.k.d.store.listQueuedInClaimOrder(POSITION_READ)).findIndex((r) => r.work_item_id === item.id) + 1;
  await c.unit("outbox").post(item, item.source, runNextReply(moved[0]!.kind, position), `<!-- factory:run-next:${key} -->`);
  return null;
}
