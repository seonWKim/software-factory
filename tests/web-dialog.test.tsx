// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../web/src/components/ui/dialog.js";
import { ItemsTable } from "../web/src/views/common.js";

// The shared native dialog (design §9): Esc and a click outside cancel without sending, focus goes in and comes
// back to the button that opened it, Enter in the verdict field sends once, the reject confirm is in the failed colour.

const AT = "2026-11-07T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: `${name} it`, allowed: true, reason: null });
let posts: { body: unknown }[];

beforeEach(() => {
  // jsdom has no showModal: open and close by the attribute.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    const body = JSON.parse(String(init.body));
    posts.push({ body });
    return new Response(JSON.stringify({ request_id: "app:x", seq: 1, command: body.command, work_item_id: "wi_1" }), { status: 202, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A button that opens a Dialog, which reports confirms and closes. */
function Host({ onConfirm, danger = false }: { onConfirm: () => void; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} onClick={() => setOpen(true)}>open it</button>
      {open && (
        <Dialog title="Do it to wi_1" consequence="It is done." confirmLabel="Do it" danger={danger} returnFocusTo={opener} onConfirm={onConfirm} onClose={() => setOpen(false)}>
          <input aria-label="Field" />
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("has a title, a consequence line, and Cancel then confirm (confirm on the right)", () => {
    render(<Host onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    const dialog = screen.getByRole("dialog", { name: "Do it to wi_1" });
    expect(dialog.querySelector("[data-dialog-consequence]")!.textContent).toBe("It is done.");
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Do it"]);
  });

  it("Esc cancels without confirming", () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a click outside (on the backdrop, the dialog element itself) cancels; a click inside does not", () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    fireEvent.click(screen.getByRole("textbox", { name: "Field" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("focus moves into the dialog on open and back to the opening button on close", () => {
    render(<Host onConfirm={() => {}} />);
    const opener = screen.getByRole("button", { name: "open it" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
  });

  it("Enter in the single-line field confirms once", () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Field" }), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("only a destructive confirm uses the failed colour variable", () => {
    render(<Host onConfirm={() => {}} danger />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    expect(screen.getByRole("button", { name: "Do it" }).className).toContain("(--color-red-700)");
    expect(screen.getByRole("button", { name: "Cancel" }).className).not.toContain("red");
  });

  it("the dialog and the stylesheet carry no hard-coded colours, and the dialog fills a phone with a 16 px gutter", () => {
    const dialog = readFileSync("web/src/components/ui/dialog.tsx", "utf8");
    for (const text of [dialog, readFileSync("web/src/index.css", "utf8")]) expect(text).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
    expect(dialog).toContain("w-[calc(100%-2rem)]");
  });
});

describe("the verdict dialog on a Needs-you row", () => {
  function mountRow() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/api/v1/session"], { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" });
    const item = {
      id: "wi_1", source: { type: "github_issue", id: "o/r#1", link: "https://github.com/o/r/issues/1" }, title: "Spec waiting", level: "needs_approval", badges: [],
      stage: "READY", tier: 2, kind: null, blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null,
      since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, need: { reason: "spec ready", anchor: null },
      commands: [cmd("approve"), cmd("verdict")],
    };
    return render(
      <QueryClientProvider client={client}>
        <ItemsTable items={[item]} now={Date.parse(AT)} label="Needs you" empty="none" actions />
      </QueryClientProvider>,
    );
  }

  it("Enter in the verdict field sends exactly one command; focus returns to the ⋯ button", async () => {
    mountRow();
    const more = screen.getByRole("button", { name: "More commands" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "verdict" }));
    const field = screen.getByRole("textbox", { name: "Verdict" });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.change(field, { target: { value: "changes minor tighten the tests" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts.map((p) => p.body)).toEqual([{ command: "verdict", note: "changes minor tighten the tests" }]);
    expect(document.activeElement).toBe(more);
  });

  it("Esc in the verdict dialog sends nothing", async () => {
    mountRow();
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "verdict" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Verdict" }), { target: { value: "accept none" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
  });
});
