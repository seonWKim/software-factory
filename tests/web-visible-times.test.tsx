// @vitest-environment jsdom
// Times in the viewer's local time (design 09-dashboard-shell): no dashboard page shows an ISO instant or a time that
// ends in " UTC". The API sends each instant as a field and the page formats it. Every page in web/src/pages.ts is
// rendered with fixtures that carry an instant in each field the owner saw raw (a retry wait, a claim pause, a model
// stall, an auto-mode stop, the improve report). No live call: fetch is a stub.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// tsconfig.test.json checks this file without JSX, so the shell fixtures (a .tsx module) load by a specifier the node check skips.
const FIXTURES = "./ui-shell-fixtures.js";
const { AT, RESPONSES, items, overview, row, installShellFixtures, mount } = (await import(/* @vite-ignore */ FIXTURES)) as {
  AT: string;
  RESPONSES: Record<string, unknown>;
  items: { items: unknown[] };
  overview: Record<string, unknown>;
  row: (n: number, level: string, title: string, extra?: object) => unknown;
  installShellFixtures: () => void;
  mount: () => { container: HTMLElement };
};

installShellFixtures();

const { PAGES } = await import("../web/src/pages.js");
const { t } = await import("../web/src/i18n/index.js");

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UNTIL = "2026-11-19T16:11:00.000Z";
const SINCE = "2026-11-19T16:11:54.203Z";
const why = (reason_code: string, code: string) => ({ code, reason_code, params: { until: UNTIL }, alarms: [], holder_id: null, next_actor: "factory", refs: [], ref_url: null });

Object.assign(overview, {
  system_actions: [
    { code: "claim_pause", text: "Model not answering", command: "Resume now in Needs you on Tasks, or factory resume model_stall", until: UNTIL, pause: "model_stall" },
    {
      code: "alarm", text: "Alarm: back to manual: the checks failed on the base branch after a merge", command: "factory mode auto", until: UNTIL,
      auto_stop: { alert_id: "al_1", at: SINCE, cause: "red_main" },
    },
  ],
});
Object.assign(RESPONSES, {
  "/api/v1/items": {
    ...items,
    items: [
      ...items.items,
      row(6, "queued", "Retry later", { why: why("not_before", "not_before") }),
      row(7, "queued", "Rate limited", { why: why("paused_rate_limit", "paused") }),
    ],
  },
  "/api/v1/health": {
    checked_at: AT,
    checks: [
      { status: "fail", msg: "agents paused: model not answering", since: SINCE, next: UNTIL },
      { status: "fail", msg: "agents paused: network not reachable; runs start again once a probe passes", since: SINCE },
    ],
  },
  "/api/v1/pauses": { pauses: [{ name: "model_stall", ends_at: UNTIL, since: SINCE }], csrf_token: "tok" },
  "/api/v1/rules": {
    enabled: false, applied: null, error: null, csrf_token: "tok", judge: null, home: null, turn_on: null, entries: [],
    improve: {
      report: { window_start: "2026-11-18T00:00:00.000Z", window_end: "2026-11-19T00:00:00.000Z", created_at: "2026-11-19T16:10:25.924Z", runs: 0, patterns: 0, groups: [] },
      run_now: false, csrf_token: null,
    },
  },
  "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
});

/** Each visible text of `main`, one per text node, without scripts and styles. */
function visibleTexts(root: HTMLElement): string[] {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("script, style").forEach((n) => n.remove());
  const out: string[] = [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

/** The texts that show a raw instant or a UTC time. */
const rawTimes = (texts: readonly string[]) => texts.filter((s) => ISO.test(s) || s.endsWith(" UTC"));

describe("every dashboard page shows times in local time", () => {
  for (const p of PAGES) {
    it(`${p.label} shows no ISO instant and no time ending in UTC`, async () => {
      history.replaceState(null, "", `/app/${p.path}`);
      const { container } = mount();
      const main = await waitFor(() => {
        const m = container.querySelector<HTMLElement>("main");
        if (m?.querySelector("h1")?.textContent !== t(`page.${p.key}` as never)) throw new Error("page not rendered yet");
        return m;
      });
      await waitFor(() => expect(container.querySelector("[aria-busy='true']")).toBeNull());
      await new Promise((r) => setTimeout(r, 100));
      expect(rawTimes(visibleTexts(main))).toEqual([]);
    });
  }

  it("the Work page's retry and pause reasons render, in local time", async () => {
    history.replaceState(null, "", "/app/items");
    const { container } = mount();
    await screen.findAllByText(/Retry waits until/);
    const main = container.querySelector<HTMLElement>("main")!;
    expect(main.textContent).toMatch(/Retry waits until \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(rawTimes(visibleTexts(main))).toEqual([]);
  });

  it("the check catches each raw form the owner reported", () => {
    const host = document.createElement("div");
    host.innerHTML = "<p>Window 2026-11-18 09:00 to 2026-11-19 09:00</p><p>Cost per UTC day</p>";
    expect(rawTimes(visibleTexts(host))).toEqual([]);
    for (const bad of [
      "Retry waits until 2026-11-19 16:11 UTC",
      "Window 2026-11-18T00:00:00.000Z to 2026-11-19T00:00:00.000Z, reported 2026-11-19T16:10:25.924Z",
      "agents paused: model not answering since 2026-11-19T16:11:54.203Z",
    ]) {
      host.innerHTML = `<p>${bad}</p>`;
      expect(rawTimes(visibleTexts(host))).toEqual([bad]);
    }
  });
});
