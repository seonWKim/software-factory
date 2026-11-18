# Work item wi_827dada7e8454bc69e408e8d23002465

Source: https://github.com/seonWKim/software-factory/issues/679

## Problem

This is phase 3 of 3 of #580. It waits for #678: the factory holds it until that phase is closed as completed. Phases 1 and 2 already removed MySQL from the design topics, and the root files still carry it. AGENTS.md has three MySQL mentions: a migration renumbering rule, a spec rule for `migrations/mysql/`, and a MySQL item in the heavy-tests bullet. SET_UP.md has four mentions, covering a MySQL CI job and store text. README.md has one, a shared MySQL store bullet. ARCHITECTURE.md has two, in the MySQL store rows. PLAN.md has one, in the D3 row, which names MySQL as the default. PROGRESS.md is a dated log and stays unchanged. The docs/ folder still has about 120 MySQL mentions across design topics and plugin docs. Those are outside this item's allowed paths, so the done grep over `docs` cannot pass inside this change. Under the owner default, those leftovers go to a follow-up issue.

Given values:
- Done grep: `grep -ri mysql docs SET_UP.md README.md ARCHITECTURE.md AGENTS.md`
- Decision 1 (owner answer, binding): Add one dated note to PLAN.md D3; leave PROGRESS.md unchanged (the default, accepted)
- Note date: 2026-11-14

## Done criteria
- AGENTS.md has no MySQL renumbering rule, no MySQL spec rule, and no MySQL in the heavy-tests bullet.
- SET_UP.md, README.md and ARCHITECTURE.md describe SQLite only, except in History text.
- PLAN.md's D3 row carries one dated note (2026-11-14) saying SQLite is the only store. The D3 row no longer names MySQL as the default.
- PROGRESS.md is unchanged.
- Running `grep -ri mysql AGENTS.md SET_UP.md README.md ARCHITECTURE.md PLAN.md` finds MySQL only in History text.
- The docs/ leftovers are listed in a follow-up issue, not edited in this change.
- `npm test` passes.

## Desired output

Edits to the five root docs only. No code, no test changes. Each removed MySQL line is replaced by its SQLite-only wording. The change adds no new sections.

## Scope

In scope:
- Remove the MySQL renumbering rule from AGENTS.md.
- Remove the MySQL spec rule from AGENTS.md.
- Remove MySQL from the heavy-tests bullet in AGENTS.md.
- Describe SQLite only in SET_UP.md, outside History text.
- Describe SQLite only in README.md, outside History text.
- Describe SQLite only in ARCHITECTURE.md, outside History text.
- Add one dated note to PLAN.md D3 saying SQLite is the only store; the D3 row no longer names MySQL as the default.
- File a follow-up issue for the MySQL mentions left in docs/.

Out of scope:
- Editing any file under docs/, including design topics and plugin docs.
- Editing PROGRESS.md.
- Removing the MySQL store code or migrations.
- Changing the SQLite store or its schema.

## Allowed paths (do not change files outside these)
- AGENTS.md
- SET_UP.md
- README.md
- ARCHITECTURE.md
- PLAN.md
- PROGRESS.md