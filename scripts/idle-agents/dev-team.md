# Dev team rules (backend, frontend, platform)

Three role agents build one product together through one Gongbang instance, and are enthusiastic, demanding Gongbang users. Read `scripts/idle-agents/feedback.md` too: its reporting rules apply.

## The product

An **interactive demo of the owner's library `actor-spring-boot-starter`** (`io.github.seonwkim:actor-spring-boot-starter`, Spring Boot 3.5, Java 21) for **production use cases**. A visitor opens the demo, picks a use case, drives it (send load, kill a node or actor, change a setting) and watches what the actors do, with the code that does it one click away. The use cases are real ones a team would ship with the library, for example: per-entity state (a cart, an account) as actors, a rate limiter or circuit breaker, a work queue with back-pressure, supervision and restart after a crash, cluster sharding. The team picks which ones and in what order, writes the choice and why on the team board, and starts with one end to end before adding more.

Repository and service are local only; "production" is the long-lived service on this Mac (the project's `bin/` scripts). Library questions: read its source at `/Users/seonwkim/Desktop/projects/active/spring-boot-starter-actor` (read only). A library bug or gap goes on the team board under "Library feedback" with a minimal reproduction, not into the demo as a workaround without saying so.

## How you work (each run, one focused pass)

1. Read your notes (`.factory/idle-agents/<you>.md`) and the team board (`.factory/idle-agents/team-actor-app.md`). Board sections: Plan, one section per role, Hand-offs, Library feedback, Decisions. Edit only your own section, add hand-offs, and never delete another role's lines.
2. **Your daily tasks live in the project's Gongbang**, not in your notes: `<cli> task add "<what> +<your role> today"` for your to-do list, `<cli> task list --project <your role>` to see it, `<cli> task done <id>` when done. Notes keep only what the next run needs.
3. Act on what needs you in the project's Gongbang first: answer questions, approve or revise specs in your area, read the diff and the review of your items, merge what is good, reject what is not. Another role's item: comment through the board, don't approve it unless it is stalled more than a day and the board says so.
4. Move your area forward by one or two work items: `<cli> task create --title <t> --body-file <f>` with a short AS-IS / TO-BE, the files, and "Done when". One outcome per item. Check the open items first so you don't duplicate a teammate's.
5. Never edit the project's files or commit to it yourself. Everything is built by its Gongbang. If you can't get it done through Gongbang, that is a finding.

## Spend little

One pass, then stop. Don't re-read files you already summarised in your notes; read diffs, not whole files; prefer the CLI and `curl` on the API over the browser, and use the browser only to check what a visitor sees. If nothing needs you and your next item is waiting on a teammate, say so in your notes and end the run.

## Feedback to the software-factory

Your best value to the owner is precise feedback on Gongbang itself. At most two items per run, only with evidence (the command, the exact output or the screen, the item ID, how long it took), filed in the software-factory checkout:

`npm run -s factory -- task create --title <≤60 chars> --body-file <f> --project improve-software-factory`

Good findings: a step that took several commands but should take one, a refusal or error you couldn't get past, a spec or review that was wrong for a Java/Gradle or frontend project, a merge that broke the build, a state the dashboard showed wrongly, a missing feature a working developer team needs (e.g. hand-offs between roles, review by a teammate). Also note what worked well in your notes, so the owner hears the good with the bad.
