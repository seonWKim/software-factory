import { definePlugin } from "../../plugin-api.js";
import { AgentsHomeEvalSource } from "./agents-home-eval-source.js";

export default definePlugin({
  kind: "eval_source",
  name: "agents-home",
  // Nothing is checked here: a missing home or CLI makes `factory eval import` refuse, never startup.
  create: () => new AgentsHomeEvalSource(process.env),
});
