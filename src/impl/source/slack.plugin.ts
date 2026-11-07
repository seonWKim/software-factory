import { slackConfig } from "../../core/config.js";
import type { Clock } from "../../interfaces/clock.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { SecretStore } from "../../interfaces/secret-store.js";
import { ConsoleLogger } from "../log/console-logger.js";
import { definePlugin } from "../../plugin-api.js";
import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SlackWebClient } from "./slack-client.js";
import { SlackSource } from "./slack-source.js";

/**
 * What build() passes every source beyond the typed source context (src/compose.ts): the SecretStore the
 * client reads the two Slack tokens from, the egress scanner every post passes, and the clock for its log.
 */
export interface SlackExtras {
  secrets?: SecretStore;
  scanner?: EgressScanner;
  clock?: Clock;
}

// Socket Mode intake from the channels in the `slack` config block (issue #109). Reads only the two Slack
// tokens; never a GitHub credential.
export default definePlugin({
  kind: "source",
  name: "slack",
  secrets: [
    { name: SLACK_APP_TOKEN, purpose: "opens the Slack Socket Mode connection (app-level token, connections:write)" },
    { name: SLACK_BOT_TOKEN, purpose: "reads thread replies and posts the factory's messages in Slack threads (bot token)" },
  ],
  create: (c) => {
    const x = c as typeof c & SlackExtras;
    if (!x.secrets || !x.scanner || !x.clock) throw new Error("the slack source needs the secret store, the egress scanner and the clock");
    return new SlackSource({
      client: new SlackWebClient(x.secrets),
      channels: slackConfig(c.loaded.file).channels,
      scanner: x.scanner,
      log: new ConsoleLogger(x.clock, "slack"),
    });
  },
});
