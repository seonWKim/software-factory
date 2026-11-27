// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AT, base, found, installDialogStub, installItemPageFixtures, mountItem as mount } from "./ui-shell-fixtures.js";

// The item page command box (design §9, issues #528, #453): refusals and the viewer's grants, the command box and pending proposals.

installItemPageFixtures();
installDialogStub();

describe("item page: refusals and the viewer's grants (issues #528, #453)", () => {
  const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
  const STORED = "`/approve` was not applied: the spec is not waiting for approval (the item is triaging).";
  const NOT_OWNER = "only the owner may send this command (`not_owner`)";

  /** Serves wi_g with `detail`'s commands and replies. */
  function serve(detail: object) {
    const body = { as_of: AT, item: base("wi_g", 50, "Grants"), timeline: [], runs: [], commands: [], replies: [], spec: null, ...detail };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.split("?")[0]!;
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_g": body,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:helper", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const out = bodies[path];
      if (out === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  it("a refusal shows as plain text beside its control, with no backticks; the stored text keeps them", async () => {
    const replies = [{ seq: 3, command: "approve", created_at: AT, handled_at: AT, refusal: STORED }];
    serve({ commands: [cmd("approve")], replies });
    mount("/app/items/wi_g");
    const row = await found('[data-outcome-of="approve"]');
    const shown = await waitFor(() => within(row).getByRole("alert"));
    expect(shown.textContent).toBe("/approve was not applied: the spec is not waiting for approval (the item is triaging).");
    expect(replies[0]!.refusal).toBe(STORED);
  });

  it("a command the owner check refuses is a disabled button with the controller's reason below the row, in plain text", async () => {
    serve({ commands: ["approve", "reject", "revise"].map((n) => ({ ...cmd(n), allowed: false, reason: NOT_OWNER })) });
    mount("/app/items/wi_g");
    await found('button[data-action="approve"]');
    for (const name of ["Approve", "Revise"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    // Reject is in the "…" menu, disabled with its reason in its label.
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    const reject = screen.getByRole("menuitem", { name: /^Reject/ }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    expect(reject.textContent).toContain("only the owner may send this command (not_owner)");
    for (const name of ["approve", "revise"]) {
      expect(document.querySelector(`[data-outcome-of="${name}"]`)!.textContent).toContain("only the owner may send this command (not_owner)");
    }
    expect(document.querySelector("[data-decide]")!.textContent).not.toContain("`");
    expect(document.querySelector("[data-commands-none]")).toBeNull();
  });
});

describe("item page: the command box and pending proposals (design 09-dashboard-app)", () => {
  let posts: { url: string; body: unknown }[];
  const PROPOSALS = [
    { id: "prop_one", created_at: AT, commands: [{ index: 0, work_item_id: "wi_b", line: "/approve ship it" }, { index: 1, work_item_id: "wi_c", line: "/reject not needed" }] },
    { id: "prop_two", created_at: AT, commands: [{ index: 0, work_item_id: "wi_b", line: "/retry" }] },
  ];

  /** Serves wi_b, running (no command applies) or at the spec gate, with `proposals`; records every POST. */
  function serve(commands: string[], proposals: unknown[]) {
    const detail = {
      as_of: AT, item: base("wi_b", 50, "Box"), timeline: [], runs: [], replies: [], spec: null, proposals,
      commands: commands.map((name) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null })),
    };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        posts.push({ url: path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ request_id: "app:x", seq: 9, command: "x", work_item_id: "wi_b" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_b": detail,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  /** `name` in `scope` once it is enabled. */
  async function enabled(scope: HTMLElement, name: string) {
    const button = within(scope).getByRole("button", { name }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    return button;
  }

  it("shows each pending proposal with its commands, a Confirm all and a Cancel; each press sends one request carrying its proposal ID", async () => {
    serve(["approve", "reject", "revise"], PROPOSALS);
    mount("/app/items/wi_b");
    const list = await screen.findByRole("list", { name: "Proposed commands" });
    const shown = [...list.querySelectorAll<HTMLElement>("[data-proposal]")];
    expect(shown.map((p) => p.dataset.proposal)).toEqual(["prop_one", "prop_two"]);
    expect(shown[0]!.textContent).toContain("/approve ship it");
    expect(shown[0]!.textContent).toContain("/reject not needed");
    expect(shown[0]!.textContent).toContain("wi_c");
    fireEvent.click(await enabled(shown[0]!, "Confirm all"));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_b/commands", body: { command: "proposal_confirm", proposal: "prop_one" } }]));
    fireEvent.click(await enabled(shown[1]!, "Cancel"));
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([
      { command: "proposal_confirm", proposal: "prop_one" },
      { command: "proposal_cancel", proposal: "prop_two" },
    ]));
    await waitFor(() => expect(within(shown[0]!).getByRole("status").textContent).toBe("sent"));
  });

  it("the one note box reads its words as a sentence on Ctrl+Enter, also when no typed command applies; an empty box sends nothing", async () => {
    serve(["approve"], []);
    mount("/app/items/wi_b");
    const box = (await screen.findByRole("textbox", { name: "Note" })) as HTMLTextAreaElement;
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText("Say it in your own words")).toBeNull();
    expect(document.querySelector("[data-command-box]")).toBeNull();
    expect(screen.queryByRole("list", { name: "Proposed commands" })).toBeNull();
    await enabled(document.body, "Approve");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(posts).toEqual([]);
    fireEvent.change(box, { target: { value: "  approve wi_b but keep it small " } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_b/commands", body: { command: "sentence", note: "approve wi_b but keep it small" } }]));
    await waitFor(() => expect(box.value).toBe(""));
  });
});
