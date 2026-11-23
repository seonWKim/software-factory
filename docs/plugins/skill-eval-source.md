# SkillEvalSource

What it does: the place `factory eval import <skill> [--source <plugin>]` reads a skill's eval cases from (design [06-measurement.md](../design/06-measurement.md)). The interface (`src/interfaces/skill-eval-source.ts`) has one call, `listCases(skill)`, returning `{ id, input, expected }[]`, and an `enabled` flag that is false for `none`. It is read only: nothing in it writes to the source, so an edit of an imported case (`factory eval case edit`) stays in the factory's store.

**Config.** The key is `plugins.eval_source`, one SkillEvalSource plugin name:

```jsonc
"plugins": { "eval_source": "none" }          // no source: `factory eval import` refuses (the default)
"plugins": { "eval_source": "agents-home" }   // the owner's golden cases under AGENTS_HOME
```

**Default: no source.** The kind is optional: leaving `plugins.eval_source` out selects no source, as `none` does, and `factory eval import` then says no source is on, exits 1 and writes nothing. A name no plugin has fails startup with an error that names `SkillEvalSource`, `plugins.eval_source` and the available names. `--source <plugin>` uses the named source for one import; a name that is not registered is refused (exit 1, nothing written). Only `factory eval import` builds a source; nothing at startup reads it.

**What import stores.** Each new case is a local copy in the skill's suite with id `import:<source>:<skill>:<source case id>`. A re-import stores only ids not stored yet; a stored case keeps its input and expected. A case the source drops stays stored. Every new case passes the `case add` rule and the egress scan (G5) before any is stored; one bad case or one finding stores none, and a finding is printed by rule name only.

## `none`

No source. Imports nothing; no secrets, no settings.

## `agents-home`

The owner's golden cases, read through the owner's `golden` CLI in their agents home: `AGENTS_HOME` when set, else `~/.agents`. No secrets. Each call runs `<home>/bin/golden` with its own argv items (no shell), in the home, with a clean environment (`PATH`, `HOME`, `TMPDIR`, `LANG` and `AGENTS_HOME`), and stops after 30 seconds. Only `golden show` runs, so nothing is written under the home.

**The CLI form, from its `--help` (checked 2026-11-24):**

```
usage: golden [-h]
              {event,events,stats,draft,observe,conflict,skip,verdict,revise,show,run,report}
              ...

usage: golden show [-h] [--status STATUS] [--tags TAGS] [--brief] [id]
```

The import runs:

1. `golden show --status active --tags <tag>`: the skill's promoted cases, one JSON object per line, each with its `id` (`G-…`). The tag is the skill ref's last path segment (`skills/tests-first` → `tests-first`); a skill ref whose last segment is empty or holds a comma is refused.
2. `golden show <G-id>` for each: one JSON object whose `body.input` becomes the case's input and `body.expected` (a list of check texts) its expected.

A missing home, a `bin/golden` that is missing or not executable, a non-zero exit, the timeout, or output that is not that JSON makes the import refuse (exit 1, nothing written). Startup does not check the home: a factory with `agents-home` selected and no home still starts.

**Switch back:** set `plugins.eval_source` to `none`, or leave it out. Cases already imported stay stored.
