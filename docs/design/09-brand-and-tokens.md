# 9. Brand and design tokens

- **One token source, generated CSS (new decision, 2026-11-11, phase 1).** `design-system/tokens.json` is the only place a dashboard colour, type size, spacing step or radius is defined: light and dark colours, status pill colours (ok, warn, bad, info), type sizes, spacing and radius. `scripts/build-tokens.mjs` (`npm run build:tokens`) writes `web/src/tokens.css` from it: light values on `:root`, dark values under `.dark` (the class the theme toggle sets). The output is deterministic and carries a header that names the script; nobody edits it. `web/src/index.css` imports it and maps the Tailwind theme (`@theme inline`), so `bg-surface`, `text-text-2`, `bg-accent` and `rounded-card` exist. Every colour value equals the Tailwind palette colour the pages use today (zinc, blue, emerald, amber, red), so phase 1 changes no look; pages keep their classes until phase 2.
  - **The hex rule.** No file under `web/src/` except `tokens.css` holds a hex colour (six or eight digits always; three or four only when a letter a-f is among them, so `#192` is not flagged). `tests/design-system.test.ts` enforces it, and fails when `tokens.css` differs from the generator's output.
  - **Not built yet.** Moving pages and `LINK_CLASS` to the token classes (phase 2); a written brand brief.

## History

- **Token source and generated CSS** (new decision, 2026-11-11). Before: each file chose Tailwind palette classes (`text-blue-700`, `dark:text-zinc-400`) and nothing stopped a hex colour.
