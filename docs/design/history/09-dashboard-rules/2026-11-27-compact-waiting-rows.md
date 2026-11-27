# Replaced 2026-11-27: the waiting rows' pill, layout, kind line, counts and group lines

Replaced by the decision at the top of [09-dashboard-rules-waiting.md](../../09-dashboard-rules-waiting.md) (owner: "improve the UX and UI of the Rules section", with a screenshot of Waiting for you).

- **State pill (2026-11-13 to 2026-11-27).** Every waiting row showed `RULE_STATE[state]`: open read "Running", pending "Needs approval", held "Held"; a proposed skill draft read "Needs approval". Open proposals were not running.
- **Row layout (2026-11-22 to 2026-11-27).** Title; then the pill and the kind line; then Promote, a secondary Button in a `ButtonRow` on its own line; then "Why and where". The ⋯ menu listed Promote, Hold and Reject. A skill draft had its score on a line of its own and Promote on another; a standing proposal had Accept on its own line.
- **Kind line (2026-11-21, file count since 2026-11-22, to 2026-11-27).** "<kind>: <N files>": "Edit a file: 1 file", "Turn a learning into a rule: 1 file", "Add a new file: 1 file", "Change: N files"; no file name in the row and no gist of the change.
- **Counts and group lines (2026-11-13 to 2026-11-27).** The Waiting for you card and each group (Skill changes, Rule candidates, Structure proposals) showed a count beside its title, with the page header's "N waiting" badge; each group showed its line on what promoting does above its rows, always.
- **Empty state text.** "Decided entries stay below; applied rules are under Applied." named the Applied tab, gone since 2026-11-22; now "Decided ones are under Details; the rules in effect are below."
- **Titles (2026-11-18 to 2026-11-27).** A waiting row's title was an `IdDetails` (the ID in its tooltip) cut to one line, so beside Promote and ⋯ a phone showed about a dozen characters.
- **In effect rows (2026-11-24 to 2026-11-27).** An applied rule row kept a blank switch-wide column so its title lined up with the standing rows'; at 390px a standing row's recent titles stacked as cut underlined links.
- **In effect titles (2026-11-22 to 2026-11-27).** A standing rule's sentence and an applied rule's name (an `IdDetails`, its ID in the tooltip) were cut to one line.
