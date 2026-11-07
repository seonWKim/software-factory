Owner defaults: the owner's standing answers. Apply each one that fits instead of asking, and list it under
applied_defaults. One rule per line, each followed by its source issue.

- A tier 4 change needs a human merge. (issue #315)
- A missing optional file or config key means the feature is off with its default; it does not stop startup. (issue #315)
- In-process state is fine only when no other replica needs it (caches are fine); state that replicas share goes in the store. (issue #315)
- A problem found outside the item's scope is filed as a follow-up issue, not fixed in this change. (issue #315)
- Items already triaged or stored keep their data as it is; no backfill unless the item asks for one. (issue #315)
- No test calls a live model or a remote service; tests use the fakes. (issue #315)
