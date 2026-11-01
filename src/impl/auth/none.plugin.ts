import { definePlugin } from "../../plugin-api.js";
import { NoAuthProvider } from "./github-auth-provider.js";

export default definePlugin({
  kind: "auth",
  name: "none",
  create: () => new NoAuthProvider(),
});
