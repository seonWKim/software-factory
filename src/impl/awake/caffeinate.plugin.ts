import { definePlugin } from "../../plugin-api.js";
import { ConsoleLogger } from "../log/console-logger.js";
import { CaffeinateKeepAwake, requireExecutable, spawnLauncher } from "./caffeinate-keep-awake.js";

export default definePlugin({
  kind: "awake",
  name: "caffeinate",
  /** macOS only; `none` is the default everywhere else. */
  default: { platforms: ["darwin"] },
  create: (c) => {
    try {
      requireExecutable("caffeinate", process.env.PATH);
    } catch {
      throw new Error(
        'plugins.awake selects "caffeinate", but there is no caffeinate executable on PATH (it ships with macOS). ' +
          'On this machine set "plugins": { "awake": "none" } (docs/plugins.md, KeepAwake)',
      );
    }
    return new CaffeinateKeepAwake({ launch: spawnLauncher, log: new ConsoleLogger(c.clock, "keep-awake"), pid: process.pid });
  },
});
