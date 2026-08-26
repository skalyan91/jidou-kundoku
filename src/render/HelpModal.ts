import { applyTranslations, onLangChange, t } from "../i18n/i18n.ts";
import { cellFor } from "./KundokuView.ts";
import { deprelJa, uposJa } from "./tokenInspector.ts";

/** The step-by-step guide to editing a parse.
 *
 * Its figures are **live DOM**, not screenshots: each one is built from the
 * very classes the app renders with — `.kanji-cell` via `KundokuView`'s own
 * `cellFor`, `.token-context-menu` and `.token-subtitle` from
 * `kunten.css` — so they take the reader's light/dark theme from the same
 * custom properties the interface does, set themselves in the same fonts at
 * the same weights, and label themselves from the same `uposJa`/`deprelJa`
 * tables the real menus use. A screenshot would need one capture per theme,
 * would go stale the first time a colour or a label changed, and would sit
 * at a fixed resolution inside a resizable dialog. This cannot drift,
 * because it is the interface.
 *
 * The figures are illustrations, not a sandbox: `pointer-events` is off
 * across them (see `.help-figure` in app.css). The editing machinery in
 * `tokenInspector.ts` keeps its selection, its open menu and its undo
 * history in module state tied to the panel being edited, so a second live
 * editor here would share all three with the real one — clicking in the
 * tutorial would deselect the user's token, and its own tree would have to
 * displace theirs in the undo history to be undoable at all. Making the
 * tutorial genuinely interactive means scoping that state per container
 * first. */

/** The sentence every figure is drawn from — the app's own canonical
 * example, already carrying the two things the tutorial needs to point at:
 * a kaeriten (the レ点 on 習) and okurigana. */
const SAMPLE: { base: string; reading?: string; okurigana?: string; kunten?: string }[] = [
  { base: "學", reading: "まな", okurigana: "び" },
  { base: "而", okurigana: "て" },
  { base: "時", reading: "とき", okurigana: "に" },
  { base: "習", reading: "なら", okurigana: "ふ", kunten: "㆑" },
  { base: "之", reading: "これ", okurigana: "を" },
];

/** A miniature kundoku panel: the real cells, in the real vertical layout.
 * `selected` marks one cell the way a click does in the panel itself. */
function sampleText(selected?: number, dropTarget?: number): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "help-sample tategaki";
  const column = document.createElement("div");
  column.className = "tategaki-column text-main";
  SAMPLE.forEach((token, i) => {
    const cell = cellFor(token.base, token.reading, token.okurigana, token.kunten, i);
    if (i === selected) cell.classList.add("token-cell-selected");
    // The highlight the real panel puts on a prospective new head as the
    // pointer passes over it — worth showing alongside the rubber band,
    // which at this size runs right through the column it connects.
    if (i === dropTarget) cell.classList.add("token-drop-target");
    column.append(cell);
  });
  figure.append(column);
  return figure;
}

/** A label of the kind the inspector puts under a selected character. The
 * two label classes carry their own colours and sizing, so this needs no
 * styling of its own. */
function annotation(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/** Menu markup matching `openRetagMenu`'s: entries running down the inline
 * axis under a bound heading, one optionally marked as current. Built here
 * rather than driven by the real opener, which positions itself against the
 * viewport and takes over the module's single open-menu slot. */
function menu(groups: { heading: string; items: string[] }[], current?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "token-context-menu help-menu";
  for (const { heading, items } of groups) {
    const lead = document.createElement("div");
    lead.className = "token-menu-group-lead";
    const title = document.createElement("div");
    title.className = "token-menu-heading";
    title.textContent = heading;
    lead.append(title);
    items.forEach((label, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "token-menu-item";
      item.textContent = label;
      item.tabIndex = -1;
      if (label === current) item.dataset.current = "true";
      if (i === 0) lead.append(item);
      else el.append(item);
    });
    el.prepend(lead);
  }
  return el;
}

/** Lays a figure out as the sample text with something shown beside it. */
function figureWith(sample: HTMLElement, ...extras: HTMLElement[]): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "help-figure";
  figure.append(sample);
  if (extras.length > 0) {
    const aside = document.createElement("div");
    aside.className = "help-figure-aside";
    aside.append(...extras);
    figure.append(aside);
  }
  return figure;
}

/** The dashed rubber band a head-drag trails behind the pointer, drawn
 * between two of the sample's cells once the figure has a layout. Uses the
 * drag line's own two-path casing so it reads the same as the real one. */
function dragLine(figure: HTMLElement, fromIndex: number, toIndex: number): void {
  const cells = figure.querySelectorAll<HTMLElement>(".kanji-cell");
  const from = cells[fromIndex]?.querySelector<HTMLElement>(".kanji-glyph");
  const to = cells[toIndex]?.querySelector<HTMLElement>(".kanji-glyph");
  if (!from || !to) return;
  const box = figure.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "help-drag-line");
  const d = `M ${a.left + a.width / 2 - box.left} ${a.top + a.height / 2 - box.top} L ${b.left + b.width / 2 - box.left} ${
    b.top + b.height / 2 - box.top
  }`;
  for (const cls of ["token-drag-line-casing", "token-drag-line-path"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", d);
    svg.append(path);
  }
  figure.append(svg);
}

interface Step {
  key: string;
  /** Built after the dialog is in the DOM, so a figure can measure itself. */
  figure: () => HTMLElement;
  /** Run once the figure has a layout, for anything that needs measuring. */
  afterLayout?: (figure: HTMLElement) => void;
}

function steps(): Step[] {
  return [
    {
      key: "select",
      figure: () =>
        figureWith(sampleText(3), annotation("token-subtitle help-floating", uposJa("VERB")), annotation("token-arrow-label help-floating", deprelJa("conj:coord"))),
    },
    {
      key: "pos",
      figure: () =>
        figureWith(
          sampleText(3),
          menu([{ heading: "用言", items: [uposJa("VERB"), uposJa("AUX"), uposJa("ADJ"), uposJa("ADV")] }], uposJa("VERB")),
        ),
    },
    {
      key: "relation",
      figure: () =>
        figureWith(
          sampleText(3),
          menu(
            [{ heading: "述語・項", items: [deprelJa("ROOT"), deprelJa("subj"), deprelJa("comp:obj"), deprelJa("comp:obl")] }],
            deprelJa("comp:obj"),
          ),
        ),
    },
    {
      key: "head",
      figure: () => figureWith(sampleText(4, 0)),
      afterLayout: (figure) => dragLine(figure, 4, 0),
    },
    {
      key: "root",
      figure: () =>
        figureWith(
          sampleText(0),
          menu([{ heading: "述語・項", items: [deprelJa("ROOT"), deprelJa("subj"), deprelJa("comp:obj")] }], deprelJa("ROOT")),
        ),
    },
    {
      key: "reading",
      figure: () =>
        figureWith(sampleText(0), menu([{ heading: "音読み", items: ["がく"] }, { heading: "訓読み", items: ["まなブ", "ならフ"] }], "まなブ")),
    },
    {
      key: "undo",
      figure: () => {
        const keys = document.createElement("div");
        keys.className = "help-keys";
        for (const cap of [t("help.step.undo.key"), "Z"]) {
          const kbd = document.createElement("kbd");
          kbd.textContent = cap;
          keys.append(kbd);
        }
        return figureWith(sampleText(), keys);
      },
    },
  ];
}

let dialog: HTMLDialogElement | null = null;
let stopLangWatch: (() => void) | null = null;

/** Built dialog plus the figures that still need measuring — see
 * `openHelpModal`, which runs `finish` only once the dialog is open. */
interface Built {
  el: HTMLDialogElement;
  finish: () => void;
}

function build(): Built {
  const el = document.createElement("dialog");
  el.className = "help-modal";
  el.setAttribute("aria-labelledby", "help-title");

  const header = document.createElement("header");
  header.className = "help-header";
  const title = document.createElement("h2");
  title.id = "help-title";
  title.dataset.i18n = "help.title";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "help-close";
  close.textContent = "×";
  close.dataset.i18nAttr = "aria-label:help.close;title:help.close";
  close.addEventListener("click", () => el.close());
  header.append(title, close);

  const intro = document.createElement("p");
  intro.className = "help-intro";
  intro.dataset.i18n = "help.intro";

  const list = document.createElement("ol");
  list.className = "help-steps";
  const pending: [Step, HTMLElement][] = [];
  for (const step of steps()) {
    const item = document.createElement("li");
    item.className = "help-step";

    const text = document.createElement("div");
    text.className = "help-step-text";
    const heading = document.createElement("h3");
    heading.dataset.i18n = `help.step.${step.key}.title`;
    const body = document.createElement("p");
    body.dataset.i18n = `help.step.${step.key}.body`;
    text.append(heading, body);

    const figure = step.figure();
    item.append(text, figure);
    list.append(item);
    if (step.afterLayout) pending.push([step, figure]);
  }

  el.append(header, intro, list);
  document.body.append(el);
  applyTranslations(el);
  // A closed <dialog> is `display: none`, so every rect inside it measures
  // zero — the figures that measure themselves have to wait until it is
  // actually open (the drag line came out as "M 0 0 L 0 0" otherwise).
  return { el, finish: () => pending.forEach(([step, figure]) => step.afterLayout!(figure)) };
}

export function openHelpModal(): void {
  // Rebuilt each time rather than kept around: the figures' own labels come
  // from the tables in `tokenInspector.ts`, and the step text is
  // translated, so a stale dialog would be a stale one in the wrong
  // language after a switch.
  dialog?.remove();
  const built = build();
  dialog = built.el;
  dialog.showModal();
  built.finish();

  stopLangWatch?.();
  stopLangWatch = onLangChange(() => {
    if (!dialog?.open) return;
    const wasOpen = dialog;
    const next = build();
    dialog = next.el;
    dialog.showModal();
    next.finish();
    wasOpen.remove();
  });

  dialog.addEventListener("close", () => {
    stopLangWatch?.();
    stopLangWatch = null;
    dialog?.remove();
    dialog = null;
  });
}
