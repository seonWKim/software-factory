## History

- **A task project is only a name that groups tasks** (until 2026-11-20, wi_d23cf428; replaced by the base folder decision at the top). `controller_projects` had no folder column, so nothing linked a project to files on disk, and the dashboard could not show or edit a project's files.
- **`task create` makes a work item only** (until 2026-11-15, the create under a project decision at the top). `factory task create --title <t> --body-file <f>` wrote no task, so its item showed under no project; the owner ran `task add "<title> +slug"` and linked the item by hand. No dashboard route created a work item.
- **`task project` takes one `+slug` or `-slug` per call** (until 2026-11-15, the move decision at the top). Moving a task between projects needed two calls, `-<from>` then `+<to>`, and a failure between them left the task in neither or in both.
- **A task belongs to no project** (until 2026-11-14, the task projects decision above). The #606 decision said: "`list` is a free label (`#home`), never a repository key: a task belongs to no project." A task had one free `#label` and no command listed tasks by a named group.
