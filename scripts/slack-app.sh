#!/usr/bin/env bash
# One-time Slack app setup for the factory (docs/slack-setup.md).
#   scripts/slack-app.sh create   create the app from slack/manifest.json (asks for a config token, hidden)
#   scripts/slack-app.sh tokens   store SLACK_BOT_TOKEN and SLACK_APP_TOKEN in the secret file (hidden prompts)
#   scripts/slack-app.sh check    bot token works and Socket Mode says hello (prints no token)
# Tokens are read with hidden prompts and never echoed, logged or written anywhere but the secret file.
set -euo pipefail
cd "$(dirname "$0")/.."
SECRETS="${SOFTWARE_FACTORY_SECRETS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/software-factory/.env}"

ask() { local v; read -rsp "$1" v; echo >&2; printf '%s' "$v"; }

case "${1:-}" in
  create)
    cfg=$(ask "Slack app configuration token (xoxe.xoxp-…, from api.slack.com/apps): ")
    curl -s https://slack.com/api/apps.manifest.create \
      -H "Authorization: Bearer $cfg" \
      --data-urlencode "manifest@slack/manifest.json" |
      python3 -c 'import json,sys; r=json.load(sys.stdin); print("ok" if r.get("ok") else "error: " + str(r.get("error")), r.get("app_id",""), r.get("oauth_authorize_url",""))'
    ;;
  tokens)
    [ -f "$SECRETS" ] || { echo "no secret file at $SECRETS; run npm run setup first" >&2; exit 1; }
    for name in SLACK_BOT_TOKEN SLACK_APP_TOKEN; do
      prefix=$([ "$name" = SLACK_BOT_TOKEN ] && echo xoxb- || echo xapp-)
      if grep -q "^$name=" "$SECRETS"; then echo "$name already set (edit the secret file to replace it)"; continue; fi
      v=$(ask "$name ($prefix…): ")
      case "$v" in "$prefix"*) ;; *) echo "$name must start with $prefix; not stored" >&2; exit 1 ;; esac
      printf '%s=%s\n' "$name" "$v" >> "$SECRETS"
      echo "$name stored"
    done
    ;;
  check)
    [ -f dist/impl/secrets/env-file-secret-store.js ] || npm run -s build
    node scripts/slack-check.mjs
    ;;
  *)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
