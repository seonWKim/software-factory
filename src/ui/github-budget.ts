// The GitHub budget on the status page (design §5 Sources, GitHub call budget; design §9): what the controller
// stored after its last poll (GITHUB_BUDGET_CURSOR), read from the store, so the page makes no GitHub call.
// With no calls left before the reset the factory is waiting, not failing: the reset time is the wait reason.

import { GITHUB_BUDGET_CURSOR, type GitHubBudgetStatus } from "../core/controller.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { esc } from "./html.js";

/** What the page shows: the stored budget as of `now`, and why GitHub work waits (null: it does not). */
export type GitHubBudgetView = GitHubBudgetStatus & {
  /** The process that stored it (`host:pid`): the count is per process. */
  replica_id: string | null;
  wait_reason: string | null;
};

/**
 * The stored budget, or null when no controller has stored one (GitHub not selected, or no poll yet). Once its
 * reset has passed the window is over: the state is `ok` and the count is 0 until the next poll stores a new one.
 */
export async function readGitHubBudget(store: Pick<FactoryStore, "getCursor">, now: Date): Promise<GitHubBudgetView | null> {
  const raw = await store.getCursor(GITHUB_BUDGET_CURSOR);
  if (raw === null) return null;
  let s: Partial<GitHubBudgetStatus> & { replica_id?: unknown };
  try {
    s = JSON.parse(raw) as typeof s;
  } catch {
    return null;
  }
  if (typeof s.reset_at !== "string" || typeof s.remaining !== "number" || typeof s.limit !== "number") return null;
  const over = now.getTime() >= Date.parse(s.reset_at);
  const state = over ? "ok" : s.state === "waiting" || s.state === "low" ? s.state : "ok";
  return {
    limit: s.limit,
    remaining: s.remaining,
    reset_at: s.reset_at,
    budget_share: typeof s.budget_share === "number" ? s.budget_share : 1,
    share_limit: typeof s.share_limit === "number" ? s.share_limit : null,
    counted: over || typeof s.counted !== "number" ? 0 : s.counted,
    state,
    as_of: typeof s.as_of === "string" ? s.as_of : "",
    replica_id: typeof s.replica_id === "string" ? s.replica_id : null,
    wait_reason: state === "waiting" ? `waiting for the GitHub rate-limit reset at ${s.reset_at}` : null,
  };
}

/** The classic page's `<section id="github-budget">`; empty without a stored budget. */
export function githubBudgetSection(v: GitHubBudgetView | null): string {
  if (v === null) return "";
  const head = v.state === "waiting"
    ? `<p class="banner"><strong>GitHub: ${esc(v.wait_reason!)}</strong> (GitHub reads and writes wait; local work goes on)</p>`
    : v.state === "low" ? `<p class="banner"><strong>GitHub budget low: optional reads wait for the reset</strong></p>` : "";
  const share = v.share_limit === null ? "" : ` of ${esc(v.share_limit)} (share ${esc(v.budget_share)})`;
  return (
    `<section id="github-budget"><h2>GitHub API</h2>${head}` +
    `<p>${esc(v.remaining)} of ${esc(v.limit)} calls left until ${esc(v.reset_at)}; this factory counted ${esc(v.counted)}${share} in this window.</p>` +
    `</section>`
  );
}
