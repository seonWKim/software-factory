# How an idle-time agent gives feedback

Shared rules for the local idle-time agents in `.claude/agents/gongbang-*.md`. They run through `scripts/idle-agents.mjs`: the developer and designer only when the software-factory has no open work, the two users once a day. They are a local development process for this repository. They are not part of the factory.

"The software-factory" below is this repository's own Gongbang (dashboard on port 4310, CLI `npm run -s factory --` from this checkout). A user agent also owns a project with its own, separate Gongbang instance; the rules for that instance are in its agent file.

## Start of every run

1. Read your notes file, `.factory/idle-agents/<your agent name>.md`. It holds what you checked before, what you filed, and what to check next. A missing file means this is your first run.
2. Read what is already open, so you never file a duplicate:
   - `curl -s http://127.0.0.1:4310/api/v1/items`: the open work items and their titles.
   - `npm run -s factory -- task list`: local work items and open plain tasks.
3. Pick one area you have not covered recently, using your notes. Go deep on it rather than wide.

## Every user agent run

These hold for the two user agents (`gongbang-user-en`, `gongbang-user-ko`), which own a project:

- **Revision check first.** The prompt has a "Project factory revision" line, computed by the script from the project's `.factory/supervisor.json` `rev` and this repository's `origin/main`. If it says the project factory is more than a day behind, write that in your notes and file it as a problem. Before filing any other problem, check it is not already fixed on main. "Unknown" is not a problem by itself; note it.
- **One real step.** Each run takes one real step toward the project goal: it moves an item forward, reviews a diff, or files the next project task. Checking status alone is not a step. Name the step in your notes.
- **The browser, every run.** Each run opens its project dashboard in the browser at least once. Take the page from your notes' "not checked" list, oldest first, so the list rotates instead of rolling over day after day.

## What is worth filing

- **Real problems only.** A problem must be something you saw or measured, with the steps to repeat it or the numbers. A guess or a taste you can't back with evidence is not filed. Write it in your notes as "to check next".
- **Product problems only.** File it only if a Gongbang user on another project would also hit it. A problem that only helps develop this repository (a dev script, a local check) goes in your notes, not to the factory.
- **Some things are never filed:** a request to loosen a guard (secrets, egress, tool broker, sandbox, auth), a request to raise auto-merge tiers, and a feature whose only reason is another person (Gongbang serves one owner).
- **Seen in two runs is evidence.** An observation written in your notes in two separate runs, on different local dates, meets the evidence bar: file it, with both dates as evidence under "Found by". Your notes keep a "seen" count per observation (see the end of every run); raise it each run you see it again. Do not leave a repeat as "seen once, not filed".
- **At most 2 tasks per run.** When nothing meets the bar, file nothing, and say so in your notes. A run that files nothing is a fine run.

## How to file

Write the body to a file under `.factory/idle-agents/drafts/`, then run:

```
npm run -s factory -- task create --title "<at most 50 characters>" --body-file .factory/idle-agents/drafts/<file>.md
```

The body is short and plain. Write it in English, and quote Korean text exactly where it matters. It has these sections:

```
<one sentence: the problem>

## AS-IS → TO-BE
- AS-IS: what happens now (steps, page, numbers)
- TO-BE: what should happen

## Found by
- Local idle agent <name>, <YYYY-MM-DD>: how you found it (page, width, steps, or the command and its output)
- (for a repeat) the second date you saw it, and what you saw then

## Done when
- 1 to 3 checks a test or a person can run
```

Name files and functions only when you read them, and never invent a cause. Do not prescribe the implementation: the factory's spec step does that.

## Never

- Never send a command to the software-factory: no approve, merge, reject, retry, revise, verdict, settings, mode, resume or pause. That includes buttons on http://127.0.0.1:4310 that send one. The sandbox, and a user agent's own project instance, are yours to click.
- Never add, edit or delete tasks or projects in the software-factory. The one exception is `task create` for your feedback.
- Never edit files in this repository or in a project repository. The only files you write are under `.factory/idle-agents/`.
- Never read or print `~/.config/software-factory/.env`, `.factory/test-mysql.url`, or any token.
- Never run `npm install`, `npx` for a package that is not installed, or `git` commands that change anything.

## End of every run

Append to your notes file:

```
## <YYYY-MM-DD HH:MM>
- Checked: <area, pages, commands>
- Step: <user agents: the one real step toward the project goal>
- Browser: <user agents: the dashboard pages opened, or "browser unavailable">
- Revision: <user agents: the project factory revision line, and whether it is behind>
- Seen: <each open observation, one line each: "<observation> (seen N: <dates>)">; filed ones are dropped
- Filed: <work item IDs and titles, or "nothing">
- Fine: <what worked well, in one line>
- Next: <1 to 3 things to check on a later run>
- Not checked: <pages or areas still to visit, oldest first; the next run's browser visit takes the first>
```

Keep the notes under about 200 lines. When they grow past that, fold the oldest entries into a short "Covered so far" list at the top, keeping every open "seen" line with its dates.
