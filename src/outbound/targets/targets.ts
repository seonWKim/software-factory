// The delivery targets outbound runs (RFC 0015 §7): github-change, github-comment, github-labels, slack-thread, local,
// and source for any other configured adapter. A process delivers only what one of its targets accepts; the rest
// waits for a process that has the adapter.

import type { SourceRef } from "../../core/types.js";
import { act, type Delivery, type DeliveryTarget, type TargetDeps } from "./target.js";

const GITHUB = "github_issue";
const SLACK = "slack_thread";
const LOCAL = "local";

function typeOf(d: Delivery): string {
  return d.kind === "comment" ? d.source_type : d.row.source_type;
}

/** A PR's status label goes through the forge, where PRs live (issue #273), labelled for the item's source. */
function prStatus(d: Delivery): { pr: number; item: SourceRef; status: string } | null {
  if (d.kind !== "action" || d.row.action !== "status" || typeof d.row.args.pr !== "number") return null;
  return { pr: d.row.args.pr, item: JSON.parse(String(d.row.args.item_source)) as SourceRef, status: String(d.row.args.status) };
}

export function buildTargets(t: TargetDeps): DeliveryTarget[] {
  const forge = t.forge;
  const adapter = (type: string) => t.byType.get(type) ?? null;
  const prOf = (target: SourceRef) => forge?.prNumberOf(target) ?? null;
  return [
    {
      // A PR closed with one comment naming who closed its issue (`{closer}` in `body_by`), through the forge.
      name: "github-change",
      accepts: (d) => d.kind === "action" && d.row.action === "close_pr" && forge !== null,
      async deliver(d) {
        if (d.kind !== "action" || !forge) throw new Error("github-change delivers PR actions only");
        const a = d.row.args;
        await forge.closePr({
          pr: Number(a.pr),
          closed: JSON.parse(String(a.closed)) as SourceRef,
          marker: String(a.marker),
          body: (closer) => (closer?.login ? String(a.body_by).replace("{closer}", `@${closer.login}`) : String(a.body)),
        });
        return { url: null };
      },
    },
    {
      name: "github-comment",
      accepts: (d) =>
        (d.kind === "comment" && prOf(d.target) !== null) ||
        ((d.kind === "comment" || d.row.action === "post") && typeOf(d) === GITHUB && adapter(GITHUB) !== null),
      async deliver(d) {
        if (d.kind === "action") return act(adapter(GITHUB)!, d.row);
        const pr = prOf(d.target);
        if (forge && pr !== null) return forge.postPrComment(pr, d.body, d.marker);
        return adapter(GITHUB)!.postComment(d.target, d.body, d.marker);
      },
    },
    {
      name: "github-labels",
      accepts: (d) => (prStatus(d) !== null && forge !== null) || (d.kind === "action" && typeOf(d) === GITHUB && adapter(GITHUB) !== null),
      async deliver(d) {
        const pr = prStatus(d);
        if (pr && forge) {
          await forge.setPrStatus(pr.item, pr.status as Parameters<typeof forge.setPrStatus>[1], pr.pr);
          return { url: null };
        }
        if (d.kind !== "action") throw new Error("github-labels delivers actions only");
        return act(adapter(GITHUB)!, d.row);
      },
    },
    {
      name: "slack-thread",
      accepts: (d) => typeOf(d) === SLACK && prStatus(d) === null && adapter(SLACK) !== null,
      deliver: (d) => (d.kind === "comment" ? adapter(SLACK)!.postComment(d.target, d.body, d.marker) : act(adapter(SLACK)!, d.row)),
    },
    {
      // A local item's surface is the store itself: nothing to write.
      name: "local",
      accepts: (d) => typeOf(d) === LOCAL,
      deliver: async () => ({ url: null }),
    },
    {
      name: "source",
      accepts: (d) => ![GITHUB, SLACK, LOCAL].includes(typeOf(d)) && prStatus(d) === null && adapter(typeOf(d)) !== null,
      deliver: (d) => (d.kind === "comment" ? adapter(d.source_type)!.postComment(d.target, d.body, d.marker) : act(adapter(typeOf(d))!, d.row)),
    },
  ];
}
