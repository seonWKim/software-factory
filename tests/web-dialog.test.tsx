// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, ModalPanel } from "../web/src/components/ui/dialog.js";
import { NeedsList } from "../web/src/views/task-work.js";
import { ApproveDialog } from "../web/src/views/item-decisions.js";

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
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    // A re-read of the session (the row's own query) keeps commands on.
    if (init?.method !== "POST") {
      const body = String(url).startsWith("/api/v1/session") ? { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
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

  it("only a destructive confirm is filled with the failed token, with on-solid text", () => {
    render(<Host onConfirm={() => {}} danger />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    const classes = (name: string) => screen.getByRole("button", { name }).className.split(/\s+/);
    expect(classes("Do it")).toEqual(expect.arrayContaining(["bg-failed", "text-on-solid"]));
    expect(classes("Cancel")).not.toContain("bg-failed");
    cleanup();
    render(<Host onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    expect(classes("Do it")).not.toContain("bg-failed");
  });

  it("only the body scrolls: the title and the Cancel and confirm footer sit outside it, so a tall form keeps its buttons in view", () => {
    render(<Host onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    const dialog = screen.getByRole("dialog");
    const body = dialog.querySelector<HTMLElement>("[data-dialog-body]")!;
    const footer = dialog.querySelector<HTMLElement>("[data-dialog-footer]")!;
    expect(body.className.split(/\s+/)).toEqual(expect.arrayContaining(["overflow-y-auto", "min-h-0"]));
    expect(body.contains(screen.getByRole("textbox", { name: "Field" }))).toBe(true);
    expect(body.contains(footer)).toBe(false);
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Do it"]);
    expect(footer.className).toContain("shrink-0");
    // The dialog itself does not scroll, else the footer scrolls away with the body.
    expect(dialog.className).not.toMatch(/\boverflow-y-auto\b/);
    expect(dialog.className).toContain("overflow-hidden");
  });

  it("sizes to its content: no box between the dialog and its fields grows from a zero basis, which WebKit draws as a 2px line (owner #82)", () => {
    render(<><Host onConfirm={() => {}} /><PanelHost /></>);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    fireEvent.click(screen.getByRole("button", { name: "open panel" }));
    for (const dialog of screen.getAllByRole("dialog")) {
      // Every box from the dialog down to the body that holds the content: the form, the Dialog body, the panel body.
      const body = dialog.querySelector<HTMLElement>("[data-dialog-body], [data-panel-body]")!;
      const chain: HTMLElement[] = [];
      for (let el: HTMLElement | null = body; el && el !== dialog; el = el.parentElement) chain.push(el);
      expect(chain.length).toBeGreaterThan(0);
      for (const el of chain) {
        // flex-1 is flex: 1 1 0%; Safari and the cmux browser size a fit-content <dialog> from that 0 basis.
        expect(el.className.split(/\s+/)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(flex-1|basis-0|grow)$/)]));
        // It still shrinks to the dialog's max height, so only the body scrolls.
        expect(el.className.split(/\s+/)).toContain("min-h-0");
      }
    }
  });

  it("the dialog and the stylesheet carry no hard-coded colours, and the dialog fills a phone with a 16 px gutter", () => {
    const dialog = readFileSync("web/src/components/ui/dialog.tsx", "utf8");
    for (const text of [dialog, readFileSync("web/src/index.css", "utf8")]) expect(text).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
    expect(dialog).toContain("w-[calc(100%-2rem)]");
  });
});

/** A button that opens a ModalPanel holding a field. */
function PanelHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open panel</button>
      {open && (
        <ModalPanel title="Reference" onClose={() => setOpen(false)}>
          <p>Body text</p>
        </ModalPanel>
      )}
    </>
  );
}

describe("ModalPanel", () => {
  const open = () => {
    const opener = screen.getByRole("button", { name: "open panel" });
    opener.focus();
    fireEvent.click(opener);
    return opener;
  };

  it("has the title in its header with a Close icon button, and focus goes to its body, then back to the opener", () => {
    render(<PanelHost />);
    const opener = open();
    const panel = screen.getByRole("dialog", { name: "Reference" });
    expect(within(panel).getByRole("heading", { name: "Reference" }).closest("header")!.contains(within(panel).getByRole("button", { name: "Close" }))).toBe(true);
    expect(document.activeElement).toBe(panel.querySelector("[data-panel-body]"));
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Esc closes it; a click on the backdrop closes it, a click inside does not", () => {
    render(<PanelHost />);
    open();
    fireEvent.keyDown(screen.getByText("Body text"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.click(screen.getByText("Body text"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a press that starts inside and ends on the backdrop (selecting text) does not close it", () => {
    render(<PanelHost />);
    open();
    fireEvent.pointerDown(screen.getByText("Body text"));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The next press on the backdrop alone still closes it.
    fireEvent.pointerDown(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the verdict dialog on a Needs-you row", () => {
  function mountRow() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/api/v1/session"], { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" });
    const item = {
      id: "wi_1", source: { type: "github_issue", id: "o/r#1", link: "https://github.com/o/r/issues/1" }, title: "Spec waiting", item_phase: "needs_approval", reason_code: "person",
      stage: "READY", tier: 2, kind: null, blocked_on: "human", blocked_reason: null, close_reason: null, run_status: null, change_ref: null, change_url: null,
      since: AT, updated_at: AT, version: 1, dependents: 0, conflicts: { automatic: 0, person: 0 }, need: { reason: "spec ready", anchor: null },
      commands: ["approve", "verdict", "reject", "revise"].map(cmd),
    };
    return render(
      <QueryClientProvider client={client}>
        <NeedsList items={[item]} />
      </QueryClientProvider>,
    );
  }

  const openFromMenu = (name: string) => {
    const more = screen.getByRole("button", { name: "More commands" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name }));
    return more;
  };

  it("the dialog title is the action and the item's title, one truncated line with the title in its tooltip", () => {
    mountRow();
    openFromMenu("Verdict");
    const heading = within(screen.getByRole("dialog", { name: "Verdict Spec waiting" })).getByRole("heading");
    expect(heading.className.split(" ")).toContain("truncate");
    expect(heading.getAttribute("title")).toBe("Verdict Spec waiting");
  });

  it("the verdict dialog sends nothing for Changes or Reject until a reason is typed; Accept sends with no reason", async () => {
    mountRow();
    const more = openFromMenu("Verdict");
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    const send = () => screen.getByRole("button", { name: "Send verdict" }) as HTMLButtonElement;
    for (const kind of ["Changes", "Reject"]) {
      fireEvent.click(screen.getByRole("radio", { name: kind }));
      expect(send().disabled, kind).toBe(true);
      // Submitting the form directly (Enter) with no reason, then with a blank one, sends nothing either.
      fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
      fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "  " } });
      expect(send().disabled, kind).toBe(true);
      fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    }
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: "Reject" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Verdict severity" }));
    fireEvent.click(within(screen.getByRole("listbox")).getAllByRole<HTMLButtonElement>("option").find((o) => o.value === "major")!);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "wrong approach" } });
    fireEvent.click(send());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts.map((p) => p.body)).toEqual([{ command: "verdict", note: "reject major wrong approach" }]);
    await waitFor(() => expect(document.activeElement).toBe(more));
    // Accept sends with no reason.
    openFromMenu("Verdict");
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toEqual({ command: "verdict", note: "accept none" });
  });

  it("Esc in the verdict, reject and revise dialogs sends nothing and closes them", () => {
    mountRow();
    for (const name of ["Verdict", "Reject", "Revise"]) {
      openFromMenu(name);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog"), name).toBeNull();
    }
    expect(posts).toEqual([]);
  });

  it("confirm buttons are filled accent, the reject confirm is filled with the bad token, Cancel is an outline", () => {
    mountRow();
    const classes = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name }).className.split(/\s+/);
    for (const [menu, confirm] of [["Verdict", "Send verdict"], ["Revise", "Send revise"]]) {
      openFromMenu(menu!);
      expect(classes(confirm!), confirm).toEqual(expect.arrayContaining(["bg-accent", "text-on-solid"]));
      expect(classes("Cancel")).toEqual(expect.arrayContaining(["border", "border-border-strong", "bg-surface"]));
      expect(classes("Cancel")).not.toContain("bg-accent");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    }
    openFromMenu("Reject");
    expect(classes("Confirm reject")).toEqual(expect.arrayContaining(["bg-failed", "text-on-solid"]));
    expect(classes("Confirm reject")).not.toContain("bg-accent");
    expect(classes("Cancel")).not.toContain("bg-failed");
  });
});

describe("the approve dialog", () => {
  const ANSWERS = [{ n: 1, question: "Fail the job, or only warn?", answer: "Only warn", isDefault: false }];
  function Approve({ onSend }: { onSend: (note: string) => void }) {
    const [open, setOpen] = useState(true);
    const opener = useRef<HTMLButtonElement>(null);
    return open ? (
      <ApproveDialog title="Approve Spec waiting" phase="spec_pending" answers={ANSWERS} note="keep it small" busy={false} error={null} returnFocusTo={opener} onSend={onSend} onClose={() => setOpen(false)} />
    ) : null;
  }

  it("shows the question with its answer, an optional note, the Next line, then Cancel on the left and Approve on the right; focus is inside", () => {
    render(<Approve onSend={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Approve Spec waiting" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const order = [
      dialog.querySelector("[data-confirm-answers]")!,
      within(dialog).getByRole("textbox", { name: "Note" }),
      dialog.querySelector("[data-confirm-next]")!,
      within(dialog).getByRole("button", { name: "Cancel" }),
      within(dialog).getByRole("button", { name: "Approve" }),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    expect(dialog.querySelector("[data-confirm-answers]")!.textContent).toBe("1. Fail the job, or only warn? → Only warn (your answer)");
    expect(dialog.querySelector("[data-confirm-next]")!.textContent).toBe("Next: The factory starts the implement run on this plan.");
  });

  it("an answer whose option needs a path outside the allowed paths shows the path and its done-when change, warns in a Notice and sends nothing (design 09-dashboard-item-commands, 2026-11-21)", () => {
    const change = { option: "Only warn", extra_paths: ["docs/ci.md"], done_when: ["CI warns on an outside path"], uncovered_paths: ["docs/ci.md"] };
    const onSend = vi.fn();
    const opener = { current: null };
    const answers = [{ ...ANSWERS[0], change }];
    render(<ApproveDialog title="Approve Spec waiting" phase="spec_pending" answers={answers} note="" busy={false} error={null} returnFocusTo={opener} onSend={onSend} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Approve Spec waiting" });
    expect(dialog.querySelector("[data-confirm-answers] [data-option-change]")!.textContent).toBe("Needs docs/ci.md. Changes done when: CI warns on an outside path");
    const warning = within(dialog).getByRole("alert");
    expect(warning.textContent).toContain("docs/ci.md");
    expect(warning.textContent).toContain("/approve +paths docs/ci.md");
    expect(warning.closest("[data-option-paths-warning]")).not.toBeNull();
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    fireEvent.click(approve);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("the default answer, or a change whose paths are covered, needs no warning and Approve stays on", () => {
    const covered = { option: "Only warn", extra_paths: ["docs/ci.md"], done_when: [], uncovered_paths: [] };
    const opener = { current: null };
    for (const answers of [[{ ...ANSWERS[0], change: covered }], [{ ...ANSWERS[0], isDefault: true, change: { ...covered, uncovered_paths: ["docs/ci.md"] } }]]) {
      render(<ApproveDialog title="Approve" phase="spec_pending" answers={answers} note="" busy={false} error={null} returnFocusTo={opener} onSend={() => {}} onClose={() => {}} />);
      const dialog = screen.getByRole("dialog", { name: "Approve" });
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false);
      cleanup();
    }
  });

  it("Approve sends the answers and the note once; Esc sends nothing and closes it", () => {
    const onSend = vi.fn();
    render(<Approve onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    cleanup();
    render(<Approve onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("1: Only warn\nkeep it small");
  });
});
