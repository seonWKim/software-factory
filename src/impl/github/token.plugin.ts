import { definePlugin } from "../../plugin-api.js";
import { GITHUB_TOKEN, TokenCredentials } from "./token-credentials.js";

export default definePlugin({
  kind: "github_auth",
  name: "token",
  default: true,
  secrets: [{ name: GITHUB_TOKEN, purpose: "every GitHub call: issues, comments, labels, pushes and pull requests (as its owner)" }],
  create: (c) => new TokenCredentials(c.secrets),
});
