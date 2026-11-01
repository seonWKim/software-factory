// scripts/slack-app.sh check: bot token works and Socket Mode says hello. Prints only Slack's answers, never a token.
import { readFile } from "node:fs/promises";
import { defaultSecretsFile, parseEnvFile } from "../dist/impl/secrets/env-file-secret-store.js";
const vals = parseEnvFile(await readFile(defaultSecretsFile(), "utf8"), ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
const bot = vals.get("SLACK_BOT_TOKEN"), app = vals.get("SLACK_APP_TOKEN");
console.log("tokens present:", { bot: !!bot, app: !!app, botPrefix: bot?.slice(0, 5), appPrefix: app?.slice(0, 5) });
const call = async (method, token) => (await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json();
const auth = await call("auth.test", bot);
console.log("bot auth.test:", auth.ok ? `ok (team ${auth.team}, bot user ${auth.user_id})` : auth.error);
const conn = await call("apps.connections.open", app);
if (!conn.ok) { console.log("apps.connections.open:", conn.error); process.exit(1); }
console.log("apps.connections.open: ok");
const ws = new WebSocket(conn.url);
const t = setTimeout(() => { console.log("no hello within 10s"); ws.close(); process.exit(1); }, 10000);
ws.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === "hello") { console.log(`socket: hello received (connections: ${e.num_connections})`); clearTimeout(t); ws.close(); process.exit(0); }
};
ws.onerror = () => { console.log("socket error"); process.exit(1); };
