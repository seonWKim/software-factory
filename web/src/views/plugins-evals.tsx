import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type EvalCase, type EvalWrite, type EvalWritten, type StarterCase, type TriedCase, postEvalWrite, useEvalRuns, useEvalSuite, useEvalSuites, useEvalsToken } from "../api/evals.js";
import { CARD_INTRO } from "../components/ui/card.js";
import { Clamp } from "../components/ui/clamp.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Notice } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Textarea } from "../components/ui/textarea.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { skillName } from "./evals.js";

// The Plugins page's Evals content (design 09-dashboard-settings, 2026-11-24): the body of the ModalPanel a Skills row's
// Evals button opens (plugins.tsx, which owns the title and the close icon), for one skill's SKILL.md path. It reads GET /api/v1/evals/<path>/suite (the suite and its cases) and /runs (how many runs keep their
// history after a delete), and writes each op through POST /api/v1/evals/write with GET /api/v1/pauses's csrf_token.
// Every input, each delete and each try result opens in the shared Dialog, so no row changes height; a refusal (409)
// stays in the open Dialog and nothing else changes. Labels are plain words: no suite, case or run ID is shown.
// A skill with no cases also gets Draft starter cases (design 07-self-improvement): its Dialog drafts the set with one
// model call per Draft click (starter.draft, nothing saved), lists the drafts, and Accept sends the whole set in one
// starter.accept. It is off, with GET /api/v1/evals's reason in a Notice, when the server cannot draft.

/** A case's input as text: text as it is, any other value as JSON. */
const inputText = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input));

/** A case's rubric checks (a list, or `{ checks }`); [] when it holds none. */
function checksOf(expected: unknown): string[] {
  const list = Array.isArray(expected) ? expected : typeof expected === "object" && expected !== null ? (expected as { checks?: unknown }).checks : null;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : [];
}

/** The non-empty lines of a text area. */
const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** One write: busy while it runs, the refusal kept for the open Dialog; on success the suite and runs are read again. */
function useEvalWrite(path: string, token: string | null) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: EvalWrite): Promise<EvalWritten | null> => {
    if (token === null) return null;
    setBusy(true);
    setError(null);
    const r = await postEvalWrite(token, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return null;
    }
    const enc = encodeURIComponent(path);
    await Promise.all(["suite", "runs"].map((read) => client.invalidateQueries({ queryKey: [`/api/v1/evals/${enc}/${read}`] })));
    return r.value;
  };
  return { busy, error, send, clear: () => setError(null) };
}

type Write = ReturnType<typeof useEvalWrite>;

/** Add or rename the test set: one name field. */
function SuiteDialog({ path, write, initial, adding, onClose }: { path: string; write: Write; initial: string; adding: boolean; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const confirm = async () => {
    const body: EvalWrite = adding ? { op: "suite.add", skill: path, title: name.trim() } : { op: "suite.rename", skill: path, title: name.trim() };
    if ((await write.send(body)) !== null) onClose();
  };
  return (
    <Dialog
      title={t(adding ? "evals.addSuiteTitle" : "evals.renameSuiteTitle")}
      {...(adding ? { consequence: t("evals.addSuiteConsequence") } : {})}
      confirmLabel={t(adding ? "evals.addSuite" : "evals.renameSuite")}
      confirmDisabled={write.busy || name.trim() === ""}
      error={write.error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <Field label={t("evals.suiteName")} htmlFor="evals-suite-name">
        <Input id="evals-suite-name" className="w-full" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** Delete the test set or one case: says how many past runs keep their history (the skill's runs read). */
function DeleteDialog({ path, suiteId, write, body, heading, onClose }: { path: string; suiteId: string; write: Write; body: EvalWrite; heading: MessageKey; onClose: () => void }) {
  const runs = useEvalRuns(path);
  const kept = runs.data?.runs.filter((r) => r.suite_id === undefined || r.suite_id === suiteId).length;
  const confirm = async () => {
    if ((await write.send(body)) !== null) onClose();
  };
  return (
    <Dialog
      title={t(heading)}
      consequence={kept === undefined ? t("evals.runsCounting") : t("evals.runsKept", { n: kept })}
      confirmLabel={t("evals.delete")}
      confirmDisabled={write.busy}
      danger
      error={write.error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
  );
}

/** Add a case, or edit one: what the skill is given and its checks, one per line. An edit sends only what changed. */
function CaseDialog({ path, write, edit, onClose }: { path: string; write: Write; edit?: EvalCase; onClose: () => void }) {
  const firstInput = edit ? inputText(edit.input) : "";
  const firstChecks = edit ? checksOf(edit.expected).join("\n") : "";
  const [input, setInput] = useState(firstInput);
  const [checks, setChecks] = useState(firstChecks);
  const confirm = async () => {
    const body: EvalWrite = edit
      ? { op: "case.edit", case: edit.id, ...(input !== firstInput && { input }), ...(checks !== firstChecks && { expected: lines(checks) }) }
      : { op: "case.add", skill: path, input, expected: lines(checks) };
    if ((await write.send(body)) !== null) onClose();
  };
  return (
    <Dialog
      title={t(edit ? "evals.editCaseTitle" : "evals.addCaseTitle")}
      consequence={t("evals.caseConsequence")}
      confirmLabel={t(edit ? "evals.save" : "evals.addCase")}
      confirmDisabled={write.busy || input.trim() === "" || lines(checks).length === 0}
      error={write.error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <Field label={t("evals.input")} htmlFor="evals-case-input">
        <Textarea id="evals-case-input" rows={4} className="w-full" value={input} onChange={(e) => setInput(e.target.value)} />
      </Field>
      <Field label={t("evals.checks")} htmlFor="evals-case-checks" help={t("evals.checksHelp")}>
        <Textarea id="evals-case-checks" rows={4} className="w-full" value={checks} onChange={(e) => setChecks(e.target.value)} />
      </Field>
    </Dialog>
  );
}

const VERDICT: Record<TriedCase["verdict"], { label: MessageKey; level: string }> = {
  pass: { label: "evals.verdictPass", level: "ready_to_merge" },
  fail: { label: "evals.verdictFail", level: "stuck" },
  errored: { label: "evals.verdictErrored", level: "needs_you" },
};

/** Try one case: replays and judges it once, stores nothing; the result stays in the Dialog until it closes. */
function TryDialog({ write, of, onClose }: { write: Write; of: EvalCase; onClose: () => void }) {
  const [tried, setTried] = useState<TriedCase | null>(null);
  const confirm = async () => {
    const r = await write.send({ op: "case.try", case: of.id });
    if (r?.tried) setTried(r.tried);
  };
  return (
    <Dialog
      title={t("evals.tryTitle")}
      consequence={t("evals.tryConsequence")}
      confirmLabel={write.busy ? t("evals.trying") : t(tried ? "evals.tryAgain" : "evals.tryCase")}
      confirmDisabled={write.busy}
      {...(tried ? { cancelLabel: t("common.close") } : {})}
      error={write.error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <p className="text-sm text-pretty wrap-anywhere text-text-2">{inputText(of.input)}</p>
      {tried && (
        <section aria-label={t("evals.verdict")} className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm">
            {t("evals.verdict")} <Badge level={VERDICT[tried.verdict].level}>{t(VERDICT[tried.verdict].label)}</Badge>
          </span>
          {tried.error && <Notice tone="warn">{tried.error}</Notice>}
          <ul className="flex flex-col gap-1">
            {tried.checks.map((c, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
                <Badge level={c.answer === "yes" ? "ready_to_merge" : "stuck"}>{t(c.answer === "yes" ? "evals.answerYes" : "evals.answerNo")}</Badge>
                <span className="font-medium text-pretty wrap-anywhere">{c.check}</span>
                <span className="text-pretty wrap-anywhere text-text-2">{c.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Dialog>
  );
}

/** Import: copies the eval source's cases for this skill into its test set; the count stays in the Dialog. */
function ImportDialog({ path, write, onClose }: { path: string; write: Write; onClose: () => void }) {
  const [done, setDone] = useState<string | null>(null);
  const confirm = async () => {
    const r = await write.send({ op: "import", skill: path });
    if (r) setDone(t("evals.importDone", { added: r.added?.length ?? 0, kept: r.kept?.length ?? 0 }));
  };
  return (
    <Dialog
      title={t("evals.importTitle")}
      consequence={t("evals.importConsequence")}
      confirmLabel={t("evals.import")}
      confirmDisabled={write.busy || done !== null}
      {...(done ? { cancelLabel: t("common.close") } : {})}
      error={write.error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {done && <Notice tone="ok">{done}</Notice>}
    </Dialog>
  );
}

const KIND: Record<StarterCase["kind"], { label: MessageKey; level: string }> = {
  typical: { label: "evals.starterKindTypical", level: "ready_to_merge" },
  edge: { label: "evals.starterKindEdge", level: "needs_you" },
  refuse: { label: "evals.starterKindRefuse", level: "stuck" },
};

/** A drafted case's checks as text: a rubric check's criterion, a text check as it is. */
function criteriaOf(expected: unknown): string[] {
  const list = Array.isArray(expected) ? expected : typeof expected === "object" && expected !== null ? (expected as { checks?: unknown }).checks : null;
  if (!Array.isArray(list)) return [];
  return list.map((c) => (typeof c === "string" ? c : String((c as { criterion?: unknown } | null)?.criterion ?? ""))).filter((c) => c !== "");
}

/** Draft starter cases: each Draft is one model call that saves nothing; Accept writes the listed set in one op. */
function StarterDialog({ path, write, onClose }: { path: string; write: Write; onClose: () => void }) {
  const [drafts, setDrafts] = useState<StarterCase[] | null>(null);
  const draft = async () => {
    setDrafts(null);
    const r = await write.send({ op: "starter.draft", skill: path });
    if (r?.cases) setDrafts(r.cases);
  };
  const confirm = async () => {
    if (drafts === null) return void (await draft());
    if ((await write.send({ op: "starter.accept", skill: path, cases: drafts })) !== null) onClose();
  };
  const label = write.busy && drafts === null ? t("evals.starterDrafting") : drafts ? t("evals.starterAccept", { n: drafts.length }) : t(write.error ? "evals.starterAgain" : "evals.starterDraft");
  return (
    <Dialog title={t("evals.starterTitle")} consequence={t("evals.starterConsequence")} confirmLabel={label} confirmDisabled={write.busy} error={write.error} onConfirm={() => void confirm()} onClose={onClose}>
      {drafts && (
        <ol aria-label={t("evals.starterDrafts")} className="flex flex-col gap-3">
          {drafts.map((c, i) => (
            <li key={i} className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <Badge level={KIND[c.kind].level}>{t(KIND[c.kind].label)}</Badge>
                <span className="font-medium text-pretty wrap-anywhere">{c.title}</span>
              </span>
              <span className="text-pretty wrap-anywhere text-text-2">{c.input}</span>
              <ul className="flex list-disc flex-col gap-0.5 ps-5 text-xs text-text-2">
                {criteriaOf(c.expected).map((k, j) => <li key={j} className="text-pretty wrap-anywhere">{k}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

type Open =
  | { kind: "suite.add" | "suite.rename" | "suite.delete" | "case.add" | "import" | "starter" }
  | { kind: "case.edit" | "case.delete" | "case.try"; of: EvalCase };

/** The Evals content for one skill's SKILL.md path: its test set and cases, each change in a Dialog. */
export function EvalsCard({ path }: { path: string }) {
  const q = useEvalSuite(path);
  const token = useEvalsToken().data?.csrf_token ?? null;
  const write = useEvalWrite(path, token);
  const [open, setOpen] = useState<Open | null>(null);
  const show = (o: Open) => {
    write.clear();
    setOpen(o);
  };
  const close = () => setOpen(null);
  const off = token === null;
  const offTitle = off ? t("evals.cannotWrite") : undefined;
  const suite = q.data?.suite ?? null;
  const cases = q.data?.cases ?? [];
  const n = (c: EvalCase) => cases.indexOf(c) + 1;
  const suites = useEvalSuites();
  // Why Draft starter cases is off: the server's reason, a plain one from an older server, null when it can draft.
  const starterOff = !suites.data ? null : suites.data.starter === undefined ? t("evals.starterOff") : suites.data.starter;
  const starter = (
    <Button disabled={off || !suites.data || starterOff !== null} title={offTitle ?? starterOff ?? undefined} onClick={() => show({ kind: "starter" })}>{t("evals.starter")}</Button>
  );
  const columns: Column<EvalCase>[] = [
    { key: "input", header: t("evals.colInput"), render: (c) => <Clamp className="text-xs">{inputText(c.input)}</Clamp> },
    { key: "checks", header: t("evals.colChecks"), render: (c) => <span className="text-xs whitespace-nowrap">{t("evals.checkCount", { n: checksOf(c.expected).length })}</span> },
    {
      key: "actions",
      header: t("evals.colActions"),
      render: (c) => (
        <ButtonRow>
          <Button size="sm" disabled={off} title={offTitle} aria-label={t("evals.editCaseLabel", { n: n(c) })} onClick={() => show({ kind: "case.edit", of: c })}>{t("evals.editCase")}</Button>
          <Button size="sm" disabled={off} title={offTitle} aria-label={t("evals.tryCaseLabel", { n: n(c) })} onClick={() => show({ kind: "case.try", of: c })}>{t("evals.tryCase")}</Button>
          <Button size="sm" variant="danger" disabled={off} title={offTitle} aria-label={t("evals.deleteCaseLabel", { n: n(c) })} onClick={() => show({ kind: "case.delete", of: c })}>{t("evals.deleteCase")}</Button>
        </ButtonRow>
      ),
    },
  ];
  const name = skillName(path);
  const note = !q.data ? null : off ? t("evals.cannotWrite") : cases.length === 0 ? starterOff : null;
  return (
    <>
      <p className={CARD_INTRO}>{t("evals.cardIntro")}</p>
      {q.isError ? (
        <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Loading rows={2} label="loading.evalSuite" onRetry={() => void q.refetch()} />
      ) : suite === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-pretty">{t("evals.cardNoSuite")}</p>
          <Button variant="secondary" disabled={off} title={offTitle} onClick={() => show({ kind: "suite.add" })}>{t("evals.addSuite")}</Button>
          {starter}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-pretty wrap-anywhere">{t("evals.cardSuite", { title: suite.title === path ? name : suite.title })}</span>
            <Badge>{t("evals.caseCount", { n: cases.length })}</Badge>
            <ButtonRow>
              <Button disabled={off} title={offTitle} onClick={() => show({ kind: "case.add" })}>{t("evals.addCase")}</Button>
              {cases.length === 0 && starter}
              <Button disabled={off} title={offTitle} onClick={() => show({ kind: "import" })}>{t("evals.import")}</Button>
              <Button disabled={off} title={offTitle} onClick={() => show({ kind: "suite.rename" })}>{t("evals.renameSuite")}</Button>
              <Button variant="danger" disabled={off} title={offTitle} onClick={() => show({ kind: "suite.delete" })}>{t("evals.deleteSuite")}</Button>
            </ButtonRow>
          </div>
          <DataTable label={t("evals.cardTitle", { name })} columns={columns} rows={cases} rowKey={(c) => c.id} empty={t("evals.cardNoCases")} />
        </>
      )}
      {/* One note under the card: the server cannot write, else why Draft starter cases is off for a skill with no cases. */}
      {note !== null && <div className="mt-4"><Notice tone="info">{off ? t("evals.cannotWrite") : note}</Notice></div>}
      {open?.kind === "suite.add" && <SuiteDialog path={path} write={write} initial={name} adding onClose={close} />}
      {open?.kind === "suite.rename" && suite && <SuiteDialog path={path} write={write} initial={suite.title} adding={false} onClose={close} />}
      {open?.kind === "suite.delete" && suite && <DeleteDialog path={path} suiteId={suite.id} write={write} body={{ op: "suite.delete", skill: path }} heading="evals.deleteSuiteTitle" onClose={close} />}
      {open?.kind === "case.delete" && suite && <DeleteDialog path={path} suiteId={suite.id} write={write} body={{ op: "case.delete", case: open.of.id }} heading="evals.deleteCaseTitle" onClose={close} />}
      {open?.kind === "case.add" && <CaseDialog path={path} write={write} onClose={close} />}
      {open?.kind === "case.edit" && <CaseDialog path={path} write={write} edit={open.of} onClose={close} />}
      {open?.kind === "case.try" && <TryDialog write={write} of={open.of} onClose={close} />}
      {open?.kind === "import" && <ImportDialog path={path} write={write} onClose={close} />}
      {open?.kind === "starter" && <StarterDialog path={path} write={write} onClose={close} />}
    </>
  );
}
