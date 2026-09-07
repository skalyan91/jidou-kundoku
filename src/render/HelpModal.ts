import { applyTranslations, getUiLang, onLangChange, setUiLang } from "../i18n/i18n.ts";
import { cellFor } from "./KundokuView.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../kundoku/kundokuTenAssigner.ts";
import { buildKundokuGlyphMap } from "./kundokuGlyphs.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import {
  appendMenuGroup,
  deprelMenuGroups,
  deprelRowElement,
  type Entry,
  showInspector,
  sizeMenuSquarish,
  uposJa,
} from "./tokenInspector.ts";
import type { Token } from "../parse/types.ts";

/** The step-by-step guide to editing a parse.
 *
 * Its figures are **live DOM**, not screenshots: each one is built from the
 * very classes the app renders with — `.kanji-cell` via `KundokuView`'s own
 * `cellFor`, `.token-context-menu` and `.token-subtitle` from
 * `kunten.css` — so they take the reader's light/dark theme from the same
 * custom properties the interface does, set themselves in the same fonts at
 * the same weights, and label themselves from the same `uposJa` table and the
 * same `deprelMenuGroups`/`deprelRowElement` pair the real menus are built
 * from. A screenshot would need one capture per theme,
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

/** The line every figure is drawn from, with the analysis the treebank
 * actually gives it — so the arrows the figures draw are the real ones,
 * labelled from the real relations, not a plausible-looking sketch. 敬 heads
 * the line; 事 is its object; 信 coordinates with it; 而 hangs off 信.
 *
 * 敬事而信 — "be attentive to affairs and be trustworthy", 論語 學而第一.5,
 * and **the sample text's own fifth chapter**: these four rows are
 * `KR1h0004_001_par5_1-2#1` in `public/data/samples/rongo-gakuji.conllu`
 * verbatim, less its trailing comma. That is the point of the choice. The
 * tutorial used to draw a line from elsewhere in the Analects (敏而好學,
 * 5.15), which was true to the book but not to anything the reader could
 * open; drawn from the text the sidebar's own button loads, the figures are
 * of a passage they can now go and look at, and `tests/sampleTexts.test.ts`
 * asserts the four rows against the file so the two cannot drift apart.
 *
 * **It is still a copy and not a load.** The modal is opened on demand and
 * should cost nothing to open; fetching a 18KB CoNLL-U file to draw four
 * cells would make the tutorial a second way of loading a document, which is
 * exactly what the note above says it must not become. So the sample is
 * written out here, as it always was, and the test is what keeps it honest.
 *
 * A replacement had to be able to teach every step, which is what settled on
 * this one out of the sample's sixteen chapters:
 *
 *   - **an inversion**, or no figure shows a kaeriten at all — 事 is 敬's
 *     `comp:obj` and is read before it, which puts the レ on 敬;
 *   - **an arc worth drawing**: 信 attaches back to 敬 across the whole
 *     column, which is the arrow the first figure needs, and 事 attaches to
 *     its neighbour, which is the short arc the relation figure needs;
 *   - **a character the prose moves**: 事 is the *second* character and the
 *     *first* word, its レ having carried it past 敬 — and the 書き下し文
 *     step's own prose promises exactly that ("not always the obvious
 *     word"), so the figure has to have one;
 *   - **readings and okurigana**: 敬 うやま-ひ, 事 こと-を, 信 しん-す, and 而
 *     bare but for its テ — the four cover a character with both, and one
 *     with okurigana alone;
 *   - **a relation in the first menu category**, since the relation figure
 *     shows 述語・項 and marks the current relation in it (see `deprelMenu`);
 *   - **four tokens**, which is both the floor and the ceiling. The floor
 *     because the steps ask for a selection with a neighbour to have come
 *     from, a drop target that is not the head, and a re-attachment; the
 *     ceiling because the figures were once five characters long and ran
 *     over — the gap between characters had to be cut to two thirds to fit
 *     them, and a four-character line buys that back at the spacing the
 *     panel actually uses (see `.help-sample` in app.css). Which is why the
 *     opening 學而時習之 was not taken, famous and already in the sidebar
 *     placeholder though it is: it is five.
 *
 * The readings are the ones the resolver gives these four and the
 * kakikudashibun below is the one the generator writes from them — both
 * taken from the app's own pipeline rather than composed here. */
export const SAMPLE: { base: string; reading?: string; okurigana?: string; token: Token }[] = [
  { base: "敬", reading: "うやま", okurigana: "ひ", token: { id: 0, text: "敬", lemma: "敬", pos: "VERB", xpos: "", dep: "ROOT", head: 0 } },
  { base: "事", reading: "こと", okurigana: "を", token: { id: 1, text: "事", lemma: "事", pos: "NOUN", xpos: "", dep: "comp:obj", head: 0 } },
  { base: "而", okurigana: "て", token: { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "", dep: "cc", head: 3 } },
  { base: "信", reading: "しん", okurigana: "す", token: { id: 3, text: "信", lemma: "信", pos: "VERB", xpos: "", dep: "conj:coord", head: 0 } },
];

/** The kaeriten a set of tokens actually calls for, through the very
 * engine the panel uses: reading order, then mark assignment, then the
 * Kanbun-block glyphs.
 *
 * Worked out rather than written down, because a figure that changes an
 * attachment changes these too. 事 hangs off 敬 and must be read before it,
 * which is what puts the レ on 敬; re-attach 信 to 事 and that レ has no
 * reason to exist, while a 一二点 carrying the reading from 信 back to 敬
 * appears instead. A hard-coded mark would have gone on saying the old thing
 * under the new arrow. */
function kuntenFor(tokens: Token[]): Map<number, string> {
  const sentence = { tokens };
  const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
  assignKundokuTen(plan); // fills in each group's depth/isRe in place
  return buildKundokuGlyphMap(plan);
}

/** 信 attached to 事 instead of 敬 — what the drag step's drag would do, used
 * both for the arrow it draws and for the kaeriten that follow from it.
 *
 * Chosen among the attachments the drag *could* show because it is the one
 * that visibly rewrites the marks: 敬's レ has no reason to exist once 事 is
 * no longer what is read before it, and a 一二点 spanning 信 and 敬 appears in
 * its place. The other candidate — 事 moved onto 信 — leaves the line with no
 * kaeriten at all, and a figure whose marks have simply gone reads as a
 * figure that failed to draw. */
const REATTACHED: Token[] = SAMPLE.map((t) => t.token).map((t) =>
  t.id === 3 ? { ...t, head: 1, dep: "conj:coord" } : t,
);

/** The real cells at their real size and spacing — the type scale is left
 * exactly as the panel sets it, so a figure shows the character, its
 * furigana and its kunten in the proportions the reader will actually be
 * looking at.
 *
 * `selected` marks a cell the way a click does, `previous` the way one that
 * has just been stepped off looks, `dropTarget` the way a prospective new
 * head does. `tokens` supplies an analysis other than the sample's own —
 * for a figure showing what an edit would leave. */
function sampleText(
  opts: { selected?: number; previous?: number; dropTarget?: number; tokens?: Token[] } = {},
): HTMLElement {
  const { selected, previous, dropTarget, tokens = SAMPLE.map((t) => t.token) } = opts;
  const marks = kuntenFor(tokens);
  const figure = document.createElement("div");
  figure.className = "help-sample tategaki";
  const column = document.createElement("div");
  column.className = "tategaki-column text-main";
  SAMPLE.forEach((token, i) => {
    const cell = cellFor(token.base, token.reading, token.okurigana, marks.get(i), i);
    if (i === selected) cell.classList.add("token-cell-selected");
    // The highlight the real panel puts on a prospective new head as the
    // pointer passes over it — worth showing alongside the rubber band,
    // which at this size runs right through the column it connects.
    if (i === dropTarget) cell.classList.add("token-drop-target");
    // Where the selection has just come from — half-way between the
    // selection blue and the text's own colour, so the pair reads as one
    // mark moving rather than two characters marked at once.
    if (i === previous) cell.classList.add("token-cell-previous");
    column.append(cell);
  });
  figure.append(column);
  return figure;
}

/** The kakikudashibun the sample comes out as, marked the way the panel
 * marks it when a character is picked out in the other one.
 *
 * Written here rather than generated: producing it for real would mean the
 * reading order, the reading resolver and the whole generator, all to
 * reproduce a run of four words that never changes. What matters for the
 * figure is that a reader sees the same words and the same mark as they will
 * on the screen, and the classes are the panel's own, so it is set in the
 * same face at the same size and marked in the same blue.
 *
 * Copied from the running app rather than composed, and in the app's order,
 * not the text's: 事 is the *second* character and the *first* word, since
 * its レ carries it past 敬. That mismatch is the whole subject of the step
 * this figure serves. It is the one thing here that could go stale without
 * anything breaking — if the generator ever writes these four differently,
 * this line has to follow it. */
export const KAKIKUDASHI_SAMPLE = ["事を", "敬ひ", "て", "信す"];

function kakikudashiSample(marked: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "help-sample tategaki";
  const column = document.createElement("div");
  column.className = "tategaki-column text-kakikudashi";
  const wrapper = document.createElement("span");
  wrapper.className = "sentence-gap";
  KAKIKUDASHI_SAMPLE.forEach((piece, i) => {
    const span = document.createElement("span");
    span.className = "kaki-token";
    if (i === marked) span.classList.add("kaki-token-selected");
    span.textContent = piece;
    wrapper.append(span);
  });
  wrapper.append("。");
  column.append(wrapper);
  el.append(column);
  return el;
}

/** Keycaps, for the steps whose gesture is a keystroke. `pressed` is drawn
 * held down — the one key the step is actually about. */
function keys(caps: string[], pressed?: string, stacked = false): HTMLElement {
  const el = document.createElement("div");
  el.className = stacked ? "help-keys help-keys-stacked" : "help-keys";
  for (const cap of caps) {
    const kbd = document.createElement("kbd");
    kbd.textContent = cap;
    if (cap === pressed) kbd.className = "help-key-pressed";
    el.append(kbd);
  }
  return el;
}

/** The four arrow keys in the inverted T they sit in on a keyboard, so they
 * are recognisable as *those* keys rather than as four symbols in a row. The
 * empty cells above the left and right keys are what makes the shape. */
function arrowKeys(pressed: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "help-keys help-keys-arrows";
  for (const cap of ["", "↑", "", "←", "↓", "→"]) {
    if (cap === "") {
      el.append(document.createElement("span"));
      continue;
    }
    const kbd = document.createElement("kbd");
    kbd.textContent = cap;
    if (cap === pressed) kbd.className = "help-key-pressed";
    el.append(kbd);
  }
  return el;
}

/** Menu markup matching `openRetagMenu`'s: entries running down the inline
 * axis under a heading, one category per band of columns, one entry
 * optionally marked as current. Built here rather than driven by the real
 * opener, which positions itself against the viewport and takes over the
 * module's single open-menu slot — but filed through the real
 * `appendMenuGroup`, so the structure the wrap depends on is not restated
 * here and cannot drift from it.
 *
 * For the two menus whose entries are one box apiece: the part-of-speech
 * menu, whose tagset is flat, and the readings menu, whose entries are kana.
 * The relation menu is composite and has `deprelMenu` below. */
function menu(groups: { heading: string; items: string[] }[], current?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "token-context-menu help-menu";
  for (const { heading, items } of groups) {
    appendMenuGroup(
      el,
      heading,
      items.map((label) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "token-menu-item";
        item.textContent = label;
        item.tabIndex = -1;
        if (label === current) item.dataset.current = "true";
        return item;
      }),
    );
  }
  return el;
}

/** The relation menu as the figure shows it: real rows, from the real
 * builder.
 *
 * The figure used to hand-build four flat `.token-menu-item` entries out of
 * `deprelJa` strings, which was accurate for as long as a relation was one
 * box. It is not any more — the menu's defining feature is now that a row
 * carries its subtypes inline and each piece is picked separately, and a
 * figure of flat entries illustrated the one thing the step exists to teach
 * as though it did not exist. Worse, it showed 斜格補語 where the menu shows
 * 斜格補語〖場所〗, so the reader was being shown a label they would not find.
 *
 * So the rows come from `deprelMenuGroups` — the same call `openRetagMenu`
 * makes — and are drawn by `deprelRowElement`, the same function that draws
 * them in the menu itself. It is still an illustration and not a live menu:
 * `deprelRowElement` is given no `onPick`, which leaves the segments as
 * buttons that are out of the tab order and do nothing, and the figures are
 * `pointer-events: none` besides (see `.help-figure` in app.css and this
 * module's own note on why the tutorial is not a sandbox).
 *
 * **Which rows.** The first category, 述語・項, as before, but four of its
 * seven rows rather than all of them — the figure sits beside the sample text
 * in a dialog, and a category that ran to seven rows would wrap into a table
 * wider than the text it annotates. Three plain rows and then the first
 * subtyped one, picked by looking rather than by index, so that whatever the
 * inventory is reordered to the figure keeps showing exactly the thing it is
 * there to show: a row with a bracket in it. Today that is 斜格補語〖場所〗,
 * and the four come out in the order the menu has them. */
function deprelMenu(current: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "token-context-menu help-menu";
  const [heading, rows] = deprelMenuGroups()[0];
  const subtyped = rows.find((row) => row.segments.length > 1) ?? rows[rows.length - 1];
  const shown = [...rows.filter((row) => row !== subtyped).slice(0, 3), subtyped];
  appendMenuGroup(el, heading, shown.map((row) => deprelRowElement(row, current)));
  return el;
}

/** Lays a figure out as the sample text with something shown beside it.
 *
 * A figure showing a *menu* is laid out the other way round, which is what
 * `help-figure-menu` says (see app.css). The menu hangs from its top right
 * corner on screen — `menuTopLeftFor` in tokenInspector.ts — so the table
 * grows down and away to the left of the point it was opened from, and a
 * figure that drew it to the right of the pointer was showing the reader the
 * arrangement the app had before that. The class is set from what the figure
 * holds rather than by each step, so a step added later cannot forget it. */
function figureWith(sample: HTMLElement, ...extras: HTMLElement[]): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "help-figure";
  figure.append(sample);
  if (extras.length > 0) {
    const aside = document.createElement("div");
    aside.className = "help-figure-aside";
    aside.append(...extras);
    figure.append(aside);
    if (extras.some((el) => el.classList.contains("token-context-menu"))) {
      figure.classList.add("help-figure-menu");
    }
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
function showArrow(root: HTMLElement, tokenIndex: number, as?: Partial<Token>): void {
  const column = root.querySelector<HTMLElement>(".tategaki-column");
  const cells = root.querySelectorAll<HTMLElement>(".kanji-cell");
  // `as` overrides the sample's own analysis, for a figure showing what an
  // edit *would* leave — the head step draws the same character attached
  // where the drag is about to put it.
  const entryFor = (i: number): Entry | null => {
    const cell = cells[i];
    const glyph = cell?.querySelector<HTMLElement>(".kanji-glyph");
    const token = i === tokenIndex && as ? { ...SAMPLE[i].token, ...as } : SAMPLE[i].token;
    return cell && glyph ? { cell, glyph, token } : null;
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
const POINTER_ARROW_PATH = "M1 1 L1 14.5 L4.6 11.2 L6.9 16.6 L9.4 15.5 L7.1 10.3 L11.6 9.9 Z";

/** The little mouse drawn beside a pointer, with the button in use filled
 * in — the step text says which button in words, and this says it again
 * where the reader is already looking. */
function mouseSvg(button: "left" | "right"): string {
  return `<svg class="help-pointer-mouse" viewBox="0 0 14 20" width="17" height="24" aria-hidden="true">
      <rect class="help-mouse-body" x="1" y="1" width="12" height="18" rx="6"/>
      <path class="help-mouse-button" d="${
        button === "right" ? "M7 1 H7.5 A5.5 5.5 0 0 1 13 6.5 V9 H7 Z" : "M6.5 1 H7 V9 H1 V6.5 A5.5 5.5 0 0 1 6.5 1 Z"
      }"/>
      <line class="help-mouse-divider" x1="7" y1="1" x2="7" y2="9"/>
    </svg>`;
}

function arrowSvg(extraClass = "", style = ""): string {
  return `<svg class="help-pointer-arrow ${extraClass}" viewBox="0 0 12 18" width="19" height="28"
               aria-hidden="true" style="${style}"><path d="${POINTER_ARROW_PATH}"/></svg>`;
}

/** The smear a thing in motion leaves, which is how a still picture says
 * that something is moving.
 *
 * `back` is the whole way the pointer has come, and the trail is laid along
 * it, so it begins exactly where the drag did rather than fading out
 * wherever a fixed length happened to reach.
 *
 * Both ends are drawn as pointers proper — arrow and mouse, the button held
 * down at each — because both are moments in the gesture: the press at one
 * end, and where it has got to at the other. What lies between them is the
 * blur, and it has to read as one continuous thing rather than as a row of
 * separate arrows: six ghosts, spread over a drag this long, were far enough
 * apart to be nearly invisible one by one.
 *
 * What holds it together is the blur, not the count. Over this 264px drag
 * these leave a widest gap of 39.3px in the middle — wider than the arrow is
 * tall, and bridged all the same, because the ghosts out there carry the
 * longest smear the trail has. Which is why the middle can be thinned at all:
 * the copies are packed where they are sharp and sparse where they are
 * smeared, and only the first of those needs numbers. */
const TRAIL_GHOSTS = 18;

/** Ease-in-out cubic — the shape a hand's movement actually has: away from
 * rest slowly, quickest in the middle, slowing again into the target.
 *
 * The ghosts are struck at even intervals of *time* and placed at the
 * distance covered by then, so the spacing carries the speed: they crowd at
 * the two ends where the pointer was barely moving, and stretch apart across
 * the middle where it was going fastest. Evenly spaced they described a
 * constant speed, which no drag has.
 *
 * The power sets how pronounced that is — how briefly the pointer is at
 * speed and how sharply it gets there. A quintic puts most of the distance
 * into the middle of the movement and most of the copies at its two ends; a
 * cubic spreads both, and reads as the more even glide.
 *
 * It also sets how far apart the middle is spread — by about EASE_POWER
 * times the average gap — and so how few copies the trail can be drawn with
 * before that gap outruns the blur bridging it. Over this drag a 5 would put
 * 58.7px between the middle pair, where a 3 puts 39.3: the same trail drawn
 * with the same eighteen copies and less strung out between them. */
const EASE_POWER = 3;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 ** (EASE_POWER - 1) * t ** EASE_POWER : 1 - (-2 * t + 2) ** EASE_POWER / 2;
}

/** How long a ghost's blur is: the speed it was struck at, which is the
 * slope of the curve above. Differentiating it gives 12t² on the way up and
 * 12(1−t)² on the way down, peaking at 3 in the middle and falling to
 * nothing at either end.
 *
 * Which is what a motion blur actually measures — how far the thing moved
 * while the shutter was open. One length for the whole trail smeared the
 * ends, where the pointer was barely moving and should be nearly sharp, as
 * heavily as the middle, where it was going fastest. Rounded to the half
 * pixel so that a couple of dozen ghosts need only a handful of filters
 * between them. */
function trailBlur(t: number): number {
  // The derivative of the curve above, which peaks at EASE_POWER in the
  // middle and falls to nothing at either end.
  const slope =
    t < 0.5
      ? EASE_POWER * 2 ** (EASE_POWER - 1) * t ** (EASE_POWER - 1)
      : EASE_POWER * (2 - 2 * t) ** (EASE_POWER - 1);
  return Math.round((0.6 + (slope / EASE_POWER) * 7.4) * 2) / 2;
}

/** Every blur length the trail calls for, each needing a filter of its own —
 * `stdDeviation` is an attribute of the filter, not something an element
 * referencing one can vary. */
function trailBlurLevels(): number[] {
  const levels = new Set<number>();
  for (let i = 1; i < TRAIL_GHOSTS; i++) levels.add(trailBlur(i / TRAIL_GHOSTS));
  return [...levels];
}

function blurFilterId(px: number): string {
  return `help-motion-blur-${String(px).replace(".", "-")}`;
}

function motionTrail(back: { dx: number; dy: number }, button: "left" | "right"): string {
  const smear = Array.from({ length: TRAIL_GHOSTS - 1 }, (_, i) => {
    // Even in time, uneven in distance: `t` is where in the movement this
    // copy was struck, `fraction` is how far down the line that puts it.
    // Only the position reads off the distance. The fade goes by `t`, and the
    // blur by the rate `t` is being spent at.
    //
    // Fading by distance is what it was, and it put the whole range across
    // the sparse middle: the copies clustered at each end sat within a few
    // percent of each other while the handful spanning the gap between them
    // carried every value in between. That is a taper collapsed into a step —
    // a dark clump, an abrupt change, a faint clump. By time the step from
    // one copy to the next is constant, which is the most gradual these two
    // endpoints can be graded between, and the trail darkens evenly along its
    // whole length.
    const t = (i + 1) / TRAIL_GHOSTS;
    const fraction = easeInOut(t);
    const style = [
      `transform: translate(${(back.dx * fraction).toFixed(1)}px, ${(back.dy * fraction).toFixed(1)}px)`,
      // Tapering from the pointer back toward the press, which is what makes
      // the smear say which way it went — heaviest and sharpest where the
      // pointer is now, thinning and blurring toward where it came from, as
      // a photograph of anything moving does.
      //
      // It starts where the copy at the start is drawn, which is 45% of the
      // ink — the two marks the gesture has, its beginning and where it has
      // got to, meeting the trail at the same strength from either end.
      //
      // Spent as alpha here and as a mix there, and they land on the same
      // colour: full ink at 0.45 over the page and 45% ink mixed into the
      // page are the same arithmetic, 0.45 of the one and 0.55 of the other.
      // Which is why the head can be given the whole ink and still not be
      // heavy — what it comes out at is the product of the two numbers, and
      // no ghost here is alone, the easing packing its copies most densely
      // at exactly the two ends.
      //
      // The far end fades past the copy at the start
      // (`.help-pointer-origin`, which is drawn at 45% of the ink) rather
      // than stopping level with it. What used to make that a seam was a gap
      // in the trail just short of the press it was supposed to be arriving
      // from, which left the smear and its origin reading as two marks
      // rather than one gesture. There is no gap to expose now: the easing
      // crowds its last copies onto the origin, the final one landing within
      // a pixel of it.
      `opacity: ${(0.45 - t * 0.27).toFixed(2)}`,
      // And the ink recedes with it: each ghost is drawn in a stroke mixed
      // further toward the background than the last, so the trail loses
      // contrast as well as substance going back. Transparency alone thins
      // a thing evenly against whatever is behind it; a colour giving way to
      // the page is what distance actually looks like. Toward the
      // background rather than to a fixed grey, so it recedes in either
      // theme — lighter on the light one, darker on the dark.
      `--ghost-ink: ${(100 - t * 92).toFixed(0)}%`,
      // Blur by speed, which is the slope of the curve the spacing follows —
      // sharp at the ends where the pointer was barely moving, longest
      // through the middle where it was quickest.
      `filter: url(#${blurFilterId(trailBlur(t))})`,
    ].join("; ");
    // The whole pointer, mouse included: it is the thing that moved, and a
    // trail of bare arrows behind a cursor that has a mouse beside it read
    // as two different objects.
    return `<span class="help-pointer help-pointer-ghost" style="${style}">${arrowSvg()}${mouseSvg(button)}</span>`;
  }).join("");

  // The press, at the far end: a whole pointer rather than another ghost,
  // barely blurred, so the gesture has a visible place where it began.
  const origin = `<span class="help-pointer help-pointer-origin"
        style="transform: translate(${back.dx.toFixed(1)}px, ${back.dy.toFixed(1)}px)">
      ${arrowSvg()}${mouseSvg(button)}
    </span>`;
  return smear + origin;
}

function pointer(
  figure: HTMLElement,
  target: Element | null | undefined,
  button: "left" | "right",
  /** Where the pointer has come from, for a step that shows a movement
   * rather than a click. Only the direction is read. */
  trailFrom?: { dx: number; dy: number },
): void {
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
    ${trailFrom ? motionTrail(trailFrom, button) : ""}
    ${arrowSvg()}
    ${mouseSvg(button)}`;
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
function dragLine(figure: HTMLElement, root: HTMLElement, fromIndex: number, toIndex: number): void {
  const cells = root.querySelectorAll<HTMLElement>(".kanji-cell");
  const from = cells[fromIndex]?.querySelector<HTMLElement>(".kanji-glyph");
  const to = cells[toIndex]?.querySelector<HTMLElement>(".kanji-glyph");
  if (!from || !to) return;
  // The figure, always: `.help-drag-line` is `inset: 0` against the nearest
  // positioned ancestor, which is the figure and not the sample the cells
  // were measured in. Measuring from one box and drawing into another put
  // the line a sample's width off to the side.
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
const glyphOf = (root: HTMLElement, i: number) => root.querySelectorAll(".kanji-cell")[i]?.querySelector(".kanji-glyph");
const rubyOf = (root: HTMLElement, i: number) => root.querySelectorAll(".kanji-cell")[i]?.querySelector("rt");
/** The samples in a figure, for the one step that draws two. */
const samplesOf = (figure: HTMLElement) => figure.querySelectorAll<HTMLElement>(".help-sample");

/** **What is actually being laid side by side.** Six of the eight figures
 * put two things next to each other, and it is worth saying which is which,
 * because they look alike on the page and mean quite different things:
 *
 *   - **sequence** — `head` (mid-drag, then what the drag leaves) and `undo`
 *     (the edit, the keystroke, the edit undone). These two, and only these
 *     two, have a before and an after.
 *   - **contrast** — `select`, which is one character under two different
 *     buttons. Nothing happens first: a reader does one or the other, so
 *     there is no order here beyond the one the step's own prose names them
 *     in.
 *   - **correspondence** — `highlight`, the kanbun beside its
 *     kakikudashibun. The step's whole point is that the two are marked *at
 *     the same moment* ("a character is never marked alone"), so there is no
 *     before and after to order. Nor is the figure echoing an arrangement on
 *     screen that it could get wrong: the app stacks these two panels
 *     vertically (`.main`'s rows in app.css), one above the other.
 *   - **spatial fact** — `pos`, `relation` and `reading`, where the menu sits
 *     to the left of the pointer because that is where a real menu opens
 *     (`help-figure-menu` in app.css, and `menuTopLeftFor` in
 *     tokenInspector.ts). About place, not about order.
 *
 * Two more orderings run *within* a figure rather than across it, and neither
 * is anybody's to choose. `navigate` moves a selection from 信 to 而 inside
 * one sample, so its before and after are two cells of one column and its
 * axis is the text's own, running up the page. And the drag's motion trail in
 * `head` runs from where the pointer was to where it is, which `afterLayout`
 * measures from the two glyphs it connects — both of them in the same
 * column, so `back.dx` is identically zero and the smear is purely vertical.
 * Both simply report a geometry. */
function steps(): Step[] {
  return [
    {
      key: "select",
      // The two gestures side by side, because the step is about the
      // difference between them: the same character picked out on the left,
      // and asked about on the right. Shown together they say what each
      // button is for; shown one at a time they would only say that
      // something happens.
      //
      // A *contrast*, not a sequence: neither gesture follows the other, so
      // the pair is simply in the order the step's own prose names them. See
      // the note above `steps` for the whole classification, and for the two
      // figures that do have a before and an after.
      figure: () => {
        const figure = figureWith(sampleText({ selected: 3 }), sampleText());
        figure.classList.add("help-figure-pair");
        return figure;
      },
      afterLayout: (figure) => {
        const [picked, analysed] = samplesOf(figure);
        pointer(figure, glyphOf(picked, 3), "left");
        // 信, whose head is 敬 — an arrow spanning the whole column.
        showArrow(analysed, 3);
        pointer(figure, glyphOf(analysed, 3), "right");
      },
    },
    {
      key: "highlight",
      // Both panels at once, which is the point: the character on one side
      // and what it became on the other.
      //
      // 事, and not the 信 the step before it picked out, because this is the
      // one step whose prose promises the word will not always be the obvious
      // one — and 事 is the only character of the four the reading order
      // actually moves, from second character to first word. A figure of 信,
      // which is fourth either way, would have illustrated the opposite.
      figure: () => figureWith(sampleText({ selected: 1 }), kakikudashiSample(0)),
    },
    {
      key: "navigate",
      // Keyboard only, so no pointer. The selection has just moved up from
      // 信 to 而 — the key held down, the character it came from still
      // half-marked — because a step about moving a selection has to show it
      // in two places to show it moving at all.
      figure: () => figureWith(sampleText({ selected: 2, previous: 3 }), arrowKeys("↑")),
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
        // The right button, because that is now the only button this opens
        // on. A figure showing the left one held would have been teaching the
        // one gesture the label ignores.
        pointer(figure, figure.querySelector(".token-subtitle"), "right");
      },
    },
    {
      key: "relation",
      // 事 -> 敬, an adjacent pair: the short arc a レ点 goes with.
      // Marked by relation and not by label: what a row marks is a *segment*,
      // so the figure says `comp:obj` where it used to say 目的語.
      figure: () => figureWith(sampleText(), deprelMenu("comp:obj")),
      afterLayout: (figure) => {
        showArrow(figure, 1);
        shapeMenus(figure);
        // Right, as on the part-of-speech step above and for the same reason.
        pointer(figure, figure.querySelector(".token-arrow-label"), "right");
      },
    },
    {
      key: "reading",
      // No arrow: the step is about the furigana and not about what the
      // character attaches to, so the figure shows the reading alone.
      //
      // 敬, the root, because this is the one character of the four the
      // resolver has much to offer for, and a menu is a poor illustration of
      // a choice when there is only one thing in it: 信 has a single reading.
      // (This is the one step that picks out a different character from the
      // ones around it; the steps are read one at a time and each is about
      // its own gesture, so what each figure needs is a character that shows
      // that gesture well.) These three are what `candidateReadings` returns
      // for 敬 under VERB, in the order it returns them — the on'yomi first,
      // then the kun'yomi, with the one in use marked.
      figure: () =>
        figureWith(sampleText({ selected: 0 }), menu([{ heading: "音読み", items: ["けい", "きやう"] }, { heading: "訓読み", items: ["うやまフ"] }], "うやまフ")),
      afterLayout: (figure) => {
        shapeMenus(figure);
        // The right button, which is now the only one these open on — the
        // plain click that used to work while the analysis was up does not
        // any more, and the step no longer offers it.
        pointer(figure, rubyOf(figure, 0), "right");
      },
    },
    {
      key: "head",
      // The drag on the left, what it leaves behind on the right: 信 hanging
      // off 事 instead of 敬, under the relation the parser gives it. A step
      // about changing an attachment that never showed the changed
      // attachment was asking the reader to picture the outcome.
      //
      // One of the two figures that is a genuine sequence rather than a pair
      // of alternatives (see the note above `steps`), and the samples are
      // appended in the order the two states happen — which is also the order
      // `afterLayout` below destructures them in.
      figure: () => {
        const figure = figureWith(
          sampleText({ dropTarget: 1 }),
          // The analysis the drag would leave, marks and all.
          sampleText({ tokens: REATTACHED }),
        );
        figure.classList.add("help-figure-pair");
        return figure;
      },
      afterLayout: (figure) => {
        const [during, after] = samplesOf(figure);
        showArrow(after, 3, REATTACHED[3]);
        showArrow(during, 3);
        dragLine(figure, during, 3, 1);
        // Mid-drag: the pointer is over the character being aimed at, with
        // the button still held — and trailing a smear back along the way it
        // came, since this is the one step that is a movement rather than a
        // click, and a still cursor sitting on a character says nothing
        // about having been dragged there.
        const from = glyphOf(during, 3)?.getBoundingClientRect();
        const to = glyphOf(during, 1)?.getBoundingClientRect();
        pointer(
          figure,
          glyphOf(during, 1),
          "left",
          from && to ? { dx: from.left - to.left, dy: from.top - to.top } : undefined,
        );
      },
    },
    {
      key: "undo",
      // The step before this one is the edit being undone, so the figure is
      // that edit's two states with the keystroke between them: 信 hanging
      // off 事 above, back on 敬 below, kaeriten and all. A figure of the
      // keys alone said which keys, and nothing about what they do.
      //
      // The other genuine sequence (see the note above `steps`), and the only
      // figure whose middle is the gesture rather than a thing being pointed
      // at: the keystroke stands between the state it is pressed in and the
      // state it leaves.
      figure: () => {
        const figure = document.createElement("div");
        figure.className = "help-figure help-figure-undo";
        // The keystroke between the two states it moves between, and set
        // down the page rather than across it — one cap wide instead of two,
        // which is what makes room for a sample on either side of it.
        figure.append(
          sampleText({ tokens: REATTACHED }),
          keys([undoModifier(), "Z"], undefined, true),
          sampleText(),
        );
        return figure;
      },
      afterLayout: (figure) => {
        const [before, after] = samplesOf(figure);
        showArrow(before, 3, REATTACHED[3]);
        showArrow(after, 3);
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

/** The motion blur the smear is drawn with.
 *
 * CSS `blur()` is a *round* Gaussian: it spreads a shape as far sideways as
 * along, which is why a stack of blurred arrows came out as a wide grey band
 * rather than a streak. An SVG filter takes the two axes separately, so this
 * blurs down the drag and not at all across it — the trail stays as narrow
 * as the arrow while running together along its length, which is what a
 * photograph of something moving does.
 *
 * The region has to be given explicitly: a filter's default box reaches only
 * 10% past the element, and a blur this long would be cut off inside it.
 *
 * Defined once per dialog and referenced by `url(#…)`; the drag it serves
 * runs down a column, so a single vertical filter covers it. A step whose
 * drag ran across the columns would want its own. */
function motionBlurFilters(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "help-filters");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `<defs>${trailBlurLevels()
    .map(
      (px) => `<filter id="${blurFilterId(px)}" x="-50%" y="-200%" width="200%" height="500%">
      <feGaussianBlur stdDeviation="0 ${px}" />
    </filter>`,
    )
    .join("")}</defs>`;
  return svg;
}

function build(): Built {
  const el = document.createElement("dialog");
  el.className = "help-modal";
  el.setAttribute("aria-labelledby", "help-title");

  // A click on the backdrop closes it, the way Escape does — the guide is
  // something to glance at and dismiss, and clicking off it is how that is
  // usually said.
  //
  // The backdrop is not an element of its own, so there is nothing to listen
  // on: a click there arrives at the <dialog> itself. But so does a click in
  // the dialog's own padding, which is plainly *on* the guide — testing the
  // target alone would dismiss it when someone clicked its margin. Hence the
  // geometry: outside the box is the backdrop, and nothing else is.
  //
  // `detail` guards the keyboard, which reports a click at (0, 0) — that
  // corner is outside the dialog, so activating the close button with Enter
  // would otherwise arrive here as a stray backdrop click.
  el.addEventListener("click", (event) => {
    if (event.detail === 0) return;
    // A dialog on its way out — a language switch has built its replacement
    // and taken this one out of the document — measures 0x0, so every click
    // would read as outside it. It is already going; nothing here applies.
    if (!el.open || !el.isConnected) return;
    const box = el.getBoundingClientRect();
    const inside =
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) el.close();
  });

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

  // The guide carries its own language switch, because the one in the
  // sidebar cannot be reached from here: this is a modal dialog, and the
  // browser makes everything outside it inert for as long as it is open —
  // that is the whole point of `showModal`, and not something to work
  // around. Switching from inside rebuilds the guide in the other language
  // (see `onLangChange` in `openHelpModal`) and takes the rest of the app
  // with it, so closing afterwards leaves everything in the language chosen
  // here.
  const lang = document.createElement("button");
  lang.type = "button";
  lang.className = "help-lang";
  lang.dataset.i18n = "sidebar.languageToggle";
  lang.addEventListener("click", () => setUiLang(getUiLang() === "en" ? "ja" : "en"));

  const actions = document.createElement("div");
  actions.className = "help-header-actions";
  actions.append(lang, close);
  header.append(title, actions);

  const intro = document.createElement("p");
  intro.className = "help-intro";
  intro.dataset.i18nHtml = "help.intro";

  const list = document.createElement("ol");
  list.className = "help-steps";
  const pending: [Step, HTMLElement][] = [];
  const figures: HTMLElement[] = [];
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
    // Figure first: it is what the step shows, and the text is its caption.
    item.append(figure, text);
    list.append(item);
    figures.push(figure);
    if (step.afterLayout) pending.push([step, figure]);
  }

  el.append(motionBlurFilters(), header, intro, list);
  document.body.append(el);
  applyTranslations(el);
  // A closed <dialog> is `display: none`, so every rect inside it measures
  // zero — the figures that measure themselves have to wait until it is
  // actually open (the drag line came out as "M 0 0 L 0 0" otherwise).
  return {
    el,
    finish: () => {
      pending.forEach(([step, figure]) => step.afterLayout!(figure));
      // After those, never before: the hooks are what draw the arrows and
      // place the labels, and it is those that a figure has to be centred
      // around.
      // Before the centring, which measures the geometry these can change.
      figures.forEach(keepFootGap);
      figures.forEach(clearArrowGutter);
      levelFigureRows(figures);
      figures.forEach(centreFigureContents);
    },
  };
}

/** Centres what a figure actually draws inside the figure's own box —
 * across it, not down it.
 *
 * Flex centres the boxes, which is not the same thing: a relation label hangs
 * out past the left edge of the column it belongs to, an arrow bows out
 * beside it, and a part-of-speech label sits under a character wider than the
 * character is — none of that counts towards the box being centred, and all
 * of it is visible.
 *
 * Only the horizontal, though. Down the figure, what matters is that the
 * text sits at the same height in every step — a reader going down the
 * column of steps should see one sample where the last one was, not each
 * nudged by however far its own labels happen to reach. Vertical centring
 * moved the two steps whose subtitle hangs below the last character up by
 * 7px and broke that line. The figures are padded instead, deeply enough
 * that the lowest label still has room (see `.help-figure`).
 *
 * Moving rather than re-padding: the figure's width is the grid column's, so
 * padding cannot be traded from one side to the other without also changing
 * where the box ends. Both children take the same displacement, so the
 * contents travel together and everything an arrow was measured against
 * moves with it. */
/** Gives a sample back the trailing inter-kanji gap `.help-sample` takes off
 * (see app.css), where something is actually standing in it.
 *
 * The gap after the last character is dead space in a box sized to its own
 * contents — except on the figures whose analysis puts a part-of-speech chip
 * below that character, where it is exactly the room the chip needs. Since 信
 * ends the sample and its head 敬 stands above it, its arrow runs down and its
 * chip goes below; without the gap it finished 8.1px outside the figure's own
 * border, measured. (The measurement was taken on the sample this replaced,
 * whose last character likewise ended the column under a head standing above
 * it — the same geometry, so the same gap.)
 *
 * Asked of the laid-out figure rather than of the call that drew the arrow.
 * Which character an overlay hangs off, and which side its chip took, are
 * known at the drawing site — but not every figure's overlay comes from
 * `showArrow`, and one that didn't was missed when this was decided there.
 * The finished geometry is the one place the answer is true for all of them:
 * a chip reaching past the foot of the last cell is a chip in the gap,
 * whoever put it there. */
function keepFootGap(figure: HTMLElement): void {
  for (const sample of samplesOf(figure)) {
    const cells = sample.querySelectorAll<HTMLElement>(".kanji-cell");
    const last = cells[cells.length - 1];
    if (!last) continue;
    const foot = last.getBoundingClientRect().bottom;
    for (const chip of sample.querySelectorAll<HTMLElement>(".token-subtitle")) {
      if (chip.getBoundingClientRect().bottom > foot) {
        sample.classList.add("help-sample-chip-foot");
        break;
      }
    }
  }
}

/** How far the analysis reaches past the left edge of the sample it is drawn
 * on — the arrow's bow and the relation label riding on it, which
 * `showInspector` puts in the gutter beside the column. Zero on a figure
 * showing no analysis.
 *
 * Asked of the laid-out figure rather than of the step that drew the arrow,
 * for the same reason `keepFootGap` is: whether a label reaches into the
 * gutter is a fact about the finished geometry, and a figure whose overlay
 * came from somewhere other than `showArrow` would be missed by a list kept
 * at the drawing sites. */
function gutterOverhang(sample: HTMLElement): number {
  const edge = sample.getBoundingClientRect().left;
  let left = edge;
  for (const el of sample.querySelectorAll<HTMLElement>("*")) {
    const r = el.getBoundingClientRect();
    // Skip what isn't drawn — an empty <rt>, a marker definition.
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
  }
  return edge - left;
}

/** Opens the gap between a menu and the sample it was opened from, where the
 * analysis is standing in it.
 *
 * Only on the figures whose menu is drawn to the left of the text
 * (`help-figure-menu`, above): the gutter the relation label hangs into is
 * the same strip the menu now occupies, and at the tight gap those figures
 * otherwise use — 0.4rem, the menu belonging right beside the character it
 * was opened from — the label would be painted over the menu's first column.
 * The label reaches 31px past the sample's own left edge, which is the
 * measurement `.help-figure-pair` already answers with 2rem.
 *
 * On screen the menu genuinely does cover what it is opened from; a figure
 * 320px wide cannot show that and stay legible, which is the same reason the
 * menu is placed in the flow here rather than at the coordinates
 * `menuTopLeftFor` would give it. */
function clearArrowGutter(figure: HTMLElement): void {
  if (!figure.classList.contains("help-figure-menu")) return;
  for (const sample of samplesOf(figure)) {
    if (gutterOverhang(sample) > 0.5) {
      figure.classList.add("help-figure-menu-gutter");
      return;
    }
  }
}

/** Levels the figures standing side by side in one row of the grid.
 *
 * The eight come out at two heights, and it is the sample that decides which:
 * a figure whose analysis puts a part-of-speech chip below the *last*
 * character keeps the gap under it for the chip to stand in (`keepFootGap`
 * and `.help-sample` in app.css) and so is one inter-character gap taller
 * than one with nothing to house — 392.4px against 348.4 at the shipped
 * scale. Three of the eight are the taller kind, which is an odd number, so
 * however the steps are ordered exactly one row of the two-column grid holds
 * one of each. Today that row is 5 and 6, and step 6's box stopped 44px short
 * of its neighbour's with its caption riding up to match.
 *
 * So the shorter of a pair is held open to the taller. The white that buys is
 * at the foot, below the last character, which is exactly where the taller
 * figure of the pair has its chip — the two boxes then hold their text at the
 * same height and end at the same line. What keeps that from moving the text
 * is that a sample hangs from the top of its figure rather than being centred
 * in it (`.help-sample:has(> .text-main)`, app.css), so the first character
 * still sits 20.2px below the figure's top edge whatever the box is held to.
 *
 * Rows are read off the laid-out figures rather than counted two at a time,
 * so this says nothing about how many columns the grid has. Every top is
 * taken before any height is written, since writing one moves the rows below
 * it. */
function levelFigureRows(figures: HTMLElement[]): void {
  const rows = new Map<number, HTMLElement[]>();
  for (const figure of figures) {
    const top = Math.round(figure.getBoundingClientRect().top);
    const row = rows.get(top);
    if (row) row.push(figure);
    else rows.set(top, [figure]);
  }
  for (const row of rows.values()) {
    if (row.length < 2) continue;
    const tallest = Math.max(...row.map((figure) => figure.getBoundingClientRect().height));
    for (const figure of row) figure.style.height = `${tallest}px`;
  }
}

function centreFigureContents(figure: HTMLElement): void {
  const box = figure.getBoundingClientRect();
  let left = Infinity;
  let right = -Infinity;
  for (const el of figure.querySelectorAll<HTMLElement>("*")) {
    const r = el.getBoundingClientRect();
    // Skip what isn't drawn — an empty <rt>, a marker definition.
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  if (!Number.isFinite(left)) return;
  const dx = (box.right - right - (left - box.left)) / 2;
  if (Math.abs(dx) < 0.5) return;
  for (const child of figure.children) {
    (child as HTMLElement).style.transform = `translateX(${dx}px)`;
  }
}

export function openHelpModal(): void {
  // Rebuilt each time rather than kept around: the figures' own labels come
  // from the tables in `tokenInspector.ts`, and the step text is
  // translated, so a stale dialog would be a stale one in the wrong
  // language after a switch.
  dialog?.remove();
  show(build());

  stopLangWatch?.();
  stopLangWatch = onLangChange(() => {
    if (!dialog?.open) return;
    // The outgoing one is taken down only once its replacement is up, so
    // the guide never blinks out between languages.
    const outgoing = dialog;
    show(build());
    outgoing.remove();
  });
}

/** Opens a built dialog and makes it the current one.
 *
 * The teardown is bound per dialog but guarded on identity, and that guard
 * is load-bearing: a language switch leaves an outgoing dialog behind, and
 * closing *it* used to run this handler against whatever `dialog` pointed at
 * by then — which was the replacement. Clicking the guide's own language
 * button therefore switched the language and dismissed the guide in the same
 * gesture. A handler may only take down the dialog it belongs to. */
function show(built: Built): void {
  dialog = built.el;
  built.el.showModal();
  built.finish();
  built.el.addEventListener("close", () => {
    if (dialog !== built.el) return;
    stopLangWatch?.();
    stopLangWatch = null;
    dialog.remove();
    dialog = null;
  });
}
