import { useMemo, useState } from "react";
import { API, type ItemRow, type Items, useApi, useItems } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Section } from "../components/ui/parts.js";
import { StatusBadge } from "../components/ui/notice.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";
import { NeedsGroups, byId, needsYou, useNow } from "./common.js";
import { ItemCommands } from "./item-commands.js";

/** The five states a built task shows on its row, from its work item's level (src/ui/priority.ts); a closed item is "merged" only when it closed as completed. */
const STATE_OF: Record<string, MessageKey> = {
  needs_approval: "tasks.state.spec",
  running: "tasks.state.running",
  queued: "tasks.state.running",
  ready_to_merge: "tasks.state.merge",
  needs_you: "tasks.state.needs",
  needs_triage: "tasks.state.needs",
  stuck: "tasks.state.needs",
};

const stateKey = (it: ItemRow): MessageKey | null => (it.level === "closed" ? (it.close_reason === "completed" ? "tasks.state.merged" : null) : (STATE_OF[it.level] ?? null));

/** The work item's state as a button that opens its commands in a Dialog; nothing while the items list lacks the item. */
export function WorkState({ id, title }: { id: string; title: string }) {
  const items = useApi<Items>(API.items).data?.items;
  const it = items?.find((i) => i.id === id);
  const [open, setOpen] = useState(false);
  const key = it ? stateKey(it) : null;
  if (!it || key === null) return null;
  return (
    <>
      <Button size="sm" aria-label={t("tasks.stateOpen", { title })} onClick={() => setOpen(true)}>
        <StatusBadge level={it.level} size="sm">{t(key)}</StatusBadge>
      </Button>
      {open && (
        <Dialog title={it.title ?? title} confirmLabel={t("tasks.stateClose")} onConfirm={() => setOpen(false)} onClose={() => setOpen(false)}>
          <Link href={itemPath(id)} className={LINK_CLASS}>{t("tasks.stateFull")}</Link>
          <ItemCommands id={id} commands={it.commands ?? []} replies={[]} />
        </Dialog>
      )}
    </>
  );
}

/**
 * Factory work: the open items that need the owner, in the Needs-you groups with their row actions; with `project` (the
 * Tasks page's switcher) only those built from a task in that project.
 */
export function FactoryWork({ project }: { project: string | null }) {
  const now = useNow();
  const items = useItems(project);
  const rows = items.data?.items;
  const needs = useMemo(() => needsYou(rows ?? []), [rows]);
  const titles = useMemo(() => byId(rows), [rows]);
  if (items.isError) return <ErrorNote error={items.error} />;
  if (!rows) return null;
  return (
    <Section title={t("tasks.factoryWork")} count={needs.length}>
      <NeedsGroups items={needs} now={now} titles={titles} empty={t("needs.empty")} />
    </Section>
  );
}
