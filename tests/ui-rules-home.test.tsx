// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AT, card, h1s, HOMES, off, reset, s, sent, show, SLOW, teardown, TOKEN } from "./ui-rules-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// The Rules page tests with the ledger off: the agents home picker, Turn on and its refusal. The shared stub is in tests/ui-rules-fixtures.ts.

describe("Rules page", () => {
  const check = () => document.querySelector<HTMLElement>("[data-home-check]")!;

  it("ledger off, home found: the picker shows the home in use and its check, and one primary Turn on is the only button", async () => {
    s.current = off();
    await show();
    const turnOn = await screen.findByRole("button", { name: "Turn on" }, SLOW);
    expect(screen.getAllByRole("button")).toEqual([turnOn]);
    expect(turnOn.className).toContain("bg-accent"); // the primary variant
    const radios = within(screen.getByRole("radiogroup", { name: "Agents home" })).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([["/Users/me/.agents", true]]);
    expect(check().textContent).toBe("The rules tools are ready in /Users/me/.agents.");
    // No path field: the picker offers only the known homes.
    expect(screen.queryByRole("textbox")).toBeNull();
    // The page's own header is the one "Rules"; the page adds no second h1 and no step list.
    expect(h1s()).toEqual(["Rules"]);
    expect(document.querySelector("ol")).toBeNull();
    // The page asks for the read width through its PageHeader and sets no max-w-* column of its own.
    expect(document.querySelector('header[data-page-width="read"]')).not.toBeNull();
    expect(document.querySelector('[class*="max-w-5xl"]')).toBeNull();
  });

  it("the picker lists only the known homes, AGENTS_HOME first, and shows the check of the one chosen: the missing file, or both executable", async () => {
    s.current = off({ home: { path: "/Users/me/agents", missing: "bin/evolve", homes: HOMES }, turn_on: null });
    await show();
    const group = await screen.findByRole("radiogroup", { name: "Agents home" }, SLOW);
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([["/Users/me/agents", true], ["/Users/me/.agents", false]]);
    expect(group.textContent).toContain("/Users/me/agents (in use)");
    expect(check().textContent).toBe("The rules tools are missing or not executable in /Users/me/agents.");
    fireEvent.click(radios[1]!);
    expect(check().textContent).toContain("The rules tools are ready in /Users/me/.agents.");
    expect(check().textContent).toContain("The factory reads the home in use, /Users/me/agents, not this one.");
    // Choosing writes nothing, and with the home in use not found there is no Turn on.
    expect(s.posts).toEqual([]);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("Turn on writes the integrations entry through POST /api/v1/settings, then loads the rules with no reload", async () => {
    s.current = off();
    s.answer = { status: 200, body: { ok: true, lines: ["integrations = {\"tacit\":\"agents-home\"}"] } };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }, SLOW));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/settings");
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(sent()).toEqual([{ action: "set", key: "integrations", value: '{"tacit":"agents-home"}' }]);
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(card("C-012")).not.toBeNull();
  });

  it("a refused Turn on shows the refusal and stays off", async () => {
    s.current = off();
    s.answer = { status: 422, body: { error: "refused: integrations changes only by the owner" } };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }, SLOW));
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("only by the owner");
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  });

  it("ledger off, home not found: names the missing file, with no path field and no Turn on, and tells nobody where to put the CLIs", async () => {
    s.current = off({ home: { path: "/Users/me/.agents", missing: "bin/evolve", homes: [{ path: "/Users/me/.agents", missing: "bin/evolve" }] }, turn_on: null });
    await show();
    await waitFor(() => expect(document.querySelector("[data-home]")).not.toBeNull(), SLOW);
    const text = document.querySelector("[data-home]")!.textContent!;
    expect(text).toContain("The rules tools are missing or not executable in /Users/me/.agents.");
    expect(text).not.toMatch(/\bput\b/i);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(h1s()).toEqual(["Rules"]);
  });

  it("with the rules home off, the Turn on empty state comes before Auto-approve plans", async () => {
    s.current = off();
    s.standing = { as_of: AT, csrf_token: TOKEN, rules: [], proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 3, threshold: 3, created_at: AT }] };
    await show();
    const turnOn = await screen.findByRole("button", { name: "Turn on" }, SLOW);
    const approvals = await screen.findByRole("region", { name: "Auto-approve plans" }, SLOW);
    expect(turnOn.compareDocumentPosition(approvals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Improve report")).toBeNull();
  });

  it("ledger off for a user who is not the owner: the reason, and no Turn on", async () => {
    s.current = off({ judge: "Only the owner turns the ledger on; you are local:alice.", csrf_token: null, turn_on: null });
    await show();
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
