# Work item wi_0711b62d5cfb4f628e757e227b021503

Source: https://github.com/seonWKim/software-factory/pull/639

## Problem

Compare favicon pixels, not PNG bytes

AS-IS: the favicon test compares PNG file bytes, which differ between zlib builds, so it fails on Linux CI.
TO-BE: the test decodes favicon.png (new `decodePng` in scripts/build-icons.mjs) and compares its size and RGBA pixels with `render()`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Done criteria

## Desired output



## Scope



## Allowed paths (do not change files outside these)
- scripts/build-icons.mjs
- tests/design-system.test.ts