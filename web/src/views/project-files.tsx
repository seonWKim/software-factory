import { FolderOpen } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { postJson } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { EmptyState } from "../components/ui/notice.js";
import { Loading } from "../components/ui/parts.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { ALERT, muted } from "./tasks/shared.js";

// The Tasks page's Files tab (design 09-dashboard-tasks, the Files tab; 02-tasks, project files): a task project's base
// folder as a tree beside a plain-text editor. The tree reads one level at a time (POST /api/v1/projects/files/tree): the
// top level on open, a folder's children each time it is expanded, nothing when it is collapsed. A file opens in a
// monospace Textarea (POST /api/v1/projects/files/read) that saves about 1 second after typing stops (POST
// /api/v1/projects/files/write), with no Save button; the note says Saving…, Saved or Couldn't save, and the typed text
// stays. A large or binary file opens read-only with a note. A project with no base folder says so, with Set folder (POST
// /api/v1/projects/folder). Below `md` the tree sits above the editor; from `md` beside it.

const TREE_PATH = "/api/v1/projects/files/tree";
const READ_PATH = "/api/v1/projects/files/read";
const WRITE_PATH = "/api/v1/projects/files/write";
const FOLDER_PATH = "/api/v1/projects/folder";

/** How long after the last keystroke a save is sent. */
export const SAVE_DELAY_MS = 1000;

interface Entry {
  name: string;
  kind: "dir" | "file";
}
type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

/** One POST to a project file route: its value, or the server's reason. */
async function post<T>(url: string, token: string, body: Record<string, string>): Promise<Answer<T>> {
  const r = await postJson<T & { error?: string }>(url, token, body);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

/** A sub-path joined under its folder ("" is the base folder). */
const under = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);

/** One folder's entries; each folder expands (one read) and collapses (no read), each file opens in the editor. */
function Folder({ project, token, dir, entries, open, onOpen }: { project: string; token: string; dir: string; entries: readonly Entry[]; open: string | null; onOpen: (path: string) => void }) {
  return (
    <ul className={cn("min-w-0", dir !== "" && "border-l border-border pl-3")}>
      {entries.map((e) =>
        e.kind === "dir" ? (
          <SubFolder key={e.name} project={project} token={token} path={under(dir, e.name)} name={e.name} open={open} onOpen={onOpen} />
        ) : (
          <li key={e.name} className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              aria-current={open === under(dir, e.name) ? "true" : undefined}
              className="w-full justify-start text-left break-all aria-[current=true]:bg-surface-2"
              onClick={() => onOpen(under(dir, e.name))}
            >
              {e.name}
            </Button>
          </li>
        ),
      )}
    </ul>
  );
}

/** A folder row: collapsed at first; expanding reads its children, collapsing forgets them. */
function SubFolder({ project, token, path, name, open, onOpen }: { project: string; token: string; path: string; name: string; open: string | null; onOpen: (path: string) => void }) {
  const [children, setChildren] = useState<readonly Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (children !== null) {
      setChildren(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ entries: Entry[] }>(TREE_PATH, token, { project, path });
      if (r.ok) setChildren(r.value.entries);
      else setError(r.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="min-w-0">
      <Button variant="ghost" size="sm" aria-expanded={children !== null} disabled={busy} className="w-full justify-start text-left break-all" onClick={() => void toggle()}>
        <span aria-hidden className="w-3 shrink-0 text-text-3">{children !== null ? "▾" : "▸"}</span>
        {name}/
      </Button>
      {error !== null && <p role="alert" className={ALERT}>{error}</p>}
      {children !== null && (children.length === 0 ? <p className={cn(muted, "pl-6")}>{t("tasks.filesEmptyFolder")}</p> : <Folder project={project} token={token} dir={path} entries={children} open={open} onOpen={onOpen} />)}
    </li>
  );
}

interface Opened {
  text: string | null;
  read_only: "large" | "binary" | null;
}

type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * One file's editor: the text, saved SAVE_DELAY_MS after the last keystroke; a save that is running when more is typed is
 * followed by another. Leaving the file (another file, another tab) sends a waiting save at once.
 */
function Editor({ project, token, path, canWrite }: { project: string; token: string; path: string; canWrite: boolean }) {
  const [file, setFile] = useState<Opened | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const again = useRef(false);

  const save = async () => {
    timer.current = null;
    if (saving.current) {
      again.current = true;
      return;
    }
    saving.current = true;
    const sent = latest.current;
    setState("saving");
    try {
      const r = await post<{ size: number }>(WRITE_PATH, token, { project, path, text: sent });
      setState(r.ok ? "saved" : "failed");
      setError(r.ok ? null : r.error);
    } catch (err) {
      setState("failed");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      saving.current = false;
    }
    if (again.current || latest.current !== sent) {
      again.current = false;
      if (timer.current === null) void save();
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let live = true;
    void post<Opened>(READ_PATH, token, { project, path }).then(
      (r) => {
        if (!live) return;
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setFile(r.value);
        latest.current = r.value.text ?? "";
        setText(latest.current);
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
      // A save still waiting goes now, so leaving the file loses no typing.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        void saveRef.current();
      }
    };
  }, [project, token, path]);

  const change = (value: string) => {
    setText(value);
    latest.current = value;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
  };

  if (file === null) return error === null ? <Loading rows={4} /> : <p role="alert" className={ALERT}>{error}</p>;
  const id = `project-file-${path}`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor={id} className="min-w-0 font-mono text-sm break-all">{path}</label>
        <p role="status" className={muted}>
          {state === "saving" ? t("tasks.filesSaving") : state === "saved" ? t("tasks.filesSaved") : state === "failed" ? t("tasks.filesSaveFailed") : ""}
        </p>
      </div>
      {state === "failed" && error !== null && <p role="alert" className={ALERT}>{error}</p>}
      {file.read_only !== null && <p className={muted}>{t(file.read_only === "large" ? "tasks.filesLarge" : "tasks.filesBinary")}</p>}
      {file.text !== null && (
        <Textarea
          id={id}
          value={text}
          readOnly={file.read_only !== null || !canWrite}
          spellCheck={false}
          rows={20}
          className="w-full max-w-full resize-y font-mono text-xs"
          onChange={(e) => change(e.target.value)}
        />
      )}
    </div>
  );
}

/** The Set folder dialog: one absolute path; the server stores its resolved real path, and a refusal stays in the dialog. */
export function SetFolderDialog({ project, name, current, token, returnFocusTo, onSaved, onClose }: {
  project: string; name: string; current: string | null; token: string; returnFocusTo: RefObject<HTMLElement | null>; onSaved: (folder: string) => void; onClose: () => void;
}) {
  const [folder, setFolder] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ folder: string }>(FOLDER_PATH, token, { project, folder: folder.trim() });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      announceStatus(t("tasks.folderSet", { name, folder: r.value.folder }));
      onSaved(r.value.folder);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("tasks.setFolderTitle", { name })}
      consequence={t("tasks.setFolderHint")}
      confirmLabel={t("tasks.setFolder")}
      confirmDisabled={busy || folder.trim() === ""}
      error={error}
      returnFocusTo={returnFocusTo}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <Field label={t("tasks.folder")} htmlFor="project-folder">
        <Input id="project-folder" value={folder} disabled={busy} spellCheck={false} placeholder={t("tasks.folderPlaceholder")} onChange={(e) => setFolder(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** The Files tab of one project: the folder's top level, read once per open and once per Set folder. */
export function ProjectFiles({ project, name, token, canWrite }: { project: string; name: string; token: string | null; canWrite: boolean }) {
  const [root, setRoot] = useState<{ folder: string | null; entries: readonly Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [setting, setSetting] = useState(false);
  const setButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    setRoot(null);
    setError(null);
    setOpen(null);
    void post<{ folder: string | null; entries: Entry[] }>(TREE_PATH, token, { project, path: "" }).then(
      (r) => live && (r.ok ? setRoot(r.value) : setError(r.error)),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [project, token, reads]);

  const setFolder = (
    <Button ref={setButton} disabled={token === null || !canWrite} onClick={() => setSetting(true)}>
      {t("tasks.setFolder")}
    </Button>
  );
  const body =
    token === null ? <p className={muted}>{t("tasks.filesOff")}</p>
    : error !== null ? <p role="alert" className={ALERT}>{error}</p>
    : root === null ? <Loading rows={3} />
    : root.folder === null ? <EmptyState icon={FolderOpen} title={t("tasks.noFolder")} description={t("tasks.noFolderHint")} action={setFolder} />
    : (
      <div className="flex min-w-0 flex-col gap-4 md:flex-row">
        <nav aria-label={t("tasks.filesTree")} className="max-h-96 min-w-0 overflow-y-auto md:max-h-[40rem] md:w-64 md:shrink-0">
          {root.entries.length === 0 ? <p className={muted}>{t("tasks.filesEmptyFolder")}</p> : <Folder project={project} token={token} dir="" entries={root.entries} open={open} onOpen={setOpen} />}
        </nav>
        <div className="min-w-0 flex-1">
          {open === null ? <p className={muted}>{t("tasks.filesPick")}</p> : <Editor key={open} project={project} token={token} path={open} canWrite={canWrite} />}
        </div>
      </div>
    );
  return (
    <Card title={t("tasks.filesTitle", { name })} action={root?.folder ? setFolder : undefined}>
      {root?.folder && <p className={cn(muted, "mb-3 font-mono break-all")}>{root.folder}</p>}
      {body}
      {setting && token !== null && (
        <SetFolderDialog project={project} name={name} current={root?.folder ?? null} token={token} returnFocusTo={setButton} onSaved={() => setReads((n) => n + 1)} onClose={() => setSetting(false)} />
      )}
    </Card>
  );
}
