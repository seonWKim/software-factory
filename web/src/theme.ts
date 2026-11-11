// The theme choice lives in this browser only (design §9): System (follow the system colour scheme, the default),
// Light or Dark. Storage can throw (private mode, blocked site data), so every access is guarded and the page
// still works without it. Only "light" or "dark" is ever stored; System is the absence of a stored value.

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "sf-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The stored choice; System when there is none, or when storage is unavailable. */
export function storedChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // no storage: fall through
  }
  return "system";
}

function setDark(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}

/** Show the choice on the page once, with no listener: main.tsx paints it before the first render to avoid a flash. */
export function paintChoice(choice: ThemeChoice): void {
  setDark(choice === "system" ? typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches : choice === "dark");
}

/**
 * Show the choice on the page. System follows the system colour scheme now and while the page is open; the returned
 * function removes that listener (call it before the next choice or on unmount). Light and Dark listen to nothing.
 */
export function applyChoice(choice: ThemeChoice): () => void {
  paintChoice(choice);
  if (choice !== "system" || typeof matchMedia !== "function") return () => {};
  const query = matchMedia(DARK_QUERY);
  const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Keep the choice for this browser: Light or Dark is stored, System removes the stored value. */
export function saveChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // no storage: the choice lasts for this page only
  }
}
