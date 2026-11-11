# AppShell

What it does: the desktop shell around a running factory. One window on the dashboard, a menu bar item with the factory's state and needs-you count, a system-wide shortcut for the quick-add box, and a Quit that drains the factory before the shell exits.

Methods: `openWindow`, `setStatus`, `onQuit`, `quit`, and (2026-11-12) `registerShortcut(accelerator, onPress)`, true when registered and false when the system refuses it (another app holds it, or it is not a valid accelerator; nothing is registered then), and `unregisterShortcut(accelerator)`, which releases one the shell registered, and (2026-11-12) `notify(title, body, target)`, which shows a system notice whose click shows the window on `target`, refused when `target` is outside the dashboard URL given to `openWindow` ([`docs/design/09-notifications.md`](../design/09-notifications.md)). Interface: `src/interfaces/app-shell.ts`. Design: [`docs/design/09-desktop-app.md`](../design/09-desktop-app.md).

**Not chosen in `factory.config.json`.** The desktop entry builds its shell directly; there is no `plugins` key and no `*.plugin.ts` descriptor. The shell starts before any factory config is read. A new platform adds its own entry and AppShell beside `desktop/electron/macos/` and runs the same contract test (`tests/desktop/app-shell-contract.test.ts`).

Implementations:

- `macos`: `createMacosShell` in `desktop/electron/macos/app-shell.js`, started by `desktop/electron/macos/main.js` (the only file that imports `electron`).
  - Enable: `npm run build:desktop:macos`, then open `desktop/out/Gongbang.app` (`SET_UP.md`, "macOS app"). The app's name is `productName` in `desktop/package.json`; the window, menu bar (`Gb <n>`), Quit item, error dialog and notifications take it from there. Secrets: none; the shell never opens the secret file.
  - Settings: `~/Library/Application Support/software-factory/config.json`, written with its defaults on first start: `checkout` (the factory checkout to run, default the folder the app was built from), `ui_port` (default 4310; match `ui.port` in `factory.config.json`), `keep_running_when_closed` (default true: closing the window hides it and the factory keeps running), `app.quick_add_shortcut` (default `Alt+Space`: the quick-add box's shortcut; a missing key takes the default, and the menu bar's "Quick-add shortcut…" changes it). The shortcut methods use Electron's `globalShortcut`; every shortcut is released on quit. `notify` uses Electron's `Notification`; the notices it showed are kept in `state/notices-shown.json`.
  - Switch back: quit the app (it drains the factory) and run `npm run factory -- dev` in a terminal.

Electron must be in `node_modules` to build the app (`electron`, pinned in `devDependencies`); the build never installs it.

## History

- 2026-11-12: the app was "Software Factory.app" and its menu bar said `SF <n>`. Renamed Gongbang (`docs/design/09-desktop-app.md`).
- 2026-11-12: the interface had no shortcut methods (open the window, show the status, set the drain, quit). The quick-add box (`docs/design/09-desktop-app.md`) added `registerShortcut` and `unregisterShortcut`.
- 2026-11-12: the interface had no way to show a notice. The owner notices (phase 2, `docs/design/09-notifications.md`) added `notify(title, body, target)`.
