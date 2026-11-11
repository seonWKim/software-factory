import { definePlugin } from "../../plugin-api.js";
import { NoTacitLedger } from "./no-tacit-ledger.js";

export default definePlugin({
  kind: "tacit",
  name: "none",
  default: true,
  create: () => new NoTacitLedger(),
});
