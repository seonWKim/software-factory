// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, act, fireEvent, within, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmAuto, installFetch, modeDialog, modeSection, settingsView, stub } from "./ui-api-fixtures.js";

beforeEach(installFetch);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Settings Mode switch asks first", () => {
  it("flipping it opens the Dialog and sends nothing; Escape and Cancel write nothing; Confirm writes the mode once", async () => {
    stub.view = settingsView("manual", null);
    const section = await modeSection();
    const toggle = await within(section).findByRole("switch", { name: "Auto mode" });
    fireEvent.click(toggle);
    fireEvent.keyDown(modeDialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(within(modeDialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The switch still shows the stored mode: nothing changed.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(await confirmAuto()).toEqual({ action: "set", key: "mode", value: '"auto"' });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("from auto it asks to switch to manual, and Confirm writes manual", async () => {
    stub.view = settingsView("auto", null);
    const section = await modeSection();
    fireEvent.click(await within(section).findByRole("switch", { name: "Auto mode" }));
    const dialog = screen.getByRole("dialog", { name: "Switch to manual mode?" });
    expect(stub.posts).toHaveLength(0);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Switch to manual" })));
    expect(stub.posts.map((p) => JSON.parse(String(p.init.body)))).toEqual([{ action: "set", key: "mode", value: '"manual"' }]);
  });
});
