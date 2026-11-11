// The quick-add box: a frameless window with one text field and the parsed fields as chips, opened by the
// quick-add shortcut. Enter posts the words once (taskPoster, through this main process); Esc, or clicking
// elsewhere, closes it and posts nothing. The window is made hidden at start, so the shortcut only shows it.
import { fieldChips } from "../common/tasks-client.js";
import { panelPreferences, panelWindow, showFocused } from "./panel.js";

/** The channels between the box's page (panel-preload.cjs) and this module. */
export const BOX = { preview: "quick-add:preview", key: "quick-add:key", opened: "quick-add:opened" };

/** The box's window: frameless, above other windows, out of the Dock's window list. */
export const boxOptions = (preload) => ({
  width: 640,
  height: 120,
  frame: false,
  show: false,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  title: "Quick add",
  webPreferences: panelPreferences(preload),
});

/**
 * `post` sends `{ id, words }` (taskPoster); `parse` is the #606 quick-add parser for the chips, or null when it is
 * not available (no chips; the route still parses). `newId` makes a task ID: one per box session, kept across a
 * failed send so a resend stores one task, and new after a stored one.
 */
export function createQuickAdd({ BrowserWindow, ipcMain }, { pageUrl, preload, post, parse, newId }) {
  let win = null;
  let id = newId();
  let posting = false;

  const hide = () => {
    if (win !== null && !win.isDestroyed() && win.isVisible()) win.hide();
  };
  const ensure = () => {
    if (win !== null && !win.isDestroyed()) return win;
    win = panelWindow(BrowserWindow, boxOptions(preload), pageUrl);
    win.on("blur", hide);
    return win;
  };

  const preview = (words) => {
    if (parse === null || typeof words !== "string" || words.trim() === "") return { chips: [], problem: null };
    const r = parse(words);
    return r.ok ? { chips: fieldChips(r.task), problem: null } : { chips: [], problem: r.reason };
  };

  const press = async (key, words) => {
    if (key === "Escape") {
      hide();
      return { closed: true };
    }
    if (key !== "Enter") return { ignored: true };
    if (typeof words !== "string" || words.trim() === "") return { error: "Type a task first." };
    // A second Enter while the first is on its way sends nothing more.
    if (posting) return { pending: true };
    posting = true;
    try {
      const r = await post({ id, words });
      if (!r.ok) return { error: r.message };
      id = newId();
      hide();
      return { task: r.task };
    } finally {
      posting = false;
    }
  };

  // Only the box's own page may ask.
  const fromBox = (e) => win !== null && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle(BOX.preview, (e, words) => (fromBox(e) ? preview(words) : null));
  ipcMain.handle(BOX.key, (e, key, words) => (fromBox(e) ? press(key, words) : null));

  return {
    /** Makes the hidden window ahead of the first shortcut press. */
    prepare: () => void ensure(),
    /** Shows the box at once and puts the cursor in its text field, emptied. */
    open() {
      const w = ensure();
      showFocused(w);
      w.webContents.send(BOX.opened);
    },
  };
}
