// @vitest-environment jsdom
// Dashboard shell tests: app shell, sidebar, icon-only sidebar and top bar. Shared setup is in ui-shell-fixtures.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_MS } from "../web/src/api.js";
import { THEME_KEY, paintChoice, storedChoice } from "../web/src/theme.js";
import { BANNER_LINK_CLASS } from "../web/src/components/ui/link-style.js";
import { RevisionBanner, UnpushedMerges } from "../web/src/views/system-banner.js";
import { AT, overview, row, RESPONSES, state, installShellFixtures, waitBadge, mount } from "./ui-shell-fixtures.js";

installShellFixtures();

describe("app shell", () => {
  it("shows the sidebar pages, Needs you (N) from /api/v1/overview, and fetches only /api/v1/* URLs", async () => {
    mount();
    await waitBadge();
    // No Needs you entry and no Factory group: Chat leads the first block, then Tasks with the waiting count as its badge.
    expect(screen.queryByRole("navigation", { name: "Factory" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Needs you" })).toBeNull();
    const tasks = screen.getByRole("navigation", { name: "Tasks" });
    expect([...tasks.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Chat", "Tasks4", "Calendar", "Schedules"]);
    const nav = screen.getByRole("navigation", { name: "System" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Work", "Health", "Workers"]);
    fireEvent.click(within(nav).getByText("Health"));
    expect(await screen.findByRole("heading", { level: 1, name: "Health" })).toBeTruthy();
    expect(location.pathname).toBe("/app/health");
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
    expect([ember.getAttribute("cx"), ember.getAttribute("cy")]).toEqual(["691.6", "332.4"]);
    expect(Number(ember.getAttribute("r"))).toBeCloseTo((2 * 1024) / 24, 1);
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
  const SETTINGS = { as_of: AT, csrf_token: "c", repo: "o/r", project: null, project_keys: [], keys: [], pr_only: [], ignored: [], history: [] };
  /** Mounts the app on Settings > General, whose Appearance card holds the theme (moved off the top bar, issue #79). */
  async function mountAppearance() {
    (RESPONSES as Record<string, unknown>)["/api/v1/settings"] = SETTINGS;
    history.replaceState(null, "", "/app/settings");
    mount();
    return screen.findByRole("radiogroup", { name: "Theme" });
  }
  // The SegmentedControl is a radiogroup: the chosen theme is its aria-checked radio.
  const choose = (name: string) => fireEvent.click(within(screen.getByRole("radiogroup", { name: "Theme" })).getByRole("radio", { name }));
  const pressed = () => within(screen.getByRole("radiogroup", { name: "Theme" })).getAllByRole("radio").filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.textContent);
  afterEach(() => void delete (RESPONSES as Record<string, unknown>)["/api/v1/settings"]);

  it("the top bar has no Theme control; Settings > General's Appearance offers System, Light and Dark, System pressed by default", async () => {
    mount();
    await waitBadge();
    expect(within(document.querySelector("header")!).queryByRole("button", { name: "Theme" })).toBeNull();
    cleanup();
    const group = await mountAppearance();
    expect(within(group).getAllByRole("radio").map((b) => b.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(pressed()).toEqual(["System"]);
    choose("Light");
    expect(pressed()).toEqual(["Light"]);
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
    await mountAppearance();
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
    await mountAppearance();
    expect(isDark()).toBe(false);
    expect(pressed()).toEqual(["Light"]);
  });

  it("the banner link takes the banner's own text token and is used by the revision banner", () => {
    expect(BANNER_LINK_CLASS).toMatch(/(?<![\w-])text-current(?![\w-])/);
    render(<RevisionBanner server="a" web="b" />);
    expect(screen.getByText("reload").className).toBe(BANNER_LINK_CLASS);
    expect(screen.getByTestId("revision-banner").className).toMatch(/(?<![\w-])text-pill-warn-fg(?![\w-])/);
  });

  it("the unpushed-merges line shows its count with the warn tokens, and nothing at 0", () => {
    const { rerender } = render(<UnpushedMerges count={3} />);
    const el = screen.getByTestId("unpushed-merges");
    expect(el.textContent).toBe("3 local merges not pushed");
    expect(el.className).toMatch(/(?<![\w-])text-pill-warn-fg(?![\w-])/);
    expect(el.className).toMatch(/(?<![\w-])bg-pill-warn-bg(?![\w-])/);
    rerender(<UnpushedMerges count={1} />);
    expect(screen.getByTestId("unpushed-merges").textContent).toBe("1 local merges not pushed");
    rerender(<UnpushedMerges count={0} />);
    expect(screen.queryByTestId("unpushed-merges")).toBeNull();
    rerender(<UnpushedMerges count={undefined} />);
    expect(screen.queryByTestId("unpushed-merges")).toBeNull();
  });

  it("keeps the stored choice ahead of the system preference", async () => {
    stubScheme(true);
    localStorage.setItem(THEME_KEY, "light");
    expect(storedChoice()).toBe("light");
    paintChoice(storedChoice()); // what web/src/main.tsx does at startup
    await mountAppearance();
    expect(pressed()).toEqual(["Light"]);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    cleanup();
    stubScheme(false);
    localStorage.setItem(THEME_KEY, "dark");
    expect(storedChoice()).toBe("dark");
    paintChoice(storedChoice());
    await mountAppearance();
    expect(pressed()).toEqual(["Dark"]);
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
    expect(links("Tasks")).toEqual(["Chat", "Tasks", "Calendar", "Schedules"]);
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
    expect(open.className.split(" ")).toEqual(expect.arrayContaining(["bg-sidebar-active", "font-medium"]));
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
  it("stays on one row and keeps the Search button at full size", async () => {
    mount();
    await waitBadge();
    const header = document.querySelector("header")!;
    // One row at 390px (issue #763): a wrapping header dropped Theme onto a second row.
    expect(header.className.split(" ")).not.toContain("flex-wrap");
    expect(within(header).getByRole("button", { name: "Search" }).closest(".shrink-0")).toBeTruthy();
  });

  it("holds only the mode, Stop all agents, Search and More (Refresh, the Appearance choices): no revision or Theme button (issue #79)", async () => {
    await atWidth(1024, async (header) => {
      expect(within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Stop all agents", "Search", "More"]);
      fireEvent.click(within(header).getByRole("button", { name: "More" }));
      const menu = within(header).getByRole("menu");
      expect(within(menu).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("aria-keyshortcuts")])).toEqual([["Refresh", "r"]]);
      // Appearance is a group of the three theme choices, the current one checked; picking one applies it in place.
      expect(menu.textContent).toContain("Appearance");
      expect(within(menu).getAllByRole("menuitemradio").map((m) => [m.textContent, m.getAttribute("aria-checked")])).toEqual([["System", "true"], ["Light", "false"], ["Dark", "false"]]);
      const path = location.pathname;
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Dark" }));
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(location.pathname).toBe(path);
      fireEvent.click(within(header).getByRole("button", { name: "More" }));
      expect(within(header).getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
      fireEvent.click(within(header).getByRole("menuitemradio", { name: "System" }));
      expect(within(header).queryByTestId("factory-rev")).toBeNull();
      expect(header.textContent).not.toContain("Factory version");
    });
  });

  /** Mounts the app at `px` wide with the pause routes on, so Stop all agents shows; restores both after `body`. */
  async function atWidth(px: number, body: (header: HTMLElement) => Promise<void>) {
    const wide = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
    RESPONSES["/api/v1/pauses"] = { pauses: [], csrf_token: "tok" };
    try {
      mount();
      await waitBadge();
      const header = document.querySelector("header")!;
      await within(header).findByRole("button", { name: "Stop all agents" });
      await body(header);
    } finally {
      delete RESPONSES["/api/v1/pauses"];
      Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
    }
  }

  it("below sm: Stop all agents is icon-only and Search stays its own button beside More", async () => {
    await atWidth(390, async (header) => {
      const stop = within(header).getByRole("button", { name: "Stop all agents" });
      expect(stop.getAttribute("aria-label")).toBe("Stop all agents");
      expect(stop.textContent).toBe("");
      expect(stop.querySelector("svg")).toBeTruthy();
      expect(within(header).getByRole("button", { name: "More" })).toBeTruthy();
      fireEvent.click(within(header).getByRole("button", { name: "Search" }));
      expect(await screen.findByRole("dialog")).toBeTruthy();
    });
  });

  it("at sm and wider: Stop all agents shows its text beside Search", async () => {
    await atWidth(1024, async (header) => {
      const stop = within(header).getByRole("button", { name: "Stop all agents" });
      expect(stop.textContent).toBe("Stop all agents");
      expect(stop.hasAttribute("aria-label")).toBe(false);
      expect(within(header).getByRole("button", { name: "Search" })).toBeTruthy();
    });
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

  it("the mode chip tooltip says what auto does, on hover and on focus, and keeps an auto stop's reason above it", async () => {
    const AUTO = "Auto approves plans below risk level 4 and merges reviewed local changes up to the auto-merge risk level. Risk level: high (4) and the gate list (changes to protected areas) wait for a person.";
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

  it("the top bar shows the mode as a chip, not a switch: Auto with the merge tier or Manual, a link to Settings' Mode section that writes nothing", async () => {
    const key = (k: string, value: string) => ({ key: k, description: "", kind: k === "mode" ? "mode" : "number", value, source: "default", file_value: null, default_value: value, applies_at: "", project_settable: false, projects: [] });
    const view = (mode: string) => ({ as_of: AT, csrf_token: "c", repo: "o/r", project: null, project_keys: [], keys: [key("mode", JSON.stringify(mode)), key("auto_merge_max_tier", "2")], pr_only: [], ignored: [], history: [] });
    try {
      (RESPONSES as Record<string, unknown>)["/api/v1/settings"] = view("auto");
      mount();
      const chip = await screen.findByTestId("mode");
      expect(chip.textContent).toBe("Auto · merges ≤ risk level 2");
      expect(chip.getAttribute("href")).toBe("/app/settings#mode");
      expect(within(document.querySelector("header")!).queryByRole("switch")).toBeNull();
      fireEvent.click(chip);
      expect(location.pathname + location.hash).toBe("/app/settings#mode");
      expect(state.posts).toEqual([]);
      cleanup();
      (RESPONSES as Record<string, unknown>)["/api/v1/settings"] = view("manual");
      mount();
      expect((await screen.findByTestId("mode")).textContent).toBe("Manual");
    } finally {
      delete (RESPONSES as Record<string, unknown>)["/api/v1/settings"];
    }
  });
});

