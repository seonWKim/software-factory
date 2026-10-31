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

## 5. Check

```bash
ls -l ~/.config/software-factory/.env       # -rw------- , owned by you
git -C <repo> status --ignored | grep .env  # nothing: no secret file in the repo
```

## 6. Automated

`npm run setup` does steps 2–5 for you (hidden prompts for the tokens, label, checks, canary). See [`SET_UP.md`](../SET_UP.md).

## Why agents can't read it

The factory follows one rule: **agents never read secrets; only tools do.** The full design is in [`architecture.md` §5](architecture.md#5-secret-isolation). In short:

| Guard | What it does |
|---|---|
| G1 | Only the worker process loads the secret file. Agent runs get an allowlisted environment, and Claude Code's subprocess scrub strips credentials from anything the agent runs |
| G2 | Actions that need a credential (push, PR, comment) are tools run outside the agent's sandbox; the agent only sees results |
| G3 | The secret directory is denied at the OS level (`sandbox.filesystem.denyRead`) for everything the agent runs |
| G4 | File-tool deny rules on the secret paths |
| G5 | Every agent output is scanned for secret values before it reaches GitHub or the store; a hit fails the run |
| G6 | A canary test plants a fake secret and checks that an agent told to find it cannot |

Don't weaken these: never copy the secret file into the repo, never pass secrets as arguments or in prompts, and never add `GITHUB_TOKEN` to an agent's environment.

## Rotating or revoking

- Claude token: run `claude setup-token` again and replace the line; revoke old sessions from your Claude account settings.
- GitHub token: regenerate or delete it under GitHub → Settings → Developer settings.
- If you suspect a leak: revoke first, then rotate.
