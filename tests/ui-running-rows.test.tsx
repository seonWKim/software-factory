// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { API } from "../web/src/api.js";
import { QueueTable, RunningTable } from "../web/src/views/common.js";
import { RunnersPage } from "../web/src/views/pages.js";

const AT = "2026-11-07T00:00:00.000Z";
const NOW = Date.parse(AT);
const LONG = "T".repeat(60);
const item = (n: number, title: string | null) => ({
  id: `wi_${n}`, source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` }, title,
});
const run = (n: number, status = "running") => ({ id: `run_${n}`, status, kind: "implement", work_item_id: `wi_${n}`, attempt: 1, owner: "h:1:0", heartbeat_at: AT, started_at: AT, lease_expires_at: AT, created_at: AT });
const queued = (n: number) => ({ position: n, id: `q_${n}`, kind: "implement", work_item_id: `wi_${n}`, attempt: 0, created_at: AT, not_before: null });

afterEach(cleanup);

describe("Running now and Queue rows", () => {
  const items = new Map([[1, item(1, LONG)], [2, item(2, null)]].map(([n, i]) => [i.id, i]));

  it("start with the title as a link to the item page, with no id and no truncate class", () => {
    for (const ui of [<RunningTable runs={[run(1)]} items={items} now={NOW} />, <QueueTable queue={[queued(1)]} items={items} now={NOW} />]) {
      const { container } = render(ui);
      const link = container.querySelector('tbody a[href="/app/items/wi_1"]');
      expect(link.textContent).toBe(LONG);
      expect(link.className).not.toContain("truncate");
      expect(link.parentElement.className).not.toContain("truncate");
      expect(link.closest("td").textContent).toBe(LONG);
      const text = container.querySelector("tbody tr").textContent;
      expect(text).not.toMatch(/wi_\d|o\/r#1/);
      expect(container.querySelectorAll('tbody a[href^="https://"]')).toHaveLength(0);
      cleanup();
    }
  });

  it("shows Untitled item for a null title, never the source id", () => {
    const { container } = render(<RunningTable runs={[run(2)]} items={items} now={NOW} />);
    expect(screen.getByText("Untitled item").getAttribute("href")).toBe("/app/items/wi_2");
    expect(container.textContent).not.toContain("o/r#2");
    cleanup();
    render(<QueueTable queue={[queued(2)]} items={items} now={NOW} />);
    expect(screen.getByText("Untitled item").getAttribute("href")).toBe("/app/items/wi_2");
  });

  it("shows the Item label, linked to the item page, while the item is not loaded", () => {
    const { container } = render(<RunningTable runs={[run(9)]} items={new Map()} now={NOW} />);
    const link = container.querySelector("tbody a");
    expect(link.textContent).toBe("Item");
    expect(link.getAttribute("href")).toBe("/app/items/wi_9");
    expect(container.querySelector("tbody").textContent).not.toContain("wi_9");
    cleanup();
    const q = render(<QueueTable queue={[queued(9)]} items={new Map()} now={NOW} />).container;
    expect(q.querySelector("tbody td:nth-child(2) a").textContent).toBe("Item");
    expect(q.querySelector("tbody").textContent).not.toContain("wi_9");
  });
});

describe("Runners Running now count", () => {
  it("counts the rows whose status is running", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData([API.runs], { runs: [run(1), run(2), run(3, "succeeded")] });
    client.setQueryData([API.items], { items: [item(1, "One"), item(2, "Two")] });
    render(<QueryClientProvider client={client}><RunnersPage /></QueryClientProvider>);
    const section = screen.getByRole("region", { name: "Running now" });
    expect(within(section).getByRole("heading", { name: "Running now" }).parentElement.textContent).toBe("Running now2");
  });
});
