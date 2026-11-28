// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, act, fireEvent, within, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alarm, checks, confirmAuto, FULL, installFetch, menuOf, modeDialog, modeSection, mount, sentence, settingsView, stop, stub, time, turnAutoOn } from "./ui-api-fixtures.js";

beforeEach(installFetch);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("auto stop: red main", () => {
  it("the Mode toggle shows manual, when and why auto stopped, a link to the alarm and Turn auto back on", async () => {
    stub.view = settingsView("manual", stop("red_main"));
    const section = await modeSection();
    const note = await within(section).findByText(`Back to manual at ${time}: the checks failed on the base branch after a merge`);
    expect(time).toMatch(/^\d\d:\d\d$/);
    expect(section.textContent).toContain("manual");
    const link = within(section).getByRole("link", { name: "See the alarm" });
    expect(link.getAttribute("href")).toBe("/app/#alarm-al_1");
    expect(note.closest("[data-auto-stop]")).not.toBeNull();
    // The Dialog first; its Confirm writes mode auto once through the setting save path.
    expect(await turnAutoOn(section)).toEqual({ action: "set", key: "mode", value: '"auto"' });
  });

  it("Cancel and Escape on Turn auto back on's Dialog write nothing", async () => {
    stub.view = settingsView("manual", stop("red_main"));
    const section = await modeSection();
    const button = await within(section).findByRole("button", { name: "Turn auto back on" });
    fireEvent.click(button);
    fireEvent.click(within(modeDialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(modeDialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stub.posts).toEqual([]);
  });

  it("its alarm's Needs-you row is the alarm's own target: one local-time sentence, no second line, and a menu of Turn auto back on then What failed", async () => {
    stub.view = settingsView("manual", stop("red_main"));
    mount(checks([{ ...alarm(stop("red_main")), text: FULL }]));
    const line = (await screen.findByText(sentence("tests failed on main after a merge"))).closest("li")!;
    expect(line.id).toBe("alarm-al_1");
    // The cause is said once: no stop line repeats it, and the row has no link, no inline button and no Failures control.
    expect(line.textContent!.split("tests failed on main")).toHaveLength(2);
    expect(line.textContent).not.toContain("Back to manual");
    expect(line.querySelector("[data-auto-stop]")).toBeNull();
    expect(within(line).queryByRole("link")).toBeNull();
    expect(line.textContent).not.toMatch(/See the alarm|Open on Failures|Failures/);
    expect(within(line).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["More commands"]);
    expect(line.querySelector("summary")!.textContent).toBe("Details");
    await vi.waitFor(() => expect(menuOf(line)).toEqual([["Turn auto back on", "auto_on"], ["What failed", "what_failed"]]));
  });

  it("Details is closed at first and shows the server's full text once opened", async () => {
    stub.view = settingsView("manual", stop("red_main"));
    mount(checks([{ ...alarm(stop("red_main")), text: FULL }]));
    const line = (await screen.findByText(sentence("tests failed on main after a merge"))).closest("li")!;
    const toggle = line.querySelector<HTMLElement>("[data-alarm-details] summary")!;
    expect(toggle.textContent).toBe("Details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).not.toContain(FULL);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(line).getByText(FULL)).not.toBeNull();
  });

  it("Turn auto back on in the row's menu opens the same Dialog; Confirm writes mode auto through the same settings write as the Settings note", async () => {
    stub.view = settingsView("manual", stop("red_main"));
    mount(checks([alarm(stop("red_main"))]));
    const line = (await screen.findByText(sentence("tests failed on main after a merge"))).closest("li")!;
    fireEvent.click(within(line).getByRole("button", { name: "More commands" }));
    const item = within(line).getByRole("menuitem", { name: "Turn auto back on" });
    await vi.waitFor(() => expect(item.hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(item));
    expect(await confirmAuto()).toEqual({ action: "set", key: "mode", value: '"auto"' });
  });
});
