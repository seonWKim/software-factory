// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
// The shared alignment primitives (design 09-dashboard-components, 2026-11-24): one control height in a PageToolbar,
// one card padding and intro, one stat tile; a Popover beside its anchor.
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../web/src/components/ui/button.js";
import { CARD_INTRO, CARD_PAD, Card } from "../web/src/components/ui/card.js";
import { PageToolbar } from "../web/src/components/ui/notice.js";
import { place } from "../web/src/components/ui/popover.js";
import { STAT_NOTE, StatTile } from "../web/src/components/ui/stat-tile.js";

afterEach(cleanup);

describe("PageToolbar control height", () => {
  it("draws a sm Button in the toolbar's row at the 32px md size, level with the search field", () => {
    render(
      <PageToolbar>
        <Button size="sm">Show closed</Button>
        <Button size="icon" aria-label="Refresh" />
      </PageToolbar>,
    );
    const sm = screen.getByRole("button", { name: "Show closed" });
    expect(sm.className).toContain("min-h-8");
    expect(sm.className).not.toContain("min-h-7");
    expect(sm.closest("[data-toolbar]")).not.toBeNull();
    // An icon Button keeps its square.
    expect(screen.getByRole("button", { name: "Refresh" }).className).toContain("size-8");
  });

  it("leaves a sm Button outside a toolbar at 28px", () => {
    render(<Button size="sm">Retry</Button>);
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain("min-h-7");
  });
});

describe("Card padding and intro", () => {
  it("pads with CARD_PAD, and the decision card pads and sits like a Card", () => {
    render(<Card title="Spend">x</Card>);
    expect(screen.getByRole("region", { name: "Spend" }).className).toContain(CARD_PAD);
    const decision = readFileSync("web/src/views/decision-card.tsx", "utf8");
    expect(decision).toMatch(/"mt-6 [^"]*rounded-card[^"]*", CARD_PAD\)/);
  });

  it("is the one card intro: Settings, Host sleeps and Evals use it", () => {
    expect(CARD_INTRO).toContain("mb-4");
    expect(readFileSync("web/src/views/settings/rows.ts", "utf8")).toContain("SETTINGS_INTRO = CARD_INTRO");
    for (const f of ["host-sleeps.tsx", "plugins-evals.tsx"]) expect(readFileSync(`web/src/views/${f}`, "utf8")).toContain("className={CARD_INTRO}");
  });
});

describe("StatTile", () => {
  it("shows the label, the figure and its notes in one tile, with the tile's data attributes", () => {
    render(
      <dl>
        <StatTile data-total="Today" label="Today" value="$1.00">
          <dd className={STAT_NOTE}>12k tokens</dd>
        </StatTile>
      </dl>,
    );
    const tile = document.querySelector('[data-total="Today"]')!;
    expect(tile.className).toContain("rounded-box");
    expect(tile.querySelector("dt")!.textContent).toBe("Today");
    const [value, note] = [...tile.querySelectorAll("dd")];
    expect(value!.textContent).toBe("$1.00");
    expect(value!.className).toContain("text-lg");
    expect(note!.textContent).toBe("12k tokens");
  });

  it("is the only tile style: Work's Last 24 hours, Spend and Efficiency draw no tile of their own", () => {
    for (const f of ["pages.tsx", "spend.tsx", "efficiency.tsx"]) {
      const src = readFileSync(`web/src/views/${f}`, "utf8");
      // A hand-drawn tile writes its own figure type; a StatTile figure comes from STAT_VALUE.
      expect(src, f).not.toContain("text-lg font-semibold tabular-nums");
      expect(src, f).toMatch(/StatTile|STAT_TILE/);
    }
  });
});

describe("Popover placement", () => {
  const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top }) as DOMRect;
  const win = { width: 1280, height: 800 };

  it("opens beside a chip high in the window, its top on the chip's top", () => {
    expect(place(rect(200, 100, 200, 24), { width: 320, height: 400 }, win)).toEqual({ left: 408, top: 100 });
  });

  it("flips a chip low in the window: the panel's bottom on the chip's bottom, still beside it, not at the window's top", () => {
    // A chip on the 23rd, near the bottom (the calendar popover review, 2026-11-24).
    expect(place(rect(200, 740, 200, 24), { width: 320, height: 512 }, win)).toEqual({ left: 408, top: 252 });
  });
});
