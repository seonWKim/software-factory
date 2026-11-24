// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ItemRow } from "../web/src/api.js";
import { t } from "../web/src/i18n/index.js";

// tsconfig.test.json checks this file without JSX, so components are built with createElement and the .tsx modules are
// loaded by a specifier the node check skips (as tests/ui-tasks-page.test.tsx does).
const COMMON = "../web/src/views/common.js";
const FIXTURES = "./ui-shell-fixtures.js";
const { InteractiveBadge, ItemsTable, isInteractiveRun, runKindLabel } = (await import(/* @vite-ignore */ COMMON)) as {
  InteractiveBadge: FunctionComponent;
  ItemsTable: FunctionComponent<{ items: readonly ItemRow[]; now: number; label: string; empty: string }>;
  isInteractiveRun: (run: { kind: string; status: string } | null | undefined) => boolean;
  runKindLabel: (kind: string) => string;
};
const fx = (await import(/* @vite-ignore */ FIXTURES)) as {
  AT: string;
  RESPONSES: Record<string, unknown>;
  detail: { item: Record<string, unknown> } & Record<string, unknown>;
  row: (n: number, level: string, title: string, extra?: object) => ItemRow;
  installShellFixtures: () => void;
  mount: () => unknown;
};

fx.installShellFixtures();

const BADGE = "Interactive task";
const run = (kind: string, status: string) => ({ kind, status, attempt: 1, worker_id: null, started_at: null, position: null });
const workRow = (n: number, r: ReturnType<typeof run> | null): ItemRow => ({ ...fx.row(n, "running", `Item ${n}`), run: r }) as ItemRow;

describe("interactive tasks (a person handles the item in their own session)", () => {
  it("an interactive run reads as an interactive task; other run kinds keep their names", () => {
    expect(runKindLabel("interactive")).toBe(BADGE);
    expect(runKindLabel("implement")).toBe("Implement");
  });

  it("a run shows the badge only while it is a running interactive run", () => {
    expect(isInteractiveRun(run("interactive", "running"))).toBe(true);
    expect(isInteractiveRun(run("interactive", "failed"))).toBe(false);
    expect(isInteractiveRun(run("implement", "running"))).toBe(false);
    expect(isInteractiveRun(null)).toBe(false);
  });

  it("a Work row whose current run is a running interactive run shows the badge; other rows do not", () => {
    const c = render(createElement(ItemsTable, {
      items: [workRow(1, run("interactive", "running")), workRow(2, run("implement", "running")), workRow(3, run("interactive", "failed"))],
      now: Date.parse(fx.AT), label: "Work items", empty: "none",
    })).container;
    const rows = [...c.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(within(rows[0]!).getByText(BADGE)).toBeTruthy();
    expect(within(rows[1]!).queryByText(BADGE)).toBeNull();
    expect(within(rows[2]!).queryByText(BADGE)).toBeNull();
  });

  it("the badge is the shared Badge with its text", () => {
    render(createElement(InteractiveBadge));
    expect(screen.getByText(BADGE)).toBeTruthy();
  });

  it("the item page header shows the badge while an interactive run is running, and its runs table names the kind", async () => {
    const url = "/api/v1/items/wi_9";
    fx.RESPONSES[url] = {
      ...fx.detail,
      item: { ...fx.detail.item, id: "wi_9", title: "Handled by a person" },
      runs: [{ id: "run_i", kind: "interactive", status: "running", attempt: 1, started_at: fx.AT, finished_at: null, created_at: fx.AT, tokens: 0, error: null }],
    };
    try {
      history.replaceState(null, "", "/app/items/wi_9");
      fx.mount();
      const header = (await screen.findByRole("heading", { level: 1, name: "Handled by a person" })).closest("header")!;
      expect(within(header).getByText(BADGE)).toBeTruthy();
      const runs = screen.getByRole("table", { name: "Runs" });
      expect(runs.querySelector('[data-run="run_i"] [data-cell-title]')!.textContent).toContain(BADGE);
    } finally {
      delete fx.RESPONSES[url];
    }
  });

  it("the item page header has no badge when no interactive run is running", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    fx.mount();
    const header = (await screen.findByRole("heading", { level: 1, name: "Spec waiting" })).closest("header")!;
    expect(within(header).queryByText(BADGE)).toBeNull();
  });

  it("the abandoned and session_lost failures speak of the interactive task", () => {
    expect(t("failure.abandoned.meaning")).toBe("The person abandoned the interactive task.");
    expect(t("failure.session_lost.meaning")).toBe("The interactive task's lease expired.");
  });
});
