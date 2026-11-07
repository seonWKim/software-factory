# How selection works, and the plugin registry

Every infrastructure interface has one or more **named plugins** (design D6). `factory.config.json` picks one
name per interface. Each plugin describes itself in a `*.plugin.ts` descriptor file beside its implementation
under `src/impl/`; the descriptors are the only non-test code that constructs these implementations. At startup
the loader in `src/plugins.ts` discovers them and fills the registry (the discovered registry, since 2026-11-01, below).
`src/compose.ts` (`build()`), the setup/doctor commands and the G6 canary all resolve plugins through that
registry, so whatever config selects is what runs and what the canary tests.

| Interface | Config key | Default (today) | Guard |
|---|---|---|---|
| FactoryStore | `store.type` | `sqlite` if there is no `store` block; the checked-in config uses `mysql` | no |
| AuthProvider | `auth` (top level) | the checked-in config uses `github` | no |
| SecretStore | `plugins.secrets` | `env-file` | **yes** |
| EgressScanner | `plugins.egress` | `pattern` | **yes** |
| ToolBroker | `plugins.broker` | `github` | **yes** |
| Sandbox | `plugins.sandbox` | `noop` | no |
| AgentRunner | `plugins.runner` | `claude-code` | no |
| LLMProvider | `plugins.llm` | `claude-cli` | no |
| SourceAdapter | `plugins.source` (a name, or a list of names; see [source-adapter.md](source-adapter.md)) | `github-issues` | no |
| SharedStorage | `plugins.storage` | `fs` | no |
| CapabilitySearch | `plugins.capability` | `bm25` (checked in; `list-all` when the key is left out) | no |
| Clock | `plugins.clock` | `system` | no |
| Updater | `plugins.updater` | `git-worktree` | no |
| KeepAwake | `plugins.awake` | `caffeinate` on macOS, `none` elsewhere (not in the checked-in config, so the platform decides) | no |
| Forge | `plugins.forge` | none: **optional**, no default (`github` available; see [forge.md](forge.md)) | no |

```jsonc
// factory.config.json (the checked-in defaults)
"store": { "type": "mysql", "host": "localhost", "port": 3306, "database": "software_factory", "user": "factory" },
"auth": "github",
"plugins": {
  "secrets": "env-file", "egress": "pattern", "broker": "github",
  "sandbox": "noop", "runner": "claude-code", "llm": "claude-cli",
  "source": "github-issues", "storage": "fs", "capability": "bm25", "clock": "system",
  "updater": "git-worktree"
  // "awake" is left out on purpose: it defaults per platform (see keep-awake.md)
}
```

Rules, checked by `loadConfig` at startup (and again by `build()`):

- **No `plugins` object** means today's defaults for every interface in it that has one (`awake`'s default depends on the platform; the optional `forge` has none, so no forge is selected). Store and auth keep their own keys.
- **A `plugins` object** must name every guard (`secrets`, `egress`, `broker`) explicitly. A non-guard key you leave out falls back to its default; an optional key you leave out selects nothing.
- **Optional kinds** (`forge`) have no default. Leaving the key out, or setting it to `"none"`, `null`, `false` or `""`, selects nothing: the selection has no entry for it and no plugin of it is built. An optional kind is never a guard.
- **An unknown name** for any interface fails startup. The error names the interface, the bad value and every available name.
- **An unknown key** under `plugins` fails startup (so a typo cannot silently fall back to a default). `store` and `auth` under `plugins` are rejected with a pointer to their own keys.
- **Unknown config keys are rejected at load**, at every level of `factory.config.json` (top level, `store` for its `type`, `repo`, `dials`, each `floors[i]`, `models`, `agent_git_identity`, `ui`, `stats`, `plugins`): one error lists every unknown key with its path and the valid keys, and adds `did you mean "…"?` when a valid key is within edit distance 2. `npm run factory -- doctor` prints each as a FAIL line and exits 1.
- **Guards cannot be disabled.** For `secrets`, `egress` and `broker`, leaving the key out of a `plugins` object, or setting it to `null`, `false`, `""`, `"none"` or anything that is not a registered name, fails startup with an error that the plugin is a guard and points to `docs/architecture.md` §5. You can switch a guard to another registered plugin; you cannot turn it off.

To switch back to the defaults, set the key back to the default name above, or delete the whole `plugins` object. There is no loading from external packages: a plugin is a descriptor file in this repository.

## The discovered registry

Since 2026-11-01:

- **One descriptor per plugin.** `src/impl/<area>/<name>.plugin.ts`, beside the implementation, default-exports `definePlugin({ kind, name, create, secrets?, default? })` from `src/plugin-api.ts`. `kind` is the interface's short name (`store`, `sandbox`, … `awake`); `name` is what config selects and must be unique within the kind (the same name under two kinds is fine); `create` gets the kind's typed context. Shared helpers live in modules without the `.plugin` suffix (for example `src/impl/claude/claude-shared.ts`).
- **Discovery.** At startup `src/plugins.ts` finds every `*.plugin.js` under the built `dist/impl/` (`*.plugin.ts` under `src/impl/` when run from source, as in tests; `*.d.ts` and source maps are ignored), sorts them by path, imports each one and registers it. `REGISTRY` is filled by top-level await. `src/plugins.ts` names no plugin and imports no implementation; only a new interface (a row in its kind table) edits it.
- **Defaults** come from the descriptors: `default: true` makes a plugin its kind's default on every platform no other plugin claims; `default: { platforms: ["darwin"] }` makes it the default on those platforms only (`awake`: `caffeinate` on `darwin`, `none` with `default: true` elsewhere). `store` and `auth` plugins take no default: their top-level keys always pick one. Optional kinds (`forge`) take no default either: every other non-guard `plugins` kind needs one, an optional kind must not have one.
- **Startup fails**, naming the file(s), when a descriptor has no default export or an unknown `kind`; when two plugins of one kind share a name (the error names the kind, the name and both files); when a non-guard `plugins` kind that is not optional has no `default: true`, when a plugin of an optional kind (`forge`) claims a default, or two plugins claim the default for the same platform (the error names the kind and the files); when a guard kind has no plugin at all; or when a guard plugin is named `none` or `""`.
- **Stale builds.** `npm run build` (also run by `npm run factory` and `npm run setup`) empties `dist/` before `tsc`, so a deleted descriptor leaves no `*.plugin.js` behind to be registered.

**Adding an implementation:** in the same change, add the implementation and its `*.plugin.ts` descriptor beside it, and its section in its interface's topic file, `docs/plugins/<interface in kebab-case>.md` (for example KeepAwake is `keep-awake.md`; "GitHub" counts as one word, so GitHubCredentials is `github-credentials.md`). A new interface also gets a new topic file and a row in the index, `docs/plugins.md`. No central file and no test list changes: `tests/plugins.test.ts` runs its property tests over every discovered descriptor, and fails if the topic file is missing or a registered name is missing from it.

**Declared secrets.** Each descriptor lists the secret names its plugin reads, each with a one-line purpose (`secrets` in the `*.plugin.ts` file; `withPlugin` takes the same list as an optional last argument). A name is checked by `secretName()`: upper-case letters, digits and `_`, starting with a letter. The secret set is the union of the names the **selected** plugins declare (`declaredSecretNames`): the `SecretStore` loads, returns and scans exactly those, so switching a plugin in config changes the set with no code edit (for example `store.type` `sqlite` drops `MYSQL_PASSWORD`). Any other key in the secret file, a plain setting such as `MYSQL_HOST` or a secret no selected plugin declares, is never returned and never scanned. A declared secret missing from the file does not stop startup; `npm run factory -- doctor` reports it as FAIL and `npm run setup` asks for it. Declarations that share a `oneOf` label are alternatives (the model credential: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). Each plugin's **Secrets:** line in its interface's topic file lists exactly its declared names; `tests/secret-names.test.ts` fails when they drift, and checks that `.env.example` lists every name the default selection declares.

## History

- **Checked-in `CapabilitySearch`** (changed 2026-11-07, issue #337). Before, the checked-in config selected `list-all`; now it selects `bm25`. `list-all` stays the registry default when the key is left out.

- **Optional kinds** (changed 2026-11-07, issue #272). Before, every non-guard `plugins` kind needed a `default: true` plugin and every kind had a name in the selection; now an optional kind (`forge`) has no default and may be left unselected.

- **The discovered registry** (changed 2026-11-01). Before 2026-11-01, `src/plugins.ts` imported every implementation and listed every plugin by hand, and `tests/plugins.test.ts` repeated that list and its count, so every new plugin edited the same lines.
