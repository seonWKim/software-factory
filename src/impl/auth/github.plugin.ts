import { secretName } from "../../interfaces/secret-store.js";
import { definePlugin } from "../../plugin-api.js";
import { GitHubAuthProvider } from "./github-auth-provider.js";

export default definePlugin({
  kind: "auth",
  name: "github",
  secrets: [{ name: secretName("GITHUB_TOKEN"), purpose: "reads a user's permission on the repository (shared GitHub client)" }],
  create: (c) => new GitHubAuthProvider(c.github, c.repo),
});
