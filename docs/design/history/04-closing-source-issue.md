## History

- **Closing the source issue** (decision changed 2026-11-01). Before: intake read only open issues, so closing a factory issue did not stop its work item, and a human had to `/reject` a closed issue by hand.
- **Decision changed 2026-11-02 (issue #104):** before, every source close was recorded as `wont_do`, a running run finished and its result was ignored (an implement run could still push a PR), and the item's open PR stayed open with no note. Now the close reason follows GitHub's, running runs stop in the same write as the close, and the open PR is closed with a comment naming the closer.
