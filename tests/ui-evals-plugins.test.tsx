// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW, json, run } from "./ui-evals-fixtures.js";


// The Plugins page's Evals panel (design 09-dashboard-settings, 2026-11-24): an Evals button on each Skills row with a
// SKILL.md path opens the Evals content in a modal panel titled with the skill's name; closing it returns focus to the button. It reads /suite and /runs for the path,
// writes through POST /api/v1/evals/write with GET /api/v1/pauses's token, and opens every input, delete and try
// result in a Dialog; a 409 stays in the open Dialog. The reads and writes are a fake fetch.

const PLUGINS_MODULE = "../web/src/views/plugins.js";
const { PluginsPage } = (await import(/* @vite-ignore */ PLUGINS_MODULE)) as { PluginsPage: FunctionComponent };

const PATH = "/home/me/.claude/skills/review-plan/SKILL.md";
const ENC = encodeURIComponent(PATH);
const SUITE = { id: "suite_abc1", skill_ref: PATH, title: "Plan reviews" };
const CASES = [
  { id: "case_one1", suite_id: SUITE.id, input: "Review this plan: ship it.", expected: ["Names a risk", "Says yes or no"] },
  { id: "case_two2", suite_id: SUITE.id, input: { plan: "x" }, expected: { checks: ["Is short"] } },
];
const SKILL_ROWS = [
  { name: "review-plan", folder: "/home/me/.claude/skills", description: null, roles: [], last_used: null, source: "claude", path: PATH, state: "ok" },
  { name: "tests-first", folder: "skills", description: null, roles: [], last_used: null },
];

let suiteView: { suite: typeof SUITE | null; cases: typeof CASES } = { suite: SUITE, cases: CASES };
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let writes: unknown[] = [];
let starterOff: string | null | undefined = null;

function stubPlugins() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.method === "POST") {
      writes.push({ url, token: (init.headers as Record<string, string>)["x-csrf-token"], body: JSON.parse(String(init.body)) });
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/plugins") return json(200, { as_of: "2026-11-24T00:00:00.000Z", csrf_token: "t", mcp: [], tools: [], skills: SKILL_ROWS, skill_folders: ["skills"], settings_token: "s" });
    if (url === "/api/v1/evals") return json(200, { skills: [], ...(starterOff !== undefined && { starter: starterOff }) });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: "tok_evals" });
    if (url === `/api/v1/evals/${ENC}/suite`) return json(200, suiteView);
    if (url === `/api/v1/evals/${ENC}/runs`) return json(200, { runs: [run("run_a1", 20, { suite_id: SUITE.id }), run("run_b2", 19, { suite_id: SUITE.id }), run("run_old", 1, { suite_id: "suite_gone" })] });
    return json(404, { error: "Not found." });
  }));
}

async function openCard() {
  history.replaceState(null, "", "/app/plugins?tab=skills");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PluginsPage)));
  fireEvent.click(await screen.findByRole("button", { name: "Evals for review-plan" }, SLOW));
  return screen.findByRole("dialog", { name: "Evals: review-plan" }, SLOW);
}

// The panel is a dialog too; a Dialog it opens is the last one.
const dialog = () => screen.getAllByRole("dialog").at(-1)!;
const confirmIn = (name: string) => fireEvent.click(within(dialog()).getByRole("button", { name }));
const closed = () => vi.waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), SLOW);

describe("Plugins Skills tab: the Evals card", () => {
  beforeEach(() => {
    suiteView = { suite: SUITE, cases: CASES };
    answer = { status: 200, body: {} };
    writes = [];
    starterOff = null;
    stubPlugins();
  });

  it("has an Evals button on each row with a SKILL.md path, and an off one with its reason on a row without", async () => {
    history.replaceState(null, "", "/app/plugins?tab=skills");
    render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PluginsPage)));
    const on = await screen.findByRole("button", { name: "Evals for review-plan" }, SLOW);
    const off = screen.getByRole("button", { name: "Evals for tests-first" });
    expect((on as HTMLButtonElement).disabled).toBe(false);
    expect((off as HTMLButtonElement).disabled).toBe(true);
    expect(off.getAttribute("title")).toBe("Only a skill with a SKILL.md file can have evals.");
  });

  it("opens a dialog titled with the skill's name, with no aria-pressed on the button, reading the suite for the URL-encoded path", async () => {
    const card = await openCard();
    expect(screen.getByRole("button", { name: "Evals for review-plan" }).hasAttribute("aria-pressed")).toBe(false);
    expect(urls).toContain(`/api/v1/evals/${ENC}/suite`);
    const cases = await within(card).findByRole("table", undefined, SLOW);
    expect(within(cases).getAllByRole("row")).toHaveLength(CASES.length + 1);
    expect(card.textContent).toContain("Plan reviews");
    // Plain words: no suite, case or run ID, and no SKILL.md path.
    expect(card.textContent).not.toMatch(/suite_|case_|run_|SKILL\.md/);
  });

  it("closing the dialog (close button, Esc or the backdrop) returns focus to that row's Evals button", async () => {
    await openCard();
    const button = screen.getByRole("button", { name: "Evals for review-plan" });
    const close = [
      (card: HTMLElement) => fireEvent.click(within(card).getByRole("button", { name: "Close" })),
      (card: HTMLElement) => fireEvent.keyDown(card, { key: "Escape" }),
      (card: HTMLElement) => fireEvent.click(card),
    ];
    for (const how of close) {
      how(screen.getByRole("dialog", { name: "Evals: review-plan" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      await screen.findByRole("dialog", { name: "Evals: review-plan" }, SLOW);
    }
  });

  it("offers Add test set only when the skill has none, and posts suite.add with the pauses token", async () => {
    suiteView = { suite: null, cases: [] };
    const card = await openCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Add test set" }, SLOW));
    await vi.waitFor(() => expect(dialog()).toBeTruthy());
    confirmIn("Add test set");
    await vi.waitFor(() => expect(writes).toHaveLength(1), SLOW);
    expect(writes[0]).toEqual({ url: "/api/v1/evals/write", token: "tok_evals", body: { op: "suite.add", skill: PATH, title: "review-plan" } });
    cleanup();
    suiteView = { suite: SUITE, cases: CASES };
    const full = await openCard();
    await within(full).findByRole("table", undefined, SLOW);
    expect(within(full).queryByRole("button", { name: "Add test set" })).toBeNull();
  });

  it("renames the suite and adds, edits, tries and imports cases through Dialogs", async () => {
    const card = await openCard();
    await within(card).findByRole("table", undefined, SLOW);
    const rowHeights = () => within(card).getAllByRole("row").map((r) => r.textContent);
    const before = rowHeights();

    fireEvent.click(within(card).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(dialog()).getByLabelText("Name"), { target: { value: "Reviews" } });
    // Opening an input changes no row of the card.
    expect(rowHeights()).toEqual(before);
    confirmIn("Rename");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "suite.rename", skill: PATH, title: "Reviews" } }), SLOW);
    await closed();

    fireEvent.click(within(card).getByRole("button", { name: "Add case" }));
    fireEvent.change(within(dialog()).getByLabelText("What the skill is given"), { target: { value: "A plan" } });
    fireEvent.change(within(dialog()).getByLabelText("Checks, one per line"), { target: { value: "One\n\n Two \n" } });
    confirmIn("Add case");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "case.add", skill: PATH, input: "A plan", expected: ["One", "Two"] } }), SLOW);
    await closed();

    fireEvent.click(within(card).getByRole("button", { name: "Edit case 1" }));
    expect((within(dialog()).getByLabelText("What the skill is given") as HTMLTextAreaElement).value).toBe(CASES[0]!.input);
    fireEvent.change(within(dialog()).getByLabelText("Checks, one per line"), { target: { value: "Names a risk" } });
    confirmIn("Save");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "case.edit", case: "case_one1", expected: ["Names a risk"] } }), SLOW);
    expect((writes.at(-1) as { body: object }).body).not.toHaveProperty("input");
    await closed();

    answer = { status: 200, body: { op: "case.try", case: "case_two2", source: "agents-home", tried: { verdict: "fail", checks: [{ check: "Is short", answer: "no", reason: "It runs long." }], error: null } } };
    fireEvent.click(within(card).getByRole("button", { name: "Try case 2" }));
    confirmIn("Try");
    await within(dialog()).findByText("Failed", undefined, SLOW);
    expect(dialog().textContent).toContain("It runs long.");
    expect(writes.at(-1)).toMatchObject({ body: { op: "case.try", case: "case_two2" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await closed();

    answer = { status: 200, body: { op: "import", skill: PATH, source: "agents-home", added: ["a", "b"], kept: ["c"] } };
    fireEvent.click(within(card).getByRole("button", { name: "Import cases" }));
    confirmIn("Import cases");
    await within(dialog()).findByText("Added 2; 1 already here.", undefined, SLOW);
    expect(writes.at(-1)).toMatchObject({ body: { op: "import", skill: PATH } });
  });

  it("each delete Dialog says how many of the suite's runs keep their history, and posts the delete", async () => {
    const card = await openCard();
    await within(card).findByRole("table", undefined, SLOW);
    fireEvent.click(within(card).getByRole("button", { name: "Delete test set" }));
    await within(dialog()).findByText("2 past runs keep their history.", undefined, SLOW);
    expect(urls).toContain(`/api/v1/evals/${ENC}/runs`);
    confirmIn("Delete");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "suite.delete", skill: PATH } }), SLOW);
    await closed();

    fireEvent.click(within(card).getByRole("button", { name: "Delete case 2" }));
    await within(dialog()).findByText("2 past runs keep their history.", undefined, SLOW);
    confirmIn("Delete");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "case.delete", case: "case_two2" } }), SLOW);
  });

  it("shows a 409 refusal in the open Dialog and reads nothing again", async () => {
    const card = await openCard();
    await within(card).findByRole("table", undefined, SLOW);
    answer = { status: 409, body: { error: "expected must be a list of rubric check texts: nothing written" } };
    fireEvent.click(within(card).getByRole("button", { name: "Add case" }));
    fireEvent.change(within(dialog()).getByLabelText("What the skill is given"), { target: { value: "A plan" } });
    fireEvent.change(within(dialog()).getByLabelText("Checks, one per line"), { target: { value: "One" } });
    const reads = urls.filter((u) => u.endsWith("/suite")).length;
    confirmIn("Add case");
    await within(dialog()).findByText(/nothing written/, undefined, SLOW);
    expect(urls.filter((u) => u.endsWith("/suite")).length).toBe(reads);
    expect(within(card).getAllByRole("row")).toHaveLength(CASES.length + 1);
  });
});

// Draft starter cases (design 07-self-improvement): beside Add test set on a skill with no cases; its Dialog drafts with
// starter.draft (nothing saved), lists the drafts and accepts the whole set in one starter.accept.
describe("Plugins Skills tab: Draft starter cases", () => {
  const rubric = (criterion: string) => ({ kind: "rubric", criterion, anchors: { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" } });
  const DRAFTS = [
    { kind: "edge", title: "Empty plan", input: "Review this plan: (empty)", expected: { checks: [rubric("Asks for the plan")] } },
    { kind: "refuse", title: "Not a plan", input: "Write my essay", expected: { checks: [rubric("Declines politely")] } },
    { kind: "typical", title: "Short plan", input: "Review: ship it", expected: { checks: [rubric("Names a risk")] } },
  ];

  beforeEach(() => {
    suiteView = { suite: null, cases: [] };
    answer = { status: 200, body: {} };
    writes = [];
    starterOff = null;
    stubPlugins();
  });

  it("shows Draft starter cases beside Add test set with no test set, and with an empty one; not when there are cases", async () => {
    const card = await openCard();
    const draft = await within(card).findByRole("button", { name: "Draft starter cases" }, SLOW);
    await vi.waitFor(() => expect((draft as HTMLButtonElement).disabled).toBe(false), SLOW);
    expect(within(card).getByRole("button", { name: "Add test set" })).toBeTruthy();
    cleanup();
    suiteView = { suite: SUITE, cases: [] };
    const empty = await openCard();
    expect(await within(empty).findByRole("button", { name: "Draft starter cases" }, SLOW)).toBeTruthy();
    cleanup();
    suiteView = { suite: SUITE, cases: CASES };
    const full = await openCard();
    await within(full).findByRole("table", undefined, SLOW);
    expect(within(full).queryByRole("button", { name: "Draft starter cases" })).toBeNull();
  });

  it("drafts in a Dialog that lists the drafts and saves nothing, then accepts the whole set in one op", async () => {
    const card = await openCard();
    const draft = await within(card).findByRole("button", { name: "Draft starter cases" }, SLOW);
    await vi.waitFor(() => expect((draft as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(draft);
    expect(writes).toEqual([]);
    answer = { status: 200, body: { op: "starter.draft", skill: PATH, cases: DRAFTS } };
    confirmIn("Draft");
    const list = await within(dialog()).findByRole("list", { name: "Drafted cases" }, SLOW);
    expect(within(list).getAllByRole("listitem").filter((li) => li.parentElement === list)).toHaveLength(DRAFTS.length);
    expect(list.textContent).toContain("Edge case");
    expect(list.textContent).toContain("Should refuse");
    expect(list.textContent).toContain("Declines politely");
    expect(writes).toEqual([{ url: "/api/v1/evals/write", token: "tok_evals", body: { op: "starter.draft", skill: PATH } }]);
    answer = { status: 200, body: { op: "starter.accept", skill: PATH, added: ["a", "b", "c"] } };
    confirmIn(`Accept ${DRAFTS.length} cases`);
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "starter.accept", skill: PATH, cases: DRAFTS } }), SLOW);
    await closed();
  });

  it("keeps a refused draft's reason in the Dialog and lists nothing", async () => {
    const card = await openCard();
    const draft = await within(card).findByRole("button", { name: "Draft starter cases" }, SLOW);
    await vi.waitFor(() => expect((draft as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(draft);
    answer = { status: 409, body: { error: "The set has no edge case, so nothing is shown or saved." } };
    confirmIn("Draft");
    await within(dialog()).findByText(/no edge case/, undefined, SLOW);
    expect(within(dialog()).queryByRole("list", { name: "Drafted cases" })).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Draft again" })).toBeTruthy();
  });

  it("is off with the server's reason in a Notice when it cannot draft; Add test set still works", async () => {
    starterOff = "No model is set up, so starter cases cannot be drafted. Add test set still works.";
    const card = await openCard();
    await within(card).findByText(starterOff, undefined, SLOW);
    const draft = within(card).getByRole("button", { name: "Draft starter cases" }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    expect(draft.title).toBe(starterOff);
    expect((within(card).getByRole("button", { name: "Add test set" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

let urls: string[] = [];

beforeEach(() => {
  urls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
