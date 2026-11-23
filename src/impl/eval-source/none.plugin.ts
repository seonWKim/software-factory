import { definePlugin } from "../../plugin-api.js";
import { NoEvalSource } from "./no-eval-source.js";

// An optional kind takes no `default`: leaving `plugins.eval_source` out selects no source, as `none` does.
export default definePlugin({
  kind: "eval_source",
  name: "none",
  create: () => new NoEvalSource(),
});
