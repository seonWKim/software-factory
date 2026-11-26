// @vitest-environment jsdom
// Dashboard shell tests: system actions, revisions, the factory update note and the tab title. Shared setup is in ui-shell-fixtures.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { localDateTime } from "../web/src/lib/format.js";
import { POLL_MS } from "../web/src/api.js";
import { RevisionBanner, SEEN_REV_KEY } from "../web/src/views/system-banner.js";
import { TOAST_MS } from "../web/src/components/ui/toast.js";
import { AT, overview, RESPONSES, installShellFixtures, waitBadge, mount } from "./ui-shell-fixtures.js";

installShellFixtures();

describe("system actions, revisions and the tab title (issue #311)", () => {
  const BANNER = "Dashboard out of date: reload / restart factory ui";

  it("a revision mismatch shows the banner; equal or unknown revisions show none", () => {
    const { container, rerender } = render(<RevisionBanner server={"a".repeat(40)} web={"b".repeat(40)} />);
    expect(screen.getByTestId("revision-banner").textContent).toBe(BANNER);
    expect(screen.getByRole("alert").querySelector("code")!.textContent).toBe("factory ui");
    rerender(<RevisionBanner server={"a".repeat(40)} web={"a".repeat(40)} />);
    expect(container.textContent).toBe("");
    rerender(<RevisionBanner server={null} web={"a".repeat(40)} />);
    expect(container.textContent).toBe("");
    rerender(<RevisionBanner server={"a".repeat(40)} web={null} />);
    expect(container.textContent).toBe("");
  });

  it("the tab title leads with the Needs you count, and has no prefix at 0", async () => {
    mount();
    await waitBadge();
    await vi.waitFor(() => expect(document.title).toBe("(4) Tasks · Gongbang"));
    cleanup();
    const before = overview.needs_you;
    overview.needs_you = 0;
    try {
      mount();
      await vi.waitFor(() => expect(document.title).toBe("Tasks · Gongbang"));
    } finally {
      overview.needs_you = before;
    }
  });

  it("Health folds ok rows behind their count; warn and fail rows stay visible", async () => {
    const checks = [
      ...Array.from({ length: 22 }, (_, i) => ({ status: "ok", msg: `fine ${i}` })),
      { status: "warn", msg: "token expires in 2 days" },
      { status: "fail", msg: "push access denied" },
    ];
    const saved = RESPONSES["/api/v1/health"];
    RESPONSES["/api/v1/health"] = { checked_at: AT, checks };
    try {
      history.replaceState(null, "", "/app/health");
      mount();
      await screen.findByText("push access denied");
      const folded = screen.getByTestId("ok-checks") as HTMLDetailsElement;
      expect(folded.open).toBe(false);
      expect(folded.querySelector("summary")!.textContent).toBe("22 ok");
      expect(folded.querySelectorAll("li")).toHaveLength(22);
      for (const msg of ["token expires in 2 days", "push access denied"]) expect(folded.textContent).not.toContain(msg);
    } finally {
      RESPONSES["/api/v1/health"] = saved;
    }
  });

  it("Health shows a stall check's since and next probe as relative times with the local time on hover, never ISO", async () => {
    const since = "2026-11-19T16:11:54.203Z";
    const next = "2026-11-19T16:21:54.203Z";
    const saved = RESPONSES["/api/v1/health"];
    RESPONSES["/api/v1/health"] = { checked_at: AT, checks: [{ status: "fail", msg: "agents paused: model not answering", since, next }] };
    try {
      history.replaceState(null, "", "/app/health");
      mount();
      const row = (await screen.findByText(/agents paused: model not answering/)).closest("li")!;
      const times = [...row.querySelectorAll("time")];
      expect(times.map((t) => t.getAttribute("datetime"))).toEqual([since, next]);
      expect(times.map((t) => t.getAttribute("title"))).toEqual([localDateTime(since), localDateTime(next)]);
      expect(times[0]!.textContent).toMatch(/^started /);
      expect(times[1]!.textContent).toMatch(/^next probe /);
      expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|UTC/);
    } finally {
      RESPONSES["/api/v1/health"] = saved;
    }
  });
});


// ---- The factory update note and the header revision (design 09-dashboard-shell) ----

describe("factory update note and header revision", () => {
  const OLD = "c0147aa0000";
  const NEW = "3dc0029bbbb";
  const UPDATED = {
    ...overview.factory, state: "running", rev: NEW, previous_rev: OLD, behind: 0,
    changes: { count: 12, subjects: ["Tell the open tab when the factory updated", "Fix the header size"] },
  };
  /** Runs `body` with the overview's factory object set to `factory`, then puts the fixture's back. */
  async function withFactory(factory: unknown, body: () => Promise<void>) {
    const saved = overview.factory;
    (overview as Record<string, unknown>).factory = factory;
    try {
      await body();
    } finally {
      (overview as Record<string, unknown>).factory = saved;
    }
  }
  const poll = () => act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 10)));

  it("a first visit (no stored revision) shows no note and stores the running one", async () => {
    await withFactory(UPDATED, async () => {
      mount();
      await waitBadge();
      await vi.waitFor(() => expect(localStorage.getItem(SEEN_REV_KEY)).toBe(NEW));
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });

  it("a revision change seen while the tab is open shows one note with the count and the change list", async () => {
    await withFactory({ ...UPDATED, rev: OLD, previous_rev: null, changes: null }, async () => {
      mount();
      await waitBadge();
      await vi.waitFor(() => expect(localStorage.getItem(SEEN_REV_KEY)).toBe(OLD));
      expect(screen.queryByTestId("update-note")).toBeNull();
      (overview as Record<string, unknown>).factory = UPDATED;
      await poll();
      const note = await screen.findByTestId("update-note");
      expect(note.querySelector("[data-update-text]")!.textContent).toBe("Updated to 3dc0029: 12 changes");
      expect(screen.getAllByTestId("update-note")).toHaveLength(1);
      fireEvent.click(within(note).getByText("Changes"));
      const subjects = [...note.querySelectorAll("li")].map((li) => li.textContent);
      expect(subjects).toEqual(UPDATED.changes.subjects);
      await poll(); // a poll for the same revision keeps the one note
      expect(screen.getAllByTestId("update-note")).toHaveLength(1);
    });
  });

  it("the update toast goes by itself after 6 s and does not come back for that revision on a poll or a reload", async () => {
    localStorage.setItem(SEEN_REV_KEY, OLD); // a stored earlier revision: the toast shows on load
    await withFactory(UPDATED, async () => {
      mount();
      const note = await screen.findByTestId("update-note");
      expect(note.closest("[role=status]")!.className).toMatch(/\bfixed\b/);
      // Stored at once: a reload while it still shows does not show it twice.
      expect(localStorage.getItem(SEEN_REV_KEY)).toBe(NEW);
      await act(async () => void (await vi.advanceTimersByTimeAsync(TOAST_MS - 500)));
      expect(screen.getByTestId("update-note")).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      // Then the 200 ms fade.
      await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
      expect(screen.queryByTestId("update-note")).toBeNull();
      await poll();
      expect(screen.queryByTestId("update-note")).toBeNull();
      cleanup();
      mount();
      await waitBadge();
      await poll();
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });

  it("Dismiss closes the toast at once; hovering it keeps it past 6 s", async () => {
    localStorage.setItem(SEEN_REV_KEY, OLD);
    await withFactory(UPDATED, async () => {
      mount();
      const card = (await screen.findByTestId("update-note")).closest("[role=status]")!;
      fireEvent.mouseEnter(card);
      await act(async () => void (await vi.advanceTimersByTimeAsync(TOAST_MS * 2)));
      expect(screen.getByTestId("update-note")).toBeTruthy();
      fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });

  it("a git failure (no count) names the revision without a count and lists nothing", async () => {
    localStorage.setItem(SEEN_REV_KEY, OLD);
    await withFactory({ ...UPDATED, changes: { count: null, subjects: [] } }, async () => {
      mount();
      const note = await screen.findByTestId("update-note");
      expect(note.querySelector("[data-update-text]")!.textContent).toBe("Updated to 3dc0029");
      expect(within(note).queryByText("Changes")).toBeNull();
    });
  });

  it("the sidebar footer shows the running short revision and its state; only the revision without behind; nothing without a factory", async () => {
    await withFactory(UPDATED, async () => {
      mount();
      await vi.waitFor(() => expect(screen.getByTestId("factory-rev").textContent).toBe("3dc0029 · up to date"));
      // In the sidebar footer under "? Shortcuts", out of the top bar (issue #79).
      expect(screen.getByTestId("factory-rev").closest("aside")).toBeTruthy();
      expect(screen.getByTestId("factory-rev").closest("header")).toBeNull();
    });
    cleanup();
    await withFactory({ ...UPDATED, behind: 3 }, async () => {
      mount();
      await vi.waitFor(() => expect(screen.getByTestId("factory-rev").textContent).toBe("3dc0029 · 3 behind"));
    });
    cleanup();
    const { behind: _, ...selfHosting } = UPDATED;
    await withFactory(selfHosting, async () => {
      mount();
      await vi.waitFor(() => expect(screen.getByTestId("factory-rev").textContent).toBe("3dc0029"));
    });
    cleanup();
    await withFactory(null, async () => {
      mount();
      await waitBadge();
      expect(screen.queryByTestId("factory-rev")).toBeNull();
      expect(screen.queryByTestId("update-note")).toBeNull();
    });
  });
});
