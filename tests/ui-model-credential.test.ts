// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, type ReactElement, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAction } from "../web/src/api.js";

// The Add model credential dialog (design 09-status-page): Needs you's model_credential row names no command and gives its reason
// and a visible Add model credential button that opens the dialog; the Failures page's setup_missing group opens the same dialog. One masked field per
// declared secret, Save and Cancel; Save posts the filled fields with the page's CSRF token. The server is a fake fetch.
// tsconfig.test.json checks this file without JSX, so the views load by a specifier the node check skips.

const BANNER_MODULE = "../web/src/views/system-banner.js";
const FAILURES_MODULE = "../web/src/views/failures.js";
const { CheckRow } = (await import(/* @vite-ignore */ BANNER_MODULE)) as { CheckRow: FunctionComponent<{ action: SystemAction }> };
const { FailuresSection } = (await import(/* @vite-ignore */ FAILURES_MODULE)) as { FailuresSection: FunctionComponent };

const TOKEN = "tok_credential";
const SECRETS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
/** A secret-like value built from parts, so no literal credential sits in the repository. */
const VALUE = ["sk", "ant", "oat01", "z".repeat(24)].join("-");
const AT = "2026-11-22T09:00:00.000Z";
const ROW: SystemAction = { code: "model_credential", text: "Add a model credential", command: "Add model credential, or npm run setup", until: null };

let posts: { url: string; token: string | undefined; body: unknown }[] = [];
let answer: { status: number; body: unknown };

beforeEach(() => {
  posts = [];
  answer = { status: 200, body: { saved: [SECRETS[0]] } };
  // jsdom has no showModal: open by the attribute.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  vi.stubGlobal("location", { ...window.location, search: "" });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, token: (init.headers as Record<string, string>)["x-csrf-token"], body: JSON.parse(String(init.body)) });
      return json(answer.status, answer.body);
    }
    const path = new URL(url, "http://127.0.0.1").pathname;
    if (path === "/api/v1/model-credential") return json(200, { secrets: SECRETS, csrf_token: TOKEN });
    if (path === "/api/v1/failures") {
      const runs = [{ id: "run_1", work_item_id: "wi_1", kind: "triage", attempt: 1, detail: "x", worker: null, finished_at: AT }];
      return json(200, { as_of: AT, window: "24h", cap: 200, total: 2, capped: false, groups: ["setup_missing", "tests_failed"].map((code) => ({ code, count: 1, last_seen: AT, items: 1, runs })) });
    }
    if (path === "/api/v1/items") return json(200, { items: [] });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(el: ReactElement) {
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, el));
}

const dialog = () => screen.findByRole("dialog", { name: "Add a model credential" });

/** Fills `value` into the field labelled `name`, saves, and waits for the dialog to close. */
async function saveIn(d: HTMLElement, name: string, value: string) {
  const save = within(d).getByRole("button", { name: "Save" });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.change(await within(d).findByLabelText(name), { target: { value } });
  expect(save.hasAttribute("disabled")).toBe(false);
  await act(async () => fireEvent.click(save));
}

describe("Needs you: the model credential row", () => {
  it("names no command, gives a reason, and its visible Add model credential button opens the dialog with one masked field per declared secret", async () => {
    mount(createElement("ul", null, createElement(CheckRow, { action: ROW })));
    const row = screen.getByText("Add a model credential").closest("li")!;
    expect(row.textContent).not.toMatch(/npm|setup|`/);
    expect(row.querySelector("code")).toBeNull();
    expect(row.textContent).toContain("agent runs wait");
    expect(row.getAttribute("data-check")).toBe("model_credential");
    expect(within(row).queryByRole("button", { name: "More commands" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Add model credential" }));
    const d = await dialog();
    for (const name of SECRETS) expect((await within(d).findByLabelText(name)).getAttribute("type")).toBe("password");
    expect(within(d).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("Save posts the filled field only, with the page's CSRF token, and closes; the value stays nowhere on the page", async () => {
    mount(createElement("ul", null, createElement(CheckRow, { action: ROW })));
    const row = screen.getByText("Add a model credential").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Add model credential" }));
    await saveIn(await dialog(), SECRETS[0]!, VALUE);
    expect(posts).toEqual([{ url: "/api/v1/model-credential", token: TOKEN, body: { values: { [SECRETS[0]!]: VALUE } } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it("a refusal stays in the open dialog", async () => {
    answer = { status: 403, body: { error: "Only the owner adds a model credential; you are local:other." } };
    mount(createElement("ul", null, createElement(CheckRow, { action: ROW })));
    const row = screen.getByText("Add a model credential").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Add model credential" }));
    const d = await dialog();
    await saveIn(d, SECRETS[1]!, VALUE);
    expect(within(d).getByRole("alert").textContent).toMatch(/Only the owner adds a model credential/);
  });
});

describe("Failures: the setup_missing group", () => {
  it("opens the same dialog; other groups have no such button", async () => {
    mount(createElement(FailuresSection));
    const buttons = await screen.findAllByRole("button", { name: "Add model credential" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest("[data-testid=failure-group]")!.textContent).toContain("Model credential missing");
    fireEvent.click(buttons[0]!);
    await saveIn(await dialog(), SECRETS[0]!, VALUE);
    expect(posts.map((p) => p.url)).toEqual(["/api/v1/model-credential"]);
  });
});
