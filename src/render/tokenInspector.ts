import type { Sentence, Token } from "../parse/types.ts";
import { redo, undo, withUndo } from "./editHistory.ts";
import { candidateReadings, type KanjidicIndex, type ReadingCandidate } from "../reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { isRereadUse, rereadCharacter } from "../kakikudashi/rereadCharacters.ts";
import { chosenReading, clearChosenReading, setChosenReading } from "../reading/chosenReading.ts";
import { toKatakana } from "./kana.ts";
import { bestDeprelForArc } from "../parse/pyodideClient.ts";

/** UPOS (Universal POS) tags this parser actually emits (see the plan's own
 * reference to the shipped lzh_sud_kyoto wheel), translated to the standard
 * Japanese terms for these categories — not a kanbun-specific gloss, since
 * UPOS itself is a general cross-linguistic tagset, not a kanbun grammar
 * concept. Unlisted tags (there shouldn't be any, in practice) fall back to
 * the raw tag itself — see `uposJa`. */
const UPOS_JA: Record<string, string> = {
  NOUN: "名詞",
  PROPN: "固有名詞",
  PRON: "代名詞",
  VERB: "動詞",
  AUX: "助動詞",
  ADJ: "形容詞",
  ADV: "副詞",
  ADP: "接置詞",
  CCONJ: "等位接続詞",
  SCONJ: "従属接続詞",
  PART: "助詞",
  PUNCT: "句読点",
  DET: "限定詞",
  NUM: "数詞",
  INTJ: "感動詞",
  SYM: "記号",
  X: "その他",
};

/** SUD (Surface-Syntactic Universal Dependencies) relations — the 34-label
 * inventory documented in this project's own plan (`depClassification.ts`'s
 * `INVERT_DEPS`/postpose sets are the *kundoku-behavior* side of this same
 * label set; this is just the label itself, translated for display) —
 * given Japanese syntactic terminology. A relation's own subtype (the part
 * after `@`, e.g. `comp:obl@lmod`) is listed individually where its
 * specific sense is worth calling out; otherwise `deprelJa` falls back to
 * the base relation (before `@`). */
const DEPREL_JA: Record<string, string> = {
  ROOT: "文の主辞",
  subj: "主語",
  "comp:obj": "目的語",
  "comp:obl": "斜格補語",
  "comp:obl@lmod": "場所の斜格補語",
  "comp:pred": "述語補語",
  "comp:aux": "助動詞補語",
  "comp@expl": "形式補語",
  mod: "修飾語",
  "mod@tmod": "時間修飾語",
  "mod@lmod": "場所修飾語",
  compound: "複合語構成要素",
  "compound@redup": "畳語構成要素",
  flat: "並列構成要素",
  "flat@vv": "動詞連続構成要素",
  "flat@foreign": "外来語構成要素",
  clf: "類別詞",
  cc: "等位接続語",
  "conj:coord": "並列語",
  "conj:coord@emb": "埋め込み並列語",
  punct: "句読点",
  det: "限定詞",
  discourse: "談話標識",
  "discourse@sp": "文末助詞",
  vocative: "呼格語",
  dislocated: "転位語",
  parataxis: "並置語",
  list: "列挙語",
  dep: "未分類の依存語",
  udep: "未分類の依存語",
  "udep@lmod": "未分類の場所修飾語",
  "udep@tmod": "未分類の時間修飾語",
  unk: "不明な依存語",
  "unk@expl": "不明な形式語",
};

/** The retag menus' own section structure — the same inventories as
 * `UPOS_JA`/`DEPREL_JA`, grouped under the headings a printed grammar
 * table would use, so a 17- or 34-entry list reads as a few short scannable
 * runs instead of one undifferentiated column. Grouping (not gojūon order)
 * is deliberate: the value you want is nearly always findable by its
 * *kind*, and neighbouring relations that differ only by subtype
 * (mod/mod@tmod/mod@lmod) belong side by side.
 *
 * Every value in the corresponding table appears in exactly one group here
 * — `assertMenuGroupsCoverInventory` below checks that at module load, so
 * adding a tag to an inventory without filing it can't silently drop it
 * out of the menu. */
const UPOS_GROUPS: [heading: string, tags: string[]][] = [
  ["体言", ["NOUN", "PROPN", "PRON", "NUM"]],
  ["用言", ["VERB", "AUX", "ADJ", "ADV"]],
  ["機能語", ["ADP", "CCONJ", "SCONJ", "PART", "DET"]],
  ["その他", ["INTJ", "PUNCT", "SYM", "X"]],
];

const DEPREL_GROUPS: [heading: string, rels: string[]][] = [
  ["述語・項", ["ROOT", "subj", "comp:obj", "comp:obl", "comp:obl@lmod", "comp:pred", "comp:aux", "comp@expl"]],
  ["修飾", ["mod", "mod@tmod", "mod@lmod", "det", "clf"]],
  ["複合・並列", ["compound", "compound@redup", "flat", "flat@vv", "flat@foreign", "cc", "conj:coord", "conj:coord@emb"]],
  ["談話・その他", ["discourse", "discourse@sp", "punct", "vocative", "dislocated", "parataxis", "list"]],
  ["未分類", ["dep", "udep", "udep@lmod", "udep@tmod", "unk", "unk@expl"]],
];

function assertMenuGroupsCoverInventory(): void {
  for (const [inventory, groups, what] of [
    [UPOS_JA, UPOS_GROUPS, "UPOS"],
    [DEPREL_JA, DEPREL_GROUPS, "deprel"],
  ] as [Record<string, string>, [string, string[]][], string][]) {
    const grouped = groups.flatMap(([, values]) => values);
    const missing = Object.keys(inventory).filter((k) => !grouped.includes(k));
    const unknown = grouped.filter((v) => !(v in inventory));
    if (missing.length || unknown.length) {
      console.warn(`tokenInspector: ${what} menu groups out of sync`, { missing, unknown });
    }
  }
}
assertMenuGroupsCoverInventory();

export function uposJa(pos: string): string {
  return UPOS_JA[pos] ?? pos;
}

export function deprelJa(dep: string): string {
  if (dep in DEPREL_JA) return DEPREL_JA[dep];
  return DEPREL_JA[dep.split("@")[0]] ?? dep;
}

/** The longest Japanese UPOS label (等位接続詞/従属接続詞, 5 characters) —
 * every UPOS/deprel label shown shares one font size, sized so that *even
 * this worst case* fits horizontally within the clicked token's own
 * kanji+ruby+kunten cell width (see `showInspector`), rather than a
 * per-label size that would make short labels bigger than long ones.
 * Computed from `UPOS_JA`'s own values rather than hardcoded, so adding a
 * longer translation later keeps this correct automatically. */
const MAX_UPOS_LABEL_LENGTH = Math.max(...Object.values(UPOS_JA).map((s) => s.length));

/** Which `Sentence` each rendered `.sentence-gap` corresponds to — the DOM
 * itself only carries token *ids* (`data-token-id`, unique within one
 * sentence but not across the whole tree), so resolving a click back to
 * that token's actual pos/dep/head needs this side table. Populated by
 * `KundokuView.ts`'s own render loop (`registerSentence`) each time it
 * builds a sentence's markup; a `WeakMap` so old sentences' entries are
 * dropped automatically once their (replaced) DOM is garbage-collected,
 * rather than accumulating across repeated re-renders of new text. */
const sentenceByGap = new WeakMap<Element, Sentence>();

export function registerSentence(gapEl: Element, sentence: Sentence): void {
  sentenceByGap.set(gapEl, sentence);
}

export interface Entry {
  cell: HTMLElement;
  glyph: HTMLElement;
  token: Token;
}

/** Resolves a `.kanji-cell[data-token-id]` back to its `Token`, via the
 * `.sentence-gap` ancestor `registerSentence` tagged — `null` if the cell
 * isn't one of these (background/whitespace), isn't yet registered, or
 * (per this app's UI, punctuation is excluded from click-to-inspect
 * entirely) is punctuation. */
function resolveEntry(cell: HTMLElement | null): Entry | null {
  if (!cell) return null;
  const glyph = cell.querySelector<HTMLElement>(".kanji-glyph");
  const gapEl = cell.closest(".sentence-gap");
  const sentence = gapEl && sentenceByGap.get(gapEl);
  const token = sentence?.tokens.find((t) => t.id === Number(cell.dataset.tokenId));
  if (!glyph || !sentence || !token || token.pos === "PUNCT") return null;
  return { cell, glyph, token };
}

/** Every clickable, non-punctuation cell inside `container`, in document
 * order — which, for text laid out by the browser's own vertical-rl line
 * wrapping (never reordered relative to source), is exactly reading order:
 * down within one column, then continuing at the top of the next column to
 * the left. Used both to step to the next/previous kanji (`navigate`'s
 * up/down) and, grouped by column, to jump a whole line (`navigate`'s
 * left/right). */
function collectEntries(container: HTMLElement): Entry[] {
  const entries: Entry[] = [];
  for (const cell of container.querySelectorAll<HTMLElement>(".kanji-cell[data-token-id]")) {
    const entry = resolveEntry(cell);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Groups an already-document-order `Entry` list into columns, by clustering
 * consecutive entries whose cell shares the same `left` (a real kanji-cell
 * column is a fixed-width vertical strip, so every member's `left` matches
 * to within rounding) — safe to do by simple adjacency, without any
 * fancier clustering, since the browser's own wrapping already guarantees
 * one column's entries are contiguous in document order before the next
 * column's begin. */
function groupByColumn(entries: Entry[]): Entry[][] {
  const columns: Entry[][] = [];
  let lastLeft: number | null = null;
  for (const entry of entries) {
    const left = Math.round(entry.cell.getBoundingClientRect().left);
    if (lastLeft === null || Math.abs(left - lastLeft) > 4) {
      columns.push([]);
      lastLeft = left;
    }
    columns.at(-1)!.push(entry);
  }
  return columns;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Hobby's velocity function — the "rho" of METAFONT's choose-controls
 * step, which turns a pair of tangent *angles* into the control-point
 * *distance* that makes the resulting cubic as round as possible (the
 * mock-curvature-matching condition Hobby's algorithm solves). `sigma` is
 * just `rho` with its arguments swapped, so the symmetric arcs here need
 * only this one function. */
function hobbyRho(alpha: number, beta: number): number {
  const sqrt5 = Math.sqrt(5);
  const sa = Math.sin(alpha);
  const sb = Math.sin(beta);
  const ca = Math.cos(alpha);
  const cb = Math.cos(beta);
  const numerator = 2 + Math.SQRT2 * (sa - sb / 16) * (sb - sa / 16) * (ca - cb);
  const denominator = 1 + ((sqrt5 - 1) / 2) * ca + ((3 - sqrt5) / 2) * cb;
  return numerator / denominator;
}

/** The cubic Bézier `d` for a Hobby spline from (x1,y1) to (x2,y2) that
 * bows `peak` pixels off the straight chord, toward the unit normal
 * (nx,ny).
 *
 * Hobby's construction takes tangent *directions* as its input and derives
 * the handle lengths from them, so the bow height is set by choosing the
 * departure/arrival angle rather than by placing a control point directly.
 * Both endpoints get the same angle (a symmetric arc), and that angle is
 * solved for by bisection against the closed form for a symmetric cubic's
 * own midpoint offset, `d·rho(phi,phi)·sin(phi)/4` — monotonic in phi, and
 * bounded by `d/2` at phi = 90°, comfortably above any `peak` this caller
 * asks for.
 *
 * `peak` of 0 degenerates to phi = 0, where rho is exactly 1 and the
 * handles land on the chord's own third-points — i.e. a straight line,
 * still expressed as the same kind of spline, which is what the
 * cross-column arcs want. */
/** The arrowhead, as a `<defs>` holding the two markers that draw it: a
 * wider "casing" one behind and the real one in front, mirroring the
 * two-path casing technique the line itself uses, so the head reads as
 * clearly outlined as the line and label do — see `.token-arrow-path` and
 * `.token-arrow-path-casing`.
 *
 * `markerUnits="userSpaceOnUse"` on *both*. The SVG default, `strokeWidth`,
 * scales a marker's own markerWidth/markerHeight by the stroke-width of
 * whichever path references it, which silently re-couples the two markers'
 * relative sizes to those paths' own (deliberately different) stroke-widths
 * every time either changes — concretely, the casing marker ended up
 * rendering at ~9x the real one's size (their intended ~1.5x size ratio,
 * compounded by the paths' own 3x stroke-width ratio), a jagged, oversized
 * blob that swallowed the real arrowhead rather than a clean outlined point
 * (confirmed by rendering the arrow in isolation, scaled up).
 * `userSpaceOnUse` makes markerWidth/markerHeight absolute, in the same
 * coordinate space as the path's own `d`, so the sizes set here stay fixed
 * regardless of either path's stroke-width.
 *
 * The casing marker is the *same* triangle at the *same* reference point as
 * the real one — not a scaled-up copy, which never stays concentric: scaling
 * a triangle about a marker-viewport origin moves its tip away from the path
 * end, so the halo bunches on one side. It is widened instead by stroking
 * that identical shape in the casing colour with a round join, exactly the
 * outline-by-a-wider-underlay trick the line's casing uses, which expands it
 * uniformly in every direction by half the stroke width. `overflow: visible`
 * is required for that expansion to survive: a marker's viewport clips its
 * content to markerWidth/markerHeight by default, which would shave the halo
 * right back off.
 *
 * `orient="auto-start-reverse"` lets the same pair serve either end of a
 * path, which is what the drag line needs: it carries the head at its start
 * rather than its end (see `setupHeadDrag`).
 *
 * `prefix` distinguishes one set of ids from another. The analysis overlay
 * and the drag line each need their own, since ids must be unique and both
 * can be on the screen at once — a character can be dragged while another is
 * inspected. Shared as a function rather than copied into the two places,
 * because everything above is one worked-out technique and a copy of it
 * would be a copy that stops matching. */
function arrowheadDefs(prefix: string): SVGDefsElement {
  const ARROWHEAD = { size: 8, d: "M0,0 L8,4 L0,8 Z", refX: "6", refY: "4" };
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const casing of [true, false]) {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", `${prefix}token-arrowhead${casing ? "-casing" : ""}`);
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("markerWidth", String(ARROWHEAD.size));
    marker.setAttribute("markerHeight", String(ARROWHEAD.size));
    marker.setAttribute("refX", ARROWHEAD.refX);
    marker.setAttribute("refY", ARROWHEAD.refY);
    marker.setAttribute("orient", "auto-start-reverse");
    marker.setAttribute("class", `token-arrowhead${casing ? "-casing" : ""}-marker`);
    if (casing) marker.setAttribute("overflow", "visible");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ARROWHEAD.d);
    marker.append(path);
    defs.append(marker);
  }
  return defs;
}

function hobbySplinePath(x1: number, y1: number, x2: number, y2: number, nx: number, ny: number, peak: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy) || 1;
  const tx = dx / chord;
  const ty = dy / chord;

  let phi = 0;
  if (peak > 0.01) {
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const midPeak = (chord * hobbyRho(mid, mid) * Math.sin(mid)) / 4;
      if (midPeak < peak) lo = mid;
      else hi = mid;
    }
    phi = (lo + hi) / 2;
  }

  const handle = (chord * hobbyRho(phi, phi)) / 3;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // Departure direction at the start turns *toward* the bulge normal;
  // arrival direction at the end turns back off it by the same angle.
  const c1x = x1 + handle * (cos * tx + sin * nx);
  const c1y = y1 + handle * (cos * ty + sin * ny);
  const c2x = x2 - handle * (cos * tx - sin * nx);
  const c2y = y2 - handle * (cos * ty - sin * ny);
  return `M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`;
}

/** The gap left when the analysis moves something out of something else's
 * way — the deprel label off the subtitle or a reading, a reading out from
 * under the subtitle.
 *
 * Clearing by a hair is not clearing: two boxes a pixel apart read as
 * touching, and the point of moving either of them was to be able to tell
 * them apart. A third of the annotation size puts a real space between
 * them, and being derived from that size it stays a real space at any
 * setting of the type scale rather than shrinking to nothing as the text
 * grows. */
function decollisionBuffer(fontSize: number): number {
  return fontSize / 3;
}

/** How long the overlay and the menus take to arrive and to leave. Matches
 * the glyph highlight's own transition (see `.kanji-glyph` in kunten.css),
 * so a right click reads as one event rather than several. */
const FADE_MS = 160;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Removes `node`, but lets it fade first.
 *
 * Arriving is CSS's own business (`token-fade-in`), since the element is in
 * the document by the time the rule applies. Leaving isn't: an element
 * removed from the document has nothing left to animate, so it has to be
 * kept until the fade is over and taken out at the end.
 *
 * A node on its way out is no longer an answer to anything — it stops taking
 * pointer events at once, so the click that dismissed a menu can't land on
 * the menu it dismissed, and whatever replaces it is what the reader
 * actually reaches. */
function fadeOutAndRemove(node: HTMLElement | null | undefined): void {
  if (!node) return;
  if (prefersReducedMotion() || typeof node.animate !== "function") {
    node.remove();
    return;
  }
  if (node.dataset.leaving === "true") return;
  node.dataset.leaving = "true";
  node.style.pointerEvents = "none";
  const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out" });
  // `cancel` as well as `finish`: an animation interrupted (the tab hidden,
  // the node reparented) must still take the node with it rather than
  // stranding it, mid-fade, on the screen.
  fade.addEventListener("finish", () => node.remove());
  fade.addEventListener("cancel", () => node.remove());
}

/** Takes down the analysis. `fade` where it is being dismissed — the reader
 * is done with it and watching it go says so — but not where it is being
 * replaced by the next one a moment later, which would leave two overlays
 * drawing two arrows over each other for the length of the fade. */
function clearInspector(column: HTMLElement, fade = false): void {
  for (const overlay of column.querySelectorAll<HTMLElement>(".token-inspector-overlay")) {
    // A replacement clears out whatever is already on its way out, too.
    if (fade) fadeOutAndRemove(overlay);
    else overlay.remove();
  }
  for (const el of column.querySelectorAll(".token-cell-selected")) el.classList.remove("token-cell-selected");
  for (const el of column.querySelectorAll(".token-cell-inspected")) el.classList.remove("token-cell-inspected");
  for (const el of column.querySelectorAll(".token-cell-head")) el.classList.remove("token-cell-head");
}

/** Renders the click-to-inspect overlay for `entry`: a subtitle (its UPOS,
 * translated) anchored just past its glyph — above it if the arrow to its
 * head points *upward* (head below it in the column), below otherwise,
 * so the subtitle never sits on the same side the arrow is approaching
 * from — and, unless `entry.token` is its own sentence's ROOT (no real head
 * to point to), an arrow from its head's glyph to its own, labeled with its
 * deprel. Arrow *endpoints* are measured off each `.kanji-glyph`
 * specifically — never the wider `.kanji-cell`, which also includes the
 * ruby annotation's own footprint and would throw the endpoints off the
 * kanji's true center — but the *font size* instead uses the full cell
 * width (kanji+ruby+kunten), per `MAX_UPOS_LABEL_LENGTH`'s own doc. Every
 * position is pixel coordinates relative to `column` (the same technique
 * `positionCompoundLines` uses); everything lives inside one
 * `.token-inspector-overlay` layer, a normal child of `column` (not
 * viewport-fixed), so it scrolls with the text for free inside the panel's
 * own `overflow-x: auto`. */
export function showInspector(column: HTMLElement, headEntry: Entry | null, entry: Entry): void {
  clearInspector(column);
  entry.cell.classList.add("token-cell-selected");
  // Which of the two ways the cell is marked — see `.token-cell-inspected`
  // in kunten.css, where the reading answers in red rather than the
  // selection blue, and the kunten stand down.
  entry.cell.classList.add("token-cell-inspected");
  // And the character it attaches to, boxed the way a drop target is: the
  // arrow already points there, but following it back is work, and its far
  // end can be off the screen entirely.
  headEntry?.cell.classList.add("token-cell-head");

  const columnRect = column.getBoundingClientRect();
  const glyphRect = entry.glyph.getBoundingClientRect();
  const cellRect = entry.cell.getBoundingClientRect();
  const fontSize = cellRect.width / MAX_UPOS_LABEL_LENGTH;

  const overlay = document.createElement("div");
  overlay.className = "token-inspector-overlay";

  let arrowPointsUp = false;

  if (headEntry) {
    const headRect = headEntry.glyph.getBoundingClientRect();
    const x1 = headRect.left + headRect.width / 2 - columnRect.left;
    const y1 = headRect.top + headRect.height / 2 - columnRect.top;
    const x2 = glyphRect.left + glyphRect.width / 2 - columnRect.left;
    const y2 = glyphRect.top + glyphRect.height / 2 - columnRect.top;
    arrowPointsUp = y1 > y2; // head sits below the token -> arrow runs upward

    // A quadratic bezier bulging perpendicular to the straight head->token
    // line, but *only* when head and token share a column (matching x) —
    // that's the one case the curve is needed at all, to stay visually
    // distinguishable from the kanji-cell grid lines it'd otherwise run
    // parallel to. An arc crossing from one column into another already
    // reads clearly on its own and is drawn as a plain straight line
    // instead (bulge 0, which also collapses the "true midpoint" formula
    // below to the ordinary segment midpoint).
    const sameColumn = Math.abs(x1 - x2) < 4;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    // Which side of the chord the arc bows to. Left to the normal, it
    // follows the direction the arc runs — left of the column for a head
    // above the token, right of it for a head below — and the right of a
    // column is where the ruby is, so half the arcs laid their apex and
    // their label across the reading. They go left always. The two normals
    // of a chord are one line in opposite directions, so negating both turns
    // the bow over and changes nothing else about it.
    if (sameColumn && nx > 0) {
      nx = -nx;
      ny = -ny;
    }
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    // How far the curve bows off the straight head->token chord: out to the
    // left border of the box drawn round the head, so that the apex and that
    // border are one line. The head is boxed for as long as the arc is on
    // the screen (`.token-cell-head .kanji-glyph`), and the two marks say the
    // same thing — this is the character at the far end — so the bow reaching
    // exactly as far out as the box does ties them together.
    //
    // Measured off that box rather than assumed: an outline is drawn outside
    // the glyph, so its own line sits `outline-offset` plus half
    // `outline-width` beyond the glyph's edge, and reading both from the
    // computed style keeps this true if either changes. The bow stopped at
    // the glyph's edge before, which is inside the box by exactly that much.
    //
    // The head's box, not the token's: it is the head that is boxed, and a
    // cross-column arc has no bow at all.
    //
    // The `len` term keeps a short arc from bowing further than it is long.
    // At this geometry it never binds — the shortest same-column arc spans
    // one advance, 88px, and 0.4 of that is 35.2 against a peak of 25 — but
    // it would again if the advance fell below 63px, and a bow deeper than
    // its own chord is a loop rather than an arc.
    const headBox = getComputedStyle(headEntry.glyph);
    const boxBorder = (parseFloat(headBox.outlineOffset) || 0) + (parseFloat(headBox.outlineWidth) || 0) / 2;
    const peak = sameColumn ? Math.min(headRect.width / 2 + boxBorder, len * 0.4) : 0;
    // A within-line (curved) arc's label is centred in the gutter between
    // this column of text and the next. Cells abut with no margin between
    // columns, so that gutter is exactly the run from one column's glyph
    // edge to the neighbouring column's — and its midpoint is the shared
    // cell boundary, half a cell width out from the glyph's own centre.
    // (Verified against a live two-column render: glyphs at x-centres 636
    // and 539 leave a 561..614 gutter centred on 587.5, which is 636 −
    // 96.8/2.) A cross-line (straight) arc has no "side" in that sense: it
    // runs between the columns rather than beside one, so it sits on the
    // arrow's own midpoint, which is what `peak` being 0 leaves here.
    const gutterOffset = cellRect.width / 2;
    const labelX = sameColumn ? midX + nx * gutterOffset : midX + nx * peak;
    // Down the page, both kinds sit on the arc's own middle. For the bowed
    // one that is the middle of the curve rather than of the chord it is
    // drawn across — `hobbySplinePath` solves its angle so the curve stands
    // exactly `peak` off the chord there, so the point wanted is the chord's
    // midpoint stepped that far along the same normal the bow uses. Where
    // the two columns line up exactly, as they do, `ny` is 0 and this is the
    // chord's midpoint; the term matters only for the few pixels of slack
    // `sameColumn` allows.
    const labelY = midY + ny * peak;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "token-arrow-svg");
    svg.setAttribute("width", String(columnRect.width));
    svg.setAttribute("height", String(columnRect.height));

    svg.append(arrowheadDefs(""));

    const d = hobbySplinePath(x1, y1, x2, y2, nx, ny, peak);
    // A wider white "casing" stroke directly under the real, narrower
    // accent-colored one — the same halo technique `.token-arrow-label`
    // uses (see its own doc) — is what keeps the arrow legible crossing
    // over body text or another arrow, since SVG has no stroke-outline
    // property equivalent to `-webkit-text-stroke`.
    const casingPath = document.createElementNS(SVG_NS, "path");
    casingPath.setAttribute("d", d);
    casingPath.setAttribute("class", "token-arrow-path-casing");
    casingPath.setAttribute("marker-end", "url(#token-arrowhead-casing)");
    svg.append(casingPath);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "token-arrow-path");
    path.setAttribute("marker-end", "url(#token-arrowhead)");
    svg.append(path);
    overlay.append(svg);

    const label = document.createElement("div");
    label.className = "token-arrow-label";
    label.textContent = deprelJa(entry.token.dep);
    label.style.left = `${labelX}px`;
    label.style.top = `${labelY}px`;
    label.style.fontSize = `${fontSize}px`;
    overlay.append(label);
  }

  const subtitle = document.createElement("div");
  subtitle.className = "token-subtitle";
  subtitle.textContent = uposJa(entry.token.pos);
  subtitle.style.left = `${glyphRect.left - columnRect.left + glyphRect.width / 2}px`;
  subtitle.style.fontSize = `${fontSize}px`;
  const placeSubtitle = (above: boolean) => {
    subtitle.classList.toggle("token-subtitle-above", above);
    subtitle.classList.toggle("token-subtitle-below", !above);
    subtitle.style.top = `${(above ? glyphRect.top : glyphRect.bottom) - columnRect.top}px`;
  };
  placeSubtitle(arrowPointsUp);
  overlay.append(subtitle);

  column.append(overlay);

  // Everything below needs real measured geometry, so it runs only now that
  // the overlay is actually in the document.

  // The subtitle goes above the kanji whenever the arrow points up, which
  // near the top of a column means overhanging into `.tategaki`'s own
  // padding — fine, and deliberate: `overflow` clips at the *padding* box,
  // not the content box, so that whole band is paintable (this is why the
  // check below is against the scroller's own rect and not `columnRect`,
  // which is the content box and would flip the subtitle down far more
  // often than anything is actually being cut off). Only a subtitle that
  // would genuinely be clipped gets flipped back.
  const scroller = column.closest<HTMLElement>(".tategaki");
  const clipTop = (scroller ?? column).getBoundingClientRect().top;
  const subtitleBuffer = decollisionBuffer(fontSize);
  /** Whether the label, where it now sits, is cut off by the panel's top. */
  const clipsAbove = () => subtitle.getBoundingClientRect().top < clipTop;
  /** How much kaeriten it now covers, in square pixels — any of them, not
   * only this character's: the marks are small and the label is a wide pill,
   * so it reaches a neighbour's as readily as its own.
   *
   * An area rather than a yes/no, because both sides can be occupied and the
   * choice is then between them rather than away from one. */
  const kaeritenCovered = () => {
    const s = subtitle.getBoundingClientRect();
    let total = 0;
    for (const e of column.querySelectorAll(".kunten-glyph")) {
      const k = e.getBoundingClientRect();
      total +=
        Math.max(0, Math.min(s.right, k.right + subtitleBuffer) - Math.max(s.left, k.left - subtitleBuffer)) *
        Math.max(0, Math.min(s.bottom, k.bottom + subtitleBuffer) - Math.max(s.top, k.top - subtitleBuffer));
    }
    return total;
  };

  /** What is wrong with the side the label is on, as it now stands. Both
   * sides can be wrong, and neither is wrong by construction, so this is
   * asked of a placement already made rather than predicted from one.
   *
   * Below stopped being the free side it was when this rule was written:
   * rule 6 moved the kaeriten out of the character's left lane to directly
   * beneath it, which is exactly where a subtitle placed below lands —
   * measured at 192px² on each of 習, 不 and 說, the whole of the mark under
   * an opaque pill. Above has its own hazard, the panel's top edge, and can
   * land on the kaeriten of the character above it besides (接置詞 over ㆒,
   * 240px², measured on 於 in 青取之於藍). */
  /** What the side the label is on costs it. Clipping is disqualifying
   * rather than expensive: a label cut in half by the panel's edge cannot be
   * read at all, whereas one over a kaeriten still reads and the mark under
   * it can be seen by moving the selection off. */
  const cost = () => (clipsAbove() ? Infinity : kaeritenCovered());
  const misplaced = () => cost() > 0;

  // The side the arrow is not approaching from, unless the other side is
  // cheaper. The upper margin is what makes that a real choice: `overflow`
  // clips at the padding box, so that band is paintable, and a first
  // character's label reaches only 12px into the 40.3px of it.
  //
  // Both sides occupied is a real case — 於 in 青取之於藍 has a kaeriten
  // above it and ㆓㆑ below — so this compares them and takes the lesser
  // rather than giving up and keeping the preferred one.
  let subtitleAbove = arrowPointsUp;
  if (misplaced()) {
    const preferred = cost();
    placeSubtitle(!subtitleAbove);
    if (cost() < preferred) subtitleAbove = !subtitleAbove;
    else placeSubtitle(subtitleAbove);
  }

  // Nothing moves the label off that midpoint, and nothing moves a reading
  // out from under anything. There used to be a great deal of both.
  //
  // The label was bounded to a band about the arc, scored over candidate
  // positions against a union of everything it might cover, re-measured over
  // four passes, and stepped sideways across the columns when none of that
  // worked. All of it went to keep it off the readings in a gutter with no
  // room to spare, and all of it is gone. Overlapping a reading is what the
  // rule costs, not a fault to be worked around: a label half over a reading
  // still says which relation it names, and a label anywhere but the arc's
  // midpoint has stopped naming it.
  //
  // The readings themselves were lifted out from under the part-of-speech
  // chip, and that is gone too, for a reason worth keeping: a reading
  // belongs to its character, and the lift moved it far enough to belong to
  // the next one. Measured on 學而時習之，不亦說乎？有朋自遠方來, it shifted
  // readings by 33 to 64px against a 44px character — 1.45 characters at
  // worst — and four of the five it touched ended up nearer a neighbouring
  // character than their own: 來's きタル 25px from 方 and 63px from 來, 時's
  // ときニ 17px from 而 and 71px from 時. By its own measure it succeeded,
  // the overlap being nought afterwards; what it had done was hand each
  // reading to the wrong character.
  //
  // Nor could a bound have saved it. The least it ever moved anything was
  // 33.37px, and that already put 而's テ nearer 學 — so a bound that kept a
  // reading with its character would have refused every lift it ever makes,
  // which is this same deletion with the machinery left in.
  //
  // The chip still chooses its own side, above or below, by which costs less
  // (see `misplaced` above). That is the overlay moving itself, which is the
  // right way round: the chip is a temporary answer to a right click, and
  // the reading is the text.
}

/** The currently inspected entry, plus which panel it belongs to — kept so
 * arrow-key navigation (`navigate`) knows where to look and what to move
 * from without re-deriving it from a click event. Module-level rather than
 * threaded through `setupTokenInspector`'s closure since there's only ever
 * one kundoku panel using this module in the app. */
let selected: { container: HTMLElement; column: HTMLElement; entry: Entry; overlay: boolean } | null = null;

/** Marks, in the kakikudashi panel, whatever this token became there.
 *
 * Matched by token id within its sentence, which is what the pieces the
 * panel is built from carry (see `generateKakikudashiPieces`). One token
 * can own several runs — a word and its ending, a compound's members —
 * so every match is marked, not just the first. Cleared across the whole
 * document rather than within a container, since the two panels are
 * siblings and the selection lives in the other one.
 *
 * `null` clears without marking anything. */
function highlightKakikudashi(sentenceIndex: number, tokenId: number | null): void {
  for (const el of document.querySelectorAll(".kaki-token-selected")) el.classList.remove("kaki-token-selected");
  if (tokenId === null || sentenceIndex < 0) return;
  const match = `.kaki-token[data-sentence="${sentenceIndex}"][data-token-id="${tokenId}"]`;
  for (const el of document.querySelectorAll(match)) el.classList.add("kaki-token-selected");
}

/** Selects `entry`, optionally showing the analysis with it.
 *
 * The two are separate gestures: a left click picks a character out — the
 * highlight, here and in the kakikudashi — while a right click asks what
 * the parse makes of it, and only that draws the overlay. Reading the text
 * and interrogating it are different activities, and the labels and arrow
 * are a lot to put on the screen for someone doing the first. */
function selectEntry(container: HTMLElement, entry: Entry, showOverlay = false): void {
  const column = entry.cell.closest<HTMLElement>(".tategaki-column");
  if (!column) return;

  // Asking the same thing of the same character again changes nothing, so
  // nothing is redrawn. `showInspector` builds the overlay from scratch every
  // time — it has to, since it measures — and rebuilding it in place tore the
  // labels and the arrow off the screen and faded an identical set back in.
  // That is the flicker on a right click on the furigana: the gesture opens
  // the readings while the analysis is already up, and the analysis it left
  // standing was a new copy of itself.
  //
  // Both halves of the state have to match. A left click after a right click
  // is the same character at a different depth, and must still put the
  // analysis away. `isConnected` is what keeps a re-render from matching: it
  // re-selects through here, and its cells are new nodes, so the comparison
  // fails on identity as it should.
  if (selected && selected.entry.cell === entry.cell && selected.overlay === showOverlay && entry.cell.isConnected) {
    return;
  }
  if (showOverlay) {
    const gapEl = entry.cell.closest(".sentence-gap")!;
    const headEntry =
      entry.token.head !== entry.token.id
        ? resolveEntry(gapEl.querySelector<HTMLElement>(`.kanji-cell[data-token-id="${entry.token.head}"]`))
        : null;
    showInspector(column, headEntry, entry);
  } else {
    // `showInspector` would have marked the cell on its way; without it,
    // this does, after clearing whatever was marked before. Fading, since
    // nothing is replacing it: this is a plain selection, and any analysis
    // that was up is being put away.
    clearInspector(column, true);
    entry.cell.classList.add("token-cell-selected");
  }
  highlightKakikudashi(sentenceIndexOf(entry.cell), entry.token.id);
  selected = { container, column, entry, overlay: showOverlay };
  entry.cell.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function deselect(column: HTMLElement): void {
  clearInspector(column, true);
  highlightKakikudashi(-1, null);
  selected = null;
}

/** Re-renders both panels after this module edits the parse tree in place
 * (`applyTokenEdit`) — supplied by `main.ts`, which owns the current tree
 * and the resolver/index bundle a render needs. Without one set, edits
 * still mutate the tree but nothing redraws. */
let onTreeEdit: (() => void) | null = null;

export function setTokenEditHandler(handler: () => void): void {
  onTreeEdit = handler;
}

/** Which `.sentence-gap` (by position among its siblings) a cell belongs to
 * — token ids are unique only *within* a sentence, so restoring a selection
 * across a re-render needs both this and the id. */
function sentenceIndexOf(cell: HTMLElement): number {
  const gapEl = cell.closest(".sentence-gap");
  const column = gapEl?.parentElement;
  if (!gapEl || !column) return -1;
  return Array.prototype.indexOf.call(column.children, gapEl);
}

/** Mutates the selected token via `mutate`, re-renders through
 * `onTreeEdit`, then re-selects the same token in the freshly built DOM so
 * the inspector overlay stays put across the edit. The tokens reachable
 * from `sentenceByGap` are the very same objects inside `main.ts`'s
 * `TokenTree`, so mutating one here *is* editing that tree — no separate
 * write-back step. */
function applyTokenEdit(mutate: (token: Token) => void): void {
  if (!selected) return;
  const { token } = selected.entry;
  // The single choke point every hand edit passes through — the retag
  // menus, the head drag, and `promoteToRoot`'s multi-token rewrite all
  // arrive here — so one `withUndo` covers the lot, and a multi-token
  // edit is correctly one step rather than several.
  withUndo(() => mutate(token));
  rerenderPreservingSelection();
}

/** The redraw half of `applyTokenEdit`, on its own so an edit that touches
 * more than the selected token — or lands later, from an async relabel —
 * can reuse it instead of going through a token-shaped mutation it doesn't
 * fit. */
function rerenderPreservingSelection(): void {
  // Nothing selected (the user dismissed the inspector while an async
  // relabel was in flight) — still redraw, or the edit would sit in the
  // tree unshown until something else happened to trigger a render.
  if (!selected) {
    onTreeEdit?.();
    return;
  }
  const { container, entry } = selected;
  const wasShowingOverlay = selected.overlay;
  const sentenceIndex = sentenceIndexOf(entry.cell);
  const tokenId = entry.token.id;

  onTreeEdit?.();

  const gap = container.querySelectorAll<HTMLElement>(".sentence-gap")[sentenceIndex];
  const cell = gap?.querySelector<HTMLElement>(`.kanji-cell[data-token-id="${tokenId}"]`);
  const restored = resolveEntry(cell ?? null);
  if (restored) selectEntry(container, restored, wasShowingOverlay);
}

/** The `Sentence` a rendered cell belongs to, or null if the render it came
 * from has since been replaced. */
function sentenceOf(cell: HTMLElement): Sentence | null {
  const gapEl = cell.closest(".sentence-gap");
  return (gapEl && sentenceByGap.get(gapEl)) ?? null;
}

/** Asks the parser what it would call each of `childIds`'s arc to `headId`
 * and adopts the answers, redrawing once at the end.
 *
 * Deliberately after the fact: this round-trips to the Pyodide worker, so
 * the structural edit renders immediately and the labels catch up a moment
 * later. An arc the oracle can't reach comes back null and keeps whatever
 * label it had — see `bestDeprelForArc`. Each result is re-checked against
 * the live tree before being applied, since the user may have moved on. */
function relabelArcsUnder(sentence: Sentence, headId: number, childIds: number[]): void {
  if (childIds.length === 0) return;
  const text = sentence.tokens.map((t) => t.text).join("");
  const heads = sentence.tokens.map((t) => t.head);
  const deps = sentence.tokens.map((t) => t.dep);

  Promise.all(
    childIds.map((childId) =>
      bestDeprelForArc({ text, heads, deps, headIndex: headId, childIndex: childId })
        .then((label) => ({ childId, label }))
        // Parser unavailable (e.g. a CoNLL-U-only session) — keep the
        // existing label for this arc rather than failing the whole batch.
        .catch(() => ({ childId, label: null as string | null })),
    ),
  ).then((results) => {
    let changed = false;
    for (const { childId, label } of results) {
      if (!label) continue;
      const token = sentence.tokens.find((t) => t.id === childId);
      if (!token || token.head !== headId || token.dep === label) continue;
      token.dep = label;
      changed = true;
    }
    if (changed) rerenderPreservingSelection();
  });
}

/** Makes `entry`'s token the ROOT of its sentence.
 *
 * Rooting a token isn't the one-arc relabel the rest of the deprel menu
 * performs. A sentence has exactly one root — `computeReadingOrder` finds
 * it by its `head === id` self-link and throws when there isn't one — so
 * simply writing ROOT onto a second token would leave two, and the old
 * root's own dependents still hanging off a token that is no longer the
 * head of anything.
 *
 * So the old root's dependents come across to the new root, and the old
 * root joins them (its self-link is what the filter below matches it by).
 * Every other arc in the sentence is left alone: this re-hangs the top of
 * the tree, it doesn't reanalyse it.
 *
 * No cycle can result. The new root's own outgoing arc is replaced by its
 * self-link, so the path that used to run from it up to the old root is
 * broken at the top before anything is re-pointed downward at it. */
function promoteToRoot(entry: Entry): void {
  const sentence = sentenceOf(entry.cell);
  if (!sentence) return;
  const newRootId = entry.token.id;
  const oldRoot = sentence.tokens.find((t) => t.head === t.id);

  // Already the root: nothing to move, but the label may still be stale
  // (a token can carry a non-ROOT dep while holding the self-link).
  if (!oldRoot || oldRoot.id === newRootId) {
    applyTokenEdit((token) => {
      token.head = token.id;
      token.dep = "ROOT";
    });
    return;
  }

  const moved = sentence.tokens.filter((t) => t.head === oldRoot.id && t.id !== newRootId).map((t) => t.id);

  applyTokenEdit((token) => {
    for (const t of sentence.tokens) {
      if (moved.includes(t.id)) t.head = newRootId;
    }
    token.head = token.id;
    token.dep = "ROOT";
  });

  // Every moved arc described its relation to the *old* root, so it is
  // now describing the wrong head — including the old root's own, which
  // was "ROOT" and certainly isn't any more.
  relabelArcsUnder(sentence, newRootId, moved);
}

/** True when re-parenting `token` under `newHead` would make a cycle —
 * `newHead` is `token` itself, or sits somewhere in `token`'s own subtree,
 * so following `head` links up from it comes back around. `computeReading
 * Order` recurses over this tree with no cycle guard of its own (a cycle
 * would hang it), and a cycle isn't a meaningful dependency parse anyway,
 * so head-reassignment refuses one outright. */
function wouldCycle(token: Token, newHead: Token, sentence: Sentence): boolean {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  let cursor: Token | undefined = newHead;
  for (let guard = 0; cursor && guard <= sentence.tokens.length; guard++) {
    if (cursor.id === token.id) return true;
    if (cursor.head === cursor.id) return false; // reached ROOT
    cursor = byId.get(cursor.head);
  }
  return true; // ran out of guard — treat an already-malformed tree as unsafe
}

/** Arrow-key navigation from the currently selected kanji: up/down step to
 * the previous/next kanji in reading order (see `collectEntries`);
 * left/right jump a whole column ("line"), landing on whichever entry in
 * the adjacent column sits closest to the current one's own vertical
 * position — vertical-rl reads column-by-column *leftward*, so left is the
 * next line, right the previous one. Punctuation is never a stop (already
 * excluded by `collectEntries`/`resolveEntry`). No-op past either end. */
function navigate(direction: "up" | "down" | "left" | "right"): void {
  if (!selected) return;
  const { container, entry } = selected;
  const entries = collectEntries(container);
  const index = entries.findIndex((e) => e.cell === entry.cell);
  if (index === -1) return;

  if (direction === "down" || direction === "up") {
    const next = entries[index + (direction === "down" ? 1 : -1)];
    if (next) selectEntry(container, next, selected?.overlay ?? false);
    return;
  }

  const columns = groupByColumn(entries);
  // `entries`/`columns` are freshly built each call (`resolveEntry` makes a
  // new wrapper object every time), so `entry` itself is never the same
  // reference as anything inside `columns` even for the very cell it came
  // from — comparing by `.cell` (a real, stable DOM element) is what
  // actually finds it.
  const colIndex = columns.findIndex((col) => col.some((e) => e.cell === entry.cell));
  if (colIndex === -1) return;
  const targetCol = columns[colIndex + (direction === "left" ? 1 : -1)];
  if (!targetCol) return;
  const y = entry.cell.getBoundingClientRect().top;
  const closest = targetCol.reduce((best, candidate) =>
    Math.abs(candidate.cell.getBoundingClientRect().top - y) < Math.abs(best.cell.getBoundingClientRect().top - y) ? candidate : best,
  );
  selectEntry(container, closest, selected?.overlay ?? false);
}

/** The open context menu, if any — module-level so any of the several
 * things that should dismiss it (a click elsewhere, Escape, scrolling, a
 * re-render) can close it without threading a reference around. */
let openMenu: HTMLElement | null = null;

/** Closes the open menu. `immediate` only where another menu is about to
 * take its place in the same spot — two menus fading through each other
 * there read as one menu flickering. */
function closeContextMenu(immediate = false): void {
  if (openMenu) {
    if (immediate) openMenu.remove();
    else fadeOutAndRemove(openMenu);
  }
  openMenu = null;
}

/** Opens the retag menu for one annotation — right-clicking the UPOS
 * subtitle offers this parser's whole UPOS inventory, right-clicking the
 * deprel label its whole relation inventory (`UPOS_JA`/`DEPREL_JA`), with
 * the token's current value marked. Picking one edits the tree in place and
 * re-renders (see `applyTokenEdit`). Each menu belongs to the label it
 * retags, so there's no ambiguity about which of the two a right-click
 * meant — and the kanji itself stays free for plain selection and
 * head-dragging.
 *
 * Set in tategaki like the text it annotates, and laid out as a
 * dictionary-style table: entries run top-to-bottom and wrap into further
 * columns leftward (`.token-context-menu`'s own flex-wrap in vertical-rl —
 * see kunten.css). Entries keep their inventory order rather than being
 * re-sorted by kana: `UPOS_JA`/`DEPREL_JA` are already written in
 * grammatical order (nominals, then verbals, then function words; core
 * arguments, then modifiers, then coordination), which is how a printed
 * grammar table groups them and is far easier to scan for the value you
 * want than gojūon would be.
 *
 * The deprel menu opens from the arrow label, which only a token that has
 * a head carries — so it is never reached on a ROOT token, and the entry
 * for ROOT in the list is how a *different* token is made the root (see
 * `promoteToRoot`), not how one stops being it. Un-rooting on its own has
 * no meaning anyway: it would leave the sentence with no root at all.
 * Correcting a mis-rooted parse is therefore always the same gesture —
 * pick out the token that should have been the root and say so. */
function openRetagMenu(kind: "pos" | "dep", entry: Entry, x: number, y: number): void {
  closeContextMenu(true);

  const menu = document.createElement("div");
  menu.className = "token-context-menu";
  const inventory = kind === "pos" ? UPOS_JA : DEPREL_JA;
  const groups = kind === "pos" ? UPOS_GROUPS : DEPREL_GROUPS;
  const current = kind === "pos" ? entry.token.pos : entry.token.dep;

  const makeItem = (value: string) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    if (value === current) item.dataset.current = "true";
    item.textContent = inventory[value] ?? value;
    // The raw tag isn't shown (it reads badly stacked vertically at this
    // size, and every label in both inventories is already distinct on its
    // own) but stays reachable on hover for anyone working from the tagset.
    item.title = value;
    item.addEventListener("click", () => {
      closeContextMenu();
      if (kind === "pos") applyTokenEdit((token) => void (token.pos = value));
      // ROOT isn't a relation to a head, it's the absence of one — picking
      // it restructures the top of the tree rather than renaming an arc.
      else if (value === "ROOT") promoteToRoot(entry);
      else applyTokenEdit((token) => void (token.dep = value));
    });
    return item;
  };

  // Headings and entries flow as siblings — a heading doesn't open a column
  // of its own, it sits inline ahead of the entries it introduces, and the
  // run wraps into columns wherever it reaches the height cap set below.
  //
  // Each heading is bound together with its own first entry in one
  // `.token-menu-group-lead` box, which the wrap treats as a single atom:
  // that is what stops a heading from ever being left stranded at the foot
  // of a column with its entries beginning in the next one. If the pair
  // doesn't fit in the space left, both move on together. Structural
  // rather than measured, so there's no layout pass that could get it
  // wrong.
  for (const [heading, values] of groups) {
    const lead = document.createElement("div");
    lead.className = "token-menu-group-lead";
    const title = document.createElement("div");
    title.className = "token-menu-heading";
    title.textContent = heading;
    lead.append(title);
    if (values.length > 0) lead.append(makeItem(values[0]));
    menu.append(lead);

    for (const value of values.slice(1)) menu.append(makeItem(value));
  }

  // Positioned against the viewport (`position: fixed`), so it isn't
  // clipped by the panel's own `overflow` the way an in-panel absolute
  // element would be; nudged back inside if it would run off an edge.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  openMenu = menu;
  sizeMenuSquarish(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

/** Caps the menu's column height so the whole table comes out roughly
 * square rather than one tall thin strip (or, unconstrained, a single
 * column taller than the screen).
 *
 * Measured, not guessed: with the menu laid out unconstrained every child
 * sits in one column, so summing their heights gives the total inline
 * extent `L` of the content and the widest child gives a column's width
 * `w`. Wrapping that into columns of height `H` needs about `L/H` of them,
 * making the table `(L/H)·w` wide — setting that equal to `H` gives
 * `H = sqrt(L·w)`, the height at which width and height match.
 *
 * Wrapping can only ever fall *between* children, and each child is a
 * `white-space: nowrap` atom, so no entry is ever split down the middle by
 * a column break. */
/** The part of a `max-height` that isn't content.
 *
 * `box-sizing: border-box` is global here, and in vertical-rl `max-height`
 * caps the *inline* size — so a cap derived from the children's own content
 * extents is short by the inline-axis padding and borders (top and bottom,
 * which are the inline edges in this writing mode) unless they are added
 * back. Measured at ~24px against a 0.7rem/1px box: enough to wrap an extra
 * column on a long menu, and on a short one to cap the box below its own
 * content, which then overflowed the rounded border outright. */
function inlineBoxExtra(menu: HTMLElement): number {
  const style = getComputedStyle(menu);
  return (
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0) +
    (parseFloat(style.borderTopWidth) || 0) +
    (parseFloat(style.borderBottomWidth) || 0)
  );
}

export function sizeMenuSquarish(menu: HTMLElement): void {
  menu.style.maxHeight = "none";
  const children = [...menu.children] as HTMLElement[];
  if (children.length === 0) return;

  const style = getComputedStyle(menu);
  // In vertical-rl the inline axis is vertical, so it's `column-gap` that
  // separates successive entries down a column, and `row-gap` that
  // separates the columns themselves.
  const inlineGap = parseFloat(style.columnGap) || 0;
  const blockGap = parseFloat(style.rowGap) || 0;

  const totalInline = children.reduce((sum, el) => sum + el.offsetHeight, 0) + inlineGap * (children.length - 1);
  const columnWidth = Math.max(...children.map((el) => el.offsetWidth)) + blockGap;
  const tallestChild = Math.max(...children.map((el) => el.offsetHeight));

  // Never shorter than a single entry (which can't wrap), never taller
  // than the viewport allows. `height` is tracked throughout as the
  // *content* extent; `inlineBoxExtra` is added only where the cap is
  // written, since that is the one place the border box is what counts.
  const extra = inlineBoxExtra(menu);
  const clamp = (h: number) => Math.max(tallestChild, Math.min(h, window.innerHeight * 0.88 - extra));
  let height = clamp(Math.sqrt(totalInline * columnWidth));
  menu.style.maxHeight = `${Math.ceil(height) + extra}px`;

  // The closed form assumes columns pack perfectly; in practice each one
  // wraps early by up to an entry's worth, leaving the table wider than
  // predicted. Nudge toward square from the *measured* result — a couple
  // of passes is plenty, and each is a cheap reflow of a small menu.
  for (let i = 0; i < 3; i++) {
    const { width, height: measuredBox } = menu.getBoundingClientRect();
    // Squareness is judged on the border box — that's the shape on screen —
    // while the next cap is derived from the content extent inside it.
    if (Math.abs(width - measuredBox) / Math.max(width, measuredBox) < 0.05) break;
    const next = clamp((measuredBox - extra) * Math.sqrt(width / measuredBox));
    if (Math.abs(next - height) < 1) break;
    height = next;
    menu.style.maxHeight = `${Math.ceil(height) + extra}px`;
  }

  dropLeadingHeadingMargins(menu);
  shrinkMenuToContent(menu);
}

/** Trims the height cap down to what the columns actually came out to.
 *
 * The cap is a *wrapping* threshold, not a measurement of the result: once
 * the entries have been distributed (and `dropLeadingHeadingMargins` has
 * pulled some of them further up), the tallest column generally ends well
 * short of it, leaving dead space below every column.
 *
 * Tightening the cap re-wraps *every* column, not just the tallest, so
 * each pass has to be checked rather than trusted: entries shuffle between
 * columns, and the new tallest is usually shorter again — which, iterated
 * blindly, runs away. (Measured: unchecked, it drove a 439px menu down to
 * 238px, spreading the entries over so many columns that the content
 * overflowed and the box went four times wider than tall.) Extra columns
 * are the signal that a step went too far, so a pass that costs any is
 * rolled back and ends the loop; what remains is the tightest cap that
 * still holds the same column count. */
function shrinkMenuToContent(menu: HTMLElement): void {
  const children = [...menu.children] as HTMLElement[];
  if (children.length === 0) return;

  const style = getComputedStyle(menu);
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
  const extra = inlineBoxExtra(menu);
  const columnCount = () => new Set(children.map((el) => Math.round(el.getBoundingClientRect().left))).size;
  const tallestColumn = () => {
    const contentTop = menu.getBoundingClientRect().top + padding;
    return Math.max(...children.map((el) => el.getBoundingClientRect().bottom)) - contentTop;
  };

  for (let pass = 0; pass < 4; pass++) {
    const previousCap = menu.style.maxHeight;
    const previousColumns = columnCount();
    const extent = tallestColumn();
    // `extent` is a content measurement and `previousCap` a border-box one,
    // so the cap's own padding comes off before they are compared.
    if (extent <= 0 || ((parseFloat(previousCap) || Infinity) - extra) - extent < 1) break;

    // A couple of pixels of tolerance: the consumed main size of a column
    // is fractionally more than its last child's border-box bottom (gaps
    // and sub-pixel rounding), so re-capping at exactly the measured
    // extent is a hair too tight and tips one entry into a new column
    // (measured: 382.4 tallest at a 460 cap, but capping at 383 re-wrapped
    // 13 columns into 14). This keeps the packing while still closing
    // essentially all of the dead space.
    menu.style.maxHeight = `${Math.ceil(extent) + 2 + extra}px`;
    if (columnCount() > previousColumns) {
      menu.style.maxHeight = previousCap;
      break;
    }
  }
}

/** A heading's `margin-top` is there to separate it from the previous
 * group's last entry — but when the wrap happens to put a heading at the
 * *start* of a column there's nothing above it to separate from, and that
 * margin just indents it below its column's top edge. Zero it in that
 * case.
 *
 * CSS can't express "first on its flex line" (`:first-child` only catches
 * the very first of all), so this is measured: with `align-content:
 * flex-start` every column begins at the same inline-start offset, so a
 * group leads its column exactly when its own border-box top, less
 * whatever margin is currently pushing it down, sits at the menu's content
 * top. (It's the heading's `.token-menu-group-lead` wrapper that carries
 * the margin, and so this that is measured — see `openRetagMenu`.) Removing a margin frees space and can pull the next entry up into
 * that column, which can in turn change which headings lead a column — so
 * this re-measures until the set stops changing (a handful of passes at
 * most, each a cheap reflow of a small menu). */
function dropLeadingHeadingMargins(menu: HTMLElement): void {
  const headings = [...menu.querySelectorAll<HTMLElement>(".token-menu-group-lead")];
  if (headings.length === 0) return;

  const style = getComputedStyle(menu);
  const contentTop =
    menu.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);

  let previous = "";
  for (let pass = 0; pass < 5; pass++) {
    const leading = headings.map((h) => {
      const marginTop = parseFloat(getComputedStyle(h).marginTop) || 0;
      return h.getBoundingClientRect().top - marginTop <= contentTop + 1;
    });
    const signature = leading.join(",");
    if (signature === previous) break;
    previous = signature;
    headings.forEach((h, i) => {
      h.style.marginTop = leading[i] ? "0" : "";
    });
  }
}

/** The kanjidic index, for the furigana menu's candidate list. Set by
 * `KundokuView.ts` on each render rather than passed to
 * `setupTokenInspector` — that runs once and is guarded against running
 * again, whereas this needs to be in place whenever the panel has content,
 * including the first render after the index finishes loading. */
let readingIndex: KanjidicIndex | null = null;
let historicalKanaIndex: HistoricalKanaIndex | null = null;

export function setReadingIndex(index: KanjidicIndex | null, historicalKana: HistoricalKanaIndex | null): void {
  readingIndex = index;
  historicalKanaIndex = historicalKana;
}

/** Alternative readings for `entry`'s token, or an empty list if there is
 * nothing to offer.
 *
 * A cell inside a `.compound-group` gets none, deliberately: its furigana
 * is one JMdict reading for the *whole span*, divided up across the
 * member characters by the render layer, not a per-token reading the
 * resolver produced. A per-character choice there would be written to a
 * token the span reading never consults, giving a menu that silently did
 * nothing. Compound spans need their own span-level chooser instead. */
function readingCandidatesFor(entry: Entry): ReadingCandidate[] {
  if (entry.cell.closest(".compound-group")) return [];
  const dictionary = readingIndex
    ? candidateReadings(readingIndex, entry.token.text, entry.token.pos, historicalKanaIndex ?? undefined)
    : [];
  return [...rereadCandidateFor(entry), ...dictionary];
}

/** The 再読 reading, for a character this parse is reading twice — offered
 * first, since it is what the panel is doing and the dictionary readings are
 * the alternatives to it.
 *
 * Written as the two halves with an ellipsis between them, いまだ…ズ, which is
 * how a grammar cites one and the only honest way to put it in a list beside
 * single readings: the character's reading is in two pieces with a whole
 * clause in the gap, and a menu entry reading いまだず would name a word that
 * is never said. The halves are split across the two fields the item is built
 * from, so `openReadingMenu` renders it in the same hiragana-then-katakana it
 * renders every other candidate in, and the ellipsis rides along on the first.
 *
 * Empty for a character used in one of its ordinary senses (且 as "moreover")
 * — `isRereadUse` decides, the same as everywhere else — and empty once the
 * reader has chosen otherwise, when it is `openReadingMenu`'s 自動 that
 * offers the way back. */
function rereadCandidateFor(entry: Entry): ReadingCandidate[] {
  const sentence = sentenceOf(entry.cell);
  if (!sentence || !isRereadUse(entry.token, sentence)) return [];
  const reread = rereadCharacter(entry.token.text);
  return reread ? [{ kind: "reread", reading: `${reread.first}…`, okurigana: reread.second }] : [];
}

/** The furigana menu: pick which of a character's readings this occurrence
 * takes. Grouped 訓読み/音読み the way a kanji dictionary lists them, and
 * filtered to those compatible with the token's part of speech — see
 * `candidateReadings`.
 *
 * Each item is labelled exactly as the annotation will read once chosen
 * (hiragana reading, katakana okurigana), so the choice is made against
 * what will appear rather than against a dictionary citation form. */
function openReadingMenu(entry: Entry, candidates: ReadingCandidate[], x: number, y: number): void {
  closeContextMenu(true);

  const menu = document.createElement("div");
  menu.className = "token-context-menu";
  const current = chosenReading(entry.token);

  // Which candidate is marked as current comes from what the annotation
  // actually shows, not from `current` — the reading on screen is usually
  // one the resolver worked out rather than one the user picked, and a
  // menu that marked nothing until a choice had been made would misreport
  // the common case as "no reading selected".
  //
  // Only the reading is compared, never the okurigana: what's rendered is
  // inflected for this occurrence (為 shows なシ, the 連用形, against a
  // dictionary な.す), so matching the ending would fail on exactly the
  // inflecting words this menu is most useful for.
  const rt = entry.cell.querySelector("rt");
  const shownOkurigana = rt?.querySelector(".okurigana")?.textContent ?? "";
  const shownReading = (rt?.textContent ?? "").slice(0, (rt?.textContent ?? "").length - shownOkurigana.length);

  // Exactly one entry is marked. Preferring a whole-annotation match picks
  // the right one when the ending happens to be uninflected; falling back
  // to the reading alone is what catches the inflected case (直 displays
  // なほシ, the 連用形, against dictionary なほ.す) — but several candidates
  // can share one reading and differ only in that ending, so without a
  // single winner all of them would light up at once.
  const exact = candidates.find(
    (c) => c.reading === shownReading && toKatakana(c.okurigana ?? "") === shownOkurigana,
  );
  // A 再読 candidate is offered only where the panel is already reading the
  // character that way (see `rereadCandidateFor`), so where one exists it is
  // by construction the reading on screen. It could not be found by the
  // comparison above in any case: only its first half is in the <rt>, the
  // second being written down the other side of the character.
  const currentCandidate =
    candidates.find((c) => c.kind === "reread") ??
    exact ??
    candidates.find((c) => c.reading === shownReading) ??
    null;

  const makeItem = (candidate: ReadingCandidate) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.textContent = candidate.reading + (candidate.okurigana ? toKatakana(candidate.okurigana) : "");
    if (candidate === currentCandidate) item.dataset.current = "true";
    if (candidate.gloss) item.title = candidate.gloss;
    item.addEventListener("click", () => {
      closeContextMenu();
      // The 再読 reading is the one candidate that is not something to store:
      // it is what the parse already makes of the character, and picking it
      // means going back to that. Storing its two halves as a reading and an
      // okurigana would put いまだ…ず in the <rt> as one word.
      if (candidate.kind === "reread") applyTokenEdit((token) => clearChosenReading(token));
      else applyTokenEdit((token) => setChosenReading(token, candidate.reading, candidate.okurigana));
    });
    return item;
  };

  for (const [heading, kind] of [
    ["再読", "reread"],
    ["音読み", "on"],
    ["訓読み", "kun"],
  ] as const) {
    const group = candidates.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    // Heading bound to its first entry so the wrap can't strand it at the
    // foot of a column — the same structure `openRetagMenu` uses.
    const lead = document.createElement("div");
    lead.className = "token-menu-group-lead";
    const title = document.createElement("div");
    title.className = "token-menu-heading";
    title.textContent = heading;
    lead.append(title, makeItem(group[0]));
    menu.append(lead);
    for (const candidate of group.slice(1)) menu.append(makeItem(candidate));
  }

  // Only offered once there is a choice to undo — otherwise it would sit
  // there claiming to revert something that never happened.
  if (current) {
    const lead = document.createElement("div");
    lead.className = "token-menu-group-lead";
    const title = document.createElement("div");
    title.className = "token-menu-heading";
    title.textContent = "既定";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.textContent = "自動";
    item.title = "解析結果どおりの読みに戻す";
    item.addEventListener("click", () => {
      closeContextMenu();
      applyTokenEdit((token) => clearChosenReading(token));
    });
    lead.append(title, item);
    menu.append(lead);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  openMenu = menu;
  sizeMenuSquarish(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
}

/** True for the parts of a cell that carry a menu of their own, which the
 * plain selection click must therefore leave alone.
 *
 * Their menus open on a right or double click now (see
 * `setupTokenContextMenu`), so this no longer guards a menu-opening click
 * from also landing on the text behind it. What it still guards is the
 * analysis: a label sits outside every cell, so a left click on one would
 * read as a click on empty panel and take down the very overlay it is part
 * of. Inert is the right answer for all of them — these are controls, and a
 * left click is no longer their gesture.
 *
 * The furigana counts only while its character is being asked about, which
 * is when it is drawn as a control. Before that it is part of the cell like
 * any other, and clicking it selects the character. */
function isMenuTarget(target: HTMLElement): boolean {
  const rt = target.closest("rt");
  if (rt) return !!rt.closest(".token-cell-inspected");
  return !!(target.closest(".token-subtitle") || target.closest(".token-arrow-label"));
}

/** Every part of a cell that is a reading of its character, and so answers
 * for the character's readings when asked.
 *
 * The `<rt>` holds the furigana and the okurigana. The other is a 再読文字's
 * second reading, which is the same character's reading written down the
 * opposite side — so it opens the same menu, which now has something to say
 * about it (see `rereadCandidateFor`). Leaving it out made the one character
 * on the page whose reading is in two places answerable on only one of
 * them. */
const READING_PARTS = "rt, .reread-second";

/** Opens the readings for whichever character `part` annotates, reporting
 * whether there was anything to open — a character the dictionaries don't
 * know, or one swallowed by a compound span, has no alternatives to offer,
 * and the caller then lets the click mean whatever it would have meant. */
function openReadingMenuFor(part: Element, x: number, y: number): boolean {
  const entry = resolveEntry(part.closest<HTMLElement>(".kanji-cell[data-token-id]"));
  const candidates = entry ? readingCandidatesFor(entry) : [];
  if (!entry || candidates.length === 0) return false;
  openReadingMenu(entry, candidates, x, y);
  return true;
}

function setupTokenContextMenu(container: HTMLElement): void {
  // Asking what the parse makes of a character: the part of speech below it,
  // and the arrow from whatever it attaches to. Reading the text and
  // interrogating it are separate gestures, so the plain left click just
  // picks a character out.
  //
  // Every menu in the panel opens from here, on this one gesture. The two
  // labels used to open theirs on a left click, on the reasoning that a
  // label *is* the thing being changed and so is a control like any other —
  // but the panel already answers a left click by selecting and a right
  // click by explaining, and a control that took the first gesture made the
  // rule depend on where in the analysis the pointer had landed. One gesture
  // for every menu is a rule that can be stated. The readings menu is here
  // for the same reason: it was reachable on a left click once the analysis
  // was up, which is precisely when the most is on screen to land on.
  const interrogate = (event: MouseEvent) => {
    const target = event.target as HTMLElement;

    // The labels exist only while the analysis is on screen, which is this
    // same gesture away — so there is always a selection by the time one of
    // them can be reached.
    const kind = target.closest(".token-subtitle") ? "pos" : target.closest(".token-arrow-label") ? "dep" : null;
    if (kind && selected) {
      event.preventDefault();
      openRetagMenu(kind, selected.entry, event.clientX, event.clientY);
      return;
    }

    // The reading answers for itself: this gesture on the furigana — or on a
    // 再読文字's second reading, the same character's reading written down the
    // other side — offers the character's others, without first having to ask
    // about the character.
    const part = target.closest(READING_PARTS);
    if (part) {
      const entry = resolveEntry(part.closest<HTMLElement>(".kanji-cell[data-token-id]"));
      if (entry) {
        event.preventDefault();
        selectEntry(container, entry, selected?.overlay ?? false);
        // Nothing to offer: the character is still selected by the gesture,
        // and no menu appears rather than an empty one.
        openReadingMenuFor(part, event.clientX, event.clientY);
        return;
      }
    }

    const entry = resolveEntry(target.closest<HTMLElement>(".kanji-cell[data-token-id]"));
    // Anywhere else — the margins, the punctuation — keeps whatever the
    // browser would have done, its own menu included.
    if (!entry) return;
    event.preventDefault();
    selectEntry(container, entry, true);
  };

  container.addEventListener("contextmenu", interrogate);
  // And on a double click, which asks the same question with the same button
  // the rest of the panel is driven by. A right click is not always an easy
  // thing to make — a trackpad, a tablet, a mouse with one button — and it is
  // the only way to the analysis, so it should not be the only way.
  //
  // The two clicks that precede it have already run: the first selected the
  // character, the second repeated that. Both are harmless to arrive at this
  // from — selecting is what the analysis does anyway, and a menu is rebuilt
  // rather than stacked (see `openReadingMenu`).
  container.addEventListener("dblclick", interrogate);

  // A click outside an open menu dismisses it, and that is the whole of what
  // it does. Putting a menu away is an act in itself, and one the reader
  // takes by clicking at whatever is nearest rather than at anything in
  // particular — so landing on a character shouldn't also select it, or
  // start dragging it, or raise a second menu where the first one just was.
  //
  // Which takes the capture phase, and `stopPropagation` rather than the
  // handlers each checking for themselves: the drag begins on `pointerdown`
  // too, on the container, and a listener there runs *before* anything on
  // `document` in the bubble phase. Catching it on the way down is what gets
  // ahead of it.
  //
  // The flag is what carries the decision to the events that follow, since
  // dismissing happens on the press and the click arrives after it. Cleared
  // on the next press rather than when it is used, so that a second gesture
  // is a real one again — a double click outside puts the menu away and then
  // acts, which is what someone doing it twice is asking for.
  let dismissedMenu = false;
  document.addEventListener(
    "pointerdown",
    (event) => {
      dismissedMenu = false;
      if (!openMenu || (event.target as HTMLElement).closest(".token-context-menu")) return;
      closeContextMenu();
      dismissedMenu = true;
      event.stopPropagation();
    },
    true,
  );
  for (const type of ["click", "dblclick", "contextmenu"]) {
    document.addEventListener(
      type,
      (event) => {
        if (!dismissedMenu) return;
        event.stopPropagation();
        // For `contextmenu` specifically this is also what keeps the
        // browser's own menu from taking the dismissed one's place.
        event.preventDefault();
      },
      true,
    );
  }
  // Escape is handled in `setupTokenInspector`'s own keydown listener, not
  // here — it has to dismiss the menu *or* the selection, innermost first,
  // and two independent listeners would both fire and do both at once.
}

/** True while a modal dialog is up — the help guide, for now.
 *
 * These keydown listeners are on `document`, so they see keys pressed while
 * a dialog is open and would act on a panel the reader can't even see. Worse
 * for Escape specifically: the handler calls `preventDefault`, which cancels
 * the dialog's *own* native Escape-to-close, so the guide became impossible
 * to dismiss that way and silently dropped the user's selection instead. */
function modalIsOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

/** Set by `setupHeadDrag` when a drag actually moved (as opposed to a
 * plain click) — read and cleared by the click handler in
 * `setupTokenInspector`, which must not treat that drag's terminating
 * click as a fresh selection. */
let suppressNextClick = false;

/** Drag a token onto another to make that other token its head. A rubber-
 * band line follows the pointer while dragging (drawn in its own fixed
 * overlay SVG, so it isn't clipped by the panel), and the prospective
 * target highlights as the pointer passes over it.
 *
 * Two edits are refused outright rather than silently corrupting the tree:
 * re-parenting the sentence's ROOT (its `head === id` self-link is what
 * `computeReadingOrder` finds the root *by* — repointing it leaves the
 * sentence rootless, which that function throws on), and any move that
 * would create a cycle (see `wouldCycle`). Both just cancel the drag; use
 * the context menu's own 係り受け section to change what a ROOT *is*. */
function setupHeadDrag(container: HTMLElement): void {
  let dragFrom: Entry | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let line: SVGSVGElement | null = null;

  const clearHighlight = () => {
    for (const el of container.querySelectorAll(".token-drop-target")) el.classList.remove("token-drop-target");
  };

  /** Off the DOM rather than off `dragFrom`, which `endDrag` has to clear
   * anyway, and which a re-render would have left pointing at a cell no
   * longer in the document. Whatever carries the class is what gives it up. */
  const clearDragSource = () => {
    for (const el of container.querySelectorAll(".token-drag-source")) el.classList.remove("token-drag-source");
  };

  const endDrag = () => {
    line?.remove();
    line = null;
    dragging = false;
    dragFrom = null;
    clearHighlight();
    clearDragSource();
    document.body.classList.remove("token-dragging");
  };

  container.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const entry = resolveEntry((event.target as HTMLElement).closest<HTMLElement>(".kanji-cell[data-token-id]"));
    // A ROOT token has no head link to re-point — see this function's doc.
    if (!entry || entry.token.head === entry.token.id) return;
    dragFrom = entry;
    startX = event.clientX;
    startY = event.clientY;
  });

  document.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < 5) return;
      dragging = true;
      // Dragging across the text would otherwise sweep a native text
      // selection through the kanji and their ruby/kunten — suppress it for
      // the duration, and drop anything already caught by the few pixels of
      // movement before the threshold tripped.
      document.body.classList.add("token-dragging");
      // The character being carried, marked where it started so the gesture
      // has both its ends on the screen: this one in the accent, the one
      // under the pointer boxed in the highlight (`.token-drop-target`).
      // Its own class rather than the selection's, which means something
      // else and is styled from a different rule — a selection spares the
      // reading of the character it marks, and a drag stands every reading
      // down including that one (see `body.token-dragging` in kunten.css).
      dragFrom.cell.classList.add("token-drag-source");
      window.getSelection()?.removeAllRanges();
      line = document.createElementNS(SVG_NS, "svg");
      line.setAttribute("class", "token-drag-line");
      // An arrowhead, because this line is the dependency arrow being drawn
      // by hand and becomes one on release — so it is pointed the way that
      // arrow will be pointed.
      //
      // Which is at the character being dragged, not at the pointer. The
      // analysis draws its arc from a head to its dependent and puts the head
      // of the arrow on the dependent (`marker-end`, the path running
      // head-first); a drag runs the other way, from the dependent the reader
      // picked up to the head they are offering it to, so the same arrowhead
      // belongs at its start. `auto-start-reverse` on the marker is what
      // turns it around to point back down the line.
      //
      // The alternative reads better for a second and worse afterwards: an
      // arrowhead under the cursor says "this goes there", and then flips the
      // moment the button comes up, because the relation it just made points
      // the other way.
      //
      // Its own copies of the two markers, under their own ids: the analysis
      // overlay's are defined inside an SVG that exists only while the
      // analysis is up, and a character can be dragged with nothing
      // inspected at all.
      line.append(arrowheadDefs("drag-"));
      // Casing first, real line over it — the same two-path halo the
      // dependency arrow uses (see `.token-arrow-path-casing`), so the
      // rubber band stays legible wherever it crosses the text. Both carry
      // the same dash pattern, so the halo wraps each dash rather than
      // laying a solid band under the whole run.
      const casing = document.createElementNS(SVG_NS, "path");
      casing.setAttribute("class", "token-drag-line-casing");
      casing.setAttribute("marker-start", "url(#drag-token-arrowhead-casing)");
      line.append(casing);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "token-drag-line-path");
      path.setAttribute("marker-start", "url(#drag-token-arrowhead)");
      line.append(path);
      document.body.append(line);
    }
    const from = dragFrom.glyph.getBoundingClientRect();
    const d = `M ${from.left + from.width / 2} ${from.top + from.height / 2} L ${event.clientX} ${event.clientY}`;
    for (const p of line!.querySelectorAll("path")) p.setAttribute("d", d);

    clearHighlight();
    const overCell = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>(
      ".kanji-cell[data-token-id]",
    );
    const over = resolveEntry(overCell ?? null);
    if (over && over.cell !== dragFrom.cell && over.cell.closest(".sentence-gap") === dragFrom.cell.closest(".sentence-gap")) {
      over.cell.classList.add("token-drop-target");
    }
  });

  document.addEventListener("pointerup", (event) => {
    if (!dragFrom) return;
    const source = dragFrom;
    const wasDragging = dragging;
    const overCell = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>(
      ".kanji-cell[data-token-id]",
    );
    const target = resolveEntry(overCell ?? null);
    endDrag();
    if (!wasDragging) return;
    suppressNextClick = true;

    const gapEl = source.cell.closest(".sentence-gap");
    const sentence = gapEl && sentenceByGap.get(gapEl);
    if (!target || !sentence) return;
    // Same sentence only — token ids repeat across sentences, so a `head`
    // pointing into a different one is meaningless.
    if (target.cell.closest(".sentence-gap") !== gapEl) return;
    if (target.token.id === source.token.id) return;
    if (wouldCycle(source.token, target.token, sentence)) return;

    selectEntry(container, source);
    const childId = source.token.id;
    const headId = target.token.id;
    applyTokenEdit((token) => void (token.head = headId));

    // The old label described the *old* head's relation, so it's usually
    // wrong under the new one — have the parser rename the arc it now is.
    relabelArcsUnder(sentence, headId, [childId]);
  });
}

/** Wires up click-to-inspect and arrow-key navigation on the kundoku panel.
 * Clicking a `.kanji-cell` (punctuation excluded) shows its token's UPOS
 * and a labeled arrow from its head (see `showInspector`); clicking the
 * same cell again, or anywhere else in the panel, dismisses it — as does
 * Escape. Once a token is selected, the four arrow keys step to the
 * next/previous kanji or line (see `navigate`) regardless of where in the
 * document focus
 * happens to be — `.kanji-cell`s aren't natively focusable, so keydown is
 * caught on `document` rather than requiring the panel itself be focused;
 * guarded to do nothing while an actual text input has focus (the sidebar
 * textarea, an editable field some future feature adds, etc.), so this
 * never hijacks ordinary text-editing arrow keys. Attached once to
 * `container` (the scrollable `.tategaki` panel, which persists across
 * re-renders — only its children are replaced) and guarded by a dataset
 * flag so calling this again after a later `renderKundokuView` call is a
 * no-op, not a second listener; the sentence data it needs at click time
 * always comes fresh from `sentenceByGap`, which the current render's own
 * `registerSentence` calls keep up to date. */
export function setupTokenInspector(container: HTMLElement): void {
  if (container.dataset.inspectorAttached) return;
  container.dataset.inspectorAttached = "true";
  setupTokenContextMenu(container);
  setupHeadDrag(container);

  container.addEventListener("click", (event) => {
    // A click that concluded a head-drag isn't a selection click — see
    // `setupHeadDrag`.
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const column = (event.target as HTMLElement).closest<HTMLElement>(".tategaki-column");
    if (!column) return;
    // A label or a furigana opens its own menu (see `setupTokenContextMenu`),
    // and must not also be read as a click on the surrounding text — which
    // for a label, sitting outside any cell, would deselect the very token
    // the menu is about.
    if (isMenuTarget(event.target as HTMLElement)) return;

    const cell = (event.target as HTMLElement).closest<HTMLElement>(".kanji-cell[data-token-id]");
    if (cell?.classList.contains("token-cell-selected")) {
      deselect(column);
      return;
    }
    const entry = resolveEntry(cell);
    if (!entry) {
      deselect(column);
      return;
    }
    selectEntry(container, entry);
  });

  // And a click anywhere else at all lets the selection go — the other panel,
  // the sidebar, the margins of this one, the page behind them.
  //
  // The listener above can only answer for clicks inside a column, which left
  // the selection standing after a click on any of those, and standing is the
  // wrong default: the highlight and the analysis are what the reader is
  // being shown *about a character*, and they should end when attention
  // moves off it. Clicking away is how attention moves off it.
  //
  // On `document` rather than on the two panels, because "anywhere else" is
  // the whole page and enumerating it would mean listing every future part of
  // the interface too. What it must not catch is enumerable, and short:
  //
  //  - a click inside a column, which the listener above has already dealt
  //    with, including deciding when *not* to deselect;
  //  - the labels and readings, which sit outside their cell but belong to
  //    it, and are the targets for their own menus;
  //  - the menus themselves, and anything inside the analysis overlay;
  //  - a click that dismissed a menu, which never reaches here at all: that
  //    handler stops the event during the capture phase, so there is no
  //    bubble phase left for this one to run in. Putting a menu away is an
  //    act in itself, and not also a click on what lies beneath it.
  //
  // Guarded on a modal too, for the reason `modalIsOpen` gives: the guide
  // covers the panel, and a click in the guide is not a click away from a
  // character the reader cannot currently see.
  document.addEventListener("click", (event) => {
    if (!selected || modalIsOpen()) return;
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest(".tategaki-column") ||
      target.closest(".token-context-menu") ||
      target.closest(".token-inspector-overlay") ||
      isMenuTarget(target)
    ) {
      return;
    }
    deselect(selected.column);
  });

  const ARROW_DIRECTIONS: Record<string, "up" | "down" | "left" | "right"> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (modalIsOpen()) return;

    // Innermost thing first: an open retag menu absorbs Escape on its own,
    // leaving the token selected underneath it.
    if (event.key === "Escape" && openMenu) {
      event.preventDefault();
      closeContextMenu();
      return;
    }
    if (!selected) return;
    if (event.key === "Escape") {
      event.preventDefault();
      deselect(selected.column);
      return;
    }
    const direction = ARROW_DIRECTIONS[event.key];
    if (!direction) return;
    event.preventDefault();
    navigate(direction);
  });

  // Undo/redo, on its own listener because it must work with nothing
  // selected — the handler above returns early in that case, which is
  // right for Escape and the arrow keys and wrong for this.
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    // The sidebar textarea keeps its own native undo stack; never take
    // Cmd+Z away from a field the user is actually typing in.
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (modalIsOpen()) return;

    // Cmd on macOS, Ctrl elsewhere — accepted interchangeably rather than
    // sniffed for, since the other platform's key doesn't collide with
    // anything here (Ctrl+Z has no meaning on macOS, and Windows has no
    // Cmd). Shift+Cmd+Z is the usual redo; Ctrl+Y is its Windows spelling.
    const accel = event.metaKey || event.ctrlKey;
    if (!accel) return;
    const key = event.key.toLowerCase();
    const action = key === "z" ? (event.shiftKey ? redo : undo) : key === "y" ? redo : null;
    if (!action) return;

    // Only claim the keystroke if there was actually something to undo,
    // so at the ends of the history it falls through to the browser.
    if (!action()) return;
    event.preventDefault();
    closeContextMenu();
    rerenderPreservingSelection();
  });
}
