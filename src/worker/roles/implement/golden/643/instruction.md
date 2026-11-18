# Work item wi_498dcc68fb524ba69cfbf17a5aea2b39

Source: https://github.com/seonWKim/software-factory/pull/643

## Problem

Phase 1 of 2 of #597: stop compiling the MySQL migration steps. `npm run build` (scripts/build.mjs) still runs a second `tsc` pass with tsconfig.migrations.json, which compiles `migrations/**/*.ts` into the staged dist/ folder. The build's header comment still says it builds dist/ for the server and migrations.

## Done criteria
- scripts/build.mjs no longer runs `tsc` with tsconfig.migrations.json; the server build (tsconfig.json) and the web build (vite) are unchanged.
- tsconfig.migrations.json is deleted.
- The header comment of scripts/build.mjs says dist/ holds the server only.

## Desired output

A build that compiles only the server and the app, and no config file left for the migration steps.

## Scope

In scope: the build script and the migration steps' tsconfig. Out of scope: the migration files themselves, and phase 2 of #597.

## Allowed paths (do not change files outside these)
- scripts/build.mjs
- tsconfig.migrations.json
