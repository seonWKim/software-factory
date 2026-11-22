## History

- **`#label` is ASCII letters, digits, `_` and `-`** (until 2026-11-16, the any-script `#label` decision at the top). The tag rule was `/^#[\w-]+$/`, so a Hangul or other non-ASCII tag such as `#집` stayed in the title and set no list. The Tasks page placeholder read "e.g. rent friday p1 #home, then {key}".
- **`task project` takes one `+slug` or `-slug` per call** (until 2026-11-15, the move decision at the top). Moving a task between projects needed two calls, `-<from>` then `+<to>`, and a failure between them left the task in neither or in both.
- **A task belongs to no project** (until 2026-11-14, the task projects decision above). The #606 decision said: "`list` is a free label (`#home`), never a repository key: a task belongs to no project." A task had one free `#label` and no command listed tasks by a named group.
