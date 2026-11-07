import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API, type CommandReply, type MergeCheckView, type MergeView, type Session, mergeBlocked, postCommand, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { cn } from "../lib/cn.js";
import { isHttpUrl } from "../lib/format.js";
import { type LocalSend, type Outcome, OutcomeText, commandOutcome } from "./item-commands.js";

// The Merge button (design §9, issue #246) on Floor rows and the item page, only where the API gives a `merge` view
// (a factory PR waiting for a human merge, merge command on). It opens a confirmation with the title, tier, size and
// PR link; confirming sends a `merge` command (POST /api/v1/items/:id/commands), and the row shows "merging" until
// the controller merges (the item leaves Needs you) or refuses (the reason shows next to the button).

/** The merge's outcome: a failed send or a refusal as an error, else "merging" while a request is out. */
export function mergeOutcome(replies: readonly CommandReply[], local?: LocalSend): Outcome {
  const o = commandOutcome(replies, "merge", local);
  if (!o || o.tone === "error") return o;
  return { tone: "status", text: "merging" };
}

const count = (n: number | null, one: string, many: string) => (n === null ? "unknown" : `${n} ${n === 1 ? one : many}`);

export function MergeButton({ id, merge, check }: { id: string; merge: MergeView; check?: MergeCheckView | null | undefined }) {
  const client = useQueryClient();
  const session = useApi<Session>(API.session, false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<LocalSend | undefined>(undefined);
  const token = session.data?.csrf_token;
  const outcome = mergeOutcome(merge.replies, local);
  const merging = outcome?.tone === "status";
  const disabled = !token || session.data?.commands_enabled !== true || mergeBlocked(check) || busy || merging;

  const send = async () => {
    if (!token) return;
    setBusy(true);
    setConfirming(false);
    try {
      const r = await postCommand(token, id, "merge", "");
      setLocal(r.ok ? { seq: r.seq } : { error: r.error });
      if (r.ok) await Promise.all([client.invalidateQueries({ queryKey: [API.items] }), client.invalidateQueries({ queryKey: [API.item(id)] })]);
    } catch (err) {
      setLocal({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span data-merge={id} className="mt-1 flex flex-wrap items-center gap-2">
      <Button variant="outline" className="h-7 w-auto px-2 text-xs" disabled={disabled || confirming} onClick={() => setConfirming(true)}>
        Merge
      </Button>
      <OutcomeText outcome={outcome} />
      {confirming && (
        <span role="dialog" aria-label={`Merge PR #${merge.pr_number}`} className="block w-full rounded-md border border-zinc-300 p-2 text-sm dark:border-zinc-700">
          <span className="mb-2 block text-pretty">Merge PR #{merge.pr_number} into the base branch?</span>
          <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-zinc-600 dark:text-zinc-400">Title</dt>
            <dd data-merge-title className="break-words">{merge.title ?? "–"}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">Tier</dt>
            <dd data-merge-tier>{merge.tier ?? "–"}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">Changed</dt>
            <dd data-merge-size>{count(merge.files, "file", "files")}, {count(merge.lines, "line", "lines")}</dd>
            {isHttpUrl(merge.pr_url) && (
              <>
                <dt className="text-zinc-600 dark:text-zinc-400">PR</dt>
                <dd>
                  <a data-merge-pr href={merge.pr_url} target="_blank" rel="noreferrer" className={cn("tabular-nums", LINK_CLASS)}>#{merge.pr_number}</a>
                </dd>
              </>
            )}
          </dl>
          <span className="flex gap-2">
            <Button variant="outline" className="h-7 w-auto px-2 text-xs" disabled={disabled} onClick={() => void send()}>
              Confirm merge
            </Button>
            <Button variant="outline" className="h-7 w-auto px-2 text-xs" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}
