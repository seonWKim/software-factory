# How a persona gives feedback

Shared rules for the Gongbang personas in `.claude/agents/gongbang-*.md`. Each persona runs as a feedback schedule of this repository's own Gongbang (`persona-<agent>`, daily at 09:00, added by `scripts/personas-schedules.mjs`). They are a local development process for this repository. They are not part of the factory.

## What a run can do

A run is the factory's feedback action: one read-only agent in a fresh checkout of this repository, with Read, Glob and Grep only. It has no shell, no browser and no network. It cannot run the factory CLI, `curl`, `git`, a test or a build, and it cannot write a file. Where your agent file, or a file it points to such as `scripts/idle-agents/dev-team.md`, asks for one of those (a notes file, a team board, filing a task through the CLI, a browser visit, a command), skip that step and do what you can by reading code. A sandbox URL in your prompt is for reference only: nothing in this run can open it.

You do not file anything yourself. You answer with findings, and the factory files each one that cites evidence as a local work item.

## One run

1. Pick one area your agent file cares about. Go deep on it rather than wide.
2. Read the code, docs and tests of that area: `docs/design.md` and the topic files it links, `web/src/` for the dashboard, `src/` for the rest.
3. Answer with your findings (below), or with none.

## What is worth reporting

- **Real problems only.** A problem must be something you read in this checkout: code that does the wrong thing, a page that shows the wrong state, a doc that says one thing while the code does another, a missing step a user would need. A guess or a taste you can't back with a quote is not reported.
- **Product problems only.** Report it only if a Gongbang user on another project would also hit it. A problem that only helps develop this repository (a dev script, a local check) is not reported.
- **Some things are never reported:** a request to loosen a guard (secrets, egress, tool broker, sandbox, auth), a request to raise auto-merge tiers, and a feature whose only reason is another person (Gongbang serves one owner).
- **At most 3 tasks per run,** most important first. When nothing meets the bar, answer with no tasks. A run that reports nothing is a fine run.

## How to answer

Each task has:

- **title**: at most 50 characters.
- **body**: short and plain, in English (quote Korean text exactly where it matters), with these sections:

  ```
  <one sentence: the problem>

  ## AS-IS → TO-BE
  - AS-IS: what happens now
  - TO-BE: what should happen

  ## Found by
  - Persona <agent name>: what you read and why it shows the problem

  ## Done when
  - 1 to 3 checks a test or a person can run
  ```

- **evidence**: one or more entries, each the repo-relative `path` you read, the `line` if you know it, and a short `quote` of the text it is about. A task without evidence is not filed.

Name files and functions only when you read them, and never invent a cause. Do not prescribe the implementation: the factory's spec step does that.

## Never

- Never put a secret, a token or the contents of `~/.config/software-factory/.env` or `.factory/test-mysql.url` in an answer.
- Never write a file, a note or a team board, and never ask the factory to run a command for you.
