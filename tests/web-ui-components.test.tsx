// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../web/src/components/ui/data-table.js";
import { Button } from "../web/src/components/ui/button.js";
import { ButtonRow } from "../web/src/components/ui/button-row.js";
import { Field } from "../web/src/components/ui/field.js";
import { Input } from "../web/src/components/ui/input.js";
import { OverflowMenu, Tooltip } from "../web/src/components/ui/menu.js";
import { EmptyState, Kbd, Notice, PageHeader, StatusBadge } from "../web/src/components/ui/notice.js";
import { Badge, LEVEL_TONE, SM_PX } from "../web/src/components/ui/parts.js";
import { Radio } from "../web/src/components/ui/radio.js";
import { Select } from "../web/src/components/ui/select.js";
import { Textarea } from "../web/src/components/ui/textarea.js";

// Every variant, size and state that design-system/components.md lists for the new components renders.

afterEach(cleanup);

const setWidth = (px: number) => Object.defineProperty(window, "innerWidth", { value: px, configurable: true });

describe("form controls", () => {
  it.each(["text", "search", "number"])("Input renders as type %s, 32px high", (type) => {
    render(<Input type={type} aria-label="i" placeholder="p" />);
    const input = screen.getByLabelText("i");
    expect(input.getAttribute("type")).toBe(type);
    expect(input.className).toContain("h-8");
    expect(input.className).toContain("placeholder:text-text-3");
  });

  it("Input, Select and Textarea can be disabled", () => {
    render(<><Input disabled aria-label="i" /><Select disabled aria-label="s"><option>a</option></Select><Textarea disabled aria-label="t" rows={2} /></>);
    for (const name of ["i", "s", "t"]) {
      expect(screen.getByLabelText(name).disabled).toBe(true);
      expect(screen.getByLabelText(name).className).toContain("disabled:opacity-50");
    }
    expect(screen.getByLabelText("t").getAttribute("rows")).toBe("2");
  });

  it("Select draws its own chevron inside its wrapper", () => {
    render(<Select aria-label="s" wrapperClassName="w-40"><option>a</option></Select>);
    const select = screen.getByLabelText("s");
    expect(select.tagName).toBe("SELECT");
    expect(select.className).toContain("appearance-none");
    expect(select.parentElement.className).toContain("w-40");
    expect(select.parentElement.querySelector("svg")).not.toBeNull();
  });

  it("Field labels its control, with and without help text", () => {
    const { rerender } = render(<Field label="Name" htmlFor="n" help="Shown to you"><Input id="n" /></Field>);
    expect(screen.getByLabelText("Name").id).toBe("n");
    expect(screen.getByText("Shown to you").className).toContain("text-text-2");
    rerender(<Field label="Name" htmlFor="n"><Textarea id="n" /></Field>);
    expect(screen.getByLabelText("Name").tagName).toBe("TEXTAREA");
    expect(screen.queryByText("Shown to you")).toBeNull();
  });

  it("Radio is checked, unchecked or disabled", () => {
    const onChange = vi.fn();
    render(<><Radio name="g" checked onChange={onChange}>On</Radio><Radio name="g" checked={false} onChange={onChange}>Off</Radio><Radio name="g" disabled>Dis</Radio></>);
    expect(screen.getByLabelText("On").checked).toBe(true);
    expect(screen.getByLabelText("On").className).toContain("checked:border-accent");
    fireEvent.click(screen.getByLabelText("Off"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Dis").disabled).toBe(true);
  });

  it("ButtonRow wraps its buttons with an 8px gap and takes its alignment from className", () => {
    const { container } = render(<ButtonRow className="justify-end"><Button>a</Button><Button variant="primary">b</Button></ButtonRow>);
    expect(container.firstChild.className).toContain("flex-wrap");
    expect(container.firstChild.className).toContain("gap-2");
    expect(container.firstChild.className).toContain("justify-end");
  });
});

describe("OverflowMenu and Tooltip", () => {
  it("opens, selects an item and closes", () => {
    const pick = vi.fn();
    render(<OverflowMenu label="More" items={[{ label: "Edit", onSelect: pick }, { label: "Delete", onSelect: vi.fn(), danger: true }, { label: "Off", onSelect: vi.fn(), disabled: true }]} />);
    const button = screen.getByRole("button", { name: "More" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button);
    expect(screen.getAllByRole("menuitem").length).toBe(3);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-pill-bad-fg");
    expect(screen.getByRole("menuitem", { name: "Off" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Esc and on a click outside", () => {
    render(<OverflowMenu label="More" items={[{ label: "Edit", onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([["top", "bottom-full"], ["bottom", "top-full"]])("Tooltip shows on hover and focus at %s", (placement, cls) => {
    render(<Tooltip text="Hint" placement={placement}><button>b</button></Tooltip>);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").className).toContain(cls);
    fireEvent.mouseLeave(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").textContent).toBe("Hint");
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("status and message pieces", () => {
  it("StatusBadge takes its tone from LEVEL_TONE, as Badge does, at both sizes", () => {
    for (const [level, tone] of Object.entries(LEVEL_TONE)) {
      render(<><StatusBadge level={level} size="sm">s</StatusBadge><StatusBadge level={level}>m</StatusBadge><Badge level={level}>b</Badge></>);
      for (const name of ["s", "m", "b"]) for (const c of tone.split(" ")) expect(screen.getByText(name).className).toContain(c);
      cleanup();
    }
    render(<StatusBadge level="nope">x</StatusBadge>);
    expect(screen.getByText("x").className).toContain("bg-surface-2");
  });

  it("no second colour map: StatusBadge's source holds no tone classes", () => {
    for (const f of readdirSync("web/src/components/ui").filter((n) => n.endsWith(".tsx") && n !== "parts.tsx")) {
      expect(readFileSync(`web/src/components/ui/${f}`, "utf8"), f).not.toContain("ready_to_merge");
    }
  });

  it.each([["info", "status"], ["ok", "status"], ["warn", "alert"], ["bad", "alert"]])("Notice %s has role %s", (tone, role) => {
    render(<Notice tone={tone} title="T">Body</Notice>);
    expect(screen.getByRole(role).className).toContain(`bg-pill-${tone}-bg`);
    expect(screen.getByText("T")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("Notice works without a title", () => {
    render(<Notice>Body</Notice>);
    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("info");
  });

  it("EmptyState shows with and without explanation and action", () => {
    const { rerender } = render(<EmptyState title="Nothing" action={<button>Add</button>}>Add one.</EmptyState>);
    expect(screen.getByText("Add one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    rerender(<EmptyState title="Nothing" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("Kbd renders a kbd element", () => {
    render(<Kbd>Esc</Kbd>);
    expect(screen.getByText("Esc").tagName).toBe("KBD");
  });

  it("PageHeader has the h1 and optional description and actions", () => {
    const { rerender } = render(<PageHeader title="Tasks" description="All of them" actions={<button>New</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("All of them")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
    rerender(<PageHeader title="Tasks" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DataTable", () => {
  const columns = [
    { key: "name", header: "Name" },
    { key: "count", header: "Count" },
    { key: "note", header: "Note" },
    { key: "id", header: "Id", numeric: false },
  ];
  const rows = [{ name: "a", count: 1, note: "", id: "x1" }, { name: "b", count: 22, note: undefined, id: "x2" }];
  const table = () => <DataTable label="T" columns={columns} rows={rows} rowKey={(r) => r.name} empty="None" />;

  it("right-aligns number cells in tabular-nums and leaves out a column empty in every row", () => {
    setWidth(SM_PX);
    render(table());
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Count", "Id"]);
    const cell = screen.getByText("22");
    expect(cell.className).toContain("tabular-nums");
    expect(cell.className).toContain("sm:text-right");
    expect(screen.getByText("Count").className).toContain("text-right");
    expect(screen.getByText("x1").className).not.toContain("text-right");
  });

  it("keeps a column that has one value", () => {
    setWidth(SM_PX);
    render(<DataTable label="T" columns={columns} rows={[...rows, { name: "c", count: 3, note: "hi", id: "x3" }]} rowKey={(r) => r.name} empty="None" />);
    expect(screen.getAllByRole("columnheader").length).toBe(4);
  });

  it("shows cards below SM_PX", () => {
    setWidth(SM_PX - 1);
    const { container } = render(table());
    expect(container.querySelector("[data-cards]")).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("li").length).toBe(2);
  });

  it("shows its empty text with no rows", () => {
    setWidth(SM_PX);
    render(<DataTable label="T" columns={columns} rows={[]} rowKey={(r) => r.name} empty="None" />);
    expect(screen.getByText("None")).toBeTruthy();
  });
});

describe("design-system/components.md", () => {
  it("has a section for every component exported under web/src/components/ui", () => {
    const doc = readFileSync("design-system/components.md", "utf8");
    const headings = new Set([...doc.matchAll(/^## (\w+)/gm)].map((m) => m[1]));
    for (const f of readdirSync("web/src/components/ui").filter((n) => n.endsWith(".tsx"))) {
      for (const m of readFileSync(`web/src/components/ui/${f}`, "utf8").matchAll(/^export function ([A-Z]\w*)/gm)) {
        expect(headings.has(m[1]), `${m[1]} (${f})`).toBe(true);
      }
    }
  });
});
