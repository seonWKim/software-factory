# Foundations

The scales every dashboard component draws from. The source is `tokens.json`; `web/src/tokens.css` is generated from it (`npm run build:tokens`) and `web/src/index.css` maps the names to Tailwind classes. Components use these classes only: no hex colour and no Tailwind palette colour (`tests/design-system.test.ts` checks both).

## Colour

Each colour has a light and a dark value; `.dark` on `<html>` switches them, so a class such as `bg-surface` is right in both themes.

| Token | Class | Light | Dark | Use |
|---|---|---|---|---|
| `bg` | `bg-bg` | #FBFAF7 | #17171A | page background |
| `surface` | `bg-surface` | #FFFFFF | #212125 | cards, controls, menus |
| `surface-2` | `bg-surface-2` | #F3F2EE | #2C2C30 | hover, table heads, neutral badge |
| `border` | `border-border` | #E4E2DC | #34343A | dividers, table and card edges |
| `border-strong` | `border-border-strong` | #C2C0BB | #59595D | control edges, dashed empty boxes |
| `text` | `text-text-1` | #1C1C1E | #F2F2F4 | body text |
| `text-2` | `text-text-2` | #5E5E63 | #A1A1A8 | secondary text, hints |
| `text-3` | `text-text-3` | #66666A | #93939A | placeholders, counts |
| `accent` | `text-accent` | #C2410C | #FB923C | links, the radio mark |
| `running` | | #1D4ED8 | #60A5FA | a running task |
| `done` | | #15803D | #4ADE80 | a finished task |
| `failed` | | #B91C1C | #F87171 | a failed task |
| `focus` | `outline-focus` | #1D4ED8 | #60A5FA | the focus ring |

`running`, `done` and `failed` have no Tailwind class yet; use the pills below.

### Pills (status colours)

Four tones, each with `bg`, `fg` and `border`. Classes: `bg-pill-<tone>-bg text-pill-<tone>-fg` (borders have no class yet).

| Tone | bg light / dark | fg light / dark | Meaning |
|---|---|---|---|
| `ok` | #E8F2EC / #284335 | #0E5328 / #4ADE80 | ready, done |
| `warn` | #F8EEE6 / #483D25 | #753606 / #FBBF24 | waits for you or triage |
| `bad` | #F8E8E8 / #482F33 | #B91C1C / #FBAAAA | stuck, failed, destructive |
| `info` | #E8EDFB / #2C394B | #1D4ED8 / #60A5FA | running, a note |

A work item's level maps to a tone in one place, `LEVEL_TONE` in `web/src/components/ui/parts.tsx`. `Badge` and `StatusBadge` both read it; never write a second map.

## Type

| Step | Size | Line height | Class | Use |
|---|---|---|---|---|
| `xs` | 0.6875rem (11 px) | 0.875rem (14 px) | `text-xs` | badges, hints, small controls |
| `sm` | 0.8125rem (13 px) | 1.125rem (18 px) | `text-sm` | body, tables, controls |
| `base` | 0.9375rem (15 px) | 1.375rem (22 px) | `text-base` | reading text |
| `lg` | 1.25rem (20 px) | 1.625rem (26 px) | `text-lg` | page title |
| `xl` | 1.75rem (28 px) | 2.125rem (34 px) | `text-xl` | large figures |

Numbers that line up in a column use `tabular-nums`.

## Spacing

Steps (Tailwind's unit is 0.25rem): `1` 0.25rem, `2` 0.5rem, `3` 0.75rem, `4` 1rem, `6` 1.5rem, `8` 2rem, `12` 3rem. Use these for gaps and padding; half steps (`py-1.5`, `px-1.5`) are for dense controls and badges.

## Radius

| Step | Value | Class | Use |
|---|---|---|---|
| `control` | 0.375rem | `rounded-control` | buttons, inputs, tables, notices |
| `box` | 0.625rem | | grouped boxes (no class yet) |
| `card` | 0.875rem | `rounded-card` | cards |
| `pill` | 9999px | `rounded-pill` | badges, switches |

## Breakpoint

`SM_PX` (640, Tailwind's `sm`) in `parts.tsx`: below it every table is a list of cards and the sidebar is narrow.
