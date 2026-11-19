// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one shared placeholder (design 09-dashboard-shell, 2026-11-19, wi_926cad13): bars for about 1 s, then
// "<label>: Still loading… (n s)", then after 30 s the ErrorNote with Retry, which calls onRetry and starts again.

// tsconfig.test.json checks this file without JSX: the components are built with createElement and loaded by a
// specifier the node check skips (as tests/ui-spend-page.test.tsx does).
const PARTS_MODULE = "../web/src/components/ui/parts.js";
const { Loading, ErrorNote } = (await import(/* @vite-ignore */ PARTS_MODULE)) as {
  Loading: FunctionComponent<{ rows?: number; label: string; onRetry: () => void }>;
  ErrorNote: FunctionComponent<{ error: unknown; onRetry?: () => void }>;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("Loading", () => {
  it("shows bars named by its label first, then Still loading with the seconds, then the error with Retry at 30 s", () => {
    const onRetry = vi.fn();
    render(createElement(Loading, { rows: 2, label: "loading.plugins", onRetry }));
    const busy = screen.getByLabelText("Plugin list");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.children).toHaveLength(2);
    expect(screen.queryByText(/Still loading/)).toBeNull();

    advance(1_000);
    expect(screen.getByRole("status").textContent).toBe("Plugin list: Still loading… (1 s)");
    advance(11_000);
    expect(screen.getByRole("status").textContent).toBe("Plugin list: Still loading… (12 s)");
    expect(screen.queryByRole("alert")).toBeNull();

    advance(18_000);
    expect(screen.queryByLabelText("Plugin list")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Plugin list did not load in 30 s");
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("Retry calls onRetry and starts the steps again", () => {
    const onRetry = vi.fn();
    render(createElement(Loading, { label: "loading.health", onRetry }));
    advance(30_000);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Health checks").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText(/Still loading/)).toBeNull();
    advance(2_000);
    expect(screen.getByRole("status").textContent).toBe("Health checks: Still loading… (2 s)");
  });
});

describe("ErrorNote", () => {
  it("shows Retry only when onRetry is given", () => {
    const onRetry = vi.fn();
    render(createElement(ErrorNote, { error: new Error("nope") }));
    expect(screen.getByRole("alert").textContent).toBe("Could not load: nope");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    render(createElement(ErrorNote, { error: new Error("nope"), onRetry }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("every placeholder in web/src/views/", () => {
  it("passes a label and an onRetry to Loading", () => {
    const dir = join(import.meta.dirname, "..", "web", "src", "views");
    const missing: string[] = [];
    const seen: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      for (const call of readFileSync(join(dir, f), "utf8").match(/<Loading\b[\s\S]*?\/>/g) ?? []) {
        seen.push(f);
        if (!/\blabel="loading\.[A-Za-z]+"/.test(call) || !/\bonRetry=/.test(call)) missing.push(`${f}: ${call}`);
      }
    }
    expect(seen).toContain("plugins.tsx");
    expect(seen).toContain("spend.tsx");
    expect(missing).toEqual([]);
  });
});
