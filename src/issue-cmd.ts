// `factory issue`: files and tidies issues through the factory's own GitHub login (plugins.github_auth), so
// with "app" they come from the bot, not from whoever runs the command. Closing, reopening and merging are
// left out on purpose: those stay human actions.

import { readFile } from "node:fs/promises";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { GitHubClient, RepoRef } from "./impl/github/github-client.js";

export const ISSUE_USAGE = `usage: npm run factory -- issue <action>
  create --title <text> --body-file <path> [--label <name>]...
  comment <number> --body-file <path>
  title <number> <text>
  sub-issue <parent> <child>`;

export type IssueAction =
  | { action: "create"; title: string; bodyFile: string; labels: string[] }
  | { action: "comment"; number: number; bodyFile: string }
  | { action: "title"; number: number; title: string }
  | { action: "sub-issue"; parent: number; child: number };

const num = (s: string | undefined): number | null => (s !== undefined && /^[1-9]\d*$/.test(s) ? Number(s) : null);

/** The action, or null for anything incomplete or unknown (the caller prints usage; nothing reaches GitHub). */
export function parseIssueArgs(args: readonly string[]): IssueAction | null {
  const [action, ...rest] = args;
  const flags = (names: readonly string[]) => {
    const out: Record<string, string[]> = {};
    const free: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("--")) {
        const v = rest[i + 1];
        if (!names.includes(a) || v === undefined) return null;
        (out[a] ??= []).push(v);
        i++;
      } else free.push(a);
    }
    return { out, free };
  };
  switch (action) {
    case "create": {
      const f = flags(["--title", "--body-file", "--label"]);
      const title = f?.out["--title"]?.[0];
      const bodyFile = f?.out["--body-file"]?.[0];
      if (!f || f.free.length > 0 || !title || !bodyFile) return null;
      return { action, title, bodyFile, labels: f.out["--label"] ?? [] };
    }
    case "comment": {
      const f = flags(["--body-file"]);
      const n = num(f?.free[0]);
      const bodyFile = f?.out["--body-file"]?.[0];
      if (!f || f.free.length !== 1 || n === null || !bodyFile) return null;
      return { action, number: n, bodyFile };
    }
    case "title": {
      const n = num(rest[0]);
      const title = rest.slice(1).join(" ").trim();
      if (n === null || !title) return null;
      return { action, number: n, title };
    }
    case "sub-issue": {
      const parent = num(rest[0]);
      const child = num(rest[1]);
      if (parent === null || child === null || rest.length !== 2) return null;
      return { action, parent, child };
    }
    default:
      return null;
  }
}

export interface IssueDeps {
  client: GitHubClient;
  repo: RepoRef;
  /** Every title and body is scanned before it is sent (G5); a finding refuses the action. */
  scanner: EgressScanner;
  read?: (path: string) => Promise<string>;
}

/** Runs one action and returns the line to print (the issue's number and URL, or the URL written to). */
export async function runIssue(d: IssueDeps, a: IssueAction): Promise<string> {
  const base = `/repos/${d.repo.owner}/${d.repo.name}/issues`;
  const read = d.read ?? ((p: string) => readFile(p, "utf8"));
  const scanned = async (text: string) => {
    const r = await d.scanner.scan("comment", text);
    if (!r.clean) throw new Error(`refused by the leak scanner: ${r.findings.map((f) => f.rule).join(", ")}`);
    return text;
  };
  switch (a.action) {
    case "create": {
      const title = await scanned(a.title);
      const body = await scanned(await read(a.bodyFile));
      const r = await d.client.request<{ number: number; html_url: string }>("POST", base, { title, body, labels: a.labels });
      return `#${r.number} ${r.html_url}`;
    }
    case "comment": {
      const body = await scanned(await read(a.bodyFile));
      const r = await d.client.request<{ html_url: string }>("POST", `${base}/${a.number}/comments`, { body });
      return r.html_url;
    }
    case "title": {
      const r = await d.client.request<{ html_url: string }>("PATCH", `${base}/${a.number}`, { title: await scanned(a.title) });
      return r.html_url;
    }
    case "sub-issue": {
      // The API takes the child's id, not its number.
      const child = await d.client.request<{ id: number }>("GET", `${base}/${a.child}`);
      await d.client.request("POST", `${base}/${a.parent}/sub_issues`, { sub_issue_id: child.id });
      return `#${a.child} is now a sub-issue of #${a.parent}`;
    }
  }
}
