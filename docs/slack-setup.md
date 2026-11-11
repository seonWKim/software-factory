# Slack app setup

One-time setup for the factory's Slack app. It lets the factory talk with people in Slack threads in real time (Socket Mode). It takes about five minutes: three steps are commands, three are clicks in the browser, because Slack has no API for them.

Nothing uses these tokens until the `slack` source plugin is selected (SET_UP.md, Slack; docs/plugins/source-adapter.md). Setting the app up early is safe.

## What gets created

- An app called **Gongbang** with a bot user `@gongbang`, defined in [`slack/manifest.json`](../slack/manifest.json):
  - **Socket Mode on:** Slack pushes events over a WebSocket the factory opens. The factory needs no public URL or open port.
  - **Interactivity on**, for the command buttons in threads.
  - **Bot scopes:** `app_mentions:read` (see @mentions), `channels:history` (read replies in threads it's part of, in public channels), `groups:history` (the same in private channels), `chat:write` (reply), `im:write` (open a DM to tell a person something, e.g. the owner), `reactions:read` (see a 👍 or 👎 on a factory message, read as a verdict), `reactions:write` (a 👀 on each typed command's message, so a command with no reply is still acknowledged). Nothing else. An app installed before `reactions:write` was added does not have it: update the manifest and reinstall the app (see [Changing the app later](#changing-the-app-later)) to grant it. Until then the 👀 fails with `missing_scope`, which the factory logs as a warning; commands still run.
  - **Events:** `app_mention`, `message.channels` (messages in public channels), `message.groups` (messages in private channels), `reaction_added` (a reaction on a message in a channel the bot is in).
  - **Reactions as verdicts:** `reactions:read` and the `reaction_added` event let a 👍 or 👎 on one of the factory's messages in a work item's thread count as a verdict (👍 stores `accept`; 👎 gets one reply asking for `/verdict changes <severity> <reason>`). An app installed before they were added does not have them: update the app from the manifest and **reinstall it** (see [Changing the app later](#changing-the-app-later)). Until then reactions are not read; everything else, the GitHub side included, works as before.
  - Public and private channels are both covered by these scopes and events. Without `groups:history` and `message.groups`, Slack sends nothing from a private channel.
- Two secrets in the factory's secret file (`~/.config/software-factory/.env`, outside the repository; see [`docs/setup.md`](setup.md)):
  - `SLACK_BOT_TOKEN` (`xoxb-…`): posts and reads as the bot.
  - `SLACK_APP_TOKEN` (`xapp-…`, scope `connections:write`): opens the Socket Mode connection.

## Steps

All commands run from the repository root. Every token is typed into a hidden prompt: it never appears on screen, in shell history or in a log, and is written only to the secret file.

### 1. Get a configuration token (browser)

Open <https://api.slack.com/apps>. At the bottom, under **Your App Configuration Tokens**, click **Generate Token** for your workspace and copy the **access token** (`xoxe.xoxp-…`). It expires after 12 hours, and it's only used in step 2.

### 2. Create the app (command)

```sh
scripts/slack-app.sh create
```

Paste the configuration token when asked. It prints `ok`, the app ID and an install link. If it prints `error: …`, the token has usually expired; generate a new one.

### 3. Install it to the workspace (browser)

Open the install link from step 2 and click **Allow**. Then, on the app's **OAuth & Permissions** page, copy the **Bot User OAuth Token** (`xoxb-…`).

### 4. Create the Socket Mode token (browser)

On the app's **Basic Information** page, under **App-Level Tokens**, click **Generate Token and Scopes**, add the scope `connections:write`, generate, and copy the token (`xapp-…`).

### 5. Store both tokens (command)

```sh
scripts/slack-app.sh tokens
```

Paste each token when asked. A token with the wrong prefix is refused. A name already in the secret file is left alone; to replace one, edit the secret file.

### 6. Check (command)

```sh
scripts/slack-app.sh check
```

All four lines should say ok:

```
tokens present: { bot: true, app: true, botPrefix: 'xoxb-', appPrefix: 'xapp-' }
bot auth.test: ok (team <your workspace>, bot user U…)
apps.connections.open: ok
socket: hello received (connections: 1)
```

| If it says | Fix |
|---|---|
| `bot: false` or `app: false` | Run step 5 again. |
| `invalid_auth` or `not_authed` on `auth.test` | The bot token is wrong or was revoked. Reinstall (step 3), then replace it in the secret file. |
| `invalid_auth` on `apps.connections.open` | The app token is wrong or lacks `connections:write`. Redo step 4. |
| `mark seen failed` with `missing_scope` in the factory log | The install predates `reactions:write`. Update the manifest and reinstall (see [Changing the app later](#changing-the-app-later)). |
| `no hello within 10s` | A network or proxy is blocking WebSockets to `wss-primary.slack.com`. |

### 7. Invite the bot to a channel (Slack)

In the channel the factory should listen in, type `/invite @gongbang`. Copy the channel ID from the channel details (bottom of the **About** tab, `C…`). The `slack` source plugin reads it from the `slack` block of `factory.config.json`: `"slack": { "channels": ["C…"] }`.

A private channel (ID starting with `G…`) works the same way once the bot is invited to it: list its ID in `channels` like a public one.

**Installed before private channels were supported?** An app installed before `groups:history` and `message.groups` were added to the manifest does not get private-channel events. Update the app from the manifest and reinstall it once (see "Changing the app later"); nothing changes on its own. Messages a private channel sent before the reinstall are not read again.

## Changing the app later

Edit `slack/manifest.json`, then update the app on its **App Manifest** page (paste the JSON). If scopes changed, Slack asks you to reinstall; the bot token stays the same unless you revoke it.

## Revoking

If a token may have leaked: on the app's pages, **revoke** it (**OAuth & Permissions** → Revoke for the bot token, **Basic Information** → App-Level Tokens → Revoke for the app token). Then create a new one (steps 3–4), and replace the line in the secret file.
