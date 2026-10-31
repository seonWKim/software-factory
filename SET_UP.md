# Set up

What to do once before the factory can take work. One command does most of it:

```bash
npm run setup
```

It is safe to run again: it skips what is already done. Two steps need you in a browser; the command stops and tells you when.

## Before you start

- Node.js 22.13 or newer, and git
- Claude Code installed (`claude --version`)
- A Claude Pro / Max / Team / Enterprise plan
- MySQL 8+ running locally, and an admin login that the `mysql` client can use (`~/.my.cnf`, or it asks for the root password). For SQLite only, set `"store": { "type": "sqlite" }` in `factory.config.json` and skip this
- Write access to the GitHub repository the factory works on (set in `factory.config.json`, default `seonWKim/software-factory`)
- `ANTHROPIC_API_KEY` **not** set in your shell. If it is, it overrides the subscription token: `unset ANTHROPIC_API_KEY`

## What `npm run setup` does

| Step | Automated | You do |
|---|---|---|
| 1. Secret file | Creates `~/.config/software-factory/.env` (folder `700`, file `600`), outside the repository | — |
| 2. Model credential | Prompts for the token with hidden input and writes it to the secret file | Run `claude setup-token` in a **separate, plain terminal**, sign in in the browser, copy the token it prints (shown once), paste it at the prompt |
| 3. GitHub token | Opens the token page, shows the exact settings, prompts with hidden input, writes it to the secret file | Create the token (settings below), paste it at the prompt |
| 4. Database | Creates the `software_factory` database and the factory's own MySQL user with a generated password, written to the secret file | Type the MySQL root password if the `mysql` client asks |
| 5. Label | Creates the `factory` label on the repository | — |
| 6. Checks | Runs `doctor`: file permissions, credentials present, claude CLI, database connection, push access, label; warns on a token that never expires | Fix any `FAIL` line and rerun |
| 7. Canary | Asks, then runs a real agent told to find a planted fake secret. It must not find it | Answer `Y`. If it fails, **do not run the factory**: revoke the GitHub token |

Tokens never appear on screen, in shell history, in command arguments, or in the repository. Only the factory's own tools read the secret file; agents can't (guards G1–G6, `docs/architecture.md` §5).

### GitHub token settings

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:

| Field | Value |
|---|---|
| Expiration | Your choice for local use (`doctor` only warns). If the factory is shared or runs in the cloud: 30 days or less |
| Repository access | Only select repositories → the factory's repository |
| Contents | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Metadata | Read-only (added automatically) |
| Everything else | No access |

## After setup

```bash
npm run factory -- dev        # start: controller + worker in one process
```

`dev` runs `origin/<base_branch>`, not your working tree: it keeps a built copy in `.factory/runtime`, and when a merge lands on the base branch it builds the new commit, lets the running job finish, and restarts on it. A build that fails leaves the old version running. Your checkout is fast-forwarded too, but only when it is on the base branch with no local changes; it is never checked out, stashed or reset. Local edits and unpushed commits do not affect `dev` until they are pushed and merged.

To run your working tree instead (as before), set `"updater": "none"` in the `plugins` object of `factory.config.json` and restart `dev`. Details: [`docs/plugins.md`](docs/plugins.md#updater).

Then on GitHub:

1. Label an issue `factory`.
2. The factory posts a spec on the issue. Reply `/approve`, or `/reject <reason>`.
3. It opens a PR, reviews it, and comments when a human merge is needed. Merge it yourself.
4. If a step fails, it comments; reply `/retry`.

Only users with write permission on the repository can approve or retry.
The factory reacts 👀 to each command it handled and to each issue it took in; if it refused a command, it replies saying why.

## Routine

| When | Command |
|---|---|
| Check that everything still works | `npm run factory -- doctor` |
| GitHub token expired or about to | `npm run setup -- --rotate-github` |
| Claude token replaced | `npm run setup -- --rotate-claude` |
| New MySQL password for the factory user | `npm run setup -- --rotate-mysql` |
| See work items / one item's history | `npm run factory -- status` / `npm run factory -- status <id>` |
| Suspect a leak | Revoke the token on GitHub first, then rotate |

Why the secret file lives where it does, and how each guard works: [`docs/setup.md`](docs/setup.md), [`docs/architecture.md` §5](docs/architecture.md#5-secret-isolation).
