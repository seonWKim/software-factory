// The app reads only the read-only JSON API under /api/v1 (design §9); nothing else is fetched.

/** `/api/v1/overview`: the page's numbers. */
export interface Overview {
  as_of: string;
  stages: Record<string, number>;
  /** Open items blocked on a person: "Needs you (N)". */
  needs_you: number;
  running: number;
  queued: number;
  last_24h: { succeeded: number; failed: number; tokens: number };
}

export const API = { overview: "/api/v1/overview" } as const;

/** Polling interval while the document is visible; TanStack Query stops it while the tab is hidden. */
export const POLL_MS = 3000;

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
