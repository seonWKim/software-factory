import { definePlugin } from "../../plugin-api.js";
import { GitHubAuthProvider } from "./github-auth-provider.js";

export default definePlugin({
  kind: "auth",
  name: "github",
  create: (c) => new GitHubAuthProvider(c.github, c.repo),
});
