import { applyTranslations, onLangChange } from "../i18n/i18n.ts";
import { cellFor } from "./KundokuView.ts";
import { deprelJa, type Entry, showInspector, sizeMenuSquarish, uposJa } from "./tokenInspector.ts";
import type { Token } from "../parse/types.ts";

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

/** The sentence every figure is drawn from, with the analysis the parser
 * actually returns for it — so the arrows the figures draw are the real
 * ones, labelled from the real relations, not a plausible-looking sketch.
 * 學 heads the sentence; 習 coordinates with it; 而, 時 and 之 hang off 習. */
const SAMPLE: { base: string; reading?: string; okurigana?: string; kunten?: string; token: Token }[] = [
  { base: "學", reading: "まな", okurigana: "び", token: { id: 0, text: "學", lemma: "學", pos: "VERB", xpos: "", dep: "ROOT", head: 0 } },
  { base: "而", okurigana: "て", token: { id: 1, text: "而", lemma: "而", pos: "CCONJ", xpos: "", dep: "cc", head: 3 } },
  { base: "時", reading: "とき", okurigana: "に", token: { id: 2, text: "時", lemma: "時", pos: "NOUN", xpos: "", dep: "mod@tmod", head: 3 } },
  { base: "習", reading: "なら", okurigana: "ふ", kunten: "㆑", token: { id: 3, text: "習", lemma: "習", pos: "VERB", xpos: "", dep: "conj:coord", head: 0 } },
  { base: "之", reading: "これ", okurigana: "を", token: { id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "", dep: "comp:obj", head: 3 } },
];

/** The real cells at their real size and spacing — the type scale is left
 * exactly as the panel sets it, so a figure shows the character, its
 * furigana and its kunten in the proportions the reader will actually be
 * looking at. `selected` marks one cell the way a click does. */
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

/** Draws the inspector exactly as a click does — the same Hobby-spline
 * arc from head to dependent, the same arrowhead and casing, the same
 * relation label in the gutter and part-of-speech label under the
 * character — by handing the figure's own cells to `showInspector`.
 *
 * That function is pure DOM: it takes a column and two entries and appends
 * an overlay, without touching the module's idea of what is selected. So
 * the tutorial gets the genuine article rather than a drawing of it, and
 * any later change to how an arrow is shaped or a label placed shows up
 * here automatically. */
function showArrow(figure: HTMLElement, tokenIndex: number): void {
  const column = figure.querySelector<HTMLElement>(".tategaki-column");
  const cells = figure.querySelectorAll<HTMLElement>(".kanji-cell");
  const entryFor = (i: number): Entry | null => {
    const cell = cells[i];
    const glyph = cell?.querySelector<HTMLElement>(".kanji-glyph");
    return cell && glyph ? { cell, glyph, token: SAMPLE[i].token } : null;
  };
  const entry = entryFor(tokenIndex);
  if (!column || !entry) return;
  const headId = entry.token.head;
  // A root has no head to draw from; `showInspector` takes null and shows
  // just the part of speech, which is what the panel does too.
  showInspector(column, headId === entry.token.id ? null : entryFor(headId), entry);
}

/** A pointer drawn onto a figure, marking what to aim at and which button
 * to use. Two pieces: the arrow itself, and a small mouse whose left or
 * right button is filled in — the step text says which button in words,
 * and this says it again where the reader is already looking.
 *
 * Positioned at `target`'s centre and offset down-right, the way a real
 * pointer sits below and right of what its tip is on. */
function pointer(figure: HTMLElement, target: Element | null | undefined, button: "left" | "right"): void {
  if (!target) return;
  const box = figure.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "help-pointer";
  // The tip goes toward the target's lower-right rather than its dead
  // centre. The pointer hangs down-and-right of its tip, so anchoring at
  // the centre lays the whole arrow across the thing being pointed at —
  // which on a kanji means competing with the glyph's own strokes, its
  // furigana and its kunten at once. From the corner it still
  // unambiguously indicates the target while sitting mostly clear of it.
  el.style.left = `${t.left + t.width * 0.72 - box.left}px`;
  el.style.top = `${t.top + t.height * 0.72 - box.top}px`;
  el.innerHTML = `
    <svg class="help-pointer-arrow" viewBox="0 0 12 18" width="19" height="28" aria-hidden="true">
      <path d="M1 1 L1 14.5 L4.6 11.2 L6.9 16.6 L9.4 15.5 L7.1 10.3 L11.6 9.9 Z"/>
    </svg>
    <svg class="help-pointer-mouse" viewBox="0 0 14 20" width="17" height="24" aria-hidden="true">
      <rect class="help-mouse-body" x="1" y="1" width="12" height="18" rx="6"/>
      <path class="help-mouse-button" d="${
        button === "right" ? "M7 1 H7.5 A5.5 5.5 0 0 1 13 6.5 V9 H7 Z" : "M6.5 1 H7 V9 H1 V6.5 A5.5 5.5 0 0 1 6.5 1 Z"
      }"/>
      <line class="help-mouse-divider" x1="7" y1="1" x2="7" y2="9"/>
    </svg>`;
  figure.append(el);
}

/** Wraps a figure's menu into columns exactly as a real one is wrapped,
 * through the same `sizeMenuSquarish` pass — a menu left unshaped runs as
 * one tall column, which is neither what the reader will see nor a good
 * fit beside the text. Runs only once the dialog is open, since the pass
 * measures. */
function shapeMenus(figure: HTMLElement): void {
  for (const el of figure.querySelectorAll<HTMLElement>(".token-context-menu")) sizeMenuSquarish(el);
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

/** Which modifier to show for undo. The handler itself accepts either —
 * neither key means anything on the other platform, so there is nothing to
 * disambiguate there — but a guide showing both would be telling the
 * reader to work out which one is theirs. `userAgentData.platform` where
 * the browser offers it, falling back to the user-agent string; a wrong
 * guess mislabels a keycap and nothing more. */
function undoModifier(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

interface Step {
  key: string;
  /** Built after the dialog is in the DOM, so a figure can measure itself. */
  figure: () => HTMLElement;
  /** Run once the figure has a layout, for anything that needs measuring. */
  afterLayout?: (figure: HTMLElement) => void;
}

/** The parts of a figure a pointer can be aimed at. */
const glyphOf = (figure: HTMLElement, i: number) => figure.querySelectorAll(".kanji-cell")[i]?.querySelector(".kanji-glyph");
const rubyOf = (figure: HTMLElement, i: number) => figure.querySelectorAll(".kanji-cell")[i]?.querySelector("rt");
const markedMenuItem = (figure: HTMLElement) => figure.querySelector(".token-menu-item[data-current]");

function steps(): Step[] {
  return [
    {
      key: "select",
      // 習, whose head is 學 — an arrow spanning most of the column.
      figure: () => figureWith(sampleText()),
      afterLayout: (figure) => {
        showArrow(figure, 3);
        pointer(figure, glyphOf(figure, 3), "left");
      },
    },
    {
      key: "pos",
      figure: () =>
        figureWith(
          sampleText(),
          menu([{ heading: "用言", items: [uposJa("VERB"), uposJa("AUX"), uposJa("ADJ"), uposJa("ADV")] }], uposJa("VERB")),
        ),
      afterLayout: (figure) => {
        showArrow(figure, 3);
        shapeMenus(figure);
        pointer(figure, figure.querySelector(".token-subtitle"), "right");
      },
    },
    {
      key: "relation",
      // 之 -> 習, an adjacent pair: the short arc a レ点 goes with.
      figure: () =>
        figureWith(
          sampleText(),
          menu(
            [{ heading: "述語・項", items: [deprelJa("ROOT"), deprelJa("subj"), deprelJa("comp:obj"), deprelJa("comp:obl")] }],
            deprelJa("comp:obj"),
          ),
        ),
      afterLayout: (figure) => {
        showArrow(figure, 4);
        shapeMenus(figure);
        pointer(figure, figure.querySelector(".token-arrow-label"), "right");
      },
    },
    {
      key: "head",
      figure: () => figureWith(sampleText(undefined, 0)),
      afterLayout: (figure) => {
        showArrow(figure, 4);
        dragLine(figure, 4, 0);
        // Mid-drag: the pointer is over the character being aimed at, with
        // the button still held.
        pointer(figure, glyphOf(figure, 0), "left");
      },
    },
    {
      key: "root",
      figure: () =>
        figureWith(
          sampleText(),
          menu([{ heading: "述語・項", items: [deprelJa("ROOT"), deprelJa("subj"), deprelJa("comp:obj")] }], deprelJa("ROOT")),
        ),
      afterLayout: (figure) => {
        showArrow(figure, 3);
        shapeMenus(figure);
        // Here the aim is the menu entry itself, not what opened it.
        pointer(figure, markedMenuItem(figure), "left");
      },
    },
    {
      key: "reading",
      // No arrow: this step is about the furigana, and 學 is the root
      // anyway, so there is no head to point from.
      figure: () =>
        figureWith(sampleText(0), menu([{ heading: "音読み", items: ["がく"] }, { heading: "訓読み", items: ["まなブ", "ならフ"] }], "まなブ")),
      afterLayout: (figure) => {
        shapeMenus(figure);
        pointer(figure, rubyOf(figure, 0), "right");
      },
    },
    {
      key: "undo",
      // Keyboard only, so no pointer.
      figure: () => {
        const keys = document.createElement("div");
        keys.className = "help-keys";
        for (const cap of [undoModifier(), "Z"]) {
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
  intro.dataset.i18nHtml = "help.intro";

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
    // Italicised Japanese terms in the English copy — see `applyTranslations`.
    body.dataset.i18nHtml = `help.step.${step.key}.body`;
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
