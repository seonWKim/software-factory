# Setup

How to give the factory its credentials without letting any agent read them.

> Status: Phase 1. The secret location and the rules below are fixed. The quick path is [`SET_UP.md`](../SET_UP.md) (`npm run setup`); this page explains what it does and why.

## Where secrets live

Secrets **never** live inside the repository, not even gitignored. They live in your user config directory:

```
${XDG_CONFIG_HOME:-~/.config}/software-factory/.env
```

Why outside the repo: agents work in git worktrees of this repo, so anything inside the repo tree is close to where they work. A file outside it can be blocked at the OS level with one rule (see [Why agents can't read it](#why-agents-cant-read-it)).

To use a different location, set `SOFTWARE_FACTORY_SECRETS_FILE=/path/to/file` in the environment that starts the factory.

## 1. Prerequisites

- Node.js (LTS) and git
- [Claude Code](https://code.claude.com) installed (`claude --version`)
- A Claude Pro / Max / Team / Enterprise plan **or** an Anthropic API key
- A GitHub account with access to the repository the factory will work on

## 2. Create the secret file

```bash
mkdir -p ~/.config/software-factory
chmod 700 ~/.config/software-factory
cp .env.example ~/.config/software-factory/.env
chmod 600 ~/.config/software-factory/.env
```

`chmod 600` makes the file readable only by your user.

## 3. Model credential

Pick **one**.

**Option A: Claude subscription (personal, local use)**

1. In a **separate, plain terminal** (not through another tool's shell; the command waits for a browser callback), run:
   ```bash
   claude setup-token
   ```
2. Sign in with your Claude subscription account and approve in the browser.
3. Back in that terminal, copy the printed token. It is shown once and not saved anywhere.
4. Put it in the secret file:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=<token>
   ```
5. Make sure `ANTHROPIC_API_KEY` is **not** set in your shell. If it is, it takes precedence over the subscription token:
   ```bash
   echo ${ANTHROPIC_API_KEY:+set}   # prints "set" if present
   ```

The token is valid for about a year and draws from your plan's usage limits. Anthropic does not allow claude.ai login for products offered to other people: if you run the factory for a team or as a service, use Option B.

**Option B: API key, cloud provider, or company gateway**

Put `ANTHROPIC_API_KEY=<key>` in the secret file, or configure the provider your organization uses (Bedrock, Vertex, an ML gateway) once those `LLMProvider` implementations exist.

## 4. GitHub token

Create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens):

- Repository access: **only** the repository the factory works on
- Permissions: Issues (read & write), Pull requests (read & write), Contents (read & write), Metadata (read)
- Expiration: the shortest you're comfortable rotating

```
GITHUB_TOKEN=<token>
```

### One GitHub budget per installation

GitHub gives each App installation (or each token's account) one hourly budget of core API calls (5,000 or more), and every factory using that installation draws from it. A factory that uses most of it leaves the others waiting for the reset; a first start, which reads the repository's whole backlog, is the most likely to.

- **Solo (default):** one App (or one token), one factory, `"github": { "budget_share": 1.0 }` or no key. Nothing to set.
- **Enterprise:** when several factories run at once, give **each factory its own GitHub App** (recommended); each keeps `budget_share` 1.0. If factories must share one App, give each a `budget_share` so the shares sum to at most 1.0 (e.g. two factories at 0.5). That sum is a manual agreement between the owners: nothing checks it across factories.
- The share is counted **per process**: replicas of one factory on one App split its share between them (two replicas of a factory with a share of 0.5 at 0.25 each).
- Once a factory has used its share, optional reads (PR mergeable, review, base-commit and check reads) wait for the reset; the intake lists still run. With no calls left at all, GitHub work waits for the reset (the status page shows the reset time) and local work goes on. Details: [`docs/plugins/github-credentials.md`](plugins/github-credentials.md).

## 4b. MySQL (only with `"store": { "type": "mysql" }`)

Connection settings and the password live together in the secret file. Empty settings fall back to `store` in `factory.config.json`. Only `MYSQL_PASSWORD` is treated as a secret (scanned by G5); the others are plain settings.

```
MYSQL_HOST=        # default localhost
MYSQL_PORT=        # default 3306
MYSQL_DATABASE=    # default software_factory
MYSQL_USER=        # default factory
MYSQL_PASSWORD=
```

- **Your own MySQL user:** fill in all five. Setup won't create anything.
- **Let setup create one:** leave `MYSQL_PASSWORD` empty. `npm run setup` creates the database and `'factory'@'localhost'` with a generated password and writes it here; you never see it. Rotate with `npm run setup -- --rotate-mysql`.

Workers on other machines will need an account for their hosts and TLS; that comes with the multi-machine step.

## 5. Check

```bash
ls -l ~/.config/software-factory/.env       # -rw------- , owned by you
git -C <repo> status --ignored | grep .env  # nothing: no secret file in the repo
```

## 6. Automated

`npm run setup` does steps 2–5 for you (secret file, hidden prompts for the tokens, MySQL database and user, labels, checks, canary). See [`SET_UP.md`](../SET_UP.md) for the steps.

- **Only what the selected plugins declare.** The Secrets step lists the secrets the selected plugins need and asks for each missing one, in the same run, with hidden input: the value goes straight to the secret file and never appears on screen, in shell history or in an argument. With GitHub off it asks for neither `GITHUB_APP_ID` nor `GITHUB_TOKEN`, and the checks report neither as a FAIL, also when you answered no to GitHub but declined to write the config change. `MYSQL_PASSWORD` is never asked: setup generates it.
- **`--yes` reads nothing.** Under `npm run setup -- --yes` setup never reads the terminal: each question takes its default, and a missing secret is reported on a `✗` line instead of asked. Paste it later with a plain `npm run setup` in a terminal.
- **Resume.** After each finished step setup writes `<state_dir>/setup-progress.json` (mode 600): the finished step names and your GitHub answer, never a secret value. A later run asks `Continue from step N?` or `start over`. A setup that finishes with every step `✓` deletes the file.
- **Check lines.** Every check says what it checks, and every FAIL (`✗` in setup) says how to fix it. `✓ ANTHROPIC_API_KEY not set (good: agents use CLAUDE_CODE_OAUTH_TOKEN)` is the good state; when it is set, the line is a FAIL that says to run `unset ANTHROPIC_API_KEY`.

## Changing settings

Fifteen keys change while the factory runs, with no PR and no restart (design 2026-11-03, "Settings change at runtime"):

```bash
npm run factory -- settings list                       # every settable key: effective value and source (override, file, default)
npm run factory -- settings set workers 2              # stored as an override, with an audit row
npm run factory -- settings set max_attempts 2 --project owner/name   # tighten one project's gate
npm run factory -- settings reset workers              # back to the file value
npm run factory -- settings history                    # who changed what, newest first
```

Applied live: `max_attempts`, `max_loops`, `max_restart`, `retry_base_ms`, `retry_max_ms` at the controller's next decision; `max_diff_lines`, `max_diff_files`, `run_timeout_ms`, `first_output_ms`, `models`, `model_by` at the next run that starts; `poll_interval_ms`, `tick_ms` at the next tick; `heartbeat_ms`, `lease_ms` at the next lease renewal; `workers` at the worker pool's next tick, never above the `workers` in `factory.config.json` (raise that by PR, then restart).

Not applied live: every other key, which changes only by a PR to `factory.config.json` and a restart (`plugins`, `repo`, `store`, `floors`, `dials`, `auth`, the guards and secrets are refused outright). The update run's own timeout in the updater keeps the file value until the next restart. On MySQL, run `npm run migrate` first (step 0015 adds the settings tables).

### Gate hooks (`agent_stop_checks`)

Implement runs on the `claude-code` runner get two Claude Code hooks (design `04-pre-push-gates.md`): one refuses an Edit or Write outside the item's `allowed_paths`, and one sends the agent back when it tries to stop with no commits, a diff over the size limits or a failing check. `agent_stop_checks` in `factory.config.json` is how many times per run the stop hook may send it back (default 3; a value that is not a positive integer fails at startup). It is not settable live: change it by PR and restart. The hooks are advisory: the worker's gates still decide. The hook folder is `<state_dir>/agents/claude-config/gate-hooks/<run id>/` while the step runs and holds no secret value.

## Why agents can't read it

The factory follows one rule: **agents never read secrets; only tools do.** The full design is in [`architecture.md` §5](architecture.md#5-secret-isolation). In short:

| Guard | What it does |
|---|---|
| G1 | Only the worker process loads the secret file. Agent runs get an allowlisted environment, and Claude Code's subprocess scrub strips credentials from anything the agent runs |
| G2 | Actions that need a credential (push, PR, comment) are tools run outside the agent's sandbox; the agent only sees results |
| G3 | The secret directory, the store's files, and admin credential files (`~/.my.cnf`, `~/.ssh`, `~/.config/gh`, …) are denied at the OS level (`sandbox.filesystem.denyRead`) for everything the agent runs |
| G4 | File-tool deny rules on the secret paths |
| G5 | Every agent output is scanned for secret values before it reaches GitHub or the store; a hit fails the run |
| G6 | A canary test plants a fake secret and checks that an agent told to find it cannot |

Don't weaken these: never copy the secret file into the repo, never pass secrets as arguments or in prompts, and never add `GITHUB_TOKEN` to an agent's environment.

## Rotating or revoking

- Claude token: run `claude setup-token` again and replace the line; revoke old sessions from your Claude account settings.
- GitHub token: regenerate or delete it under GitHub → Settings → Developer settings.
- If you suspect a leak: revoke first, then rotate.
