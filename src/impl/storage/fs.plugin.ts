import { join } from "node:path";
import { definePlugin } from "../../plugin-api.js";
import { FsSharedStorage } from "./fs-shared-storage.js";

export default definePlugin({
  kind: "storage",
  name: "fs",
  default: true,
  create: (c) => new FsSharedStorage(join(c.loaded.stateDir, "storage")),
});
