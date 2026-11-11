// The quick-add box's way to the factory: POST /api/v1/tasks on the local dashboard API, with the dashboard's own
// Origin and the per-process CSRF token from GET /api/v1/session, as the dashboard page sends them. Sent from the
// shell's main process, never from the box's page. The caller chooses the task ID, so a resend stores one task.

const origin = (port) => `http://127.0.0.1:${port}`;

/** The route the box posts to. */
export const tasksUrl = (port) => `${origin(port)}/api/v1/tasks`;

/** The route the token comes from. */
export const sessionUrl = (port) => `${origin(port)}/api/v1/session`;

const UNREACHABLE = "The factory is not reachable; try again once it runs.";

/**
 * A function that posts `{ id, words }` and answers `{ ok: true, task }` or `{ ok: false, message }`. It reads the
 * token once and again after a 403 (a restarted factory has a new one), then sends the same body once more.
 */
export function taskPoster({ fetch, port }) {
  let token = null;
  const session = async () => {
    const res = await fetch(sessionUrl(port));
    const body = res.ok ? await res.json() : null;
    if (typeof body?.csrf_token !== "string") throw new Error("no session");
    return body.csrf_token;
  };
  const send = (t, body) =>
    fetch(tasksUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json", origin: origin(port), "x-csrf-token": t },
      body: JSON.stringify(body),
    });
  return async (body) => {
    let res;
    try {
      token ??= await session();
      res = await send(token, body);
      if (res.status === 403) {
        token = await session();
        res = await send(token, body);
      }
    } catch {
      token = null;
      return { ok: false, message: UNREACHABLE };
    }
    const answer = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, task: answer.task } : { ok: false, message: answer.error ?? `The factory answered ${res.status}.` };
  };
}

/** The parsed fields of quick-add words as the box's chips, in a fixed order; the title is the text itself. */
export function fieldChips(fields) {
  const chips = [];
  if (fields.due) chips.push({ field: "due", text: "date" in fields.due ? fields.due.date : fields.due.days_from_today === 0 ? "today" : "tomorrow" });
  if (fields.due_time) chips.push({ field: "time", text: fields.due_time });
  if (fields.priority) chips.push({ field: "priority", text: `!${fields.priority}` });
  if (fields.list) chips.push({ field: "list", text: `#${fields.list}` });
  if (fields.recurrence) chips.push({ field: "recurrence", text: `every ${fields.recurrence}` });
  return chips;
}
