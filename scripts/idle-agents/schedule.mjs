// Pure helpers for scripts/idle-agents.mjs, importable without side effects (tests/idle-agents.test.ts): the
// once-a-day due check, the run record (length, browser use) and the project factory's revision lag.
// `now` and `timeZone` are parameters so a test can fake the clock and the zone; the script passes the real ones.

/** The local date (YYYY-MM-DD) of a timestamp: "once a day" follows the owner's day, not UTC's. */
export function localDate(when, timeZone) {
  return new Date(when).toLocaleDateString("sv-SE", timeZone ? { timeZone } : {});
}

/** Whether an agent last run at `lastRun` (an ISO time, or undefined for never) is due again at `now`. */
export function isDue(lastRun, now, timeZone) {
  return !lastRun || localDate(lastRun, timeZone) !== localDate(now, timeZone);
}

/** The agent to run now: due, allowed now, longest ago first; null when none is due. */
export function pick(agents, last, allowed, now, timeZone) {
  const due = agents.filter((a) => allowed(a) && isDue(last[a], now, timeZone));
  due.sort((a, b) => (last[a] ?? "").localeCompare(last[b] ?? ""));
  return due[0] ?? null;
}

/** Browser tool calls in a run's `claude --output-format stream-json` output. Lines that are not JSON are skipped. */
export function countBrowserCalls(streamJson) {
  let calls = 0;
  for (const line of streamJson.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    calls += event.message.content.filter((c) => c?.type === "tool_use" && String(c.name).startsWith("mcp__playwright__")).length;
  }
  return calls;
}

/** One agent's last run for `status`: its length and browser use, "unknown" for runs recorded before both were kept. */
export function describeRun(run) {
  const length = typeof run?.seconds === "number" ? `${run.seconds} s` : "unknown";
  const browser = typeof run?.browserCalls === "number" ? (run.browserCalls > 0 ? `yes (${run.browserCalls} calls)` : "no") : "unknown";
  return `length ${length}, browser ${browser}`;
}

/**
 * The prompt line on the project factory's revision. `revTime` and `mainTime` are commit times in seconds, or null
 * when unknown (no supervisor.json, no `rev`, or a commit this checkout does not have).
 */
export function revisionLine(rev, revTime, mainTime) {
  if (!rev || revTime == null || mainTime == null) return "Project factory revision: unknown (no supervisor.json, no rev, or a commit not in this checkout).";
  const hours = Math.max(0, Math.round((mainTime - revTime) / 3600));
  const behind = hours > 24 ? "MORE than a day behind origin/main: say so in your notes and file it as a problem" : "within a day of origin/main";
  return `Project factory revision: ${rev.slice(0, 12)}, ${hours} h behind origin/main (${behind}).`;
}
