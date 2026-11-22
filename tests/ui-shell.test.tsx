// @vitest-environment jsdom
// Dashboard shell tests: app shell, sidebar, icon-only sidebar and top bar. Shared setup is in ui-shell-fixtures.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { POLL_MS } from "../web/src/api.js";
import { THEME_KEY, paintChoice, storedChoice } from "../web/src/theme.js";
import { BANNER_LINK_CLASS } from "../web/src/components/ui/link-style.js";
import { RevisionBanner } from "../web/src/views/system-banner.js";
import { AT, overview, row, RESPONSES, state, installShellFixtures, waitBadge, mount } from "./ui-shell-fixtures.js";

installShellFixtures();

describe("app shell", () => {
  it("shows the sidebar pages, Needs you (N) from /api/v1/overview, and fetches only /api/v1/* URLs", async () => {
    mount();
    await waitBadge();
    // No Needs you entry and no Factory group: Tasks leads, with the waiting count as its badge.
    expect(screen.queryByRole("navigation", { name: "Factory" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Needs you" })).toBeNull();
    const tasks = screen.getByRole("navigation", { name: "Tasks" });
    expect([...tasks.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Tasks4", "Calendar"]);
    const nav = screen.getByRole("navigation", { name: "System" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Work", "Health", "Workers"]);
    fireEvent.click(within(nav).getByText("Health"));
    expect(await screen.findByRole("heading", { level: 1, name: "Health" })).toBeTruthy();
    expect(location.pathname).toBe("/app/health");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(state.fetched.length).toBeGreaterThan(0);
    expect(state.fetched.every((u) => u.startsWith("/api/v1/"))).toBe(true);
  });

  it("the sidebar top shows the mark and the wordmark Gongbang", async () => {
    mount();
    await waitBadge();
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const brand = sidebar.querySelector("p")!;
    expect(brand.textContent).toBe("Gongbang");
    const mark = within(brand).getByTestId("brand-mark");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("path")!.getAttribute("fill-rule")).toBe("evenodd");
    const ember = mark.querySelector("circle")!;
    expect(ember.getAttribute("class")).toBe("fill-ember");
    expect([ember.getAttribute("cx"), ember.getAttribute("cy")]).toEqual(["800", "224"]);
    expect(Number(ember.getAttribute("r"))).toBeCloseTo((2.5 * 1024) / 24, 1);
  });

  it("polls every 3 s while visible and stops while the document is hidden", async () => {
    mount();
    await waitBadge();
    const first = state.fetched.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 100)));
    expect(state.fetched.length).toBeGreaterThanOrEqual(first + 2);

    state.hidden = true;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    const whileHidden = state.fetched.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 5)));
    expect(state.fetched.length).toBe(whileHidden);

    state.hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 100)));
    expect(state.fetched.length).toBeGreaterThan(whileHidden);
  });

  /** A matchMedia whose dark state a test can flip; counts the live "change" listeners. */
  function stubScheme(dark: boolean) {
    let matches = dark;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() { return q.includes("dark") && matches; },
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => void listeners.add(l),
      removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => void listeners.delete(l),
    }));
    return {
      set(next: boolean) { matches = next; for (const l of [...listeners]) l({ matches: next }); },
      listeners: () => listeners.size,
    };
  }
  const isDark = () => document.documentElement.classList.contains("dark");
  const openMenu = () => fireEvent.click(within(document.querySelector("header")!).getByRole("button", { name: "Theme" }));
  const choose = (name: string) => {
    openMenu();
    fireEvent.click(within(screen.getByRole("menu", { name: "Theme" })).getByRole("menuitem", { name }));
  };
  const checked = () => screen.getAllByRole("menuitem").filter((i) => i.getAttribute("aria-checked") === "true").map((i) => i.textContent);

  it("offers one Theme button that opens System, Light and Dark, System checked by default", async () => {
    mount();
    await waitBadge();
    const header = document.querySelector("header")!;
    expect(within(header).getAllByRole("button", { name: "Theme" })).toHaveLength(1);
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(header).getByRole("button", { name: "Theme" }).getAttribute("aria-expanded")).toBe("false");
    openMenu();
    expect(within(header).getByRole("button", { name: "Theme" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(checked()).toEqual(["System"]);
  });

  it("the menu closes on choosing, on Escape and on a click outside", async () => {
    mount();
    await waitBadge();
    choose("Light");
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("with no saved choice, a dark system scheme renders dark", async () => {
    stubScheme(true);
    mount();
    await waitBadge();
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("System follows a change of the system scheme with no reload", async () => {
    const scheme = stubScheme(false);
    mount();
    await waitBadge();
    expect(isDark()).toBe(false);
    act(() => scheme.set(true));
    expect(isDark()).toBe(true);
    act(() => scheme.set(false));
    expect(isDark()).toBe(false);
  });

  it("Light or Dark overrides the system and removes the listener; System follows it again and clears the stored value", async () => {
    const scheme = stubScheme(false);
    mount();
    await waitBadge();
    expect(scheme.listeners()).toBe(1);
    choose("Dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(scheme.listeners()).toBe(0);
    act(() => scheme.set(false));
    expect(isDark()).toBe(true);
    choose("Light");
    act(() => scheme.set(true));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    choose("System");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(isDark()).toBe(true);
    expect(scheme.listeners()).toBe(1);
    act(() => scheme.set(false));
    expect(isDark()).toBe(false);
  });

  it("the pre-render paint shows the system scheme without leaving a listener", () => {
    const scheme = stubScheme(true);
    paintChoice("system");
    expect(isDark()).toBe(true);
    expect(scheme.listeners()).toBe(0);
    paintChoice("light");
    expect(isDark()).toBe(false);
  });

  it("a saved light or dark value applies on load, over the system", async () => {
    stubScheme(true);
    localStorage.setItem(THEME_KEY, "light");
    mount();
    await waitBadge();
    expect(isDark()).toBe(false);
    openMenu();
    expect(checked()).toEqual(["Light"]);
  });

  it("the banner link takes the banner's own text token and is used by the revision banner", () => {
    expect(BANNER_LINK_CLASS).toMatch(/(?<![\w-])text-current(?![\w-])/);
    render(<RevisionBanner server="a" web="b" />);
    expect(screen.getByText("reload").className).toBe(BANNER_LINK_CLASS);
    expect(screen.getByTestId("revision-banner").className).toMatch(/(?<![\w-])text-pill-warn-fg(?![\w-])/);
  });

  it("keeps the stored choice ahead of the system preference", () => {
    stubScheme(true);
    localStorage.setItem(THEME_KEY, "light");
    expect(storedChoice()).toBe("light");
    paintChoice(storedChoice()); // what web/src/main.tsx does at startup
    mount();
    openMenu();
    expect(checked()).toEqual(["Light"]);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    cleanup();
    stubScheme(false);
    localStorage.setItem(THEME_KEY, "dark");
    expect(storedChoice()).toBe("dark");
    paintChoice(storedChoice());
    mount();
    openMenu();
    expect(checked()).toEqual(["Dark"]);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("sidebar", () => {
  it("stays in view in a window-high shell where the content column scrolls, not sticky; on its own tint over the bg token", () => {
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    const own = side.className.split(" ");
    for (const c of ["overflow-y-auto", "bg-(--sidebar)"]) expect(own).toContain(c);
    // check:responsive fails a sticky or fixed element taller than 40% of the window (tall-fixed).
    expect(own).not.toContain("sticky");
    expect(own).not.toContain("fixed");
    const wrapper = side.parentElement!.className.split(" ");
    for (const c of ["h-dvh", "bg-bg"]) expect(wrapper).toContain(c);
    expect(wrapper).not.toContain("bg-surface");
    const content = side.parentElement!.querySelector("[data-scroll-root]")!;
    expect(content.className.split(" ")).toContain("overflow-y-auto");
  });

  it("the sidebar has no group heading; each nav is named by aria-label (its links are named by their text) and the blocks are split by dividers", () => {
    mount();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    expect(side.querySelectorAll("nav p, nav h1, nav h2, nav h3, nav h4, nav h5, nav h6")).toHaveLength(0);
    for (const name of ["Tasks", "System", "Setup"]) {
      const nav = screen.getByRole("navigation", { name });
      expect(nav.hasAttribute("aria-labelledby")).toBe(false);
      expect(nav.getAttribute("aria-label")).toBe(name);
    }
    const links = (name: string) => within(screen.getByRole("navigation", { name })).getAllByRole("link").map((a) => a.textContent);
    expect(links("Tasks")).toEqual(["Tasks", "Calendar"]);
    expect(links("System")).toEqual(["Work", "Health", "Workers"]);
    expect(links("Setup")).toEqual(["Rules", "Plugins", "Settings"]);
    expect(document.querySelector("aside details, aside summary, aside [data-chevron]")).toBeNull();
    expect(screen.getByRole("navigation", { name: "System" }).closest("div")!.className.split(" ")).toEqual(expect.arrayContaining(["mt-3", "border-t", "pt-3"]));
  });

  it("Settings is a row at the bottom of the sidebar, selected while open, and no longer a top-bar link", async () => {
    mount();
    await waitBadge();
    expect(within(document.querySelector("header")!).queryByRole("link", { name: "Settings" })).toBeNull();
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    const row = within(side).getByRole("link", { name: "Settings" });
    expect(row.getAttribute("href")).toBe("/app/settings");
    expect(row.hasAttribute("aria-current")).toBe(false);
    expect(screen.getByRole("navigation", { name: "System" }).compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "System" }).contains(row)).toBe(false);
    fireEvent.click(row);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const open = within(side).getByRole("link", { name: "Settings" });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.className.split(" ")).toEqual(expect.arrayContaining(["bg-surface-2", "font-medium"]));
  });
});


describe("sidebar in the icon-only layout", () => {
  it("each link has a title and an accessible name, though its label is hidden", async () => {
    const wide = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      mount();
      await waitBadge();
      for (const nav of [screen.getByRole("navigation", { name: "Tasks" }), screen.getByRole("navigation", { name: "System" })]) {
        const links = [...nav.querySelectorAll("a")];
        expect(links.length).toBeGreaterThan(0);
        for (const a of links) {
          const label = a.querySelector("span")!.textContent!;
          expect(a.getAttribute("title")).toBe(label);
          expect(within(nav).getByRole("link", { name: label === "Tasks" ? "Tasks, 4 need you" : label })).toBe(a);
        }
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
    }
  });
});

describe("top bar", () => {
  // jsdom has no layout, so this checks the classes that keep the bar inside a 390px screen (checked by screenshot).
  it("wraps and keeps the icon buttons at full size", async () => {
    mount();
    await waitBadge();
    const header = document.querySelector("header")!;
    expect(header.className.split(" ")).toContain("flex-wrap");
    expect(within(header).getByRole("button", { name: "Refresh" }).className.split(" ")).toContain("shrink-0");
  });

  it("has no Needs you chip and no age text; the sidebar Tasks badge keeps the count", async () => {
    mount();
    await waitBadge();
    const header = document.querySelector("header")!;
    expect(screen.queryByTestId("needs-you")).toBeNull();
    expect(header.textContent).not.toMatch(/Needs you \(/);
    expect(header.textContent).not.toMatch(/updated|ago/);
    expect(header.textContent).not.toContain("not updated yet");
    expect(screen.getByRole("link", { name: "Tasks, 4 need you" }).textContent).toBe("Tasks4");
    expect(document.querySelector("aside a[aria-label]")).toBeNull();
  });

  it("shows update failed when the overview request fails", async () => {
    const saved = RESPONSES["/api/v1/overview"];
    delete RESPONSES["/api/v1/overview"];
    try {
      mount();
      expect(await within(document.querySelector("header")!).findByText("update failed")).toBeTruthy();
    } finally {
      RESPONSES["/api/v1/overview"] = saved;
    }
  });

  it("the Refresh icon spins while a query is fetching and not otherwise", async () => {
    mount();
    await waitBadge();
    const icon = () => within(document.querySelector("header")!).getByRole("button", { name: "Refresh" }).querySelector("svg")!;
    await vi.waitFor(() => expect(icon().classList.contains("animate-spin")).toBe(false));
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    fireEvent.click(within(document.querySelector("header")!).getByRole("button", { name: "Refresh" }));
    await vi.waitFor(() => expect(icon().classList.contains("animate-spin")).toBe(true));
  });

  it("the mode switch tooltip says what auto does, on hover and on focus, and keeps an auto stop's reason above it", async () => {
    const AUTO = "Auto approves specs below tier 4 and merges reviewed local changes up to the auto-merge tier. Tier 4 and the gate list wait for a person.";
    const row = { key: "mode", description: "", kind: "mode", value: "manual", source: "default", file_value: null, default_value: "manual", applies_at: "", project_settable: false, projects: [] };
    const view = { as_of: AT, csrf_token: "c", repo: "o/r", project: null, project_keys: [], keys: [row], pr_only: [], ignored: [], history: [] };
    (RESPONSES as Record<string, unknown>)["/api/v1/settings"] = view;
    try {
      mount();
      const wrap = (await screen.findByTestId("mode")).parentElement!;
      fireEvent.mouseEnter(wrap);
      expect(screen.getByRole("tooltip").textContent).toBe(AUTO);
      fireEvent.mouseLeave(wrap);
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.focus(wrap);
      expect(screen.getByRole("tooltip")).toBeTruthy();
      cleanup();
      (RESPONSES as Record<string, unknown>)["/api/v1/settings"] = { ...view, auto_stop: { alert_id: "a", at: AT, cause: "red_main" } };
      mount();
      fireEvent.mouseEnter((await screen.findByTestId("mode")).parentElement!);
      const text = screen.getByRole("tooltip").textContent!;
      expect(text.startsWith("Back to manual at")).toBe(true);
      expect(text.endsWith(AUTO)).toBe(true);
    } finally {
      delete (RESPONSES as Record<string, unknown>)["/api/v1/settings"];
    }
  });
});

