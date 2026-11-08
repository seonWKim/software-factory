import { definePlugin } from "../../plugin-api.js";
import { secretName } from "../../interfaces/secret-store.js";

/** Named here, not in the implementation, so discovering this descriptor loads no implementation. */
export const GITHUB_APP_ID = secretName("GITHUB_APP_ID");

export default definePlugin({
  kind: "github_auth",
  name: "app",
  secrets: [{ name: GITHUB_APP_ID, purpose: "the GitHub App's ID; with github-app.pem next to the secret file it mints the bot's token" }],
  create: async (c) => (await import("./app-credentials.js")).appAccess(c),
});
