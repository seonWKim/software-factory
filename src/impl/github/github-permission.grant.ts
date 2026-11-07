import { defineGrant } from "../../plugin-api.js";
import { GitHubPermissionGrant } from "./github-permission.js";

export default defineGrant({
  name: "github-permission",
  default: true,
  create: (c) => new GitHubPermissionGrant(c.github, c.repo),
});
