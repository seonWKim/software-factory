// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, render, screen } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ItemRow } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so components are built with createElement and the .tsx module is
// loaded by a specifier the node check skips (as tests/ui-tasks-page.test.tsx does).
const COMMON = "../web/src/views/common.js";
const { InteractiveBadge, isInteractive, runKindLabel } = (await import(/* @vite-ignore */ COMMON)) as {
  InteractiveBadge: FunctionComponent;
  isInteractive: (it: Pick<ItemRow, "run">) => boolean;
  runKindLabel: (kind: string) => string;
};

const run = (kind: string, status: string): Pick<ItemRow, "run"> => ({ run: { kind, status, attempt: 1, worker_id: null, started_at: null, position: null } });

afterEach(cleanup);

describe("interactive tasks (a person handles the item in their own session)", () => {
  it("an interactive run reads as an interactive task; other run kinds keep their names", () => {
    expect(runKindLabel("interactive")).toBe("Interactive task");
    expect(runKindLabel("implement")).toBe("implement");
  });

  it("an item is shown as an interactive task only while its interactive run is running", () => {
    expect(isInteractive(run("interactive", "running"))).toBe(true);
    expect(isInteractive(run("interactive", "failed"))).toBe(false);
    expect(isInteractive(run("implement", "running"))).toBe(false);
    expect(isInteractive({ run: null })).toBe(false);
  });

  it("the badge says Interactive task", () => {
    render(createElement(InteractiveBadge));
    expect(screen.getByText("Interactive task")).toBeTruthy();
  });
});
