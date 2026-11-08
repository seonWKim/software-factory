import { definePlugin } from "../../plugin-api.js";

export default definePlugin({
  kind: "auth",
  name: "github",
  create: async (c) => new (await import("./github-auth-provider.js")).GitHubAuthProvider(c.store, c.grants),
});
