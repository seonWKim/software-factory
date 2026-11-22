// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW, TOKEN, TasksPage, json, reset, s, teardown, view } from "./ui-tasks-fixtures.js";

// The Files tab (design 09-dashboard-tasks, the Files tab; 02-tasks, project files): on a project tab, the row ends with
// Files; it shows the project's folder tree, one level read at a time, above (phone) or beside the editor, which saves
// about 1 second after typing stops with the Saving…, Saved and Couldn't save note.

const TREE = "/api/v1/projects/files/tree";
const READ = "/api/v1/projects/files/read";
const WRITE = "/api/v1/projects/files/write";
const FOLDER = "/api/v1/projects/folder";
const PROJECTS = [{ slug: "home", name: "Home" }, { slug: "garden", name: "Garden" }];

type Answer = { status: number; body: unknown };
/** The file routes' answers: the tree by path, the read by path, the write's and the set folder's. */
const f: { folder: string | null; trees: Record<string, unknown[]>; files: Record<string, Answer>; write: Answer; set: Answer } = {
  folder: "/srv/home", trees: {}, files: {}, write: { status: 200, body: {} }, set: { status: 200, body: {} },
};

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, string>;
const posts = (url: string) => s.posts.filter((p) => p.url === url).map((p) => bodyOf(p.init));

beforeEach(() => {
  reset();
  s.current = view({ active_projects: PROJECTS });
  s.filtered = { home: view({ active_projects: PROJECTS }), garden: view({ active_projects: PROJECTS }) };
  f.folder = "/srv/home";
  f.trees = {
    "": [{ name: "docs", kind: "dir" }, { name: "src", kind: "dir" }, { name: "README.md", kind: "file" }],
    src: [{ name: "lib", kind: "dir" }, { name: "main.ts", kind: "file" }],
  };
  f.files = {
    "README.md": { status: 200, body: { path: "README.md", text: "# hello\n", size: 8, read_only: null } },
    "big.log": { status: 200, body: { path: "big.log", text: "xxxx", size: 2_000_000, read_only: "large" } },
    "logo.png": { status: 200, body: { path: "logo.png", text: null, size: 7, read_only: "binary" } },
  };
  f.write = { status: 200, body: { size: 1 } };
  f.set = { status: 200, body: { project: "home", folder: "/srv/home" } };
  const tasksFetch = vi.mocked(fetch);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST" || ![TREE, READ, WRITE, FOLDER].includes(url)) return tasksFetch(url, init);
    s.posts.push({ url, init });
    const b = bodyOf(init);
    if (url === TREE) return f.folder === null ? json(200, { folder: null, path: "", entries: [] }) : json(200, { folder: f.folder, path: b.path, entries: f.trees[b.path!] ?? [] });
    if (url === READ) return json(f.files[b.path!]?.status ?? 404, f.files[b.path!]?.body ?? { error: "no such file" });
    if (url === WRITE) return json(f.write.status, f.write.body);
    if (f.set.status === 200) f.folder = b.folder!;
    return json(f.set.status, f.set.body);
  }));
});
afterEach(teardown);

function open(url = "/app/tasks?project=home&view=files") {
  history.replaceState(null, "", url);
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(TasksPage)));
}
const tree = () => screen.findByRole("navigation", { name: "Folders and files" }, SLOW);
const names = (nav: HTMLElement) => within(nav).getAllByRole("button").map((b) => b.textContent?.replace(/^[▸▾]/, ""));

describe("the Files tab", () => {
  it("ends the row on a project tab as a pressed-state button, keeps the project in the URL, and is not on All projects", async () => {
    open("/app/tasks");
    await screen.findByRole("tab", { name: "Home" }, SLOW);
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Home" }));
    const files = screen.getByRole("button", { name: "Files" });
    expect(screen.getByRole("tablist").parentElement!.contains(files)).toBe(true);
    expect(files.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(files);
    const params = new URLSearchParams(location.search);
    expect([params.get("project"), params.get("view")]).toEqual(["home", "files"]);
    expect(files.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: "Files: Home" }, SLOW)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Overdue" })).toBeNull();
    fireEvent.click(files);
    expect(new URLSearchParams(location.search).get("view")).toBeNull();
    expect(await screen.findByRole("list", { name: "Overdue" }, SLOW)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(screen.getByRole("tab", { name: "Garden" }));
    expect(new URLSearchParams(location.search).get("view")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Files: Home" })).toBeNull();
  });

  it("shows the base folder's top level from one read", async () => {
    open();
    const nav = await tree();
    await waitFor(() => expect(names(nav)).toEqual(["docs/", "src/", "README.md"]), SLOW);
    expect(screen.getByText("/srv/home")).toBeTruthy();
    expect(posts(TREE)).toEqual([{ project: "home", path: "" }]);
    expect(s.posts.find((p) => p.url === TREE)!.init.headers).toMatchObject({ "x-csrf-token": TOKEN });
  });

  it("expanding a folder reads and lists its children; clicking it again collapses it without a read", async () => {
    open();
    const nav = await tree();
    const src = await within(nav).findByRole("button", { name: /src/ }, SLOW);
    expect(src.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(src);
    await waitFor(() => expect(names(nav)).toEqual(["docs/", "src/", "lib/", "main.ts", "README.md"]), SLOW);
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(posts(TREE)).toEqual([{ project: "home", path: "" }, { project: "home", path: "src" }]);
    fireEvent.click(src);
    expect(names(nav)).toEqual(["docs/", "src/", "README.md"]);
    expect(posts(TREE)).toHaveLength(2);
  });

  it("a project with no base folder says so and offers Set folder, which stores it and shows its top level", async () => {
    f.folder = null;
    open();
    expect(await screen.findByText("This project has no folder yet", undefined, SLOW)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Folders and files" })).toBeNull();
    expect(posts(TREE)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Set folder" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: " /srv/home " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set folder" }));
    const nav = await tree();
    await waitFor(() => expect(names(nav)).toEqual(["docs/", "src/", "README.md"]), SLOW);
    expect(posts(FOLDER)).toEqual([{ project: "home", folder: "/srv/home" }]);
  });

  it("a refused folder stays in the dialog with its reason", async () => {
    f.folder = null;
    f.set = { status: 400, body: { error: "folder must be an absolute path" } };
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Set folder" }, SLOW));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Folder"), { target: { value: "relative" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set folder" }));
    expect(await within(dialog).findByText("folder must be an absolute path", undefined, SLOW)).toBeTruthy();
  });
});

describe("the editor", () => {
  async function openReadme() {
    open();
    const nav = await tree();
    fireEvent.click(await within(nav).findByRole("button", { name: "README.md" }, SLOW));
    const area = await screen.findByLabelText<HTMLTextAreaElement>("README.md", undefined, SLOW);
    await waitFor(() => expect(area.value).toBe("# hello\n"), SLOW);
    return area;
  }
  const note = () => screen.getByRole("status").textContent;

  it("saves about 1 second after typing stops, with no Save button: Saving…, then Saved", async () => {
    const area = await openReadme();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const write = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === WRITE) await held;
      return write(url as string, init);
    });
    const started = Date.now();
    fireEvent.change(area, { target: { value: "# hello\nmore" } });
    await new Promise((r) => setTimeout(r, 400));
    fireEvent.change(area, { target: { value: "# hello\nmore text" } });
    await new Promise((r) => setTimeout(r, 600));
    expect(s.posts.filter((p) => p.url === WRITE)).toHaveLength(0);
    await waitFor(() => expect(note()).toBe("Saving…"), SLOW);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1300);
    release();
    await waitFor(() => expect(note()).toBe("Saved"), SLOW);
    expect(posts(WRITE)).toEqual([{ project: "home", path: "README.md", text: "# hello\nmore text" }]);
  });

  it("a failed save says Couldn't save with the reason and keeps the typed text", async () => {
    f.write = { status: 409, body: { error: "the file system refused it (EACCES)" } };
    const area = await openReadme();
    fireEvent.change(area, { target: { value: "kept" } });
    await waitFor(() => expect(note()).toBe("Couldn't save"), SLOW);
    expect(screen.getByText("the file system refused it (EACCES)")).toBeTruthy();
    expect(area.value).toBe("kept");
  });

  it("opens a large file read-only with a note, and a binary file with a note and no text", async () => {
    f.trees[""] = [{ name: "big.log", kind: "file" }, { name: "logo.png", kind: "file" }];
    open();
    const nav = await tree();
    fireEvent.click(await within(nav).findByRole("button", { name: "big.log" }, SLOW));
    const big = await screen.findByLabelText<HTMLTextAreaElement>("big.log", undefined, SLOW);
    expect(big.readOnly).toBe(true);
    expect(screen.getByText(/larger than about 1 MB, so it opens read-only/)).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: "logo.png" }));
    expect(await screen.findByText(/isn't plain text, so it opens read-only/, undefined, SLOW)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("puts the tree before the editor in one column below md, so at phone width the tree sits above it", async () => {
    await openReadme();
    const nav = screen.getByRole("navigation", { name: "Folders and files" });
    const area = screen.getByLabelText("README.md");
    expect(nav.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = nav.parentElement!;
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bmd:flex-row\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
    expect(area.className).toMatch(/\bmax-w-full\b/);
  });
});
