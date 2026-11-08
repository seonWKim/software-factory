import { defineGrant } from "../../plugin-api.js";

export default defineGrant({
  name: "github-permission",
  default: true,
  create: async (c) => new (await import("./github-permission.js")).GitHubPermissionGrant(c.github, c.repo),
});
