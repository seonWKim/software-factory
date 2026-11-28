// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { NeedActions } from "../web/src/views/item-commands.js";
import { AT, DECIDE_AT, FACTORY_MSG, base, box, decideDetail, decideState, found, installDecideFixtures, installDialogStub, installItemPageFixtures, mountDecide, mountItem as mount } from "./ui-shell-fixtures.js";

// The item page decisions (design §9, issues #526, #527): In short and the approve confirm, the Reject and Revise dialogs, and the over-cap Approve dialog.

installItemPageFixtures();
installDialogStub();

describe("item page: In short, decisions and the approve confirm (issue #526)", () => {
  const APPROVE = { name: "approve", usage: "/approve [notes]", description: "approve", allowed: true, reason: null };
  const SPEC = {
    in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
    decisions: [
      { question: "Fail the job, or only warn?", options: ["Fail the job", "Only warn"], default: "Fail the job", reason: "A failing job blocks merges.", owner_only: false },
      { question: "Name the step?", options: [], default: "scope", reason: "It shows in CI.", owner_only: false },
      { question: "Who owns the gate?", options: [], default: null, reason: null, owner_only: true },
    ],
  };
  let posts: { url: string; body: unknown }[];

  /** Serves wi_d with `blocked_reason` and the waiting spec (none at a block that is not the spec gate). */
  function serve(blocked_reason: string, stage = "READY") {
    const spec = blocked_reason === "spec_pending" || blocked_reason === "max_revisions" ? SPEC : null;
    const detail = { as_of: AT, item: base("wi_d", 30, "Decisions", { blocked_reason, stage }), timeline: [], runs: [], commands: [APPROVE], replies: [], spec };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        posts.push({ url: path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ request_id: "app:x", seq: 3, command: "approve", work_item_id: "wi_d" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_d": detail,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  /** Clicks Approve once it is enabled; returns the approve dialog, before anything is sent. */
  async function approve() {
    const button = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Approve Decisions" });
    expect(posts).toEqual([]);
    return dialog;
  }

  const send = async (body: unknown) => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_d/commands", body }]));
  };

  it("shows In short above Commands, and each decision as a question: radios with the default selected and write my own, or a prefilled field", async () => {
    serve("spec_pending");
    mount("/app/items/wi_d");
    const commands = await screen.findByRole("region", { name: "Commands" });
    const inShort = screen.getByRole("region", { name: "In short" });
    expect(inShort.compareDocumentPosition(commands) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inShort.textContent).toContain("TO-BE: CI checks the scope.");
    const first = within(commands).getByRole("radiogroup", { name: "1. Fail the job, or only warn?" });
    const radios = within(first).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(["Fail the job(default)", "Only warn", "write my own"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(commands.textContent).toContain("A failing job blocks merges.");
    expect((within(commands).getByRole("textbox", { name: "Answer 2" }) as HTMLInputElement).value).toBe("scope");
    expect((within(commands).getByRole("textbox", { name: "Answer 3" }) as HTMLInputElement).value).toBe("");
    // write my own opens a field for the answer.
    fireEvent.click(radios[2]!);
    fireEvent.change(within(first).getByRole("textbox", { name: "Answer 1" }), { target: { value: "Warn on docs only" } });
    expect(radios[2]!.checked).toBe(true);
  });

  it("a layout decision shows each option's sketch in monospace with the default marked; the others stay plain text", async () => {
    const SKETCH_A = "+--------+\n| Header |\n+--------+\n| Cards  |\n+--------+";
    const SKETCH_B = "+--------+\n| Header |\n+--------+\n| List   |\n+--------+";
    const layout = { question: "Which layout?", options: [SKETCH_A, SKETCH_B], default: SKETCH_B, reason: "A list scans faster.", owner_only: false, layout: true };
    SPEC.decisions.push(layout);
    try {
      serve("spec_pending");
      mount("/app/items/wi_d");
      const group = await screen.findByRole("radiogroup", { name: "4. Which layout?" });
      const sketches = [...group.querySelectorAll("pre")];
      expect(sketches.map((p) => p.textContent)).toEqual([SKETCH_A, SKETCH_B]);
      for (const p of sketches) expect(p.className).toContain("font-mono");
      const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
      expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
      expect(radios[1]!.parentElement!.textContent).toBe(`${SKETCH_B}(default)`);
      expect(group.closest("fieldset")!.hasAttribute("data-layout")).toBe(true);
      const plain = screen.getByRole("radiogroup", { name: "1. Fail the job, or only warn?" });
      expect(plain.querySelector("pre")).toBeNull();
      expect(plain.closest("fieldset")!.hasAttribute("data-layout")).toBe(false);
    } finally {
      SPEC.decisions.pop();
    }
  });

  it("spec waiting for approval: the confirm names the answers and the defaults taken, then sends N: lines and the note", async () => {
    serve("spec_pending");
    mount("/app/items/wi_d");
    fireEvent.click(await screen.findByRole("radio", { name: "Only warn" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Answer 3" }), { target: { value: "the platform team" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "keep it small" } });
    const confirm = await approve();
    expect(confirm.textContent).toContain("You approve the plan waiting for approval.");
    expect([...confirm.querySelectorAll("li")].map((l) => l.textContent)).toEqual([
      "1. Fail the job, or only warn? → Only warn (your answer)",
      "2. Name the step? → scope (default taken)",
      "3. Who owns the gate? → the platform team (your answer)",
    ]);
    expect(confirm.textContent).toContain("Next: The factory starts the implement run on this plan.");
    await send({ command: "approve", note: "1: Only warn\n2: scope\n3: the platform team\nkeep it small" });
  });

  it("spec at the revision limit: the confirm says it is approved as it is, and an unanswered decision with no default is named", async () => {
    serve("max_revisions");
    mount("/app/items/wi_d");
    const confirm = await approve();
    expect(confirm.textContent).toContain("You approve the plan at the revision limit, as it is (no new revision).");
    expect(confirm.textContent).toContain("3. Who owns the gate? → no answer (no default)");
    expect(confirm.textContent).toContain("Next: The factory starts the implement run on this plan.");
    await send({ command: "approve", note: "1: Fail the job\n2: scope" });
  });

  it("floor block: the confirm names the tier raise and what happens next, with no decisions", async () => {
    serve("floor_tier", "RUNNING");
    mount("/app/items/wi_d");
    const confirm = await approve();
    expect(screen.queryByRole("region", { name: "In short" })).toBeNull();
    expect(confirm.querySelector("[data-confirm-answers]")).toBeNull();
    expect(confirm.textContent).toContain("You approve a risk level raise to the risk level the floor check needs.");
    expect(confirm.textContent).toContain("Next: The item's risk level is raised and the implement run starts again.");
    await send({ command: "approve" });
  });

  it("Rule of Two hold: the confirm names the held run and that it starts", async () => {
    serve("rule_of_two", "RUNNING");
    mount("/app/items/wi_d");
    const confirm = await approve();
    expect(confirm.textContent).toContain("You approve the run held for a person by the Rule of Two.");
    expect(confirm.textContent).toContain("Next: The held run starts.");
    await send({ command: "approve" });
  });
});

describe("item page: the Reject and Revise dialogs (issue #527)", () => {
  const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
  let posts: { url: string; body: unknown }[];

  /** Serves wi_r at the spec gate with approve, revise and reject; `extra` sets the item's fields (a PR). */
  function serve(extra: object = {}) {
    const detail = {
      as_of: AT, item: base("wi_r", 40, "Forms", extra), timeline: [], runs: [], commands: ["approve", "revise", "reject"].map(cmd), replies: [], spec: { in_short: "AS-IS: a.\nTO-BE: b.", decisions: [] },
    };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { command: string };
        posts.push({ url: path, body });
        return new Response(JSON.stringify({ request_id: "app:x", seq: 7, command: body.command, work_item_id: "wi_r" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_r": detail,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  /** Clicks `name` once it is enabled; returns its dialog. */
  async function open(name: "reject" | "revise") {
    const label = name === "reject" ? "Reject" : "Revise";
    // Reject is in the item's "…" menu; Revise is a button of the row.
    const button = (await screen.findByRole("button", { name: name === "reject" ? "More commands" : label })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    if (name === "reject") fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    return screen.getByRole("dialog", { name: `${label} Forms` });
  }

  it("Reject opens a Why? form with four reasons and a text box; the reason and the text are sent as the reject note", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("reject");
    expect(within(form).getByText("Why?")).toBeTruthy();
    const reasons = within(within(form).getByRole("radiogroup", { name: "Reason" })).getAllByRole("radio") as HTMLInputElement[];
    expect(reasons.map((r) => r.parentElement!.textContent)).toEqual(["not needed", "wrong approach", "duplicate", "too big; split it"]);
    const confirm = within(form).getByRole("button", { name: "Confirm reject" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(reasons[1]!);
    fireEvent.change(within(form).getByRole("textbox", { name: "Reject details" }), { target: { value: " use the existing hook " } });
    expect(posts).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_r/commands", body: { command: "reject", note: "wrong approach\nuse the existing hook" } }]));
  });

  it("free text alone is a reject note too; Cancel closes the form and sends nothing", async () => {
    serve();
    mount("/app/items/wi_r");
    let form = await open("reject");
    fireEvent.change(within(form).getByRole("textbox", { name: "Reject details" }), { target: { value: "covered by #12" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
    form = await open("reject");
    fireEvent.change(within(form).getByRole("textbox", { name: "Reject details" }), { target: { value: "covered by #12" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ command: "reject", note: "covered by #12" }]));
  });

  it("the Reject confirm says the item closes, and its PR too when it has one", async () => {
    serve();
    mount("/app/items/wi_r");
    let form = await open("reject");
    expect(form.querySelector("[data-dialog-consequence]")!.textContent).toBe("Rejecting closes this item.");
    cleanup();
    serve({ change_ref: "42", change_url: "https://github.com/o/r/pull/42" });
    mount("/app/items/wi_r");
    form = await open("reject");
    expect(form.querySelector("[data-dialog-consequence]")!.textContent).toBe("Rejecting closes this item and its PR #42, without a merge.");
  });

  it("after a Reject is sent, its outcome shows next to the Reject button", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("reject");
    fireEvent.click(within(form).getByRole("radio", { name: "duplicate" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm reject" }));
    const row = await found('[data-outcome-of="reject"]');
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("sent"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Revise shows the spec sections, each with an optional comment box, and sends one revise with only the commented sections", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("revise");
    expect([...form.querySelectorAll("[data-revise-section]")].map((x) => x.getAttribute("data-revise-section"))).toEqual(
      ["In short", "Problem", "Done when", "Scope", "Allowed paths"],
    );
    for (const s of ["In short", "Problem", "Done when", "Scope", "Allowed paths"]) expect(within(form).getByRole("textbox", { name: `Comment on ${s}` })).toBeTruthy();
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Problem" }), { target: { value: " Say why the gate is slow. " } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Allowed paths" }), { target: { value: "Also `docs/`." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send revise" }));
    await waitFor(() => expect(posts).toEqual([{
      url: "/api/v1/items/wi_r/commands",
      body: { command: "revise", note: "### Problem\nSay why the gate is slow.\n\n### Allowed paths\nAlso `docs/`." },
    }]));
    const row = await found('[data-outcome-of="revise"]');
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("sent"));
  });

  it("Revise's five comment boxes have distinct accessible names, one per section", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("revise");
    const names = within(form).getAllByRole("textbox").map((t) => t.getAttribute("aria-label"));
    expect(names).toEqual(["In short", "Problem", "Done when", "Scope", "Allowed paths"].map((s) => `Comment on ${s}`));
    expect(new Set(names).size).toBe(names.length);
  });

  it("Revise stays disabled while no section has a comment; a blank comment does not count", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("revise");
    const send = within(form).getByRole("button", { name: "Send revise" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Scope" }), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(posts).toEqual([]);
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Done when" }), { target: { value: "Add a timing test." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ command: "revise", note: "### Done when\nAdd a timing test." }]));
  });
});

describe("Needs you: an over-cap Approve opens the note dialog (design 09-dashboard-item-commands, 2026-11-24)", () => {
  const OVER = { sizes: { lines: 5000, files: 60 }, caps: { max_diff_lines: 1500, max_diff_files: 40 }, one_time_cap: { max_diff_lines: 5883, max_diff_files: 71 } };
  const approve = (extra: object = {}) => ({ name: "approve", usage: "/approve", description: "d", allowed: true, reason: null, ...extra });
  const reject = { name: "reject", usage: "/reject", description: "d", allowed: true, reason: null };

  /** Renders a Needs-you row's actions with `commands`; returns what it sent. */
  function row(commands: object[]) {
    const sent: [string, string][] = [];
    const cmd = { on: true, busy: false, local: {}, send: async (c: string, n: string) => (sent.push([c, n]), true) };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NeedActions id="wi_1" title="Big change" commands={commands} pr={null} group="approve" checking={false} cmd={cmd} allow={[]} />
      </QueryClientProvider>,
    );
    return sent;
  }
  const menuApprove = async () => {
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Approve" }));
  };

  it("the menu's Approve opens the dialog with the size, the cap, the one-time cap and a note; Confirm waits for the note and sends it trimmed", async () => {
    const sent = row([approve({ over_cap: OVER }), reject]);
    await menuApprove();
    const dialog = await screen.findByRole("dialog", { name: "Approve Big change" });
    expect(sent).toEqual([]);
    const facts = dialog.querySelector("[data-over-cap]")!.textContent;
    expect(facts).toContain("5000 lines in 60 files");
    expect(facts).toContain("1500 lines in 40 files");
    expect(facts).toContain("5883 lines in 71 files");
    const confirm = within(dialog).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Why approve it over the cap" }), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Why approve it over the cap" }), { target: { value: "  one generated table  " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(sent).toEqual([["approve", "one generated table"]]));
  });

  it("the p key's hidden button opens the same dialog and sends nothing", async () => {
    const sent = row([approve({ over_cap: OVER })]);
    fireEvent.click(document.querySelector<HTMLElement>("[data-shortcut=p]")!);
    expect(await screen.findByRole("dialog", { name: "Approve Big change" })).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("an Approve that is not over the caps sends at once, with no dialog", async () => {
    const sent = row([approve(), reject]);
    await menuApprove();
    await waitFor(() => expect(sent).toEqual([["approve", ""]]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("item page: DecisionCard", () => {
  installDecideFixtures();

  it("orders the page: the card, the current run, the thread (collapsed after its first message), the runs, the timeline", async () => {
    const older = { ...FACTORY_MSG, seq: 3, anchor: "msg-3", at: "2026-11-11T00:00:00.000Z", body: "An older message." };
    decideState.body = decideDetail({
      thread: [older, FACTORY_MSG],
      runs: [...decideDetail().runs, { id: "run_i1", kind: "implement", status: "running", attempt: 1, started_at: DECIDE_AT, finished_at: null, created_at: DECIDE_AT, tokens: 0, error: null, attempts: [{ attempt: 1, worker_id: "mac-mini:4242:2" }] }],
    });
    mountDecide();
    const order = [
      await box(),
      screen.getByRole("region", { name: "Current run" }),
      screen.getByRole("region", { name: "Thread" }),
      screen.getByRole("region", { name: "Runs" }),
      screen.getByRole("region", { name: "Timeline" }),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.textContent).toContain("Running"); // the run pill shows the state table's label
    // A running run links to its transcript before any of it is stored.
    expect(within(order[1]!).getByRole("link", { name: "Transcript" }).getAttribute("href")).toMatch(/\/items\/[^/]+\/runs\/run_i1$/);
    // The thread shows its first message; the rest wait behind one button.
    const list = screen.getByRole("list", { name: "Thread" });
    expect(list.dataset.collapsed).toBe("true");
    expect(list.querySelector("li")!.id).toBe("msg-7");
    const more = within(order[2]!).getByRole("button", { name: "Show 1 earlier message" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(list.dataset.collapsed).toBe("false");
  });

  it("has no control without an accessible name", async () => {
    mountDecide();
    await box();
    const result = await axe.run(document.querySelector("main")!, {
      runOnly: ["button-name", "select-name", "label", "aria-input-field-name", "link-name", "summary-name", "input-button-name"],
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });

  it("has no command prose in the page body: no /approve, /reject or /verdict text and no terminal line", async () => {
    mountDecide();
    await box();
    const main = document.querySelector("main")!;
    expect(main.textContent).not.toMatch(/\/(approve|reject|verdict)\b/);
    expect(main.textContent).not.toContain("From a terminal");
    expect(main.querySelector("[data-cli-hint]")).toBeNull();
  });

  it("shows the owner as you and a worker as worker N, each ID in a tooltip on its name; the timeline names them in its sentences", async () => {
    mountDecide();
    await box();
    const timeline = screen.getByRole("region", { name: "Timeline" });
    expect(timeline.textContent).toContain("Created by you");
    expect(timeline.textContent).toContain("A person asked for a retry");
    const runs = screen.getByRole("table", { name: "Runs" });
    const worker = runs.querySelector("[data-id]")!;
    expect(worker.tagName).toBe("BUTTON");
    expect(worker.textContent).toBe("worker 3");
    expect(runs.querySelector("details")).toBeNull();
    fireEvent.mouseEnter(worker.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("mac-mini:4242:3");
    // "Acting as" names the viewer as you too.
    expect(document.querySelector("[data-commands-actor] [data-id]")!.textContent).toBe("you");
  });
});
