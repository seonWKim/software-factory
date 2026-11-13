# 9. Dashboard complexity audit

**Finding (audit of 2026-11-13; documentation only, no code changed).** The dashboard (`web/`) has 12 sidebar pages in three groups plus Settings, and an item page whose single "What you need to decide" box carries up to four ways to answer (command buttons, one-tap verdicts, a free-text command box and a note box) over four dialogs. The normal day needs two pages (Needs you, and an item page to approve or merge). Seven System pages and several overlapping answer paths add choices the owner does not need for it. Five proposals follow; none is built by this change. Each becomes its own follow-up issue after approval.

Scope: the dashboard app only (`web/`), as decided at approval. The CLI, Slack commands and controller are not audited.

**Approver note, applied.** Complexity is to be managed by the agents that build the system, not by the owner's input. So proposal 5 is a check the builders run, not a setting the owner sets.

## How claims were checked

- **[code]** read in the named file at the time of the audit.
- **[doc]** taken from `docs/design/09-dashboard-app.md` or `09-status-page.md` alone, not checked in code.
- Nothing here was run in a browser; behaviour is read from source, not observed.
- One claim in the work item did not hold: it said the System group is collapsed by default. `web/src/App.tsx` [code] renders it always open, and the design doc's History says it changed on 2026-11-13 to "always open". The audit uses the code.
- The 140-line size of `09-dashboard-app.md` [doc] was taken from the work item, not counted again.
- Not checkable in code: how often the owner opens each page, and whether the owner uses the System pages on a normal day. Both are guesses and are the basis of the owner questions below.

## Sidebar pages [code: `web/src/pages.ts`]

| Page | Group | Route |
|---|---|---|
| Tasks | Tasks | `/app/tasks` |
| Needs you | Factory | `/app/` |
| Work | Factory | `/app/items` (one item: `/app/items/<id>`) |
| Activity | Factory | `/app/activity` |
| Health | System | `/app/health` |
| Failures | System | `/app/failures` |
| Spend | System | `/app/spend` |
| Rules | System | `/app/rules` |
| Runners | System | `/app/runners` |
| Queue | System | `/app/queue` |
| Data | System | `/app/data` |
| Settings | bottom row | `/app/settings` |

Old paths `workers` and `users` redirect (`REDIRECTS` in the same file). Beyond the sidebar there is a search dialog and a help dialog [code: `web/src/App.tsx`].

## Item-page flows that need more than one click or dialog

All sit in `web/src/views/item-commands.tsx` (buttons, verdict dialog, merge button), with the approve, reject and revise dialogs and the decisions panel in `web/src/views/item-decisions.tsx`, and the command box in `web/src/views/command-box.tsx`. [code]

1. **Approve in an approve phase** (spec gate, floor block, Rule of Two): pick an answer per decision in the panel, click Approve, then confirm in the approve dialog.
2. **Reject**: click Reject, give a reason and confirm what closes in the reject dialog.
3. **Revise**: click Revise, then write one comment per spec section in the revise dialog.
4. **Verdict**: click Verdict, choose Accept, Changes or Reject, choose a severity, write a reason (required for Changes and Reject), send.
5. **Feedback (one tap)**: type in the note box first, then click Feedback; it sends the note box text. Good and Bad are one click.
6. **Command box**: type a sentence, read the proposal the controller returns, then Confirm or Cancel from the pending-proposals list (`PendingProposals`).

Single-click flows (not listed as multi-step): Merge, Retry, Resolve, Good, Bad.

Overlap [code]: Verdict (4), Good, Bad and Feedback (5) are the same verdict request in two shapes; Reject (2) and the verdict "Reject" are two reject paths with different meanings (close the item vs rate the result) [doc for the meaning].

## Proposals (at most five, in the order to build them)

**First: proposal 1.** It removes the most visible duplicate path and needs no data about the owner's habits beyond one answer. Proposal 5 can run in parallel because it touches no screen.

1. **One verdict path on the item page.** Screen: item page. Removes: either the Verdict dialog or the Good, Bad and Feedback buttons (merges the two into one control: a Good and Bad tap, with a "More" that opens the dialog). Owner question: is the severity choice used, or are Good, Bad and Feedback enough? Size: small.
2. **Fold the command box into the dialogs.** Screen: item page. Removes: the free-text command box and the pending-proposals list, if every command already has a button. Merges their confirm step into the existing dialogs. Owner question: does the owner type commands to the page, or only press buttons? Size: medium.
3. **One approve step.** Screen: item page and Needs you. Removes: the second confirm click in the approve dialog when every decision still has its default answer (the panel already showed them). Owner question: should an approve with only defaults need a confirm? Size: small.
4. **Fewer sidebar pages.** Screen: sidebar. Merges: Health, Failures and Runners into one "System" page with sections, and Queue into Work as a filter. Leaves Spend, Rules, Data and Settings alone. Owner question: which System pages does the owner open in a normal week? Size: large (routes, redirects, the responsive check lists every page).
5. **A complexity check run by the builders, not the owner.** Screen: none (a script under `scripts/`, run by the agents that build the dashboard, since it only helps develop this repository). Adds: a report of page count, dialogs per item page and controls in the item page's decision box, compared with the last run, that the implementer and reviewer read and that flags growth in the review. Owner question: what growth counts as too much (for example a new page or a fifth dialog)? Size: small.

## Open owner questions (all four needed before proposals 1 to 4 start)

- Is the severity choice in the verdict used?
- Does the owner type commands into the command box?
- Should an approve with only default answers still need a confirm?
- Which System pages does the owner open in a normal week?

## History

- 2026-11-13: first audit, documentation only. Nothing replaced.
