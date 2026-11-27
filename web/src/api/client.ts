// The shared fetch, polling and CSRF code. Every write sends the per-process CSRF token (from the resource's own read)
// in x-csrf-token. A write refused for a stale token (code "stale_csrf", after a UI restart) is retried once with
// GET /api/v1/session's token (postJson).

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "./overview.js";
import { API } from "./routes.js";

/** Polling interval while the document is visible; TanStack Query stops it while the tab is hidden. */
export const POLL_MS = 3000;

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The app's QueryClient, kept by useApi so postJson can put a fresh token in the cached session query. */
let appClient: QueryClient | null = null;

/** One API read, polled every POLL_MS while the document is visible. */
export function useApi<T>(url: string, pollMs: number | false = POLL_MS) {
  appClient = useQueryClient();
  return useQuery({
    queryKey: [url],
    queryFn: () => getJson<T>(url),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}

/** The code of the server's 403 for a missing or stale x-csrf-token (src/ui/commands.ts STALE_CSRF). */
const STALE_CSRF = "stale_csrf";

/**
 * A JSON POST with the CSRF token: the status and the parsed body ({} when the body is not JSON). A 403 with code
 * "stale_csrf" (the UI process restarted since the page read its token; refused before any store write) fetches GET
 * /api/v1/session once, puts its token in the cached session query and retries the same write once with it; the
 * retry's result is returned, whatever it is. `signal` aborts the write: fetch then rejects with an AbortError. Any other answer, or a session read that fails, is returned as is.
 */
export async function postJson<T extends { error?: string }>(url: string, token: string, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; value: T }> {
  const first = await postOnce<T>(url, token, body, signal);
  if (first.status !== 403 || (first.value as { code?: unknown }).code !== STALE_CSRF) return first;
  let fresh: Session;
  try {
    fresh = await getJson<Session>(API.session);
  } catch {
    return first;
  }
  appClient?.setQueryData([API.session], fresh);
  return postOnce<T>(url, fresh.csrf_token, body, signal);
}

async function postOnce<T>(url: string, token: string, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; value: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  let value = {} as T;
  try {
    value = (await res.json()) as T;
  } catch {
    // An error without a JSON body: the caller says the status.
  }
  return { ok: res.ok, status: res.status, value };
}

/**
 * One API read that never refetches on its own: no interval, no refetch on focus, mount or reconnect. Only the
 * Refresh button (which invalidates every query) reads it again. For the Data page, whose reads are heavier.
 */
export function useManualApi<T>(url: string | null) {
  return useQuery({
    queryKey: [url],
    queryFn: () => getJson<T>(url!),
    enabled: url !== null,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
}
