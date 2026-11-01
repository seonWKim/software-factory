import { declaredSecretNames, definePlugin } from "../../plugin-api.js";
import { EnvFileSecretStore } from "./env-file-secret-store.js";

export default definePlugin({
  kind: "secrets",
  name: "env-file",
  default: true,
  create: (c) =>
    new EnvFileSecretStore(c.loaded.secretsFile, declaredSecretNames(c.loaded.registry, c.loaded.plugins), c.extraScanValues),
});
