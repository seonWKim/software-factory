## History

- **`factory issue` posts as the bot** (removed 2026-11-16, phase 1 of 2 of local-task-tk_f99d69ea). Before: `factory issue` (create / comment / title / sub-issue, each egress-scanned) let the owner's terminal post as the bot too; it was unused and is deleted.
- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: Declared secret names gave `MYSQL_HOST` as the example of a plain setting in the secret file.
- **Discovered registry** (D6 changed 2026-11-01). Before: `src/plugins.ts` imported every implementation and listed every plugin name, and `tests/plugins.test.ts` repeated the list with a fixed count, so every plugin PR conflicted on the same lines.
- **GitHub login is a plugin** (new decision, 2026-11-01). Before: every GitHub call read `GITHUB_TOKEN` directly, so everything the factory wrote showed the owner as author.
- **Declared secret names** (decision changed 2026-11-01). Before: `SecretName` was a closed union in the guarded `SecretStore` interface, repeated as a fixed list in the `env-file` plugin, so a new secret meant editing guarded code.
- **Fallback chains** (new decision, 2026-11-07). Before: `plugins.runner` and `plugins.llm` took exactly one name, so a rate-limited or broken provider stopped the factory until it came back.
- **Guard defaults** (changed 2026-11-09, runtime review H3). Before: a guard descriptor could take `default: { platforms: [...] }`; only two defaults for one platform were refused, so a new guard plugin with a platform default replaced the fallback (the pattern scanner, env-file secrets, the GitHub broker) on every zero-setup config.
- **GitHub code and the project key** (changed 2026-11-10). Before: `githubProjectKey` was defined in `src/core/project.ts` (allow-listed in the forge-wording check) and `resolveProject` in `src/compose.ts`, and startup called the GitHub client's repository lookup directly.
