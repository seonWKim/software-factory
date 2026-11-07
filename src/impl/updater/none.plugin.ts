import { join } from "node:path";
import { SUPERVISOR_STATUS_FILE } from "../../interfaces/updater.js";
import { definePlugin } from "../../plugin-api.js";
import { baseEnv } from "../process/run-process.js";
import { NoneUpdater } from "./none.js";

export default definePlugin({
  kind: "updater",
  name: "none",
  create: (c) =>
    new NoneUpdater({
      repoPath: c.loaded.root,
      run: c.run,
      env: baseEnv(),
      clock: c.clock,
      log: c.log,
      statusFile: join(c.loaded.stateDir, SUPERVISOR_STATUS_FILE),
    }),
});
