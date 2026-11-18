# Work item wi_64eb247e06104845992f95148b37fa91

Source: https://github.com/seonWKim/software-factory/pull/687

## Problem

Idle agents: pull latest main each pass

## AS-IS → TO-BE
- AS-IS: The idle-agents loop runs whatever the checkout had when it started; new agent rules or sandbox fixes wait for someone to pull and restart it. "Once a day" counts UTC days.
- TO-BE: Before each pass the loop fast-forwards main to origin/main (only while main is checked out; never touches another branch or uncommitted files) and restarts itself when its own script changed. Days are local.

Owner asked 2026-11-14: "the agents should automatically pull latest changes on the software-factory periodically".

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Done criteria

## Desired output



## Scope



## Allowed paths (do not change files outside these)
- scripts/idle-agents.mjs