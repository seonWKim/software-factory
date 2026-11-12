// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../web/src/components/ui/data-table.js";
import { ButtonRow, Field, Input, Radio, Select, Textarea } from "../web/src/components/ui/form.js";
import { OverflowMenu, Tooltip } from "../web/src/components/ui/menu.js";
import { EmptyState, Kbd, Notice, PageHeader, StatusBadge } from "../web/src/components/ui/notice.js";
import { Badge, LEVEL_TONE, SM_PX } from "../web/src/components/ui/parts.js";

// Every variant, size and state that design-system/components.md lists for the new components renders.

afterEach(cleanup);

const setWidth = (px: number) => Object.defineProperty(window, "innerWidth", { value: px, configurable: true });

describe("form controls", () => {
  it.each(["sm", "md"])("Input, Select and Textarea render at size %s", (size) => {
    render(<><Input size={size} aria-label="i" /><Select size={size} aria-label="s"><option>a</option></Select></>);
    expect(screen.getByLabelText("i").className).toContain(size === "sm" ? "text-xs" : "text-sm");
    expect(screen.getByLabelText("s").tagName).toBe("SELECT");
  });

  it("marks invalid and disabled controls", () => {
    render(<><Input invalid disabled aria-label="i" /><Textarea invalid aria-label="t" rows={2} /><Select invalid aria-label="s" /></>);
    expect(screen.getByLabelText("i").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("i").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("t").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("t").getAttribute("rows")).toBe("2");
    expect(screen.getByLabelText("s").getAttribute("aria-invalid")).toBe("true");
  });

  it("Field labels its control and links the hint and the error", () => {
    render(<Field label="Name" hint="Shown to you" error="Required"><Input /></Field>);
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = input.getAttribute("aria-describedby").split(" ");
    expect(ids.map((id) => document.getElementById(id).textContent)).toEqual(["Shown to you", "Required"]);
  });

  it("Field without hint or error describes nothing", () => {
    render(<Field label="Name"><Textarea /></Field>);
    expect(screen.getByLabelText("Name").hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByLabelText("Name").hasAttribute("aria-invalid")).toBe(false);
  });

  it("Radio is checked, unchecked or disabled", () => {
    const onChange = vi.fn();
    render(<><Radio name="g" checked onChange={onChange}>On</Radio><Radio name="g" checked={false} onChange={onChange}>Off</Radio><Radio name="g" disabled>Dis</Radio></>);
    expect(screen.getByLabelText("On").checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Off"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Dis").disabled).toBe(true);
  });

  it("ButtonRow aligns to the end or the start", () => {
    const { container, rerender } = render(<ButtonRow><button>a</button></ButtonRow>);
    expect(container.firstChild.className).toContain("justify-end");
    rerender(<ButtonRow align="start"><button>a</button></ButtonRow>);
    expect(container.firstChild.className).toContain("justify-start");
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
