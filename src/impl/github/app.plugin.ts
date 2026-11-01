import { dirname, join } from "node:path";
import { definePlugin } from "../../plugin-api.js";
import { AppCredentials, GITHUB_APP_ID } from "./app-credentials.js";

export default definePlugin({
  kind: "github_auth",
  name: "app",
  secrets: [{ name: GITHUB_APP_ID, purpose: "the GitHub App's ID; with github-app.pem next to the secret file it mints the bot's token" }],
  create: (c) =>
    new AppCredentials({
      secrets: c.secrets,
      keyFile: join(dirname(c.loaded.secretsFile), "github-app.pem"),
      repo: c.repo,
      clock: c.clock,
    }),
});
