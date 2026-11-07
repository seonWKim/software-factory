import { definePlugin } from "../../plugin-api.js";
import { HttpNetworkProbe, probeTargets } from "./http-network-probe.js";

// The default with no setup and no account: it probes only the endpoints the selected plugins already use.
export default definePlugin({
  kind: "network_probe",
  name: "http",
  default: true,
  create: (c) => new HttpNetworkProbe(probeTargets(c.loaded.plugins, c.loaded.file)),
});
