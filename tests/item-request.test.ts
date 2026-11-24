// About's request (GET /api/v1/items/:id `item.request`): the body's first paragraph for each intake path, never the title.
import { describe, expect, it } from "vitest";
import { buildTask, createLocalItem } from "../src/core/task-build.js";
import type { UserId } from "../src/core/types.js";
import { requestOf } from "../src/ui/item-checks.js";
import { PROJECT_KEY, human, newStore } from "./helpers/store.js";

const TITLE = "Export spend as CSV";
const BODY = "Export the monthly spend as a CSV file from the Health page.\n\nDone when: a Download CSV button exists.";
const FIRST = "Export the monthly spend as a CSV file from the Health page.";
const user = "github:1" as UserId;

describe("item request: the body's first paragraph", () => {
  it("local task create", async () => {
    const { store } = await newStore();
    const { item } = await createLocalItem(store, { source_id: "local-abc", title: TITLE, body: BODY, project: PROJECT_KEY, user });
    expect(requestOf(item)).toBe(FIRST);
  });

  it("Build this (task-build)", async () => {
    const { store } = await newStore();
    await store.addTask({ id: "tk_1", title: TITLE, body: BODY, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: user });
    const r = await buildTask(store, "tk_1", PROJECT_KEY, user);
    expect(r.ok && requestOf(r.item)).toBe(FIRST);
  });

  it("GitHub-issue intake", async () => {
    const { store } = await newStore();
    const source = { type: "github" as const, id: "o/r#1", link: "https://github.com/o/r/issues/1" };
    const item = await store.createWorkItem(
      { source, title: TITLE, requester_id: user, project: PROJECT_KEY, problem: `${TITLE}\n\n${BODY}`.trim(), resources: [source.link] },
      human,
    );
    expect(requestOf(item.item)).toBe(FIRST);
  });

  it("an empty body, or a request equal to the title, is null", () => {
    expect(requestOf({ title: TITLE, issue_text: TITLE })).toBeNull();
    expect(requestOf({ title: TITLE, issue_text: `${TITLE}\n\n` })).toBeNull();
    expect(requestOf({ title: TITLE, issue_text: `x\n\n${TITLE}` })).toBe("x");
    expect(requestOf({ title: TITLE, issue_text: null })).toBeNull();
  });
});
