import { settingsBase } from "../../compose.js";
import { definePlugin } from "../../plugin-api.js";
import { parseSettingsArgs, runSettings } from "../../settings-cmd.js";
import { HttpSlackApi, SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from "./slack-api.js";
import { slackConfig } from "./slack-config.js";
import { webSocketConnector } from "./slack-socket.js";
import { SlackSource } from "./slack-source.js";

// Slack threads as work items, in real time over Socket Mode (issue #109). Off unless `plugins.source` lists it;
// then the `slack` block of factory.config.json is required. Reads only its two Slack tokens.
export default definePlugin({
  kind: "source",
  name: "slack",
  secrets: [
    { name: SLACK_APP_TOKEN, purpose: "Slack app-level token (xapp-, connections:write): opens the Socket Mode connection" },
    { name: SLACK_BOT_TOKEN, purpose: "Slack bot token (xoxb-): reads the listed channels' threads and replies in them" },
  ],
  create: (c) =>
    new SlackSource({
      api: new HttpSlackApi(c.secrets),
      connect: webSocketConnector,
      channels: slackConfig(c.loaded.file).channels,
      scanner: c.scanner,
      store: c.store,
      repo: c.repo,
      log: c.log,
      // `settings list` and `settings history` from Slack: the CLI's own reads over the same store and config file.
      settings: async (args) => {
        const a = parseSettingsArgs(args);
        if ("error" in a) return { ok: false, lines: [a.error] };
        if (a.action !== "list" && a.action !== "history") return { ok: false, lines: [`settings ${a.action} is not run from Slack`] };
        const refuse = () => Promise.reject(new Error("settings reads name no project"));
        return runSettings({ store: c.store, base: settingsBase(c.loaded), repo: c.repo, resolveProject: refuse, actor: "" }, a);
      },
    }),
});
