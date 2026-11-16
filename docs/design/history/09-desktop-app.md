## History

- 2026-11-12 (brand phase 3): the build wrote "Software Factory.app" from a constant and kept Electron's icon; the window, tooltip, Quit item and error dialog said "Software Factory" and the menu bar said `SF <n>`. Replaced by the Gongbang decision above.
- 2026-11-12 (owner notices, phase 2): "a notification per newly needed item" was listed under Not yet. The shell now shows each pending owner notice once (`docs/design/09-notifications.md`), and keeps the shown ones in `state/notices-shown.json` in its app data folder.
- 2026-11-12 (quick-add box): the shell added no route and held no shortcut, only `main.js` imported `electron`, and of the checkout it read only `.factory/supervisor.json`. Replaced by the quick-add box above, which needs a global shortcut, a route that stores a task and the checkout's parser for its chips.
- 2026-11-11 (issue #573): the shell always started its own supervisor and read none of the checkout's files. Replaced the same day because a second supervisor beside a running factory (a terminal `dev`, or a second app build) shares its state folder and port.
