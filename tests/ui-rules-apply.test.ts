/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Promote of a proposal applies it (2026-11-18, phase 4 of local-0ffe3059-d863-4717-b3eb-1c72a06e444e). The owner's
// evolve has no apply subcommand (`evolve --help`: learn, learnings, propose, verdict, pending, show), so the plugin
// applies: on confirm it replaces the proposal's current lines (from `evolve show`) with its proposed lines in its
// target file, only when they occur there exactly once, then runs `evolve verdict <id> promote --reason <r>
// --applied-to <target>`. A failed apply (a refusal, a non-zero exit, the timeout) leaves the file as it was and shows
// the CLI's error in the dialog. A proposal whose change is prose (`evolve show`'s JSON) records the verdict as applied
// to its target and writes no file, then the route stores one task to build it (2026-11-20). The Rules page here talks to the real route (`respond`) over a stubbed fetch, and the
// route to a temp agents home whose stub evolve takes only the real forms: no real home, no network.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FunctionComponent, createElement } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/environments";
import type { UserId } from "../src/core/types.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import type { UiSettings } from "../src/ui/settings-api.js";

// The route runs as on the server, so this file keeps the node environment (the jsdom one rewrites the server modules'
// `new URL(…, import.meta.url)`); the page gets a DOM from jsdom set up here, before the DOM libraries load.
const { respond } = await import("../src/ui/server.js");
const { newCsrfToken } = await import("../src/ui/settings-api.js");
const { baseFromConfig } = await import("../src/core/settings.js");
const { FakeClock } = await import("../src/impl/clock/fake-clock.js");
const { PatternEgressScanner } = await import("../src/impl/egress/pattern-egress-scanner.js");
const { AgentsHomeTacitLedger } = await import("../src/impl/tacit/agents-home-tacit-ledger.js");
const { HealthMonitor } = await import("../src/ui/health.js");
const { config, silent } = await import("./helpers/fakes/config.js");
const { newStore } = await import("./helpers/store.js");
const dom = await builtinEnvironments.jsdom.setup(globalThis, {});
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
afterAll(() => dom.teardown(globalThis));

const PAGE_MODULE = "../web/src/views/rules.js";
const { RulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RulesPage: FunctionComponent };

const HOST = "127.0.0.1:4310";
const OWNER = "local:owner@example.com" as UserId;
const SLOW = { timeout: 10_000 };
const TARGET = "prompts/review.md";
const BEFORE = "# Review\n\nReview the change.\n\nThen say what you found.\n";
const AFTER = "# Review\n\nReview the change, then its tests.\n\nThen say what you found.\n";

/**
 * A temp agents home holding `prompts/review.md` (BEFORE) and a stub `bin/evolve` that takes only the real forms
 * (`pending`, `show <id>`, `verdict <id> {hold,promote,reject} --reason <r> [--applied-to <file>]`; promote without
 * `--applied-to` exits 1, as the real one) and exits 2 with usage on any other, `apply` among them. It logs each
 * verdict's argv to `<root>/verdicts`; `<root>/refuse` makes a verdict exit 1 with evolve's error, `<root>/sleep` makes
 * it outlast the timeout. `show P-0007` prints `<root>/show`.
 */
function stubHome() {
  const root = mkdtempSync(join(tmpdir(), "sf-apply-"));
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, "prompts"));
  writeFileSync(join(home, TARGET), BEFORE);
  writeFileSync(join(root, "show"), [
    "# P-0007 Split the review prompt", "kind: edit-asset", `target: ${TARGET}`, "current: Review the change.", "proposed: Review the change, then its tests.", "",
  ].join("\n"));
  writeFileSync(join(home, "bin", "evolve"), `#!/bin/sh
root="$(cd "$(dirname "$0")/../.." && pwd)"
usage() { echo "usage: evolve {learn,learnings,propose,verdict,pending,show} ..." >&2; exit 2; }
case "$1" in
  pending)
    [ "$#" -eq 1 ] || usage
    [ -f "$root/promoted" ] && { printf '## proposals (open) 0\\n'; exit 0; }
    printf '## proposals (open) 1\\n- P-0007 [edit-asset] ${TARGET} — Split the review prompt\\n## proposals (held) 0\\n## tacit Pending 0\\n## tacit Held 0\\n'
    ;;
  show)
    [ "$#" -eq 2 ] && [ "$2" = P-0007 ] || { echo "no entry $2" >&2; exit 1; }
    cat "$root/show"
    ;;
  verdict)
    [ "$#" -ge 5 ] && [ "$4" = "--reason" ] || usage
    case "$3" in hold|promote|reject) ;; *) usage ;; esac
    decision="$3"; shift 5; applied=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --applied-to) [ "$#" -ge 2 ] || usage; applied="$2"; shift 2 ;; *) usage ;; esac
    done
    [ "$decision" != promote ] || [ -n "$applied" ] || { echo "promote requires --applied-to (반영한 파일)" >&2; exit 1; }
    [ -f "$root/sleep" ] && sleep 5
    [ -f "$root/refuse" ] && { echo "evolve: P-0007 was judged already" >&2; exit 1; }
    echo "verdict $decision $applied" >> "$root/verdicts"
    touch "$root/promoted"
    ;;
  *) usage ;;
esac
`);
  chmodSync(join(home, "bin", "evolve"), 0o755);
  return {
    root, home,
    target: () => readFileSync(join(home, TARGET), "utf8"),
    verdicts: () => (existsSync(join(root, "verdicts")) ? readFileSync(join(root, "verdicts"), "utf8").trim().split("\n") : []),
    control: (name: "refuse" | "sleep") => writeFileSync(join(root, name), ""),
  };
}

let s: ReturnType<typeof stubHome>;
let posts: unknown[];

/** The page's deps with the ledger at the stub home (CLI timeout `timeout_ms`), as rules-page.test.ts builds them. */
async function deps(timeout_ms = 10_000): Promise<PauseDeps> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  const pauses: UiPauses = { principal: async () => OWNER, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  const settings: UiSettings = {
    base: baseFromConfig(config), repo: config.repo, actor: OWNER, resolveProject: async () => null, csrfToken: pauses.csrfToken,
    integrations: [{ kind: "tacit", interface: "TacitLedger", configured: "agents-home" }],
  };
  const ledger = new AgentsHomeTacitLedger(s.home, timeout_ms);
  return {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, settings,
    tacit: { ledger, settings: { refresh: async () => {}, values: () => ({ integrations: { tacit: "agents-home" } }) }, home: () => ({ path: s.home, missing: null, homes: [] }) },
  };
}

/** Renders the Rules page with every fetch answered by the real route. */
async function show(d: PauseDeps) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
    const r = await respond(d, {
      method: init?.method ?? "GET", url, host: HOST, origin: `http://${HOST}`, contentType: headers.get("content-type") ?? undefined,
      csrfToken: headers.get("x-csrf-token") ?? undefined, body: init?.body === undefined ? undefined : String(init.body),
    });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(RulesPage)));
}

const card = () => document.querySelector<HTMLElement>('[data-rule="P-0007"]')!;
/** Picks a verdict: Promote is the row's visible button; Hold and Reject are items of its ⋯ menu. */
const choose = (el: HTMLElement, label: string) => {
  if (label === "Promote") return void fireEvent.click(within(el).getByRole("button", { name: "Promote" }));
  fireEvent.click(within(el).getByRole("button", { name: /^Decide:/ }));
  fireEvent.click(within(el).getByRole("menuitem", { name: label }));
};
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-dialog]");

/** Opens Promote on P-0007, waits for its lines and gives the reason; returns the confirm button. */
async function openPromote(): Promise<HTMLButtonElement> {
  await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
  choose(card(), "Promote");
  await waitFor(() => expect(dialog()!.querySelector('[data-change="proposed"]')).not.toBeNull(), SLOW);
  fireEvent.change(within(dialog()!).getByRole("textbox", { name: "Reason" }), { target: { value: "clearer review" } });
  return within(dialog()!).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
}

beforeEach(() => {
  s = stubHome();
  posts = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Rules page: promote of a proposal applies it", () => {
  it("the dialog shows the current and proposed lines; with no confirm nothing is sent, written or judged", async () => {
    await show(await deps());
    await openPromote();
    expect(dialog()!.querySelector('[data-change="current"]')!.textContent).toBe("Review the change.");
    expect(dialog()!.querySelector('[data-change="proposed"]')!.textContent).toBe("Review the change, then its tests.");
    expect(dialog()!.textContent).toContain(`Path: ${TARGET}`);
    expect(within(dialog()!).queryByRole("textbox", { name: "Applied to" })).toBeNull();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(posts).toEqual([]);
    expect(s.target()).toBe(BEFORE);
    expect(s.verdicts()).toEqual([]);
  }, 30_000);

  it("on confirm the target gets the proposed lines, then evolve verdict runs with --applied-to the target", async () => {
    await show(await deps());
    fireEvent.click(await openPromote());
    await waitFor(() => expect(dialog()).toBeNull(), SLOW);
    expect(posts).toEqual([{ id: "P-0007", verdict: "promote", reason: "clearer review" }]);
    expect(s.target()).toBe(AFTER);
    expect(s.verdicts()).toEqual([`verdict promote ${TARGET}`]);
  }, 30_000);

  it("evolve refusing the verdict: the file is put back byte for byte and the dialog shows evolve's error", async () => {
    s.control("refuse");
    await show(await deps());
    fireEvent.click(await openPromote());
    expect((await within(dialog()!).findByRole("alert", {}, SLOW)).textContent).toContain("evolve: P-0007 was judged already");
    expect(s.target()).toBe(BEFORE);
    expect(s.verdicts()).toEqual([]);
  }, 30_000);

  it("evolve outlasting the timeout: the file is put back and the dialog says it stopped", async () => {
    s.control("sleep");
    await show(await deps(1_000));
    fireEvent.click(await openPromote());
    expect((await within(dialog()!).findByRole("alert", {}, SLOW)).textContent).toContain("evolve verdict stopped after 1000 ms");
    expect(s.target()).toBe(BEFORE);
  }, 30_000);

  it("current lines not in the target exactly once: a refusal, nothing written and no verdict sent", async () => {
    writeFileSync(join(s.home, TARGET), `${BEFORE}${BEFORE}`);
    await show(await deps());
    fireEvent.click(await openPromote());
    expect((await within(dialog()!).findByRole("alert", {}, SLOW)).textContent).toContain(`occur 2 times in ${TARGET}, not once: nothing written`);
    expect(s.target()).toBe(`${BEFORE}${BEFORE}`);
    expect(s.verdicts()).toEqual([]);
  }, 30_000);

  it("a proposal whose change is prose (evolve show's JSON): Send is on with a reason, the verdict is recorded with --applied-to its target, no file is written, and one task is stored to build it", async () => {
    writeFileSync(join(s.root, "show"), `${JSON.stringify({
      id: "P-0007", ts: "2026-10-17T21:04:11+09:00", by: "evolve", kind: "edit-asset", target: TARGET, title: "Split the review prompt",
      rationale: "Reviews skip the tests.", change: "Ask the reviewer to run the changed tests.", evidence: ["T-20261017-de7e"], state: "open", verdicts: [],
    })}\n`);
    const d = await deps();
    await show(d);
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    choose(card(), "Promote");
    await waitFor(() => expect(dialog()!.querySelector("[data-detail-change]")!.textContent).toBe("Ask the reviewer to run the changed tests."), SLOW);
    expect(dialog()!.querySelector("[data-dialog-consequence]")!.textContent).not.toMatch(/by hand|Now and Proposed/);
    expect(dialog()!.querySelector("[data-dialog-consequence]")!.textContent).toContain("creates a task to build it");
    expect(within(dialog()!).queryByRole("alert")).toBeNull();
    fireEvent.change(within(dialog()!).getByRole("textbox", { name: "Reason" }), { target: { value: "applied it" } });
    const confirm = within(dialog()!).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(dialog()).toBeNull(), SLOW);
    expect(posts).toEqual([{ id: "P-0007", verdict: "promote", reason: "applied it" }]);
    expect(s.verdicts()).toEqual([`verdict promote ${TARGET}`]);
    expect(s.target()).toBe(BEFORE);
    expect(await d.store.getTask("tk_p-0007")).toMatchObject({
      body: `Rationale: Reviews skip the tests.\nChange: Ask the reviewer to run the changed tests.\nTarget: ${TARGET}\nEvidence: T-20261017-de7e\nProposal: P-0007`,
    });
  }, 30_000);

  it("the route refuses a target outside the home with nothing written and no verdict sent", async () => {
    writeFileSync(join(s.root, "show"), "# P-0007 x\ntarget: ../outside.md\ncurrent: a\nproposed: b\n");
    const d = await deps();
    const r = await respond(d, {
      method: "POST", url: "/api/v1/rules/verdict", host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: d.pauses!.csrfToken,
      body: JSON.stringify({ id: "P-0007", verdict: "promote", reason: "x" }),
    });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).error).toContain("has a .. segment: nothing written");
    expect(s.verdicts()).toEqual([]);
    expect(s.target()).toBe(BEFORE);
  }, 30_000);
});
