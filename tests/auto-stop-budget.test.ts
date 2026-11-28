// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, within, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alarm, checks, installFetch, menuOf, modeSection, mount, sentence, settingsView, stop, stub, time } from "./ui-api-fixtures.js";

beforeEach(installFetch);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("auto stop: budget checkpoint", () => {
  it("the Mode toggle and the alarm's Needs-you row both show the checkpoint and the time", async () => {
    stub.view = settingsView("manual", stop("budget_checkpoint"));
    const section = await modeSection();
    expect(await within(section).findByText(`Back to manual at ${time}: an item reached its budget checkpoint`)).not.toBeNull();
    cleanup();
    mount(checks([alarm(stop("budget_checkpoint"))]));
    const line = (await screen.findByText(sentence("an item reached its budget checkpoint"))).closest("li")!;
    expect(within(line).queryByRole("link")).toBeNull();
    expect(menuOf(line).map(([label]) => label)).toEqual(["Turn auto back on", "What failed"]);
    expect(document.querySelectorAll("li[data-check]")).toHaveLength(1);
  });
});
