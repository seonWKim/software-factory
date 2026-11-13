import { OwnerAuth } from "../../core/authorize.js";
import { definePlugin } from "../../plugin-api.js";
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
  create: (c) => {
    const block = slackConfig(c.loaded.file);
    return new SlackSource({
      api: new HttpSlackApi(c.secrets),
      connect: webSocketConnector,
      channels: block.channels,
      // The owner's notices (design 12-notification-channels): slack.notify_channel, else the first listed channel.
      ...(block.notify_channel !== undefined ? { notify_channel: block.notify_channel } : {}),
      // A spec message's Full spec link and each notice's link go to slack.dashboard_url (https) when set; without it
      // they are View buttons that open the item in a Slack modal, never a link to the local dashboard (a phone cannot open it).
      ...(block.dashboard_url !== undefined ? { dashboard_url: block.dashboard_url } : {}),
      scanner: c.scanner,
      store: c.store,
      // A Good, Bad or Feedback tap's record_verdict check: the owner check every command path takes (design 08-permissions).
      auth: new OwnerAuth(c.store),
      repo: c.repo,
      log: c.log,
      // `settings list` and `settings history` from Slack: the CLI's own reads over the same store and config file.
      // Imported when asked: compose.ts loads the plugin registry, which imports this file.
      settings: async (args) => {
        const [{ settingsBase }, { parseSettingsArgs, runSettings }] = await Promise.all([import("../../compose.js"), import("../../settings-cmd.js")]);
        const a = parseSettingsArgs(args);
        if ("error" in a) return { ok: false, lines: [a.error] };
        if (a.action !== "list" && a.action !== "history") return { ok: false, lines: [`settings ${a.action} is not run from Slack`] };
        const refuse = () => Promise.reject(new Error("settings reads name no project"));
        return runSettings({ store: c.store, base: settingsBase(c.loaded), repo: c.repo, resolveProject: refuse, actor: "" }, a);
      },
    });
  },
});
