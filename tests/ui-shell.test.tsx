// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { POLL_MS } from "../web/src/api.js";
import { THEME_KEY } from "../web/src/theme.js";

// The app shell (step 2 of #124, design §9): it fetches only /api/v1/*, polls every 3 s while the document is
// visible and not while it is hidden, and keeps the light/dark choice in browser storage.

const overview = { as_of: "2026-11-07T00:00:00.000Z", stages: {}, needs_you: 4, running: 1, queued: 2, last_24h: { succeeded: 0, failed: 0, tokens: 0 } };
let fetched: string[] = [];
let hidden = false;

/** Browser storage for the test: Node 25's own experimental localStorage would otherwise shadow jsdom's. */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  fetched = [];
  hidden = false;
  vi.stubGlobal("localStorage", new MemoryStorage());
  document.documentElement.classList.remove("dark");
  history.replaceState(null, "", "/app/");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(url);
    return new Response(JSON.stringify(overview), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("app shell", () => {
  it("shows the sidebar pages, Needs you (N) from /api/v1/overview, and fetches only /api/v1/* URLs", async () => {
    mount();
    expect(await screen.findByText("Needs you (4)")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Floor", "Work items", "Workers", "Queue", "Health", "Settings"]);
    fireEvent.click(screen.getByText("Queue"));
    expect(screen.getByText("The queue page comes in step 5 of #124.")).toBeTruthy();
    expect(location.pathname).toBe("/app/queue");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith("/api/v1/"))).toBe(true);
  });

  it("polls every 3 s while visible and stops while the document is hidden", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    const first = fetched.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 100)));
    expect(fetched.length).toBeGreaterThanOrEqual(first + 2);

    hidden = true;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    const whileHidden = fetched.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 5)));
    expect(fetched.length).toBe(whileHidden);

    hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 100)));
    expect(fetched.length).toBeGreaterThan(whileHidden);
  });

  it("the theme toggle switches light and dark and keeps the choice in browser storage", async () => {
    mount();
    await screen.findByText("Needs you (4)");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");

    cleanup();
    localStorage.setItem(THEME_KEY, "dark");
    mount();
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
  });
});
