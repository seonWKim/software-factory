import { definePlugin } from "../../plugin-api.js";
import { NoTestDatabase } from "./no-test-database.js";

export default definePlugin({
  kind: "test_database",
  name: "none",
  /** A fresh install needs no MySQL server. */
  default: true,
  create: () => new NoTestDatabase(),
});
