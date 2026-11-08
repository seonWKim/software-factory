# software-factory

A local-first software factory: agents take a work item from intake to a reviewed, merged change; people make the decisions the design reserves for them; the factory improves itself from recorded outcomes. It builds most of itself: new features are issues the factory works, and a person approves specs and merges.

## What it does today

- **Intake from three sources:** GitHub issues labelled `factory`, Slack threads that mention the bot (optional), and local tasks from the CLI with no external account.
- **Agents for each step:** triage writes a spec, implement writes the change test-first, review reads it blind, and update and resolve handle base changes and merge conflicts. Each run's steps are journaled, so a restart resumes where it stopped.
- **People decide at the gates:** `/approve`, `/revise`, `/reject`, `/verdict` and `/resolve` from a GitHub comment, a Slack reply or the dashboard. **Manual mode is the default:** a person approves every spec and merges every change. Auto mode approves and merges low-tier changes off the gate list by itself; changes to the factory's own gates, prompts, permissions or tools always wait for a person.
- **Merges:** a local change through the merge queue (its checks run on the merge result first); a GitHub PR from the dashboard's Merge button, at the head the review passed.
- **Dashboard:** `factory ui` (served by `factory dev` too) at <http://127.0.0.1:4310/>: what needs you first, work items with their timelines, workers, queue, health, failures, settings and users, with commands and Merge on each item.
- **Guards:** agents never see secrets; credentialed writes go through outbound and the tool broker; every outgoing text is scanned for secrets; size, scope and protected-path gates run before a push.
- **Solo or team:** one machine with SQLite and no accounts, or many developers and replicas on a shared MySQL store with per-person roles and an audit trail.

Status: Phase 2 (the factory builds itself), with parts of Phase 3. Details: [`PLAN.md`](PLAN.md); the event-driven refactor (RFC 0015) landed on main on 2026-11-09: [`PROGRESS.md`](PROGRESS.md).

## Start

1. One-time setup: [`SET_UP.md`](SET_UP.md) (`npm run setup`).
2. Run the factory: `npm run factory -- dev` (it follows `origin/main` and restarts itself on new commits).
3. Open <http://127.0.0.1:4310/>.

## Read more

| File | What |
|---|---|
| [`SET_UP.md`](SET_UP.md) | Setup, commands, auto mode, settings, the dashboard, Slack |
| [`PLAN.md`](PLAN.md) | Phases and what each one has delivered |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Every component and how they talk |
| [`docs/design.md`](docs/design.md) | Index of the living design, one topic file per decision |
| [`docs/plugins.md`](docs/plugins.md) | Every plugin, how to enable, switch or disable it |
| [`docs/setup.md`](docs/setup.md) | Where secrets live and how to create them |
| [`docs/architecture.md`](docs/architecture.md) | Layers, control plane vs agent plane, scaling rules |
| [`PROGRESS.md`](PROGRESS.md) | The RFC 0015 refactor: milestones, ratchets, what is left |
| [`AGENTS.md`](AGENTS.md) | Rules for anyone (person or agent) changing this repo |

## Commands

Run `make help` (or just `make`) to list the commands. Each target wraps `npm run factory -- <cmd>` (setup wraps `npm run setup`), for example `make dev`, `make status ID=<work item id>`, `make setup ARGS=--rotate-github`. `make` is optional; the npm commands work without it.
