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
import { Badge, StatusBadge, TONE_CLASS } from "../web/src/components/ui/badge.js";
import { STATES } from "../src/shared/states.js";
import { Card, CardSection } from "../web/src/components/ui/card.js";
import { Chart } from "../web/src/components/ui/chart.js";
import { Clamp } from "../web/src/components/ui/clamp.js";
import { Disclosure } from "../web/src/components/ui/disclosure.js";
import { ListRow, ROW_TITLE } from "../web/src/components/ui/list-row.js";
import { EmptyState, Kbd, Notice, PageHeader, PageToolbar } from "../web/src/components/ui/notice.js";
import { SM_PX } from "../web/src/components/ui/parts.js";
import { Inbox } from "lucide-react";
import { Radio } from "../web/src/components/ui/radio.js";
import { Select } from "../web/src/components/ui/select.js";
import { Textarea } from "../web/src/components/ui/textarea.js";
import { TOAST_MS, Toast } from "../web/src/components/ui/toast.js";
import { TypingDots } from "../web/src/components/ui/typing-dots.js";
import { act } from "@testing-library/react";

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

  it("Select draws its own chevron inside its wrapper, and no native select", () => {
    const { container } = render(<Select aria-label="s" wrapperClassName="w-40"><option>a</option></Select>);
    const select = screen.getByRole("combobox", { name: "s" });
    expect(container.querySelector("select")).toBeNull();
    expect(select.className).toContain("h-8");
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

  it("Field with no single control is a group named by its label, with its hint under the control", () => {
    render(<Field label="Notice when" help="Each switch is one kind"><span>switches</span></Field>);
    const group = screen.getByRole("group", { name: "Notice when" });
    // A <label> for no control names nothing: the label would be lost to a screen reader.
    expect(group.querySelector("label")).toBeNull();
    expect(group.lastElementChild!.textContent).toBe("Each switch is one kind");
  });

  it.each([["md", "px-3", "-ms-3"], ["sm", "px-2", "-ms-2"]] as const)("a flush %s Button pulls its start back by its padding, so its label sits on the text edge", (size, pad, pull) => {
    render(<Button variant="ghost" size={size} flush>Show result</Button>);
    const classes = screen.getByRole("button", { name: "Show result" }).className.split(" ");
    expect(classes).toEqual(expect.arrayContaining([pad, pull]));
  });

  it("a Button that is not flush keeps its margin, and an icon Button is never flush", () => {
    render(<><Button variant="ghost">Plain</Button><Button size="icon" flush aria-label="More">⋯</Button></>);
    expect(screen.getByRole("button", { name: "Plain" }).className).not.toMatch(/-ms-/);
    expect(screen.getByRole("button", { name: "More" }).className).not.toMatch(/-ms-/);
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

describe("Select", () => {
  const FRUIT = (
    <>
      <option value="" disabled>Pick a fruit</option>
      <option value="apple">Apple</option>
      <option value="banana">Banana</option>
      <option value="blueberry">Blueberry</option>
      <option value="cherry">Cherry</option>
    </>
  );
  const box = () => screen.getByRole("combobox", { name: "Fruit" });
  const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);
  const highlighted = () => document.getElementById(box().getAttribute("aria-activedescendant")!)!.textContent;

  it("opens its own list below the field, shows the choice checked, picks and closes", () => {
    const pick = vi.fn();
    render(<Select aria-label="Fruit" value="banana" onChange={pick}>{FRUIT}</Select>);
    expect(box().textContent).toBe("Banana");
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(box());
    const list = screen.getByRole("listbox");
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-controls")).toBe(list.id);
    expect(list.className).toContain("top-full");
    expect(optionNames()).toEqual(["Pick a fruit", "Apple", "Banana", "Blueberry", "Cherry"]);
    const banana = screen.getByRole("option", { name: "Banana" });
    expect(banana.getAttribute("aria-selected")).toBe("true");
    expect(banana.querySelector("svg:not(.invisible)")).not.toBeNull();
    expect(screen.getByRole("option", { name: "Apple" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("option", { name: "Apple" }).querySelector("svg:not(.invisible)")).toBeNull();
    expect((screen.getByRole("option", { name: "Pick a fruit" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: "Cherry" }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls[0]![0].target.value).toBe("cherry");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it("shows the disabled placeholder option when the value is empty", () => {
    render(<Select aria-label="Fruit" value="" onChange={vi.fn()}>{FRUIT}</Select>);
    expect(box().textContent).toBe("Pick a fruit");
  });

  it("Esc closes the list without picking and returns focus to the field", () => {
    const pick = vi.fn();
    render(<Select aria-label="Fruit" value="apple" onChange={pick}>{FRUIT}</Select>);
    fireEvent.click(box());
    expect(screen.getByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(box());
    expect(pick).not.toHaveBeenCalled();
  });

  it("opens above the field when there is no room below it", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const r = this.getAttribute("role") === "listbox" ? { top: 0, bottom: 200, height: 200 } : { top: innerHeight - 40, bottom: innerHeight - 8, height: 32 };
      return { ...r, left: 0, right: 100, width: 100, x: 0, y: r.top, toJSON: () => r } as DOMRect;
    });
    try {
      render(<Select aria-label="Fruit" value="apple" onChange={vi.fn()}>{FRUIT}</Select>);
      fireEvent.click(box());
      expect(screen.getByRole("listbox").className).toContain("bottom-full");
      expect(screen.getByRole("listbox").className).not.toContain("top-full");
    } finally {
      rect.mockRestore();
    }
  });

  it("keyboard: Enter opens, arrows move the highlight past disabled options, Enter picks", () => {
    const pick = vi.fn();
    render(<Select aria-label="Fruit" value="apple" onChange={pick}>{FRUIT}</Select>);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.getByRole("listbox")).not.toBeNull();
    expect(highlighted()).toBe("Apple");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(highlighted()).toBe("Apple");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(highlighted()).toBe("Blueberry");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(highlighted()).toBe("Banana");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(pick.mock.calls[0]![0].target.value).toBe("banana");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keyboard: Space opens; type-to-find highlights the first option starting with the typed letters", () => {
    const pick = vi.fn();
    render(<Select aria-label="Fruit" value="apple" onChange={pick}>{FRUIT}</Select>);
    fireEvent.keyDown(box(), { key: " " });
    expect(screen.getByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(box(), { key: "b" });
    expect(highlighted()).toBe("Banana");
    fireEvent.keyDown(box(), { key: "l" });
    expect(highlighted()).toBe("Blueberry");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(pick.mock.calls[0]![0].target.value).toBe("blueberry");
  });

  it("a disabled Select does not open", () => {
    render(<Select aria-label="Fruit" value="apple" disabled onChange={vi.fn()}>{FRUIT}</Select>);
    fireEvent.click(box());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
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

  it("takes an icon for its button and marks the checked item", () => {
    render(<OverflowMenu label="Pick" icon={<svg data-testid="ic" />} items={[{ label: "A", checked: true, onSelect: vi.fn() }, { label: "B", checked: false, onSelect: vi.fn() }]} />);
    const button = screen.getByRole("button", { name: "Pick" });
    expect(button.textContent).not.toContain("⋯");
    expect(button.querySelector("[data-testid=ic]")).toBeTruthy();
    fireEvent.click(button);
    // A pick list's items are menuitemradio: aria-checked is not valid on a plain menuitem.
    expect(screen.getAllByRole("menuitemradio").map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("closes on Esc and on a click outside", () => {
    render(<OverflowMenu label="More" items={[{ label: "Edit", onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" }));
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
  it("Badge is a pill with a dot that takes its tone from the state table; a level with no state is neutral", () => {
    for (const [level, { tone }] of Object.entries(STATES)) {
      render(<Badge level={level}>b</Badge>);
      const badge = screen.getByText("b");
      for (const c of TONE_CLASS[tone].split(" ")) expect(badge.className).toContain(c);
      expect(badge.className).toContain("rounded-pill");
      expect(badge.getAttribute("data-level")).toBe(level);
      expect(badge.querySelector("[aria-hidden]")!.className).toContain("bg-current");
      cleanup();
    }
    render(<Badge level="nope">x</Badge>);
    expect(screen.getByText("x").className).toContain("bg-surface-2");
  });

  it("StatusBadge shows a state's label in its tone with data-status; its own words when given", () => {
    for (const [state, { label, tone }] of Object.entries(STATES)) {
      render(<StatusBadge state={state} />);
      const badge = screen.getByText(label);
      expect(badge.getAttribute("data-status")).toBe(state);
      for (const c of TONE_CLASS[tone].split(" ")) expect(badge.className).toContain(c);
      cleanup();
    }
    render(<StatusBadge state="ready_to_merge">Merge queued (position 2)</StatusBadge>);
    expect(screen.getByText("Merge queued (position 2)").getAttribute("data-status")).toBe("ready_to_merge");
    cleanup();
    render(<StatusBadge state="some_state" />);
    expect(screen.getByText("some state").className).toContain("bg-surface-2");
  });

  it("no second colour map or badge: only badge.tsx holds the tones and StatusBadge, and Section and Empty are gone", () => {
    for (const f of readdirSync("web/src/components/ui").filter((n) => n.endsWith(".tsx") && n !== "badge.tsx")) {
      const src = readFileSync(`web/src/components/ui/${f}`, "utf8");
      expect(src, f).not.toContain("ready_to_merge");
      expect(src, f).not.toMatch(/export function (Section|StatusBadge|Empty)\(/);
    }
  });

  it("Card is a region on the surface with a 1px border, the card radius, 24px padding and shadow-sm", () => {
    render(<Card title="Runs" count={3} action={<button>More</button>}>Body</Card>);
    const card = screen.getByRole("region", { name: "Runs" });
    for (const c of ["bg-surface", "border", "border-border", "rounded-card", "sm:p-6", "shadow-sm"]) expect(card.className.split(" ")).toContain(c);
    const title = screen.getByRole("heading", { level: 2, name: "Runs" });
    expect(title.className).toContain("text-balance text-base font-semibold");
    expect(card.textContent).toContain("3");
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
  });

  it("Card without a title is named by its label, or is no region at all; a label names a titled Card", () => {
    const { rerender } = render(<Card label="Tasks">Body</Card>);
    expect(screen.getByRole("region", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    rerender(<Card>Body</Card>);
    expect(screen.queryByRole("region")).toBeNull();
    rerender(<Card title="work_items" label="Table work_items">Body</Card>);
    expect(screen.getByRole("region", { name: "Table work_items" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "work_items" })).toBeTruthy();
  });

  it("CardSection is an h3 in the one sub-group type inside a Card, not a region", () => {
    render(<Card title="Spend"><CardSection title="Totals" count={2}>x</CardSection></Card>);
    expect(screen.getByRole("heading", { level: 3, name: "Totals" }).className).toContain("text-xs font-medium text-text-2");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Spend"]);
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

  it("EmptyState is centred and shows with and without icon, description and action", () => {
    const { container, rerender } = render(<EmptyState icon={Inbox} title="Nothing" description="Add one." action={<button>Add</button>} />);
    expect(screen.getByText("Add one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    const box = container.querySelector("[data-empty]")!;
    expect(box.className).toContain("items-center");
    expect(box.className).toContain("text-center");
    expect(box.querySelector("svg[aria-hidden]")).toBeTruthy();
    rerender(<EmptyState title="Nothing" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  it("Toast is a fixed status box that closes itself after TOAST_MS, waits while hovered or focused, and closes on Dismiss", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<Toast dismissLabel="Dismiss" onClose={onClose}><p>Updated</p></Toast>);
      const box = screen.getByRole("status");
      for (const c of ["fixed", "bg-surface", "border-border", "rounded-box", "shadow-lg"]) expect(box.className.split(" ")).toContain(c);
      // Hovered: the timer waits, however long.
      fireEvent.mouseEnter(box);
      act(() => void vi.advanceTimersByTime(TOAST_MS * 3));
      expect(onClose).not.toHaveBeenCalled();
      // Left: TOAST_MS, then the fade, then it closes.
      fireEvent.mouseLeave(box);
      act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
      expect(onClose).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(1));
      expect(box.className).toContain("opacity-0");
      act(() => void vi.advanceTimersByTime(200));
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
      const dismissed = vi.fn();
      render(<Toast dismissLabel="Dismiss" onClose={dismissed}>x</Toast>);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(dismissed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Kbd renders a kbd element", () => {
    render(<Kbd>Esc</Kbd>);
    expect(screen.getByText("Esc").tagName).toBe("KBD");
  });

  it("PageHeader has the h1 in text-xl semibold and optional description and actions, in order", () => {
    const { rerender } = render(<PageHeader title="Tasks" description="All of them" actions={<><button>Export</button><button>New</button></>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Tasks" }).className).toContain("text-xl font-semibold");
    // The actions sit at the end, in the order given, so the primary one (last) ends the row.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Export", "New"]);
    expect(screen.getByText("All of them")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
    rerender(<PageHeader title="Tasks" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a Disclosure's trigger is at least 28px tall", () => {
    const { container } = render(<Disclosure summary="Details">Body</Disclosure>);
    expect(container.querySelector("summary")!.className.split(" ")).toContain("min-h-7");
  });

  it("PageHeader marks the page wide by default and read when asked, for <main> to take its width from", () => {
    const { container, rerender } = render(<PageHeader title="Tasks" />);
    expect(container.querySelector("header")!.getAttribute("data-page-width")).toBe("wide");
    rerender(<PageHeader title="Rules" width="read" />);
    expect(container.querySelector("header")!.getAttribute("data-page-width")).toBe("read");
  });

  it("PageToolbar puts the tabs on the first row and the search, view and filters on the second", () => {
    const { container, rerender } = render(<PageToolbar tabs={<div role="tablist" aria-label="Tabs" />}><input aria-label="Search" /><button>Board</button></PageToolbar>);
    const bar = container.querySelector("[data-page-toolbar]")!;
    const [first, second] = [...bar.children];
    expect(first!.getAttribute("role")).toBe("tablist");
    expect(second!.contains(screen.getByRole("textbox", { name: "Search" }))).toBe(true);
    expect(second!.contains(screen.getByRole("button", { name: "Board" }))).toBe(true);
    rerender(<PageToolbar><button>24 hours</button></PageToolbar>);
    expect(bar.children).toHaveLength(1);
    expect(bar.querySelector('[role="tablist"]')).toBeNull();
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
    const cell = screen.getByText("22").closest("td")!;
    expect(cell.className).toContain("tabular-nums");
    expect(cell.className).toContain("sm:text-right");
    expect(screen.getByText("Count").className).toContain("text-right");
    expect(screen.getByText("x1").closest("td")!.className).not.toContain("text-right");
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

describe("Chart", () => {
  const pts = [
    { key: "a", value: 0.5, caption: "Nov 1", text: "Nov 1: 50%" },
    { key: "b", value: 1, caption: "Nov 9", text: "Nov 9: 100%" },
  ];

  it("draws one bar per point, each also as text, with the first and last captions", () => {
    const { container } = render(<Chart label="Pass rate" points={pts} max={1} />);
    const list = screen.getByRole("list", { name: "Pass rate" });
    expect(list.querySelectorAll("li")).toHaveLength(pts.length);
    expect(list.textContent).toBe("Nov 1: 50%Nov 9: 100%");
    const bars = [...list.querySelectorAll("li > span[aria-hidden]")].map((b) => b.style.height);
    expect(bars).toEqual(["50%", "100%"]);
    expect(container.textContent).toContain("Nov 1");
    expect(container.textContent).toContain("Nov 9");
  });

  it("scales to the largest value without max, and draws nothing without points", () => {
    const { container } = render(<Chart label="Pass rate" points={[{ ...pts[0], value: 2 }, { ...pts[1], value: 4 }]} />);
    expect([...container.querySelectorAll("li > span[aria-hidden]")].map((b) => b.style.height)).toEqual(["50%", "100%"]);
    cleanup();
    expect(render(<Chart label="Pass rate" points={[]} />).container.innerHTML).toBe("");
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

describe("ListRow", () => {
  it("puts the leading control first, the title then the details in one column, and the ⋯ menu last, at the right of the title line", () => {
    render(
      <ul>
        <ListRow
          data-testid="row"
          leading={<input type="checkbox" aria-label="pick" />}
          title={<p className={ROW_TITLE} title="Full title">Full title</p>}
          details={<span>2 items</span>}
          menu={<OverflowMenu label="More: Full title" items={[{ label: "Retire", danger: true, onSelect: () => {} }]} />}
        >
          <p>extra</p>
        </ListRow>
      </ul>,
    );
    const row = screen.getByTestId("row");
    expect(row.tagName).toBe("LI");
    const parts = [...row.children];
    // The leading control and the menu are both pulled up 6px, so their 32px boxes centre on the title's 20px line.
    expect(parts[0]!.matches("[data-row-leading]")).toBe(true);
    expect(parts[0]!.firstElementChild!.tagName).toBe("INPUT");
    expect(parts[0]!.className).toContain("-mt-1.5");
    expect(parts[2]!.className).toContain("-mt-1.5");
    expect(parts[1]!.textContent).toBe("Full title2 itemsextra");
    expect(parts[1]!.querySelector("[data-details]")!.textContent).toBe("2 items");
    expect(parts[2]!.matches("[data-row-menu]")).toBe(true);
    expect(parts[2]!.querySelector("button")!.getAttribute("aria-label")).toBe("More: Full title");
    // One line for the title: cut with an ellipsis, the full text in its title attribute.
    expect(row.querySelector("p")!.className).toContain("truncate");
  });

  it("draws no details line and no menu box when it has none", () => {
    render(<ul><ListRow data-testid="row" title={<p>Only a title</p>} /></ul>);
    const row = screen.getByTestId("row");
    expect(row.querySelector("[data-details]")).toBeNull();
    expect(row.querySelector("[data-row-menu]")).toBeNull();
  });
});

describe("TypingDots", () => {
  it("is a live status read as its label, with three dots bouncing in turn", () => {
    render(<TypingDots label="Thinking…" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Thinking…");
    const dots = [...status.querySelectorAll("[data-dot]")];
    expect(dots).toHaveLength(3);
    for (const d of dots) expect(d.getAttribute("aria-hidden")).toBe("true");
    // Staggered: each dot's 1.2s loop starts at its own delay, inside the shorthand (a separate delay class is reset by it).
    const delays = dots.map((d) => d.className.match(/animate-\[typing_1\.2s_ease-in-out_(\d+)ms_infinite\]/)?.[1]);
    expect(delays).toEqual(["0", "150", "300"]);
    expect(dots.some((d) => /animation-delay/.test(d.className))).toBe(false);
    // The keyframes the classes name exist at the top level of index.css, or the dots would stand still everywhere.
    expect(readFileSync("web/src/index.css", "utf8")).toMatch(/^@keyframes typing \{/m);
  });

  it("moves only when motion is allowed: with reduced motion the dots stand still", () => {
    render(<TypingDots label="Thinking…" />);
    for (const d of screen.getByRole("status").querySelectorAll("[data-dot]")) {
      const classes = d.className.split(" ");
      expect(classes.filter((c) => c.includes("animate-")).every((c) => c.startsWith("motion-safe:"))).toBe(true);
      expect(classes.some((c) => c.startsWith("motion-safe:animate-"))).toBe(true);
    }
  });
});

describe("Clamp", () => {
  const sizes = (scroll: number, client: number) => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: scroll, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { value: client, configurable: true });
  };
  afterEach(() => {
    delete HTMLElement.prototype.scrollHeight;
    delete HTMLElement.prototype.clientHeight;
  });

  it("clamps to 2 lines and opens and closes the full text in place", () => {
    sizes(100, 40);
    render(<Clamp data-x="1">A long description</Clamp>);
    const text = screen.getByText("A long description");
    expect(text.className).toContain("line-clamp-2");
    expect(text.getAttribute("data-x")).toBe("1");
    const more = screen.getByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(text.className).not.toContain("line-clamp-2");
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    expect(text.className).toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("shows no toggle when the text is not cut off", () => {
    sizes(40, 40);
    render(<Clamp>Short</Clamp>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
