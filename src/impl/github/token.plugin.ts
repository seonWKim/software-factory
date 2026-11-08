import { definePlugin } from "../../plugin-api.js";
import { secretName } from "../../interfaces/secret-store.js";

/** Named here, not in the implementation, so discovering this descriptor loads no implementation. */
export const GITHUB_TOKEN = secretName("GITHUB_TOKEN");

export default definePlugin({
  kind: "github_auth",
  name: "token",
  default: true,
  secrets: [{ name: GITHUB_TOKEN, purpose: "every GitHub call: issues, comments, labels, pushes and pull requests (as its owner)" }],
  create: async (c) => (await import("./token-credentials.js")).tokenAccess(c),
});
