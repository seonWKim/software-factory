// Owner notices in the shell (docs/design/09-notifications.md): on each status tick that reached the dashboard, read
// GET /api/v1/notices and show each pending notice once. The notices the shell has shown are kept in a file in its
// app data folder, so a restart shows none of them again; the store's delivered_at stays unset. Every effect (fetch,
// fs, notify) comes in as an argument. A notice's text is its kind and count only: the API carries no free text.

import { PRODUCT_NAME } from "./product.js";

/** The pending notices route. */
export const noticesUrl = (port) => `http://127.0.0.1:${port}/api/v1/notices`;

/** Every notice's title: the app's name. */
export const NOTICE_TITLE = PRODUCT_NAME;

/** One item's notice body by kind; a kind not listed reads as `other`. */
const BODY = {
  spec: "A spec waits for your approval",
  merge: "A change waits for your merge",
  failure: "A failed item needs you",
  other: "An item needs you",
};

/** A notice as the route lists it: a summary (quiet hours) has a null work_item_id. */
const isNotice = (n) =>
  (n?.work_item_id === null || typeof n?.work_item_id === "string") && typeof n?.wait_key === "string" && typeof n?.kind === "string" && Number.isInteger(n?.count);

/** The notice's title and body: its kind and its count, nothing else. */
export function noticeText(n) {
  if (n.work_item_id === null) {
    return { title: NOTICE_TITLE, body: `${n.count} ${n.count === 1 ? "item" : "items"} waited for you during quiet hours` };
  }
  return { title: NOTICE_TITLE, body: BODY[n.kind] ?? BODY.other };
}

/** Where a click on the notice goes: a summary opens the dashboard root, an item notice its item page. */
export const noticeTarget = (n, dashboard) => (n.work_item_id === null ? dashboard : `${dashboard}items/${encodeURIComponent(n.work_item_id)}`);

const keyOf = (n) => JSON.stringify([n.work_item_id, n.wait_key]);

/** The keys in the shown-notices file; none when it is missing or unreadable. */
function readShown(fs, file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(Array.isArray(v?.shown) ? v.shown.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Returns `poll()`: reads the pending notices once and calls `notify(title, body, target)` for each one not shown
 * before. The file keeps only the shown notices still pending, so it never outgrows the route's list. A failed read
 * changes nothing; a failed write still shows each notice once while the shell runs.
 */
export function noticePoller({ fetch, url, dashboard, fs, file, notify }) {
  let shown = null;
  let busy = false;
  return async function poll() {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const body = await res.json();
      if (!Array.isArray(body?.notices)) return;
      shown ??= readShown(fs, file);
      const pending = body.notices.filter(isNotice);
      const fresh = pending.filter((n) => !shown.has(keyOf(n)));
      const keep = new Set(pending.map(keyOf).filter((k) => shown.has(k)).concat(fresh.map(keyOf)));
      if (fresh.length > 0 || keep.size !== shown.size) {
        shown = keep;
        try {
          fs.writeFileSync(file, `${JSON.stringify({ shown: [...keep] })}\n`);
        } catch {
          // The app data folder is not writable: remembered in memory until the shell restarts.
        }
      }
      for (const n of fresh) {
        const { title, body: text } = noticeText(n);
        notify(title, text, noticeTarget(n, dashboard));
      }
    } catch {
      // The dashboard does not answer: the next tick reads again.
    } finally {
      busy = false;
    }
  };
}
