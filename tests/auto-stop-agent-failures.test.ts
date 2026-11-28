// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, within, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alarm, checks, installFetch, menuOf, modeSection, mount, sentence, settingsView, stub } from "./ui-api-fixtures.js";

beforeEach(installFetch);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("auto stop: a burst of agent-run failures", () => {
  it("leaves the mode auto with no stop line; its repeated-error alarm's row shows the server's sentence and Show failures", async () => {
    stub.view = settingsView("auto", null);
    const section = await modeSection();
    expect(section.textContent).toContain("auto");
    expect(section.querySelector("[data-auto-stop]")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Turn auto back on" })).toBeNull();
    cleanup();
    mount(checks([{ ...alarm(), pattern: "repeated_error", error_code: "checks_failed" }]));
    const line = document.querySelector<HTMLElement>("li[data-check='alarm']")!;
    expect(line.querySelector("[data-alarm-summary]")!.textContent).toBe("Alarm: something");
    expect(menuOf(line)).toEqual([["Show failures", "show_failures"]]);
    expect(line.querySelector("details")).toBeNull();
  });
});
