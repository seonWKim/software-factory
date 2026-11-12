import { type ReactNode, useState } from "react";
import { Brand, BrandMark } from "../components/ui/brand.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { DataTable } from "../components/ui/data-table.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Markdown } from "../components/ui/markdown.js";
import { OverflowMenu, Tooltip } from "../components/ui/menu.js";
import { EmptyState, Kbd, Notice, PageHeader, StatusBadge } from "../components/ui/notice.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr, LEVEL_TONE } from "../components/ui/parts.js";
import { Radio } from "../components/ui/radio.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import { type MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";

// The design system gallery (docs/design/09-brand-and-tokens.md): every shared component of components/ui in each
// variant, size and state. It reads no data. A state the browser draws only on interaction (hover, focus) is
// shown by the same token classes the component uses, so a change to a component shows here at once.

const HOVER = "bg-surface-2";
const FOCUSED = "outline-2 outline-solid outline-offset-2 outline-focus";
const INVALID = "border-failed";

const STATES = ["default", "hover", "focus", "disabled", "error"] as const;
type State = (typeof STATES)[number];
const stateLabel = (s: State) => t(`design.state.${s}` as MessageKey);

/** The classes and attributes that put a control into `state`; `error` is only for fields. */
function forced(state: State, fieldError: boolean): { className?: string; disabled?: boolean; "aria-invalid"?: true } {
  if (state === "hover") return { className: HOVER };
  if (state === "focus") return { className: FOCUSED };
  if (state === "disabled") return { disabled: true };
  if (state === "error" && fieldError) return { className: INVALID, "aria-invalid": true };
  return {};
}

/** One labelled sample. */
function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span className="text-xs text-text-2">{label}</span>
      {children}
    </div>
  );
}

const ROW = "flex flex-wrap items-end gap-4";

const VARIANTS = ["primary", "secondary", "ghost", "danger"] as const;
const SIZES = ["md", "sm", "icon"] as const;

function Buttons() {
  return (
    <div className="space-y-4">
      {VARIANTS.map((variant) => (
        <div key={variant} className="space-y-2">
          <p className="text-sm font-medium">{t(`design.variant.${variant}` as MessageKey)}</p>
          {SIZES.map((size) => (
            <div key={size} className={ROW}>
              {STATES.filter((s) => s !== "error").map((state) => (
                <Sample key={state} label={`${t(`design.size.${size}` as MessageKey)} · ${stateLabel(state)}`}>
                  <Button variant={variant} size={size} aria-label={size === "icon" ? t("design.icon.label") : undefined} {...forced(state, false)}>
                    {size === "icon" ? <span aria-hidden>⋯</span> : t(`design.variant.${variant}` as MessageKey)}
                  </Button>
                </Sample>
              ))}
            </div>
          ))}
        </div>
      ))}
      <div className={ROW}>
        <Sample label={t("design.variant.solid")}>
          <Button variant="danger" solid>
            {t("design.variant.solid")}
          </Button>
        </Sample>
        <Sample label={`${t("design.variant.solid")} · ${stateLabel("disabled")}`}>
          <Button variant="danger" solid disabled>
            {t("design.variant.solid")}
          </Button>
        </Sample>
      </div>
    </div>
  );
}

function Fields() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {STATES.map((state) => {
        const f = forced(state, true);
        return (
          <div key={state} className="space-y-3">
            <p className="text-sm font-medium">{stateLabel(state)}</p>
            <Field label={t("design.field.label")} help={state === "error" ? t("design.field.error") : t("design.field.help")}>
              <Input placeholder={t("design.field.placeholder")} defaultValue={state === "error" ? t("design.field.value") : ""} {...f} />
            </Field>
            <Textarea rows={2} aria-label={t("design.field.label")} placeholder={t("design.field.placeholder")} {...f} />
            <Select aria-label={t("design.field.label")} wrapperClassName="w-full" {...f}>
              <option>{t("design.option.a")}</option>
              <option>{t("design.option.b")}</option>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

function Choices() {
  const [view, setView] = useState("a");
  const options = [
    { id: "a", label: t("design.option.a") },
    { id: "b", label: t("design.option.b") },
    { id: "c", label: t("design.option.c") },
  ];
  return (
    <div className="space-y-4">
      <SegmentedControl label={t("design.segmented.label")} options={options} value={view} onChange={setView} />
      <div className={ROW}>
        {STATES.filter((s) => s === "default" || s === "focus" || s === "disabled").map((state) => (
          <div key={state} className="flex flex-col gap-2">
            <span className="text-xs text-text-2">{stateLabel(state)}</span>
            <div className="flex items-center gap-4">
              <Switch aria-label={t("design.switch.label")} checked={false} onCheckedChange={() => undefined} {...forced(state, false)} />
              <Switch aria-label={t("design.switch.label")} checked onCheckedChange={() => undefined} {...forced(state, false)} />
              <Radio name={`design-radio-${state}`} defaultChecked {...forced(state, false)}>
                {t("design.radio.a")}
              </Radio>
              <Radio name={`design-radio-${state}`} {...forced(state, false)}>
                {t("design.radio.b")}
              </Radio>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Status() {
  const levels = Object.keys(LEVEL_TONE);
  return (
    <div className="space-y-3">
      {(["md", "sm"] as const).map((size) => (
        <div key={size} className={ROW}>
          {[...levels, "none"].map((level) => (
            <StatusBadge key={level} level={level === "none" ? undefined : level} size={size}>
              {t(`design.level.${level}` as MessageKey)}
            </StatusBadge>
          ))}
        </div>
      ))}
      <div className={ROW}>
        {levels.map((level) => (
          <Badge key={level} level={level}>
            {t(`design.level.${level}` as MessageKey)}
          </Badge>
        ))}
      </div>
      <p className="text-sm">{t("design.kbd.before")} <Kbd>{t("design.kbd.key")}</Kbd> {t("design.kbd.after")}</p>
      <Tooltip text={t("design.tooltip.text")}>
        <Button variant="secondary">{t("design.tooltip.trigger")}</Button>
      </Tooltip>
    </div>
  );
}

function Layout() {
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("design.header.title")}
        description={t("design.header.description")}
        actions={
          <ButtonRow>
            <Button>{t("design.variant.secondary")}</Button>
            <Button variant="primary">{t("design.header.action")}</Button>
          </ButtonRow>
        }
      />
      <Section title={t("design.section.title")} count={3} action={<Button size="sm">{t("design.header.action")}</Button>}>
        <p className="text-sm">{t("design.section.body")}</p>
      </Section>
    </div>
  );
}

interface Row {
  id: string;
  name: string;
  level: string;
  count: number;
}
const ROWS: readonly Row[] = [
  { id: "a", name: "design.table.rowA", level: "running", count: 4 },
  { id: "b", name: "design.table.rowB", level: "needs_you", count: 12 },
];

function Tables() {
  return (
    <div className="space-y-4">
      <DataTable
        label={t("design.table.label")}
        rows={ROWS}
        rowKey={(r) => r.id}
        empty={t("design.table.empty")}
        columns={[
          { key: "name", header: t("design.table.name"), render: (r) => t(r.name as MessageKey) },
          { key: "level", header: t("design.table.state"), render: (r) => <StatusBadge level={r.level} size="sm">{t(`design.level.${r.level}` as MessageKey)}</StatusBadge> },
          { key: "count", header: t("design.table.count") },
          {
            key: "actions",
            header: t("design.table.actions"),
            render: () => (
              <ButtonRow>
                <Button size="sm">{t("design.table.reject")}</Button>
                <Button size="sm" variant="primary">{t("design.table.accept")}</Button>
                <OverflowMenu
                  label={t("design.table.more")}
                  items={[
                    { label: t("design.table.menuItem"), onSelect: () => undefined },
                    { label: t("design.table.menuDanger"), onSelect: () => undefined, danger: true },
                  ]}
                />
              </ButtonRow>
            ),
          },
        ]}
      />
      <DataTable label={t("design.table.label")} rows={[] as readonly Row[]} rowKey={(r) => r.id} columns={[]} empty={t("design.table.empty")} />
      <Table label={t("design.table.label")} head={[t("design.table.name"), t("design.table.count")]} numeric={[false, true]}>
        <Tr>
          <Td>{t("design.table.rowA")}</Td>
          <Td className="tabular-nums">4</Td>
        </Tr>
      </Table>
    </div>
  );
}

function Messages() {
  return (
    <div className="space-y-3">
      {(["info", "ok", "warn", "bad"] as const).map((tone) => (
        <Notice key={tone} tone={tone} title={t(`design.notice.${tone}` as MessageKey)}>
          {t("design.notice.body")}
        </Notice>
      ))}
      <EmptyState title={t("design.empty.title")} action={<Button variant="primary">{t("design.empty.action")}</Button>}>
        {t("design.empty.body")}
      </EmptyState>
      <Empty>{t("design.empty.plain")}</Empty>
      <ErrorNote error={new Error(t("design.error.message"))} />
      <Loading rows={2} />
    </div>
  );
}

function Overlays() {
  const [open, setOpen] = useState(false);
  return (
    <div className={ROW}>
      <Button onClick={() => setOpen(true)}>{t("design.dialog.open")}</Button>
      {open && (
        <Dialog title={t("design.dialog.title")} consequence={t("design.dialog.consequence")} confirmLabel={t("design.dialog.confirm")} onConfirm={() => setOpen(false)} onClose={() => setOpen(false)} />
      )}
      <OverflowMenu label={t("design.menu.label")} items={[{ label: t("design.table.menuItem"), onSelect: () => undefined }]} />
    </div>
  );
}

function BrandAndText() {
  return (
    <div className="space-y-3">
      <Brand />
      <BrandMark className="size-10" />
      <Markdown text={t("design.markdown")} />
    </div>
  );
}

/** The Design system page: no query, no API; every section is a fixed sample. */
export function DesignPage() {
  const sections: readonly [MessageKey, ReactNode][] = [
    ["design.section.buttons", <Buttons />],
    ["design.section.fields", <Fields />],
    ["design.section.choices", <Choices />],
    ["design.section.status", <Status />],
    ["design.section.layout", <Layout />],
    ["design.section.table", <Tables />],
    ["design.section.messages", <Messages />],
    ["design.section.overlays", <Overlays />],
    ["design.section.brand", <BrandAndText />],
  ];
  return (
    <div>
      <p className="mb-4 text-sm text-text-2">{t("design.intro")}</p>
      {sections.map(([title, body]) => (
        <Section key={title} title={t(title)}>
          {body}
        </Section>
      ))}
    </div>
  );
}
