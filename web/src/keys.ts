import { useEffect, useRef } from "react";
import { BASE } from "./pages.js";

// The app's keyboard shortcuts (design §9). One listener on the document. None fires while focus is in an input,
// textarea, select or contenteditable element, nor with Ctrl, Alt or Shift held (⌘K is the one chord).

/** One shortcut for the help list: the keys as typed, and the catalog key of what they do. */
export interface Shortcut {
  keys: string;
  what: "keys.search" | "keys.help" | "keys.goNeeds" | "keys.goWork" | "keys.goActivity" | "keys.next" | "keys.prev" | "keys.open" | "keys.primary" | "keys.addTask" | "keys.editTask" | "keys.deleteTask";
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: "⌘K", what: "keys.search" },
  { keys: "?", what: "keys.help" },
  { keys: "g n", what: "keys.goNeeds" },
  { keys: "g w", what: "keys.goWork" },
  { keys: "g a", what: "keys.goActivity" },
  { keys: "j", what: "keys.next" },
  { keys: "k", what: "keys.prev" },
  { keys: "Enter", what: "keys.open" },
  { keys: "p", what: "keys.primary" },
  { keys: "q", what: "keys.addTask" },
  { keys: "e", what: "keys.editTask" },
  { keys: "Delete", what: "keys.deleteTask" },
];

/**
 * After `g`, the page a key goes to. `g i`, `g t` and `g u` (Inbox, Today, Upcoming) have no view until the task
 * views exist, so they are not listed and do nothing;.
 */
export const GO_KEYS: Readonly<Record<string, string>> = { n: BASE, w: `${BASE}items`, a: `${BASE}activity` };

/** The Tasks page's quick-add field: `q` focuses it, so the key does nothing on a page without one. */
export const QUICK_ADD_ATTR = "data-quick-add";

/** How long `g` waits for its second key. */
const G_MS = 1000;

const ROWS = "main [data-key]";

/** True when the event's target is a place the user types in. */
export function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

/**
 * Marks the row `step` away from the selected one (the first when none is) and scrolls it into view. A focusable row
 * (a Tasks page row) also takes focus, so its own keys (`e` edits, Delete deletes) act on it.
 */
function moveSelection(step: 1 | -1): void {
  const rows = [...document.querySelectorAll<HTMLElement>(ROWS)];
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.dataset.selected === "true");
  const next = rows[at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step))]!;
  for (const r of rows) clearRow(r);
  next.dataset.selected = "true";
  next.style.outline = "2px solid currentColor";
  next.style.outlineOffset = "-2px";
  next.scrollIntoView?.({ block: "nearest" });
  if (next.tabIndex >= 0) next.focus({ preventScroll: true });
}

function clearRow(r: HTMLElement): void {
  delete r.dataset.selected;
  r.style.outline = "";
  r.style.outlineOffset = "";
}

/** Opens the selected row: a click on its first link, so it navigates as a click does. */
function openSelection(): boolean {
  const row = document.querySelector<HTMLElement>(`${ROWS}[data-selected="true"]`);
  const link = row?.querySelector<HTMLAnchorElement>("a[href]");
  if (!link) return false;
  link.click();
  return true;
}

/** Presses the selected row's primary action (a Needs-you row's button marked `data-shortcut="p"`; Merge has none). */
function pressPrimary(): boolean {
  const button = document.querySelector<HTMLButtonElement>(`${ROWS}[data-selected="true"] [data-shortcut="p"]`);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

/** Installs the shortcuts. `path` clears the row selection on a page change. */
export function useShortcuts({ navigate, openSearch, openHelp, path }: { navigate: (to: string) => void; openSearch: () => void; openHelp: () => void; path: string }): void {
  const g = useRef(0);
  const handlers = useRef({ navigate, openSearch, openHelp });
  handlers.current = { navigate, openSearch, openHelp };
  useEffect(() => {
    for (const r of document.querySelectorAll<HTMLElement>(ROWS)) clearRow(r);
  }, [path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inField(e.target)) return;
      const h = handlers.current;
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        h.openSearch();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const pending = g.current !== 0 && Date.now() - g.current < G_MS;
      g.current = 0;
      if (pending) {
        const to = GO_KEYS[e.key];
        if (to !== undefined) {
          e.preventDefault();
          h.navigate(to);
        }
        return;
      }
      if (e.key === "g") g.current = Date.now();
      else if (e.key === "?") h.openHelp();
      else if (e.key === "q") {
        const field = document.querySelector<HTMLElement>(`[${QUICK_ADD_ATTR}]`);
        if (field) {
          e.preventDefault();
          field.focus();
        }
      } else if (e.key === "p") pressPrimary();
      else if (e.key === "j") moveSelection(1);
      else if (e.key === "k") moveSelection(-1);
      else if (e.key === "Enter" && !(e.target as HTMLElement | null)?.closest?.("a, button") && openSelection()) e.preventDefault();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);
}
