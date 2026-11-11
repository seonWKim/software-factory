// Owner notices on the local API (design 09-notifications). GET /api/v1/notices lists the notices the owner has still
// to see, oldest first: each item's notice, and the summary that covers what quiet hours held (a held notice is shown
// only through it). Read-only: the shell marks a notice delivered in phase 2. IDs and kinds only, no free text.

import { SUMMARY_ITEM } from "../core/notifications.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { ApiDeps, ApiResult } from "./api.js";

export const NOTICES_PATH = "/api/v1/notices";

export async function readNotices(d: { store: Pick<FactoryStore, "listPendingNotices">; clock: ApiDeps["clock"] }): Promise<ApiResult> {
  const notices = (await d.store.listPendingNotices()).map((n) => ({
    work_item_id: n.work_item_id === SUMMARY_ITEM ? null : n.work_item_id, wait_key: n.wait_key, kind: n.kind, count: n.count, created_at: n.created_at,
  }));
  return { status: 200, value: { as_of: d.clock.now().toISOString(), notices } };
}
