# AppShell

What it does: the desktop shell around a running factory. One window on the dashboard, a menu bar item with the factory's state and needs-you count, and a Quit that drains the factory before the shell exits. Interface: `src/interfaces/app-shell.ts`. Design: [`docs/design/09-desktop-app.md`](../design/09-desktop-app.md).

**Not chosen in `factory.config.json`.** The desktop entry builds its shell directly; there is no `plugins` key and no `*.plugin.ts` descriptor. The shell starts before any factory config is read. A new platform adds its own entry and AppShell beside `desktop/electron/macos/` and runs the same contract test (`tests/desktop/app-shell-contract.test.ts`).

Implementations:

- `macos`: `createMacosShell` in `desktop/electron/macos/app-shell.js`, started by `desktop/electron/macos/main.js` (the only file that imports `electron`).
  - Enable: `npm run build:desktop:macos`, then open `desktop/out/Software Factory.app` (`SET_UP.md`, "macOS app"). Secrets: none; the shell never opens the secret file.
  - Settings: `~/Library/Application Support/software-factory/config.json`, written with its defaults on first start: `checkout` (the factory checkout to run, default the folder the app was built from), `ui_port` (default 4310; match `ui.port` in `factory.config.json`), `keep_running_when_closed` (default true: closing the window hides it and the factory keeps running).
  - Switch back: quit the app (it drains the factory) and run `npm run factory -- dev` in a terminal.

Electron must be in `node_modules` to build the app (`electron`, pinned in `devDependencies`); the build never installs it.

## History

No earlier decision is recorded for this topic.
