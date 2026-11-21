## History

- **The help dialog listed only the shortcuts, and the search only pages and items** (decision changed 2026-11-19, the command help decision at the top of 09-dashboard-search.md). Before: `?` showed the keyboard shortcuts and `⌘K` searched the pages and the loaded items; the item commands were explained only on the item page (button titles with their `/command` usage and "From a terminal: `factory <command> <short number>`").

- **The search listed only the items the page had loaded** (decision changed 2026-11-20, the closed items decision at the top of 09-dashboard-search.md). Before: `⌘K` filtered the pages and the cached open items, so a merged item was almost never found (the default items read leaves out closed ones). Now it also reads `items?closed=1`, lists closed hits last and labels them Merged or Closed.
