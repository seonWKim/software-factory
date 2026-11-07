import { definePlugin } from "../../plugin-api.js";
import { LocalAuthProvider } from "./local-auth-provider.js";

export default definePlugin({
  kind: "auth",
  name: "local",
  create: (c) => new LocalAuthProvider(c.store, c.grants),
});
