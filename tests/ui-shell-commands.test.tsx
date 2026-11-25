// @vitest-environment jsdom
// Dashboard shell tests: item commands. Shared setup is in ui-shell-fixtures.tsx.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";
import { ItemDecision } from "../web/src/views/decision-card.js";
import { commandOutcome } from "../web/src/views/command-send.js";
import { API } from "../web/src/api.js";
import { AT, items, detail, RESPONSES, state, installShellFixtures, mount, cmd, SESSION, cap, button, settle } from "./ui-shell-fixtures.js";

installShellFixtures();

const reply = (seq: number, command: string, handled: boolean, refusal: string | null = null) =>
  ({ seq, command, created_at: AT, handled_at: handled ? AT : null, refusal });

function mountCommands(commands = ["approve", "revise", "reject", "retry"].map(cmd), replies: ReturnType<typeof reply>[] = [], session: object | null = SESSION, nextActor = "human") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (session) client.setQueryData(["/api/v1/session"], session);
  // The item the page already read: the DecisionCard shows only when its why names the owner as next actor.
  client.setQueryData(["/api/v1/items/wi_1"], { ...detail, spec: { in_short: "AS-IS: a.\nTO-BE: b.", decisions: [] }, item: { ...detail.item, why: { ...detail.item.why, next_actor: nextActor } } });
  return render(
    <QueryClientProvider client={client}>
      <ItemDecision id="wi_1" commands={commands} replies={replies} />
    </QueryClientProvider>,
  );
}
const outcomeOf = (name: string) => document.querySelector(`[data-outcome-of="${name}"]`) as HTMLElement | null;
/** Picks `name` (Reject or Verdict) from the DecisionCard's "…" menu. */
const fromMenu = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "More commands" }));
  fireEvent.click(screen.getByRole("menuitem", { name: cap(name) }));
};
const typeNote = (text: string) => fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: text } });

describe("item commands", () => {
  it("shows one button per command, labelled with its name: the primary first (approve before retry), the rest in the API's order, each with data-action", () => {
    mountCommands(["retry", "approve", "budget"].map(cmd));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-decision-actions] > span > button[data-action]")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Approve", "Retry", "Budget"]);
    expect(buttons.map((b) => b.dataset.action)).toEqual(["approve", "retry", "budget"]);
  });

  it("verdict shows Good and Bad as one segmented control and Feedback as a button, each sending the verdict request; Feedback waits for the note box's text", async () => {
    mountCommands([cmd("verdict")]);
    const group = screen.getByRole("group", { name: "Verdict" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Good", "Bad"]);
    expect(group.parentElement!.parentElement).toBe(button("Feedback").parentElement);
    expect(button("Feedback").disabled).toBe(true);
    fireEvent.click(button("Good"));
    await settle();
    fireEvent.click(button("Bad"));
    await settle();
    typeNote("the flag name is wrong");
    fireEvent.click(button("Feedback"));
    await settle();
    expect(state.posts.map((p) => p.body)).toEqual([
      { command: "verdict", note: "accept none" },
      { command: "verdict", note: "changes minor Bad" },
      { command: "verdict", note: "changes none the flag name is wrong" },
    ]);
  });

  it("Reject and Verdict are in the \"…\" menu, not buttons in the card, each entry with data-action, and open their dialogs", () => {
    mountCommands(["approve", "verdict", "reject"].map(cmd));
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verdict" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.dataset.action)).toEqual(["verdict", "reject"]);
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    fromMenu("verdict");
    expect(screen.getByRole("dialog", { name: "Verdict Spec waiting" })).toBeTruthy();
    fireEvent.click(button("Cancel"));
    fromMenu("reject");
    expect(screen.getByRole("dialog", { name: "Reject Spec waiting" })).toBeTruthy();
  });

  it("an item that waits for nobody shows no DecisionCard, only its \"…\" menu with Reject and Verdict", () => {
    mountCommands(["approve", "verdict", "reject"].map(cmd), [], SESSION, "factory");
    expect(document.querySelector("[data-decision-card]")).toBeNull();
    expect(screen.queryByRole("region", { name: "What you need to decide" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Verdict", "Reject"]);
  });

  it("with no command that applies (a running item), says so and offers no note box or button", () => {
    mountCommands([], [], SESSION, "factory");
    expect(document.querySelector("[data-commands-none]")?.textContent).toContain("Nothing needs you now");
    expect(document.querySelectorAll("[data-decision-actions] button[data-action]")).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
  });

  it("the item page shows the buttons from the item API's commands list", async () => {
    RESPONSES["/api/v1/session"] = SESSION;
    (detail as Record<string, unknown>).commands = [cmd("approve"), cmd("reject")];
    (detail as Record<string, unknown>).replies = [];
    try {
      history.replaceState(null, "", "/app/items/wi_1");
      mount();
      expect((await screen.findByRole("button", { name: "Approve" })).dataset.action).toBe("approve");
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More commands" }));
      expect(screen.getByRole("menuitem", { name: "Reject" })).toBeTruthy();
    } finally {
      delete RESPONSES["/api/v1/session"];
      delete (detail as Record<string, unknown>).commands;
      delete (detail as Record<string, unknown>).replies;
    }
  });

  it("revise and reject open a dialog, not the note box; the note box stays for the other commands", async () => {
    mountCommands();
    expect(screen.getByRole("textbox", { name: "Note" })).toBeTruthy();
    typeNote("tighten the tests");
    fireEvent.click(button("revise"));
    const dialog = screen.getByRole("dialog", { name: "Revise Spec waiting" });
    expect((within(dialog).getByRole("button", { name: "Send revise" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fromMenu("reject");
    expect(screen.getByRole("dialog", { name: "Reject Spec waiting" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Revise Spec waiting" })).toBeNull();
    await settle();
    expect(state.posts).toEqual([]);
  });

  it("a send posts { command, note } with the session token; the note only when the box has text", async () => {
    // A refetch after a send must still carry the spec, or Revise opens the Add context modal.
    RESPONSES["/api/v1/items/wi_1"] = { ...detail, spec: { in_short: "AS-IS: a.\nTO-BE: b.", decisions: [] } };
    onTestFinished(() => { RESPONSES["/api/v1/items/wi_1"] = detail; });
    mountCommands();
    fireEvent.click(button("approve"));
    await settle();
    typeNote("  more tests please ");
    fireEvent.click(button("retry"));
    await settle();
    fireEvent.click(button("revise"));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on Problem" }), { target: { value: "narrower" } });
    fireEvent.click(button("Send revise"));
    await settle();
    expect(state.posts.map((p) => [p.url, p.body])).toEqual([
      ["/api/v1/items/wi_1/commands", { command: "approve" }],
      ["/api/v1/items/wi_1/commands", { command: "retry", note: "more tests please" }],
      ["/api/v1/items/wi_1/commands", { command: "revise", note: "### Problem\nnarrower" }],
    ]);
    expect(state.posts[0]!.headers["x-csrf-token"]).toBe("tok-123");
    expect(state.posts[0]!.headers["content-type"]).toBe("application/json");
  });

  it("reject asks why and to confirm: cancel posts nothing, confirm posts the reason once", async () => {
    mountCommands();
    typeNote("not the reject reason");
    fromMenu("reject");
    fireEvent.click(screen.getByRole("radio", { name: "duplicate" }));
    await settle();
    expect(state.posts).toEqual([]);
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(state.posts).toEqual([]);
    fromMenu("reject");
    fireEvent.click(screen.getByRole("radio", { name: "duplicate" }));
    fireEvent.click(button("Confirm reject"));
    await settle();
    expect(state.posts.map((p) => p.body)).toEqual([{ command: "reject", note: "duplicate" }]);
  });

  it("a 202 shows sent at once; a failed send shows its error next to its button", async () => {
    mountCommands();
    fireEvent.click(button("approve"));
    await settle();
    expect(within(outcomeOf("approve")!).getByRole("status").textContent).toBe("sent");
    state.postAnswer = { status: 403, body: { error: "Missing or stale x-csrf-token; reload the page." } };
    fireEvent.click(button("retry"));
    await settle();
    expect(within(outcomeOf("retry")!).getByRole("alert").textContent).toBe("Missing or stale x-csrf-token; reload the page.");
    expect(within(outcomeOf("approve")!).getByRole("status").textContent).toBe("sent");
  });

  it("shows the latest request's outcome per command: its refusal, sent, or Done", () => {
    mountCommands(["approve", "retry", "revise", "reject"].map(cmd), [
      reply(1, "approve", true, "You may not approve this item."),
      reply(2, "retry", true),
      reply(3, "approve", false),
      reply(4, "revise", true),
      reply(5, "revise", true, "Nothing to revise."),
    ]);
    expect(outcomeOf("approve")!.textContent).toBe("sent");
    expect(outcomeOf("retry")!.textContent).toBe("Done");
    expect(outcomeOf("revise")!.textContent).toBe("Nothing to revise.");
    expect(outcomeOf("reject")).toBeNull();
  });

  it("a local send shows sent until a reply as new as it arrives", () => {
    const replies = [reply(4, "retry", true)];
    expect(commandOutcome(replies, "retry", { seq: 9 })).toEqual({ tone: "status", text: "sent" });
    expect(commandOutcome([...replies, reply(9, "retry", true)], "retry", { seq: 9 })).toEqual({ tone: "status", text: "Done" });
    expect(commandOutcome(replies, "retry", { error: "boom" })).toEqual({ tone: "error", text: "boom" });
  });

  it("with commands on the page says who it acts as and where that came from", () => {
    mountCommands(undefined, [], SESSION);
    const actor = document.querySelector("[data-commands-actor]")!;
    const you = actor.querySelector("[data-id]")!;
    expect(you.textContent).toBe("you");
    expect(actor.querySelector("details")).toBeNull();
    fireEvent.mouseEnter(you.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("local:me");
    expect(actor.textContent).toMatch(/^Acting as you.*\(from environment\)$/);
  });

  it("with commands off every button is disabled and the page says so", () => {
    mountCommands(undefined, [], { ...SESSION, commands_enabled: false, actor: null, actor_source: null });
    typeNote("some text");
    for (const b of document.querySelectorAll("[data-decision-actions] > span > button[data-action]")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Commands are off/)).toBeTruthy();
    // The notice links to the Settings page's section that says what to set.
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/app/settings#page-commands");
  });
});


describe("command help", () => {
  const NAMES = ["/approve", "/revise", "/reject", "/retry", "/resolve", "/verdict"];
  /** The command names the help lists: the first word of each entry's usage. */
  const named = (help: HTMLElement) => [...help.querySelectorAll("dt code")].map((c) => c.textContent!.split(" ")[0]);

  it("? opens the help with every command's name", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    mount();
    await screen.findByRole("heading", { name: "Spec waiting" });
    fireEvent.keyDown(document, { key: "?" });
    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(named(within(help).getByRole("region", { name: "Commands" }))).toEqual(expect.arrayContaining(NAMES));
  });

  it("⌘K opens the search, which lists the commands and filters them as you type", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    mount();
    await screen.findByRole("heading", { name: "Spec waiting" });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const search = screen.getByRole("dialog", { name: "Search" });
    expect(named(within(search).getByRole("region", { name: "Commands" }))).toEqual(expect.arrayContaining(NAMES));
    fireEvent.change(within(search).getByRole("searchbox"), { target: { value: "verdict" } });
    expect(named(within(search).getByRole("region", { name: "Commands" }))).toEqual(["/verdict"]);
  });
});
