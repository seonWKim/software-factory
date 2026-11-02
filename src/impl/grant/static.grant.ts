import { defineGrant } from "../../plugin-api.js";
import { StaticGrant, staticGrantConfig } from "./static.js";

export default defineGrant({
  name: "static",
  create: (c) => new StaticGrant(staticGrantConfig(c.loaded.file.permissions?.static)),
});
