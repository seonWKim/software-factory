import { definePlugin } from "../../plugin-api.js";
import { tacitLedgerAt } from "./agents-home-tacit-ledger.js";

export default definePlugin({
  kind: "tacit",
  name: "agents-home",
  // Built for the controller only: outbound runs the CLIs; an agent run never gets it.
  create: () => tacitLedgerAt(process.env),
});
