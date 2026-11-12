// The UI check runs at merge (design §4): the implement sandbox cannot start Chrome, so an implementer that reports
// the configured `repo.ui_check` as missing work has not left anything undone. The implement run drops a `missing`
// entry that names the UI check, so the item is not marked incomplete; every other entry stays.

import { describe, expect, it } from "vitest";
import { config, pipeline } from "./helpers/fakes.js";

const ui_check = { command: ["npm", "run", "check:responsive"], paths: ["web/", "src/ui/"] };
const UI_ONLY = ["`npm run check:responsive` could not run in the sandbox (Chrome cannot start)", "Check:Responsive not verified"];

async function implemented(missing: string[], withUiCheck = true) {
  const f = await pipeline({
    config: { repo: { ...config.repo, ...(withUiCheck ? { ui_check } : {}) } },
    implement: () => ({ output: { summary: "## In short\n\nx", next_steps: "n", missing } }),
  });
  const it = await f.submit();
  await f.step();
  const run = (await f.runs(it, "implement"))[0]!;
  const open = f.broker.calls.filter((c) => c.name === "forge.open_change").map((c) => c.args as { body: string; labels: Record<string, boolean> });
  return { run, open, last: f.source.comments.at(-1)!.body };
}

describe("implement: a missing entry that names the UI check is dropped", () => {
  it("only the UI check reported missing: no missing entries, the item is not incomplete", async () => {
    const r = await implemented(UI_ONLY);
    expect(r.run.outcome).toMatchObject({ status: "succeeded", data: { missing: [] } });
    expect(r.open[0]!.labels).toEqual({ "sf: incomplete": false });
    expect(r.open[0]!.body).not.toContain("Not done");
    expect(r.last).not.toContain("incomplete");
  });

  it("other missing work stays, and the item is still incomplete", async () => {
    const r = await implemented([UI_ONLY[0]!, "the MySQL step"]);
    expect(r.run.outcome).toMatchObject({ data: { missing: ["the MySQL step"] } });
    expect(r.open[0]!.labels).toEqual({ "sf: incomplete": true });
    expect(r.last).toContain("It is **incomplete**");
  });

  it("with no repo.ui_check nothing runs at merge, so nothing is dropped", async () => {
    const r = await implemented([UI_ONLY[0]!], false);
    expect(r.run.outcome).toMatchObject({ data: { missing: [UI_ONLY[0]] } });
    expect(r.open[0]!.labels).toEqual({ "sf: incomplete": true });
  });
});
