// The light/dark choice lives in this browser only (design §9). Storage can throw (private mode, blocked site
// data), so every access is guarded and the page still works without it.

export type Theme = "light" | "dark";

export const THEME_KEY = "sf-theme";

/** The stored choice, else the system preference. */
export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // no storage: fall through
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("dark", t === "dark");
}

export function saveTheme(t: Theme): void {
  applyTheme(t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // no storage: the choice lasts for this page only
  }
}
