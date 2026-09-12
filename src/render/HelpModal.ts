import { applyTranslations, getUiLang, onLangChange, setUiLang } from "../i18n/i18n.ts";
import { cellFor } from "./KundokuView.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../kundoku/kundokuTenAssigner.ts";
import { buildKundokuGlyphMap } from "./kundokuGlyphs.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import {
  appendMenuGroup,
  deprelMenuGroups,
  type DeprelMenuRow,
  deprelRowElement,
  type Entry,
  type Extent,
  menuAnchorFor,
  POS_MENU_HEADING,
  posMenuPrefixes,
  type RetagKind,
  showInspector,
  sizeMenuSquarish,
} from "./tokenInspector.ts";
import { syntacticPrefix } from "../parse/xpos.ts";
import type { Token } from "../parse/types.ts";

/** The step-by-step guide to editing a parse.
 *
 * Its figures are **live DOM**, not screenshots: each one is built from the
 * very classes the app renders with — `.kanji-cell` via `KundokuView`'s own
 * `cellFor`, `.token-context-menu` and `.token-subtitle` from
 * `kunten.css` — so they take the reader's light/dark theme from the same
 * custom properties the interface does, set themselves in the same fonts at
 * the same weights, and label themselves from the same
 * `posMenuPrefixes`/`POS_MENU_HEADING` pair and the same
 * `deprelMenuGroups`/`deprelRowElement` pair the real menus are built from. A screenshot would need one capture per theme,
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
 *     shows 基本成分 and marks the current relation in it (see `deprelMenu`);
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
 * taken from the app's own pipeline rather than composed here.
 *
 * **The xpos are the treebank's**, copied from `public/data/samples/
 * rongo-gakuji.conllu` (tokens 11-14 of 子曰：「道千乘之國，敬事而信…), which
 * is this app's own shipped parse of the very sentence these four are cut
 * from. They used to be empty, which was harmless while the chip named a UPOS
 * and is not now: the chips read the treebank's category (`posChipParts`), so
 * an empty xpos would have made the tutorial's chip take the fallback path
 * — one chip reading 動詞 where the app shows 動詞 over 行為・態度 — and
 * taught a figure the reader will not find. Copied rather than invented for the same reason the
 * readings are: a figure that makes up its own annotation is a figure that
 * can be wrong about the app. */
export const SAMPLE: { base: string; reading?: string; okurigana?: string; token: Token }[] = [
  { base: "敬", reading: "うやま", okurigana: "ひ", token: { id: 0, text: "敬", lemma: "敬", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "ROOT", head: 0 } },
  { base: "事", reading: "こと", okurigana: "を", token: { id: 1, text: "事", lemma: "事", pos: "NOUN", xpos: "n,名詞,可搬,成果物", dep: "comp:obj", head: 0 } },
  { base: "而", okurigana: "て", token: { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 } },
  { base: "信", reading: "しん", okurigana: "す", token: { id: 3, text: "信", lemma: "信", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 0 } },
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

/** **Which way a menu joins the mark it was opened from** — hanging below it,
 * or standing beside it — as a word a figure can be laid out from.
 *
 * Asked of `menuAnchorFor`, which is the function the panel itself anchors by,
 * rather than restated here as a list of kinds. That function answers in
 * coordinates: it names the point the menu's *top right* corner is hung from
 * (`menuTopLeftFor`), and which corner of the mark that point is decides the
 * arrangement outright. The mark's bottom right is a subjoin — the menu's top
 * edge against the mark's bottom edge, right edges flush, the table hanging
 * straight down from the thing it is about. The mark's top left is a
 * left-join — the menu's right edge against the mark's left edge, tops level,
 * the table growing away to the left.
 *
 * So the unit box below is not a stand-in for a real mark; it is the smallest
 * box whose four corners are distinguishable, and all this reads off it is
 * *which corner came back*. A figure that hard-coded "the relation menu is the
 * one that goes beside" would be a second copy of the reader's rule, free to
 * go on saying it after the panel had stopped — which is exactly the drift
 * this whole file is built to be incapable of.
 *
 * **Asked with the standoff taken out**, which is the one thing this has to
 * say for itself now that a join is no longer flush. `menuAnchorFor` stands
 * every menu `MENU_JOIN_GAP` off its mark (the reader: *"I didn't mean
 * subjoin/left join with zero space!"*), and it stands it off *along the axis
 * of the join* — down for a subjoin, leftward for a left-join. So a subjoin's
 * `y` is the mark's bottom plus the gap, and a test for the bare corner would
 * have quietly stopped recognising it and laid the part-of-speech figure out
 * beside its pill instead of under it. Passing 0 asks the function the
 * question this wants asked — *which corner* — rather than where the box
 * finally lands, and it goes on asking the function rather than restating its
 * answer, which is the whole point of the paragraph above. The gap itself is
 * not a figure's business: a figure draws the join with its own rules in
 * app.css. */
function joinsBelow(kind: RetagKind): boolean {
  const mark: Extent = { left: 0, top: 0, right: 1, bottom: 1 };
  return menuAnchorFor(kind, mark, 0).y === mark.bottom;
}

/** The join a figure's menu is to be laid out by, written on the menu itself
 * so that `figureWith` can read it off what it was handed. One of "below" or
 * "left"; see `joinsBelow` for where the answer comes from, and
 * `.help-figure-menu` / `.help-figure-menu-below` in app.css for what each
 * one does to the box. */
function withJoin(el: HTMLElement, below: boolean): HTMLElement {
  el.dataset.helpJoin = below ? "below" : "left";
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
 * For the two menus whose entries are one box apiece: the 品詞 menu, where a
 * whole four-field xpos is one pick however many pieces its label has, and the
 * readings menu, whose entries are kana. The relation menu is the composite
 * one — its row is several relations — and has `deprelMenu` below. */
function menu(groups: { heading: string; items: string[] }[], current?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "token-context-menu help-menu";
  for (const { heading, items } of groups) {
    const entries = items.map((label) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "token-menu-item";
      item.textContent = label;
      item.tabIndex = -1;
      if (label === current) item.dataset.current = "true";
      return item;
    });
    appendMenuGroup(el, heading, entries);
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
 * **Which rows — the whole of the first category with more than one relation
 * in it, `基本成分`.** ROOT was one of that category's six rows and is now a
 * singleton category of its own, first in the table and unreachable by
 * `deprelRowsShown`'s own rule for exactly that reason (see its doc) — so the
 * figure now shows the five that are left: 主語, 目的語, 述語補語, 助動詞補語
 * and 補語〖形式〗, in the menu's own order. It showed four of the original six
 * for a while, and then two and a 三点リーダー standing for the other four,
 * which was an abbreviation drawn to hold the figure's *width* down — and the
 * reader has since asked for the opposite: *"show the full-size menus, but
 * hide the overflow"*. So the cut is gone and the clamp in app.css is what
 * answers for the size now, and the later removal of ROOT is a change to
 * *which* whole category this is, not a second cut.
 *
 * What the fit costs is two pixels, and they are worth naming because this
 * figure is the one the clamp actually clips across the page. Five rows wrap
 * into five columns — one to a column now, where six used to leave one pair
 * (文の主辞 and 目的語) sharing a column: the cap is floored at the tallest
 * atom, and the two tallest are still both 160 (the heading bound to 主語,
 * 100 + 60, and 補語〖形式〗, 60 + 20 + 60 + 20 — neither one was ROOT's row),
 * but losing 文の主辞's own 100 pulls the squared-off cap down from 180 to
 * 177, three short of the 180 that 目的語 (80) and 述語補語 (100) would need to
 * stand in one column together. Five atoms, five columns, and the width is the
 * same formula it always was — `5·30 + 4·10 + 12 = 202` across the run,
 * unmoved by which atoms happen to share a column, since that arithmetic only
 * ever counts columns. With the 2rem gutter the arrow's label needs
 * (`.help-figure-menu-gutter`) and the 88px column beside it, the figure's
 * boxes come to **322** in a 320px box: one pixel falls off each edge, and
 * `overflow: hidden` is what makes that a clip rather than a spill into the
 * neighbouring step. On the left that pixel is the menu's own 匡郭; on the
 * right it is empty box, the ruby leaving a 四分 less a furigana of slack
 * inside the sample's own edge. Both are pinned in tests/helpFigureFit.test.ts.
 *
 * The category is still only the first of several — the menu on screen goes on
 * past it — which is the one thing this figure abbreviates and always has.
 * Nothing in the figure claims otherwise: what it shows is a whole category,
 * complete with the heading that names it.
 *
 * Split out from the drawing so that the rows can be counted without a
 * browser: how long a row is, in cells, is what decides how many columns
 * `sizeMenuSquarish` wraps this menu into, and so how wide the figure holding
 * it comes out — see tests/helpFigureFit.test.ts, which is the test that
 * would have caught the part-of-speech figure outgrowing its box.
 *
 * **No longer literally `deprelMenuGroups()[0]`.** That was true until ROOT
 * was pulled out into a singleton category of its own at the front of the
 * table (`DEPREL_GROUPS` in tokenInspector.ts, whose own doc argues the
 * filing) — index 0 is `述語`/ROOT alone now, one row with no subtype to sit
 * beside, which is precisely the thing this figure exists to demonstrate. A
 * figure that dutifully kept reading index 0 would have quietly started
 * showing a single unsubtyped row instead of the worked example it always
 * has, which is the outcome the reader was warned against rather than one
 * chosen here: this function instead takes the first category with more than
 * one relation in it, which is `基本成分` both before and after the promotion
 * (five of its six original rows are still there; only ROOT left), so the
 * figure's own content is unchanged by a menu reorganisation that had nothing
 * to do with it. The rule is general rather than a hard-coded second index,
 * so a future group emptied down to one relation of its own falls through the
 * same way ROOT's did, and only a category with something to demonstrate is
 * ever reached for. */
export function deprelRowsShown(): { heading: string; rows: DeprelMenuRow[] } {
  const groups = deprelMenuGroups();
  const [heading, rows] = groups.find(([, groupRows]) => groupRows.length > 1) ?? groups[0];
  return { heading, rows };
}

function deprelMenu(current: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "token-context-menu help-menu";
  const { heading, rows } = deprelRowsShown();
  appendMenuGroup(el, heading, rows.map((row) => deprelRowElement(row, current)));
  // Left-joined, which is what this figure has always drawn — see `joinsBelow`
  // and `.help-figure-menu`.
  return withJoin(el, joinsBelow("dep"));
}

/** The readings menu as the figure shows it, and the one menu of the three
 * that is *dropped at the pointer* rather than joined to a mark.
 *
 * `setupTokenContextMenu` opens it at the event's own coordinates
 * (`openReadingMenuFor`), because the thing asked from is a run of kana in a
 * lane and not a pill with edges worth flushing against. So there is no side to
 * derive and no standoff to keep: `menuTopLeftFor` hangs the box from its top
 * right corner at the point clicked, and `dropMenuAtPointer` puts it there —
 * across the characters, which is where it lands on the page. The figure used
 * to stand it to the left of the text in the flow instead, deriving the side
 * and not the coordinates; see `dropMenuAtPointer` for why that changed. If the
 * readings menu is ever given a mark to join, that function is what has to
 * learn about it.
 *
 * The three readings are what `candidateReadings` returns for 敬 under VERB,
 * in the order it returns them — the on'yomi first, then the kun'yomi, with
 * the one in use marked. */
export const READING_MENU_GROUPS: { heading: string; items: string[] }[] = [
  { heading: "音読み", items: ["けい", "きやう"] },
  { heading: "訓読み", items: ["うやまフ"] },
];

/** The one of them the character is actually read with, marked in the figure
 * the way the open menu marks it. */
export const READING_MENU_CURRENT = "うやまフ";

function readingMenu(): HTMLElement {
  // No join written on it: `withJoin` is for the two menus `figureWith` has to
  // lay out beside or below a mark, and this one is placed at a point instead.
  return menu(READING_MENU_GROUPS, READING_MENU_CURRENT);
}

/** The 品詞 menu as the figure shows it: the real thing, from the real
 * builder.
 *
 * `deprelMenu` above and this are the same idea and were written for the same
 * reason — a hand-built figure showed 斜格補語 where the menu showed
 * 斜格補語〖場所〗, and this one showed a list of UPOS where the menu had
 * stopped offering UPOS at all. Both read their entries from the call
 * `openRetagMenu` makes, so a figure cannot go on illustrating a menu the app
 * has stopped having.
 *
 * **All eleven of them**, which is what this note argued for in the first
 * place — "a truthful figure rather than a truncated one; a reader who counts
 * them has counted the menu" — and then stopped arguing for a round, when the
 * figure was cut to three entries and a 三点リーダー to hold its height down.
 * The reader has settled that the other way: *"clamp them all to the same
 * size, and hide the overflow. (I.e. show the full-size menus, but hide the
 * overflow.)"* So the entries are the menu's, all of them, and what the figure
 * shows of them is the clamp's business rather than this function's.
 *
 * **What the clamp does to this one figure, since it is the only one it cuts
 * down the page.** A category menu is subjoined to its pill, so this figure is
 * stacked — the menu hangs below the sample rather than standing beside it
 * (`.help-figure-menu-below`) — and eleven entries squared into five columns
 * come to a 211px cap and 226.6 of table, under 336.3 of characters and chip:
 * **583px** against the 356.5 of ink the other seven reach. The clamp is
 * **425.3**, which leaves this figure **60px** of the menu's run.
 *
 * Sixty is one entry deep, and what it shows is more than that sounds, because
 * the columns of a wrapped menu all begin at the top of the run
 * (`.token-menu-group` is `flex-wrap: wrap` with no `justify-content`, and its
 * main axis is the vertical one) — so a horizontal cut crosses all five at the
 * same depth. The packing is `[品詞+名詞 120, 代名詞 80]`, `[動詞 60, 助動詞 80,
 * 数詞 60]`, `[副詞 60, 前置詞 80, 助詞 60]`, `[感嘆詞 80, 記号 60]` and
 * `[接尾辞 80]`, so at 60 the reader is shown the 品詞 heading (bound inside the
 * first column by `appendMenuGroup`, and 60 itself), **動詞 whole and marked**,
 * 副詞 whole, and 感嘆詞 and 接尾辞 with their last character cut through the
 * middle.
 *
 * **動詞 is why the clamp is 425.3 and not 376.7.** The step's prose says the
 * current entry is marked, and 動詞 is what this figure marks — 信's own 品詞 in
 * the treebank's parse (see `SAMPLE`). The clamp is the larger of *the deepest
 * ink in the dialog that is not a menu* and *the run that shows that entry
 * whole*, and it is the second that binds here: term (a) alone gives 376.7,
 * which showed the table's 匡郭 and 11.4px of the heading's cartouche and left
 * that sentence pointing at nothing. Both terms are derived at `.help-figure` in
 * app.css and both are asserted in tests/helpFigureFit.test.ts, the second so
 * that an inventory which moved 動詞 down the list fails there rather than
 * quietly taking the mark off the page.
 *
 * (The reader gave the first term freely — *"I don't care if the menu in step 4
 * has words cut off in the middle"* — and two entries here are cut exactly that
 * way. What they did not grant, because nobody would, is a menu with no word on
 * it at all.)
 *
 * **What the clamp was:** 511 for a round, the deepest cut into this menu that
 * left no word of it shown in part — every atom is a whole number of 20px cells
 * and every entry carries 二分 at each end, so a cut at `二分 + n cells` of the
 * run falls on a glyph boundary in every column at once, and 130 was the
 * deepest such cut that also began no entry it could not finish. That
 * constraint is the one the reader struck out.
 *
 * **Eleven, and it used to be ten.** This note said ten, on the ground that
 * 記号 is filtered from a resolving token's menu because picking it would
 * write a full stop and stop the cell resolving. It is not filtered any more,
 * and `offeredValues`'s own note records why: with an `accept` predicate the
 * menu falls back from `s,記号,句点,*` to `s,記号,一般,*`, an ordinary
 * resolving tag, so 記号 became reachable and the eleventh entry came back.
 * Nothing here had to change for that — the entries come from
 * `posMenuPrefixes`, which is the call `openRetagMenu` makes — but the *count*
 * was written down here and went stale, and the count is load-bearing: it is
 * an entry's worth of inline extent, and the wrap turns on the total. It is
 * pinned in tests/helpFigureFit.test.ts now, along with the width the wrap
 * comes to.
 *
 * The order is the menu's own, so 名詞 and 動詞 lead as they do in the corpus,
 * and the marked entry is 動詞 — 信's actual 品詞 in the treebank's parse of
 * this sentence (see `SAMPLE`), not a plausible one chosen here.
 *
 * There is no figure for the *domain* or *sense* menus, which are the other
 * two chips'. The step this illustrates is "change the part of speech", and
 * one figure per step is this dialog's own rule; the other two menus are one
 * right-click away from chips the same figure already shows. */
const posWord = (prefix: string) => prefix.split(",")[1] ?? prefix;

/** The whole 品詞 menu, as words rather than as whole xpos strings — 名詞,
 * 動詞, 記号… — in the menu's own order.
 *
 * Exported for the same reason `deprelRowsShown` above is: eleven entries of
 * two and three characters are eleven inline extents, and what the wrap makes
 * of them is what decides how tall the figure holding them comes out — and so
 * where the clamp in app.css falls among them. tests/helpFigureFit.test.ts
 * counts them, wraps them, and works out what the clamp leaves showing. */
export function posMenuWords(token: Token): string[] {
  return posMenuPrefixes(token).map(posWord);
}

function posMenu(token: Token): HTMLElement {
  const own = syntacticPrefix(token.xpos);
  // Subjoined, where the relation menu beside it is left-joined — asked of
  // `joinsBelow`, and the reason the part-of-speech figure is the one figure
  // in this dialog laid out down the page rather than across it. See
  // `.help-figure-menu-below` in app.css for what that costs and buys.
  return withJoin(
    menu([{ heading: POS_MENU_HEADING, items: posMenuWords(token) }], own === undefined ? undefined : posWord(own)),
    joinsBelow("pos"),
  );
}

/** Lays a figure out as the sample text with something shown beside it.
 *
 * A figure showing a *menu* is laid out from where that menu joins the mark it
 * was opened from, and there are two answers now rather than one:
 *
 *   - **left-joined** (`help-figure-menu`, app.css) — the relation menu, which
 *     hangs from its top right corner at its label's top left (`menuTopLeftFor`
 *     in tokenInspector.ts), so the table grows down and away to the *left* of
 *     the point it was opened from; the figure reverses its row so the menu
 *     stands left of the text. A figure that drew it to the right of the
 *     pointer was showing the reader the arrangement the app had before that.
 *     The readings menu is no longer one of these: it is dropped at the
 *     pointer's own coordinates and is drawn there (`dropMenuAtPointer`), so it
 *     is not laid out beside anything and never reaches this function.
 *   - **subjoined** (`help-figure-menu-below`) — the category menus, the
 *     part-of-speech one among them. Their anchor is the pill's *bottom* right
 *     (`menuAnchorFor`), so the table hangs straight down from the pill with
 *     their right edges flush, and a figure standing it beside the text is
 *     teaching a placement the app does not have.
 *
 * Which of the two is read off the menu the figure was handed rather than set
 * by each step (`joinsBelow`, `withJoin`), so a step added later cannot forget
 * it and cannot get it wrong: the answer comes from the same function the
 * panel anchors by. */
function figureWith(sample: HTMLElement, ...extras: HTMLElement[]): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "help-figure";
  figure.append(sample);
  if (extras.length > 0) {
    const aside = document.createElement("div");
    aside.className = "help-figure-aside";
    aside.append(...extras);
    figure.append(aside);
    const menuEl = extras.find((el) => el.classList.contains("token-context-menu"));
    if (menuEl) {
      figure.classList.add(menuEl.dataset.helpJoin === "below" ? "help-figure-menu-below" : "help-figure-menu");
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

/** Where in its target a pointer's tip is put — the target's lower right rather
 * than its dead centre, so the arrow sits mostly clear of the thing it
 * indicates (see `pointer`).
 *
 * Named because two things now depend on it agreeing with itself: the pointer,
 * and the readings menu, which is *dropped at the pointer* on the page and is
 * drawn at that same point here (`dropMenuAtPointer`). A menu that appeared a
 * few pixels off the cursor drawn beside it would be a figure disagreeing with
 * itself about where the click was. */
const POINTER_TIP = 0.72;

/** **The class the category chips' foldout is revealed by**, which the
 * part-of-speech figure wears so that its row is drawn unfolded.
 *
 * Written out rather than imported: `SEMANTICS_SHOWN` is module-private to
 * tokenInspector.ts, and the tutorial is not a reason to widen that file's
 * surface. The two are pinned against each other in
 * tests/helpFigureFit.test.ts, which reads the constant out of that module's
 * source — a copied string is only safe where something checks it. */
export const SEMANTICS_SHOWN = "token-semantics-shown";

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
  el.style.left = `${t.left + t.width * POINTER_TIP - box.left}px`;
  el.style.top = `${t.top + t.height * POINTER_TIP - box.top}px`;
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

/** **Drops a menu where the pointer opened it**, which for the readings menu is
 * the whole of its placement rule.
 *
 * `setupTokenContextMenu` opens that one at the event's own coordinates
 * (`openReadingMenuFor` → `placeMenu` → `menuTopLeftFor`): the box hangs from
 * its **top right corner** at the point clicked, reaching leftward by its own
 * width and downward by its height. There is no standoff — `MENU_JOIN_GAP` is
 * for the two menus that join a *mark*, and a run of kana in a lane is not one.
 *
 * So the figure does the same thing, at the same point the pointer beside it is
 * drawn from (`POINTER_TIP`), and the menu covers the characters it covers. It
 * used to stand in the flow to the left of the text instead, on the argument
 * that a 320px figure could honestly derive the side and not the coordinates —
 * and the reader has answered that: *"the readings menu should appear where it
 * normally would, even though this would obscure the text"*. A menu drawn where
 * one never opens teaches the wrong place to look.
 *
 * Absolute against the figure, which is the positioned ancestor
 * (`.help-figure`), so the whole thing still travels with the centring pass:
 * `centreFigureInk` transforms the figure's children, and a transform on an
 * ancestor carries its absolutely positioned descendants with it. */
function dropMenuAtPointer(figure: HTMLElement, target: Element | null | undefined): void {
  const menuEl = figure.querySelector<HTMLElement>(".token-context-menu");
  if (!menuEl || !target) return;
  const box = figure.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const menu = menuEl.getBoundingClientRect();
  menuEl.style.left = `${t.left + t.width * POINTER_TIP - box.left - menu.width}px`;
  menuEl.style.top = `${t.top + t.height * POINTER_TIP - box.top}px`;
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
      // 信's own group and 信's own tag marked, since 信 is the character the
      // arrow and the pointer are on (`showArrow(figure, 3)` below).
      //
      // **The one figure that draws the chip row unfolded.** In the app the row
      // is the 品詞 pill alone until the pointer rests on it, when the two
      // semantic pills slide out from behind it; every figure here shows the
      // resting state, because a figure that changes under the pointer is not a
      // figure, and this one shows the unfolded state as a drawing rather than
      // as a hover left switched on. The class is what says so — the figures
      // never set `token-semantics-shown`, which is the *interaction's* class
      // and carries its transitions and its stagger with it. See
      // `.help-figure-unfolded` in app.css, and this step's own prose, which
      // now says where the other two pills come from.
      figure: () => {
        const figure = figureWith(sampleText(), posMenu(SAMPLE[3].token));
        figure.classList.add("help-figure-unfolded");
        return figure;
      },
      afterLayout: (figure) => {
        showArrow(figure, 3);
        // **The revealed state, put on by hand rather than reached by hovering.**
        // `SEMANTICS_SHOWN` is the class the whole reveal is written against —
        // the two pills' opacity and slide, and the 品詞 pill's own silhouette,
        // which is a straight edge trimmed back by half a chevron until this
        // class lands and a pointed polygon after it
        // (`.token-semantics-shown .token-subtitle-row > .token-subtitle` in
        // kunten.css). Setting the two declarations by hand in app.css instead,
        // which is what this figure did for a round, left the first pill blunt
        // against the second one's notch: the reader reported it as a chevron
        // that had not rendered.
        //
        // It is a *state* and not a gesture. What made the reveal an
        // interaction is the row's own `mouseover` and the transitions it
        // starts, and a figure has neither: `.help-figure` takes the pointer
        // away from every mark and stills every transition and animation, so
        // this class can only be worn, never arrived at.
        figure.querySelector(".token-inspector-overlay")?.classList.add(SEMANTICS_SHOWN);
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
      // that gesture well.) `readingMenu` above has the three candidates and
      // the reason this menu is the one still drawn beside the text.
      //
      // **The one figure whose menu is drawn at its own coordinates.** The
      // readings menu is dropped at the pointer rather than joined to a mark,
      // so there is a point to draw it at and the figure uses it — see
      // `dropMenuAtPointer`. The menu is appended to the figure rather than set
      // beside the sample in an aside, since it is not in the flow at all.
      figure: () => {
        const figure = figureWith(sampleText({ selected: 0 }));
        figure.classList.add("help-figure-dropped");
        figure.append(readingMenu());
        return figure;
      },
      afterLayout: (figure) => {
        shapeMenus(figure);
        // The menu first, then the pointer: both are placed from the same ruby
        // and the same fraction into it, and the pointer is drawn last so it
        // lands on top of the menu it opened.
        dropMenuAtPointer(figure, rubyOf(figure, 0));
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
      // After `keepFootGap`, which decides whether the chip stands at the foot
      // of the sample at all and is what this pass is guarded on — and which
      // changes the sample's height, so the menu below it has not finished
      // moving until that has run.
      figures.forEach(joinMenuToPill);
      // There is no levelling pass any more. There used to be one — the eight
      // figures came out at two heights, a chip at the foot of a sample making
      // one of them 44px taller, and an odd number of the taller kind left one
      // row of the grid holding one of each — and `.help-figure` now gives them
      // all one declared height, so a pass that measured a row and held its
      // shorter figure open to its taller had nothing left to find. What it was
      // protecting, two boxes in a row ending on different lines, is now a
      // property of the stylesheet rather than of a measurement.
      figures.forEach(centreFigureInk);
    },
  };
}

/** Centres what a figure actually draws inside the figure's own box, across it
 * and down it.
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
  // Ink and not boxes, for the reasons `inkRects` gives at length — and here
  // the difference decides a class rather than a few pixels: a sample's own
  // cells are a column pitch wide and its glyphs are not, so measuring boxes
  // answered "does anything reach past the sample's left edge" with the
  // sample's own left edge and could never say no.
  const left = Math.min(edge, ...inkRects(sample).map((rect) => rect.left));
  return edge - left;
}

/** Opens the gap between a menu and the sample it was opened from, where the
 * analysis is standing in it.
 *
 * Only on the figures whose menu is drawn to the left of the text
 * (`help-figure-menu`, above), which is the relation step alone now that the
 * readings menu is dropped at its own coordinates: the gutter the relation
 * label hangs into is the same strip the menu occupies, and at the tight gap
 * those figures otherwise use — 0.4rem — the label would be painted over the
 * menu's first column. The label reaches 14.46 past the sample's own left
 * edge, and `.help-figure-menu-gutter` answers it with 1.5rem.
 *
 * That gutter is close to the truth rather than a compromise with it: on the
 * page this menu is left-joined to the label itself, `MENU_JOIN_GAP` clear of
 * its left edge, which puts its right edge 20.46px left of the sample where
 * the figure puts it at 24. See `.help-figure-menu-gutter` in app.css. */
function clearArrowGutter(figure: HTMLElement): void {
  if (!figure.classList.contains("help-figure-menu")) return;
  for (const sample of samplesOf(figure)) {
    if (gutterOverhang(sample) > 0.5) {
      figure.classList.add("help-figure-menu-gutter");
      return;
    }
  }
}

/** Flushes a subjoined menu's right edge with the right edge of the pill it
 * hangs from, which is the second half of what "subjoined" means.
 *
 * `.help-figure-menu-below` (app.css) does the first half in the stylesheet:
 * the menu goes below the sample rather than beside it, and `align-items:
 * flex-end` puts its right edge level with the sample's. That is not the same
 * line. The pill is centred on its glyph and pulled back half its own width
 * (`translateX(-50%)` on `.token-subtitle-row`), so its right edge stands
 * `half a column − half a pill` *inside* the sample's — 18.1px on this figure,
 * whose pill reads 動詞 and comes to 51.8 (two characters at a fifth of the
 * 88px cell, 四分 of a rem of padding in front and that plus half a chevron
 * behind — `CHIP_SIZE_OF_CELL` here and `.token-subtitle` in kunten.css), and
 * less than that for a longer tag. Left alone, the figure would show a menu
 * flush with the text rather than with the mark, which is a different claim
 * about where a menu goes.
 *
 * So the residue is measured off the laid-out figure and spent as a margin,
 * for the reason `keepFootGap` and `clearArrowGutter` above are measured
 * rather than declared: the pill's width is a fact about the word written in
 * it, and there is nothing for a selector to test. It is also the one figure
 * in the arithmetic at `.help-figure > *` that is not a constant, which is why
 * the fit is argued there against its *bound* — the margin cannot exceed half
 * a column, since a pill has a width of at least zero — rather than against
 * whatever this measures.
 *
 * Clamped at zero. A pill wider than its own column would ask for a negative
 * margin, which would push the menu out to the right past the text; the figure
 * then simply keeps the stylesheet's flush-with-the-sample and is a few pixels
 * out, which is the better of the two failures. Nothing in the treebank's
 * eleven 品詞 is anywhere near that wide.
 *
 * Only where the chip is at the foot, which `keepFootGap` has already decided
 * and recorded on the sample. That is the arrangement this pass is written
 * against — the pill below the last character, the menu below the pill — and
 * on a figure whose chip stood *above* its character the same measurement
 * would be answering about a mark at the wrong end of the column. */
function joinMenuToPill(figure: HTMLElement): void {
  if (!figure.classList.contains("help-figure-menu-below")) return;
  const menuEl = figure.querySelector<HTMLElement>(".token-context-menu");
  const [sample] = samplesOf(figure);
  if (!menuEl || !sample || !sample.classList.contains("help-sample-chip-foot")) return;
  const pill = sample.querySelector<HTMLElement>(".token-subtitle");
  if (!pill) return;
  const sampleBox = sample.getBoundingClientRect();
  const pillBox = pill.getBoundingClientRect();
  const inset = sampleBox.right - pillBox.right;
  if (inset > 0.5) menuEl.style.marginRight = `${inset}px`;
  // **And the same again down the figure**, which the note in app.css left
  // undone as "a 15.7px residue not worth a second measured pass". It is worth
  // it now: the pass is this one, and the pixels are the only ones the clamp
  // has to give this figure's menu.
  //
  // What the residue is: the sample's box keeps a whole inter-character gap
  // under its last character so the chip has room to stand in (`keepFootGap`,
  // and `.help-sample` in app.css), the chip reaches 28.3 of that 44, and the
  // 15.7 left over is empty box between the chip's foot and the sample's.
  // Left alone, the menu is subjoined to *that* edge rather than to the mark,
  // which is a menu hanging 15.7px below the pill it came out of — and, under
  // the clamp, 15.7px of menu that is cut off the bottom instead.
  const drop = sampleBox.bottom - pillBox.bottom;
  if (drop > 0.5) menuEl.style.marginTop = `${-drop}px`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Whether an element is invisible *here* — itself or anywhere up to the
 * figure it is in.
 *
 * `visibility` and `display` are answered by the computed style alone, the
 * first being inherited and the second showing up as a zero box. `opacity` is
 * neither: it does not inherit, and an element at full opacity inside a parent
 * at 0 has an ordinary box and is painted by nobody. So this walks.
 *
 * It has to. The category chips' foldout rests at `opacity: 0` and is laid out
 * all the same (`.token-subtitle-semantics` is `position: absolute; left: 100%;
 * width: max-content` in kunten.css) — a real box of two pills standing to the
 * right of the 品詞 pill, tucked behind it by `--semantics-slide` and painted
 * by nothing at all. That box is what broke the centring these figures are
 * measured by: see `inkRects` below.
 *
 * **Safe to ask only because the figures are stills.** A computed `opacity` is
 * the *animated* value while an animation is running, and the overlay fades
 * itself in over 160ms as it is drawn — so on a figure that animated, a
 * measurement taken in the frame the dialog opens could find the whole overlay
 * at nearly zero and discard every mark in it. Nothing in a figure animates
 * (`.help-figure *` in app.css), which is what makes an opacity here a
 * statement about the drawing rather than about the moment. */
function hiddenIn(root: HTMLElement, el: Element): boolean {
  for (let node: Element | null = el; node !== null && node !== root.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return true;
    if (Number(style.opacity) === 0) return true;
  }
  return false;
}

/** Whether an element paints a box of its own, as against merely holding
 * things: a background, a border, an outline, a shadow. A pill, a menu, a
 * keycap and a selected cell do; a sample, a column and a cell do not. */
function paintsBox(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;
  if (bg !== "" && bg !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return true;
  if (style.backgroundImage !== "none" && style.backgroundImage !== "") return true;
  if (style.boxShadow !== "none" && style.boxShadow !== "") return true;
  if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) return true;
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const width = parseFloat(style[`border${side}Width` as "borderTopWidth"]);
    if (width > 0 && style[`border${side}Style` as "borderTopStyle"] !== "none") return true;
  }
  return false;
}

/** **What a figure actually paints**, as rectangles — which is not the same
 * question as what boxes it lays out, and the difference is what put the undo
 * step off its centre far enough to lose a label off the left-hand edge.
 *
 * This measured `getBoundingClientRect()` over every descendant, and a box is
 * a poor stand-in for ink in three ways that all pushed the same direction
 * here:
 *
 *   - **boxes that paint nothing and are wider than what they hold.** A cell
 *     is a whole column pitch, 88px, of which the glyph is the middle 44 and
 *     the ruby 14.7 of the lane beside it, so a sample's box runs 6-7px past
 *     its own ink at each edge. The drag line's `<svg>` is worse: it is
 *     `inset: 0` on the figure, so measuring its box said the ink filled the
 *     figure and the centring of the head step was a no-op.
 *   - **boxes that are laid out and never painted.** The foldout behind the
 *     品詞 pill is ~96px of pill standing to the right of the column at
 *     `opacity: 0` (see `hiddenIn`), and every figure that draws an analysis
 *     had it. On the undo step, whose two samples sit as far apart as the
 *     figure allows, that phantom carried the measured right edge past the
 *     border and the centring dragged the whole picture left to make room for
 *     it — taking the left-hand sample's relation label out through the frame.
 *     Before the clamp that merely looked off-centre; with `overflow: hidden`
 *     the label is cut.
 *   - **ink that is not in any box.** A glyph's own painted extent is the line
 *     box the text sets, and `Range.getClientRects()` is what reports it. The
 *     precedent is `inkOf` in tokenInspector.ts, written when the relation
 *     label was dodging a ruby *lane* rather than the kana in it; this is the
 *     same correction one level up.
 *
 * So: text is measured as text, an element counts its own box only where it
 * paints one, an `<svg>` is skipped in favour of the shapes inside it (its own
 * box is a viewport, not a drawing), and anything invisible counts for
 * nothing. */
function inkRects(figure: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const keep = (rect: DOMRect) => {
    if (rect.width > 0 || rect.height > 0) rects.push(rect);
  };

  for (const el of figure.querySelectorAll<Element>("*")) {
    if (hiddenIn(figure, el)) continue;
    // An `<svg>` element's box is the viewport it gives its contents — the
    // whole figure, for the drag line — where the shapes inside it report
    // their own geometry. Skip the container, keep the drawing.
    if (el.namespaceURI === SVG_NS) {
      if (el.tagName !== "svg" && el.tagName !== "defs" && el.tagName !== "filter") keep(el.getBoundingClientRect());
      continue;
    }
    if (paintsBox(getComputedStyle(el))) keep(el.getBoundingClientRect());
  }

  // The text, as set. A text node's range gives the line boxes its glyphs
  // occupy, so a kana in a lane measures the kana and not the lane.
  const walker = document.createTreeWalker(figure, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? "").trim() === "") continue;
    const parent = node.parentElement;
    if (!parent || hiddenIn(figure, parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) keep(rect);
  }
  return rects;
}

function centreFigureInk(figure: HTMLElement): void {
  const box = figure.getBoundingClientRect();
  const style = getComputedStyle(figure);
  const edge = (side: "Left" | "Right" | "Top" | "Bottom") => ({
    border: parseFloat(style[`border${side}Width` as "borderTopWidth"]) || 0,
    padding: parseFloat(style[`padding${side}` as "paddingTop"]) || 0,
  });
  // **The padding box, which is the box the clip is taken at.** `overflow:
  // hidden` on `.help-figure` cuts at the inside of the border, so that — and
  // not the border box — is the frame ink has to land inside of. The two
  // differ by a pixel a side and the pixel matters: the figures that fill
  // their column have single digits of clearance left, and it is that
  // clearance the clamp now decides the fate of.
  const inner = {
    left: box.left + edge("Left").border,
    right: box.right - edge("Right").border,
    top: box.top + edge("Top").border,
    bottom: box.bottom - edge("Bottom").border,
  };
  const rects = inkRects(figure);
  if (rects.length === 0) return;
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  const dx = (inner.right - right - (left - inner.left)) / 2;
  // **Down the page the rule has two arms, because one figure does not fit.**
  //
  //   - **A figure whose ink fits is centred**, exactly as it is across the
  //     page. This is what the reader asked for — *"every diagram should be
  //     individually vertically centred, rather than forced to a consistent
  //     vertical position"* — and it replaces a rule that hung every sample
  //     from the top of its figure so that a reader going down the column of
  //     steps found each one at the same height. That invariant was worth
  //     having while the figures were all the same shape; it stopped being
  //     worth having when they stopped being, and what it costs is a figure
  //     with its white all at the bottom.
  //   - **A figure whose ink does not fit is hung from the top.** Centring an
  //     overflow cuts both ends, and on the one figure that overflows — the
  //     part-of-speech step, whose menu is subjoined under a whole sample — the
  //     top end is the sample: characters, readings, kaeriten, the chip. That
  //     is the ink `.help-figure`'s own first term exists to protect, and the
  //     bottom end is menu, which its second term says may be cut. So the
  //     figure gives up the same thing the clamp does.
  //
  // The arm is chosen by measurement rather than by which step it is: a figure
  // that grew past the clamp would take the second arm on its own, and the
  // clamp's own derivation (`.help-figure` in app.css) is asserted against
  // both.
  const fits = bottom - top <= inner.bottom - inner.top;
  const dy = fits
    ? (inner.bottom - bottom - (top - inner.top)) / 2
    : inner.top + edge("Top").padding - top;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  for (const child of figure.children) {
    (child as HTMLElement).style.transform = `translate(${dx}px, ${dy}px)`;
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
