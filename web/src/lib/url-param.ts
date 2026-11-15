import { useState } from "react";

/** The query parameter's value, or null when it is absent, empty, refused by `accept`, or there is no window (server rendering). */
function readParam(name: string, accept?: (value: string) => boolean): string | null {
  if (typeof location === "undefined") return null;
  const v = new URLSearchParams(location.search).get(name);
  return v && (!accept || accept(v)) ? v : null;
}

/**
 * A page choice kept in a query parameter (a tab, a project): read from the URL on load, written to it in place (no new
 * history entry) on change. `null` means no choice and removes the parameter. A value `accept` refuses reads as null.
 */
export function useUrlParam(name: string, accept?: (value: string) => boolean): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState(() => readParam(name, accept));
  const choose = (next: string | null) => {
    const url = new URL(location.href);
    if (next === null) url.searchParams.delete(name);
    else url.searchParams.set(name, next);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    setValue(next);
  };
  return [value, choose];
}
