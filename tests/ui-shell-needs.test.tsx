// @vitest-environment jsdom
// Dashboard shell tests: Floor banner, Runners banner and Needs-you buttons. Shared setup is in ui-shell-fixtures.tsx.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemsTable } from "../web/src/views/common.js";
import { NeedsList } from "../web/src/views/task-work.js";
import { FactoryBanner } from "../web/src/views/pages.js";
import { API, type Items, type ItemRow, useApi } from "../web/src/api.js";
import { STATUS_MS } from "../web/src/components/ui/dialog.js";
import { AT, overview, row, items, runs, RESPONSES, state, installShellFixtures, cmd, SESSION, cap, button, rowOf, settle } from "./ui-shell-fixtures.js";

installShellFixtures();

describe("Runners banner and Needs-you reasons", () => {
  const NOW = Date.parse(AT);
  const running = { state: "running", rev: "aaaaaaa1111", target_rev: "aaaaaaa1111", child_pid: 7, since: AT, workers: 3, error: null, pending: [] } as never;

  it("a running factory's banner says its version; it names no pause (a pause is its own Needs-you row)", () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><FactoryBanner factory={running} now={NOW} /></QueryClientProvider>);
    const text = screen.getByTestId("factory-banner").textContent;
    expect(text).toContain("Running version aaaaaaa · started");
    expect(text).not.toMatch(/Paused|model_stall/);
  });

  it("an Answer-or-fix row shows the need's reason, the failed run's message, and no command to type", () => {
    const need = { reason: "no model credential in the secret file" };
    const failed = { blocked_on: "human", blocked_reason: "run_failed:implement:exception", need };
    render(<QueryClientProvider client={new QueryClient()}><NeedsList items={[row(1, "needs_human", "Failed one", failed) as unknown as ItemRow]} /></QueryClientProvider>);
    expect(document.querySelector("[data-need]")!.textContent).toBe("no model credential in the secret file");
  });
});

describe("Runners banner: Migrate now, Start and Restart now (design 08-self-update)", () => {
  const NOW = Date.parse(AT);
  const offer = (offered: boolean, reason: string | null = null) => ({ offered, reason });
  const NOT_LIVE = "No factory supervisor is running, so this page cannot reach it. Start the factory from a terminal with factory dev.";
  function banner(factory: unknown, view: object) {
    RESPONSES["/api/v1/supervisor"] = { live: true, state: null, csrf_token: "tok", migrate: offer(true), start: offer(false, "A factory process already runs and claims work: use Restart now for a fresh one."), restart: offer(true), ...view };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><FactoryBanner factory={factory as never} now={NOW} /></QueryClientProvider>);
    return screen.getByTestId("factory-banner");
  }
  afterEach(() => {
    delete RESPONSES["/api/v1/supervisor"];
  });

  it("the stopped and migration texts carry no npm run", () => {
    expect(banner(null, {}).textContent).not.toContain("npm run");
    cleanup();
    expect(banner({ ...overview.factory, pending: [] }, {}).textContent).toContain("waits for its migration: Migrate now applies it.");
    cleanup();
    const text = banner(overview.factory, {}).textContent!;
    expect(text).toContain("waits for its migration (pending: schema 12): Migrate now applies it.");
    expect(text).not.toContain("npm run");
  });

  it("a running factory offers Restart now only; its confirm files the restart request", async () => {
    const el = banner({ state: "running", rev: "aaaaaaa1111", target_rev: null, child_pid: 7, since: AT, workers: 3, error: null, pending: [] }, {});
    const restart = await within(el).findByRole("button", { name: "Restart now" });
    expect(within(el).queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(restart);
    expect(state.posts).toHaveLength(0); // the confirm first
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart now" }));
    await vi.waitFor(() => expect(state.posts).toEqual([expect.objectContaining({ url: "/api/v1/supervisor", body: { action: "restart", confirm: true } })]));
  });

  it("a migration waiting shows the dry run before Migrate now's confirm posts", async () => {
    state.postAnswer = { status: 200, body: { dry_run: { pending: ["project keys (1 row)"], lines: ["-- project keys: 1 row would change", "dry run: nothing was changed"], ok: true } } };
    const el = banner(overview.factory, {});
    fireEvent.click(await within(el).findByRole("button", { name: "Migrate now" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Pending steps: project keys (1 row)");
    expect(dialog.querySelector("pre")!.textContent).toContain("1 row would change");
    expect(state.posts.map((p) => p.body)).toEqual([{}]);
    state.postAnswer = { status: 202, body: { started: true } };
    fireEvent.click(within(dialog).getByRole("button", { name: "Migrate now" }));
    await vi.waitFor(() => expect(state.posts.map((p) => p.body)).toEqual([{}, { confirm: true }]));
  });

  it("with no live supervisor no button shows and the page says why in plain words", async () => {
    const el = banner(null, { live: false, migrate: offer(false, NOT_LIVE), start: offer(false, NOT_LIVE), restart: offer(false, NOT_LIVE) });
    await within(el).findByText(NOT_LIVE);
    expect(within(el).queryByRole("button")).toBeNull();
  });
});

describe("Needs-you command buttons (issue #453)", () => {
  const NOT_OWNER = "only the owner may send this command (`not_owner`)";
  /** Needs you with one row whose commands are `commands`, as the items API lists them. */
  function mountNeeds(commands: ReturnType<typeof cmd>[], extra: object = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/api/v1/session"], SESSION);
    const it = row(1, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human", need: { reason: "spec ready", anchor: null }, commands, ...extra });
    return render(
      <QueryClientProvider client={client}>
        <NeedsList items={[it as unknown as ItemRow]} />
      </QueryClientProvider>,
    );
  }

  const menu = () => screen.getByRole("button", { name: "More commands" });
  const pick = (name: string) => {
    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("menuitem", { name: cap(name) }));
  };
  /** The row's menu items, read with the menu open, then closed again. */
  const menuLabels = () => {
    fireEvent.click(menu());
    const labels = screen.getAllByRole("menuitem").map((m) => m.textContent);
    fireEvent.click(menu());
    return labels;
  };
  /** The row's controls outside its menu that a person sees (the hidden p-shortcut button is not one). */
  const visibleButtons = () => [...document.querySelectorAll<HTMLButtonElement>("li button")].filter((b) => !b.hidden && !b.closest("[role=menu]")).map((b) => b.getAttribute("aria-label") ?? b.textContent);

  it("one ⋯ menu per row and no other button, the primary command first in it; Work items has none", () => {
    mountNeeds(["approve", "reject", "revise"].map(cmd));
    expect(visibleButtons()).toEqual(["More commands"]);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(menuLabels()).toEqual(["Approve", "Reject", "Revise"]);
    cleanup();
    mountNeeds([cmd("retry"), cmd("reject")]);
    expect(menuLabels()).toEqual(["Retry", "Reject"]);
    expect(rowOf("retry").hidden).toBe(true);
    cleanup();
    // No primary: no p shortcut and no Open button (the title links to the item).
    mountNeeds([cmd("reject")]);
    expect(menuLabels()).toEqual(["Reject"]);
    expect(document.querySelector("[data-shortcut]")).toBeNull();
    expect(rowOf("open")).toBeNull();
    cleanup();
    const it = row(1, "needs_approval", "Spec waiting", { need: { reason: "spec ready" }, commands: [cmd("approve")] });
    render(<ItemsTable items={[it as unknown as ItemRow]} now={Date.parse(AT)} label="Work items" empty="none" />);
    expect(document.querySelector("[data-need-commands]")).toBeNull();
  });

  // The menu closes on a send, so the row itself says it was sent, once (no button carries it any more).
  it("approve, retry and resolve send at once, with no note; the row says Sent, waiting once, and a status message is announced", async () => {
    for (const [name, label] of [["approve", "Approve"], ["retry", "Retry"], ["resolve", "Answer"]] as const) {
      state.posts = [];
      mountNeeds([cmd(name)]);
      fireEvent.click(menu());
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      await settle();
      expect(state.posts.map((p) => [p.url, p.body]), name).toEqual([["/api/v1/items/wi_1/commands", { command: name }]]);
      expect(state.posts[0]!.headers["x-csrf-token"]).toBe("tok-123");
      expect(document.querySelector("li")!.textContent!.split("Sent, waiting").length - 1, name).toBe(1);
      expect(screen.getAllByRole("status").map((e) => e.textContent)).toContain(`Command sent: ${name}`);
      cleanup();
    }
  });

  it("the status message outlives a row that leaves the list after its send, then goes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/api/v1/session"], SESSION);
    const it = row(1, "needs_approval", "Spec waiting", { stage: "READY", blocked_on: "human", need: { reason: "spec ready", anchor: null }, commands: [cmd("approve")] });
    client.setQueryData(["/api/v1/items"], { ...items, items: [it] });
    function Listed() {
      const list = useApi<Items>(API.items, false).data;
      return <NeedsList items={list?.items ?? []} />;
    }
    const saved = RESPONSES["/api/v1/items"];
    RESPONSES["/api/v1/items"] = { ...items, items: [] };
    try {
      render(
        <QueryClientProvider client={client}>
          <Listed />
        </QueryClientProvider>,
      );
      fireEvent.click(menu());
      fireEvent.click(screen.getByRole("menuitem", { name: "Approve" }));
      await settle();
      expect(state.posts.map((p) => p.body)).toEqual([{ command: "approve" }]);
      expect(document.querySelector("[data-need-commands]")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Command sent: approve");
      await act(async () => void (await vi.advanceTimersByTimeAsync(STATUS_MS)));
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      RESPONSES["/api/v1/items"] = saved;
    }
  });

  it("opening reject, revise or verdict leaves the row's children as they were; the dialog sits outside the row", () => {
    mountNeeds(["approve", "reject", "revise", "verdict"].map(cmd));
    const tr = document.querySelector("li")!;
    const before = [...tr.querySelectorAll("*")];
    for (const [name, title] of [["reject", "Reject Spec waiting"], ["revise", "Revise Spec waiting"], ["verdict", "Verdict Spec waiting"]] as const) {
      pick(name);
      const dialog = screen.getByRole("dialog", { name: title });
      expect(tr.contains(dialog), name).toBe(false);
      expect([...tr.querySelectorAll("*")], name).toEqual(before);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("reject opens the dialog and asks to confirm, naming the PR it closes; nothing is sent before the confirm", async () => {
    mountNeeds(["approve", "reject"].map(cmd), { change_ref: "42" });
    pick("reject");
    const dialog = screen.getByRole("dialog", { name: "Reject Spec waiting" });
    expect(dialog.textContent).toContain("Rejecting closes this item and its PR #42, without a merge.");
    fireEvent.click(within(dialog).getByRole("radio", { name: "duplicate" }));
    await settle();
    expect(state.posts).toEqual([]);
    fireEvent.click(button("Confirm reject"));
    await settle();
    expect(state.posts.map((p) => p.body)).toEqual([{ command: "reject", note: "duplicate" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("revise opens its note fields and sends only once a section has text; Cancel sends nothing", async () => {
    mountNeeds([cmd("approve"), cmd("revise")]);
    pick("revise");
    const dialog = screen.getByRole("dialog", { name: "Revise Spec waiting" });
    expect((within(dialog).getByRole("button", { name: "Send revise" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(state.posts).toEqual([]);
    pick("Revise");
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on Problem" }), { target: { value: "narrower" } });
    fireEvent.click(button("Send revise"));
    await settle();
    expect(state.posts.map((p) => p.body)).toEqual([{ command: "revise", note: "### Problem\nnarrower" }]);
  });

  it("verdict opens a dialog with Accept, Changes and Reject; Changes needs a reason, then Send verdict sends it", async () => {
    mountNeeds([cmd("approve"), cmd("verdict")]);
    pick("verdict");
    // Accept is chosen at first and needs no reason.
    expect(button("Send verdict").disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Changes" }));
    expect(button("Send verdict").disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: " ok " } });
    fireEvent.click(button("Send verdict"));
    await settle();
    expect(state.posts.map((p) => p.body)).toEqual([{ command: "verdict", note: "changes none ok" }]);
  });

  it("a command the viewer may not send stays in the menu, disabled, with its reason in plain text", async () => {
    mountNeeds(["approve", "reject"].map((n) => ({ ...cmd(n), allowed: false, reason: NOT_OWNER })));
    // Nothing allowed is primary: no p shortcut, no Open button, and approve is in the menu with reject.
    expect(document.querySelector("[data-shortcut]")).toBeNull();
    expect(rowOf("open")).toBeNull();
    fireEvent.click(menu());
    for (const name of ["Approve", "Reject"]) {
      const item = screen.getByRole("menuitem", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
      expect(item.disabled, name).toBe(true);
      expect(item.textContent).toContain("only the owner may send this command (not_owner)");
      expect(item.textContent).not.toContain("`");
    }
    fireEvent.click(screen.getByRole("menuitem", { name: /^Approve/ }));
    await settle();
    expect(state.posts).toEqual([]);
  });
});

