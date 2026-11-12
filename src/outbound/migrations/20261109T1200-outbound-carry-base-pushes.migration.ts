// RFC 0015 M8: a local merge's base push is outbound's `push_base` action. A base push still pending in
// `outbound_base_pushes` at upgrade becomes that action, under the key the merge would record (`push_base:<item>:<sha>`),
// so it is pushed once and not lost. A migration knows no host id, so its destination is the `local` host's base push
// (`git:local:<base>:push`), which every controller flushes: a solo one flushes every host's, and a replica on a
// shared store flushes the `local` host's beside its own, as any replica pushed these before (design 10-event-driven,
// Git destinations). Additive: rows only, keyed, safe to rerun.

import { insertOrSkip } from "../../bus/index.js";
import { defineMigration, tableExists } from "../../state/index.js";
import { LOCAL_GIT_HOST, basePushTarget } from "../intents.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableExists(db, "outbound_base_pushes"))) return;
    const pending = await db.all("SELECT work_item_id, base_ref, merge_sha, created_at FROM outbound_base_pushes WHERE finished_at IS NULL ORDER BY seq");
    for (const p of pending) {
      const [id, base, sha] = [String(p.work_item_id), String(p.base_ref), String(p.merge_sha)];
      const target = basePushTarget(LOCAL_GIT_HOST, base);
      const args = { base_ref: base, merge_sha: sha, message: `Merge origin/${base} into ${base}\n\nBefore the base push of work item ${id}.` };
      await insertOrSkip(
        db,
        "outbound_actions (work_item_id, source_type, target, action, args, intent_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, target.type, JSON.stringify(target), "push_base", JSON.stringify(args), `push_base:${id}:${sha}`, String(p.created_at)],
      );
    }
  },
});
