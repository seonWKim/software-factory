# 4. Agents: roles, models and the GitHub gate

| Role | Reads | Writes | Model |
|---|---|---|---|
| Triage | Slack thread, issues, code (API, no clone) | its fields, `READY` / `CLOSED` | cheap |
| Manager | `READY` queue | lease, assignment | none (code) |
| Implementer | work item + pointers + previous mistakes | code on its branch, TDD tests, handoff row per commit | standard at tier 1–2, strong at tier 3–5 |
| Reviewer | pass 1: work item + diff + `worked_on` (no transcript); pass 2: intent, how_to_test | acceptance tests (blind, hidden from implementer), verdict, cumulative mistakes, tier recheck | standard, different if measured to help |
| Resolver (`/resolve`) | conflicting files + work item + notes | the merge resolution | standard at tier 1–2, strong at tier 3–5 |

The model column is the shipped `model_by` table (below); a retry after a review loop goes one class up.

**Model class per run kind and tier.** There are three classes, `cheap`, `standard` and `strong`; `models` in `factory.config.json` maps each to a model name (shipped: `haiku`, `sonnet`, `opus`, CLI aliases, not pinned versions) and must list all three. `model_by` maps run kind and tier to a class: one entry per run kind (`triage`, `implement`, `review`, `resolve`), each either one class for every tier or an object with a class for each of tiers `"1"` to `"5"`, plus `retry_up` (default true). Shipped, and used when `model_by` is absent:

| Run kind | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 | Retry after a review loop |
|---|---|---|---|---|---|---|
| triage | cheap | cheap | cheap | cheap | cheap | not moved |
| implement | standard | standard | strong | strong | strong | one class up |
| review | standard | standard | standard | standard | standard | not moved |
| resolve | standard | standard | strong | strong | strong | one class up |

A retry is an implement or resolve run for an item whose `loop_count` is 1 or more (review or failed checks sent it back); it goes one class up (`cheap` → `standard` → `strong`, `strong` stays) unless `retry_up` is false. Restart retries (`/retry`, backoff) do not move `loop_count` and are not bumped. An item with no tier yet takes its run kind's tier-5 entry. The merge-conflict steps inside an implement run use the implement run's class. Golden reviewer replays use the review class (tier-5 entry, no bump), so they match production review. `loadConfig` checks both keys at startup: an unknown run kind or tier key, a value that is not a class, a tier object missing a tier, or `models` without one of the three classes fails loading with the key or value named. The choice is one pure function (`modelClassFor` in `src/core/model-choice.ts`). Each agent run's succeeded outcome data records `model_class` and `model` (the configured name) next to `tokens`; no schema change. Review moves from strong to standard by default, which lowers the reviewer's model: a human confirms this at merge. Out of scope: suggest, canary and setup's check stay `cheap`; stats per class; per-item overrides.

Instructions are soft; tools and permissions are hard. Credentials live only inside tool wrappers: agents never read secrets, only tools do, enforced by guards G1–G6 (architecture §5).

Phase 1 human gate on GitHub (D5): the triage spec is an issue comment; a user with **write** permission replies `/approve` or `/reject <reason>`; `/retry` re-runs a failed run that the factory stopped retrying (§5 Restarts); `/resolve [notes]` starts an agent resolve of a merge conflict (§5 Merge conflict; on the issue or on the PR's conversation). Merging the PR is the merge gate. The factory marks each handled command (and each issue it takes in) with a 👀 reaction, and explains a refused command (no write permission, or a state that cannot take it) in one reply comment (decided 2026-11-01). Agents may call read-only broker tools that `tool_grants` grants to their run kind (decision changed 2026-11-07, issue #164; how the guards hold: `docs/architecture.md` §5). Absent, a run gets none. The worker still pushes, opens the PR and posts the review through the `ToolBroker` after the agent exits.

**Spec layout (decision changed 2026-11-07, issue #229).** After In short the spec comment reads: `### Problem`; `### Decisions for you` (the tier raise line, then triage's `decisions`: risky choices and open questions; at most 5 lines shown, the rest folded; omitted when empty); `### Done when` (the first 10 criteria, the rest in a `<details>` block; triage, the implementer and review still get all); the PR contents (`desired_output`) folded under "What the PR contains", or dropped when at least 70% of its words are already in the done criteria (`repeatsDone`); `### In scope` and `### Out of scope`; `### Files`; `### Risk`. Triage returns `in_scope` and `out_of_scope` lists instead of one `scope` text; the stored `scope` is built from them (`scopeText`), so the work item, the store and the implement prompt are unchanged. An older triage output with only `scope` still parses and renders it under `### Scope`.

**In short opening.** Triage returns a required `in_short` text field: "AS-IS:" in one plain sentence or two, then "TO-BE:" in one, with no file-level detail. The spec comment is `## Factory spec`, then `### In short (AS-IS → TO-BE)` and that text; nothing comes before it. `prompts/implement.md` and `prompts/resolve.md` tell the agent that its summary (the PR description, the resolution summary) starts with the same section, before any file-level detail; the PR body is still summary, `Closes #<issue>`, work item line. `in_short` is not stored; a revised spec gets a new one from its triage run. Only the prompt text is tested; nothing checks that a model's reply starts with the section (a reviewer check would need a tool that reads the PR description, an open question).

## History

- **Broker tools in agent runs** (2026-11-07, issue #164). Before: agents got no broker tools (decided 2026-10-31); the runner refused a run with grants.
- **Spec layout** (decision changed 2026-11-07, issue #229). Before: In short, "Please check" (tier raise only), What changes, Done when (every criterion), Not included (one `scope` text that also named what was in scope), Problem, Files, Risk.
- **Model class per run kind and tier** (decision changed 2026-11-02, issue #137). Before: two classes, `cheap` and `strong`, hard-coded per run kind in the worker: triage cheap, implement, review and resolve strong, whatever the tier or loop, and runs did not record which model they used.
- **In short opening** (decision changed 2026-11-01). Before: the spec comment opened with the first one or two sentences of the problem, and the PR description was the implementer's summary with no plain statement of the change at the top.
