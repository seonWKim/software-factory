import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type CommandReply, type ItemCommand, type ItemDetail, type ItemRow, type RequestState, type Session, mergeInFlight, plainRefusal, postCommand, useApi } from "../api.js";
import { t } from "../i18n/index.js";

// Structurally command-box.tsx's Outcome; declared here because tsconfig.test.json (no JSX) cannot import a .tsx file.
type Outcome = { tone: "error" | "status"; text: string } | null;

/**
 * What this page did with a command since it loaded: the request it sent (with the row's `label` when the server
 * applied it at once, or the `refusal` it answered with), or the error its send got.
 */
export type LocalSend = { seq: number; label?: string | null; refusal?: string | null } | { error: string };

/** The text beside a button the viewer's grants do not allow: the controller's reason, in plain words. */
export function notAllowed(c: ItemCommand): Outcome {
  return { tone: "status", text: plainRefusal(c.reason ?? "not allowed") };
}

/**
 * The outcome of the item's latest request for `command`: its refusal, "sent" while not handled, else "Done".
 * A send from this page wins until a reply as new as it arrives; a failed send shows its error.
 */
export function commandOutcome(replies: readonly CommandReply[], command: string, local?: LocalSend): Outcome {
  if (local && "error" in local) return { tone: "error", text: local.error };
  if (local?.refusal) return { tone: "error", text: plainRefusal(local.refusal) };
  const latest = replies.filter((r) => r.command === command).reduce<CommandReply | null>((a, r) => (a && a.seq > r.seq ? a : r), null);
  // Applied at once: its label until a newer request's reply, or a refusal of this one, arrives.
  if (local?.label && (!latest || latest.seq <= local.seq) && !latest?.refusal) return { tone: "status", text: local.label };
  if (local && (!latest || latest.seq < local.seq)) return { tone: "status", text: t("commands.sent") };
  if (!latest) return null;
  if (latest.refusal) return { tone: "error", text: plainRefusal(latest.refusal) };
  return { tone: "status", text: latest.handled_at === null ? t("commands.sent") : t("commands.done") };
}

/** Whether `outcome` is the "sent" state: a request queued, its reply not here yet. */
export const awaitsReply = (outcome: Outcome): boolean => outcome?.tone === "status" && outcome.text === t("commands.sent");

/** The fields of the item's row and page that a request's state changes; a Merge under way also turns its button. */
function statePatch(s: RequestState): Partial<ItemRow> {
  const fields = { stage: s.stage, blocked_on: s.blocked_on, blocked_reason: s.blocked_reason };
  const merge = { enabled: false, reason: s.label };
  return mergeInFlight(merge) ? { ...fields, merge } : fields;
}

/**
 * Sending app commands for item `id`: `send` posts one with the session's token, keeps what this page did with each
 * command (`local`), merges the item's new state from the response (Approve, Merge) into the item and list queries at
 * once, then re-reads them, so the controller's reply shows. `on`: commands are on for this page's session.
 */
export function useCommandSend(id: string) {
  const client = useQueryClient();
  const session = useApi<Session>(API.session, false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<Record<string, LocalSend>>({});
  const token = session.data?.csrf_token;
  const send = async (command: string, note: string, proposal?: string): Promise<boolean> => {
    if (!token) return false;
    setBusy(true);
    // A proposal's Confirm all or Cancel is kept under the proposal's ID, every other send under its command.
    const key = proposal ?? command;
    try {
      const r = await postCommand(token, id, command, note, proposal);
      setLocal((m) => ({ ...m, [key]: r.ok ? { seq: r.seq, label: r.state?.label ?? null, refusal: r.refusal ?? null } : { error: r.error } }));
      if (r.ok && r.state) {
        const patch = statePatch(r.state);
        client.setQueryData<ItemDetail>([API.item(id)], (old) => (old ? { ...old, item: { ...old.item, ...patch } } : old));
        client.setQueriesData<{ items?: ItemRow[] }>({ predicate: (q) => String(q.queryKey[0]).startsWith(API.items) }, (old) =>
          Array.isArray(old?.items) ? { ...old, items: old.items.map((row) => (row.id === id ? { ...row, ...patch } : row)) } : old);
      }
      if (r.ok) await Promise.all([client.invalidateQueries({ queryKey: [API.item(id)] }), client.invalidateQueries({ queryKey: [API.items] })]);
      return r.ok;
    } catch (err) {
      setLocal((m) => ({ ...m, [key]: { error: err instanceof Error ? err.message : String(err) } }));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { session, on: !!token && session.data?.commands_enabled === true, busy, local, send };
}
