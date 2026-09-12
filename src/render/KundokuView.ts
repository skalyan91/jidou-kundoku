import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import type { CompoundSpan, JmdictIndex } from "../reading/jmdictLookup.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { type KanjidicIndex, seriesAmbiguousReading } from "../reading/kanjidicLookup.ts";
import { fullSizeKana, type HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { compoundCharacters, compoundFurigana } from "../reading/compoundFurigana.ts";
import { compoundSuruOkurigana } from "../reading/readingResolver.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../kundoku/kundokuTenAssigner.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { buildKundokuGlyphMap } from "./kundokuGlyphs.ts";
import { toKatakana } from "./kana.ts";
import { iterationMarkFor } from "./odoriji.ts";
import {
  auxiliaryFormFor,
  conjugatedOkurigana,
  converbSuffix,
  writesStatedForm,
  decideConjForm,
  extraEndingFor,
  findRoot,
  isNamingUse,
  isNegationUse,
  isSentenceFinalParticleUse,
  isPresentativeCopula,
  negationEnding,
  nextMeaningfulToken,
  pickedEnding,
  quoteClosing,
  repeatsPredicateCopula,
  selectedForm,
  conjugationSubject,
  lexiconEntryFor,
  teOrShite,
  usesLexiconEntry,
  yuParts,
  ziReading,
  readsAsSentenceFinalWord,
  sentenceFinalParticleFor,
  isUnpunctuatedTitleSpan,
  rereadSecondReading,
} from "../kakikudashi/conjugationContext.ts";
// The one particle guard both panels call in place of `caseParticleFor` — see
// `particleStack.ts` for the three stacks it was measured against and for the
// closed list of the stacks classical Japanese does have.
import { writtenCaseParticle } from "../kakikudashi/particleStack.ts";
import { CONVERB, NEGATION, retainedAuxiliaryParts } from "../kakikudashi/bungoConjugation.ts";
import {
  adverbialRenyouTe,
  compoundSuruRenyouTe,
  pickedRenyouTe,
  renyouTeOn,
  renyouTeSuffix,
  synthesizedRenyouTe,
} from "../kakikudashi/renyouTe.ts";
import { registerSentence, setupTokenInspector, setReadingIndex } from "./tokenInspector.ts";
import { chosenReadingParts, chosenReadingText, chosenSpellsOutInProse } from "../reading/chosenReading.ts";
import { type LineBreakKind, sourceLayoutOf } from "../parse/sourceLayout.ts";
import { annotateVerseRimes } from "./rimeAnnotation.ts";
import { createSentenceMemo, sentenceFingerprint } from "./sentenceMemo.ts";
import type { RimeIndex } from "../reading/rimeIndex.ts";
import {
  BRACKETS,
  isPunctuationMark,
  japanesePunct,
  OPENING_BRACKETS,
  type TitleSpans,
  titleReader,
  titleSpansOf,
} from "../parse/punctuation.ts";
import {
  CHAR_FADE_MS,
  charStepMs,
  charsDrawnBy,
  proseShownBy,
  showableChars,
  type ProvisionalSentence,
} from "../parse/provisionalSentences.ts";
import { isRereadUse, rereadCharacter, rereadFirstParts, rereadGovernedForm } from "../kakikudashi/rereadCharacters.ts";
import { VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
import { inflectedReading, readingInflects } from "../kakikudashi/classicalConjugation.ts";
import { retainedAdverbApplies, retainedAdverbParts } from "../reading/classicalEnding.ts";

const PUNCT_DEP = "punct";

/** How many kana of annotation the lane beside a character can hold before
 * the reading and the okurigana together would have to run past the gap and
 * into the next character's own annotation — the point at which rule 5 sends
 * the reading to the lane outside.
 *
 * The character's own height plus the gap after it, over the height of one
 * kana: M(1 + g) / f, where g is `--kanji-gap-ratio`. Read off the type scale
 * rather than written down, since it is a fact about the sizes and would
 * otherwise be a further number to remember when any of them moved — the gap
 * ratio included, which is why typography.css states it as a bare number this
 * can read rather than only as the `calc()` the stylesheet uses.
 * `--size-main` and `--size-furigana` are declared on `:root` in rem (the
 * furigana as a fraction of the character), so the root font size converts
 * them.
 *
 * **Strictly inside, and the strictness is now load-bearing.** The room a
 * lane has is the pitch from one character's reading to the next one's, so a
 * run that comes to exactly that room does not fit: its last kana ends
 * precisely where the next character's first kana begins, and two runs
 * meeting with no air between them read as one undivided run of kana — the
 * very thing rule 5 exists to prevent, arriving without a pixel of overlap to
 * announce itself. So this is the largest count that is *under* the room, not
 * the largest that is not over it, which is `ceil(room / f) - 1` and differs
 * from a plain `floor` in exactly the case where the division comes out
 * whole.
 *
 * That case used to be unreachable and now is not. With the furigana sized by
 * eye at 15.2px the room came to 5.789 kana and either arithmetic said 5;
 * with three kana to the character (see `--size-furigana` in typography.css)
 * the room is 88 / 14.667 = **exactly 6**, and a `floor` would have let a
 * six-kana lane through on the strength of a division landing on a whole
 * number. The answer is 5 either way, which is why nothing on the page moved
 * when the size did.
 *
 * Falls back to a count one short of the scale's own — 4 against the 5 above
 * — where the document can't be read at all: a cell built before the
 * stylesheet has applied, or in a test. Short rather than long on purpose,
 * since the failure it buys is a reading sent to the outside lane that could
 * have stayed in its own, and the other way round is two runs printed over
 * each other. Cached, since the scale doesn't change while the page is up. */
let annotationCapacityCache: number | null = null;
function annotationCapacity(): number {
  if (annotationCapacityCache !== null) return annotationCapacityCache;
  const fallback = 4;
  try {
    const root = getComputedStyle(document.documentElement);
    const rem = parseFloat(root.fontSize);
    const len = (name: string): number => {
      const raw = root.getPropertyValue(name).trim();
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return NaN;
      return raw.endsWith("rem") ? n * rem : raw.endsWith("px") ? n : NaN;
    };
    const main = len("--size-main");
    const furigana = len("--size-furigana");
    const gapRatio = parseFloat(root.getPropertyValue("--kanji-gap-ratio"));
    annotationCapacityCache =
      Number.isFinite(main) && Number.isFinite(furigana) && furigana > 0 && Number.isFinite(gapRatio)
        ? Math.ceil((main * (1 + gapRatio)) / furigana) - 1
        : fallback;
  } catch {
    annotationCapacityCache = fallback;
  }
  return annotationCapacityCache;
}

/** Opening quotes/brackets are the one class of punctuation Japanese
 * typesetting *allows* at the top of a new column (行頭禁則 — kinsoku shori —
 * forbids everything else there: 、。？！ closing brackets, etc.). Every
 * other punct token gets glued to the cell before it (see `appendPunct`)
 * so a column break can never fall between them and strand it at the top
 * of the next column.
 *
 * The lists themselves live in `parse/punctuation.ts`, which both panels now
 * read: the kakikudashibun has to classify the same mark the same way, and
 * two copies of the answer were two answers. */
const OPENING_PUNCT = OPENING_BRACKETS;
const BRACKET_PUNCT = BRACKETS;

/** The class a character wears while it stands inside a title — 《…》 in the
 * source, set as a 傍線 down the character's left-hand side rather than as a
 * pair of brackets (see `titleSpansOf` in parse/punctuation.ts, and
 * `.kanji-cell.title-line` in kunten.css, which draws it).
 *
 * **This panel only, and that is the reader's ruling**: "The prose panel
 * should have 《》, not the sideline!" The 書き下し文 writes both marks as the
 * characters they are and wears no line at all. So the two panels *do* differ
 * over these two characters, against the rule this file otherwise keeps — see
 * the note at the head of `renderKakikudashiView`, and the one above
 * `titleSpansOf`, which say why and ask a later reader not to reconcile them.
 * The 傍線 belongs to the apparatus, which is what this panel is; the brackets
 * belong to the writing, which is what that one is. */
const TITLE_CLASS = "title-line";

/** Whether `token` is the last thing in its sentence that isn't a closing
 * bracket — 也。」 ends at the 。, not at the 」.
 *
 * The structural signal, and it decides only where the mark itself says
 * nothing (see `kundokuPunct`). It cannot be trusted on its own here,
 * because this parser segments *at* punctuation: 學而時習之，不亦說乎？有朋
 * 自遠方來。 comes back as three sentences ending in ，, ？ and 。 —
 * measured — so "last in its sentence" is true of the comma as well, and
 * splitting a sentence at a comma does not make the comma a full stop. */
function endsSentence(sentence: Sentence, token: Token): boolean {
  return sentence.tokens
    .filter((t) => t.id > token.id)
    .every((t) => BRACKET_PUNCT.has(t.text));
}

/** What the kundoku panel writes for a mark of punctuation, which is not
 * always what the source wrote — see `japanesePunct`, which both panels
 * write their marks through. */
const kundokuPunct = japanesePunct;

/** Appends a punctuation cell, gluing it to the previously-appended element
 * (whatever that was — a plain cell, a compound-group, or an earlier
 * glued unit) inside a `white-space: nowrap` wrapper unless it's an
 * opening quote/bracket. This guarantees 、/。/？/！/etc. can never end up
 * as the first character of a new tategaki column — plain CSS line-
 * breaking treats each `.kanji-cell` as an opaque atomic box and can't be
 * trusted to apply kinsoku shori *between* them the way it would for a
 * run of ordinary text. */
function appendPunct(frag: DocumentFragment, cell: HTMLElement, text: string): void {
  const prev = frag.lastElementChild;
  if (OPENING_PUNCT.has(text) || !prev) {
    frag.append(cell);
    return;
  }
  const glued = document.createElement("span");
  glued.className = "no-break-unit";
  prev.replaceWith(glued);
  glued.append(prev, cell);
}
/** How long an annotation switch takes to settle. Longer than the 160ms the
 * overlay and the menus fade in: this moves the text itself rather than
 * bringing a label up over it, and something the reader has to follow from
 * one place to another needs longer than something that merely appears.
 *
 * Two other places state this same 260ms rather than importing it, each with
 * a note naming this constant: `FADE_MS` in `KakikudashiView.ts`, and the
 * visibility fade in `kunten.css`, which is a CSS transition and could not
 * import it in any case. All three are one gesture answering at one speed —
 * on a single switch flip an annotation may fade, walk, and have a connective
 * ink in beside it, and those must finish together. */
const REFLOW_MS = 260;

/** Every `.kanji-cell` in the kundoku panel, under a name that outlives the
 * panel being built again.
 *
 * The three 振り仮名/送り仮名/訓点 switches only repaint, so the cells they
 * change are the same elements before and afterwards and can simply be
 * measured twice. The 連用形-て switch redraws both panels from the tree
 * (`main.ts`'s `onRenyouTeChange`), and every node the first measurement held
 * is discarded before the second one runs, so something outside the DOM has
 * to say which new cell is which old one.
 *
 * The panel already carries it, in three parts: which sentence the cell
 * stands in, the id of the token it was rendered from, and — because a token
 * the tokenizer fused writes one cell per character, all of them under that
 * one id (see `renderSentence`'s multi-character branch), as does a compound
 * span under its members' several ids — how many cells of that same token
 * have already gone by. All three are read off the one tree either side of
 * the redraw, so all three name the same cell either time.
 *
 * Document order within a sentence is what the count walks, which is why the
 * cells are collected per `.sentence-gap` rather than by position among
 * siblings: `appendPunct` and `glueOpeningPunctForward` nest cells inside
 * `.no-break-unit` wrappers, so siblings are not the sequence — but a
 * `querySelectorAll` under the sentence is, whatever the nesting.
 *
 * Nothing downstream assumes the two sides agree. A key on one side only is
 * skipped, which is what makes this safe for a change that adds or drops a
 * cell. The 連用形-て switch does not — measured on 酒蟲, 359 cells before and
 * 359 after, none new and none lost, since every て it writes goes into an
 * okurigana that a cell already had or into a slot that cell already owns —
 * but that is a fact about what the switch writes, not something a walk over
 * the page is entitled to rely on. */
function keyedCells(): Map<string, HTMLElement> {
  const cells = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>("#kundoku-view .sentence-gap").forEach((sentence, index) => {
    const seen = new Map<string, number>();
    for (const cell of sentence.querySelectorAll<HTMLElement>(".kanji-cell")) {
      const id = cell.dataset.tokenId ?? "-";
      const nth = (seen.get(id) ?? -1) + 1;
      seen.set(id, nth);
      cells.set(`${index}:${id}:${nth}`, cell);
    }
  });
  return cells;
}

/** Where one cell's apparatus stands: the cell's own box on the screen, and
 * each run's placement within it, in the properties that run's own rule
 * places it with (see kunten.css).
 *
 * Whether a run *exists* is recorded apart from where it is, because the two
 * answer different questions and this walk turns on the difference. A run with
 * an element but no box is one a display switch has hidden or is bringing
 * back; it has not travelled, and those switches must leave it exactly as they
 * always did. A run with no element at all on the far side is one the redraw
 * has written for the first time — the bare テ the 連用形-て switch puts beside
 * 見 and 視, which had no okurigana of their own — and it has nowhere to have
 * come from. */
interface Placement {
  cell: DOMRect;
  /** The lane the `<rt>` stands in — its `left`, which rule 5 steps out by
   * one kana when it sends the reading outside. Both runs ride on it. */
  lane: number | null;
  hasOkurigana: boolean;
  okuTop: number | null;
  okuLeft: number | null;
  hasFurigana: boolean;
  furTop: number | null;
}

/** A placement property as it actually resolved for a run that is on the
 * screen, or null for one that isn't.
 *
 * The used value, which is what `getComputedStyle` gives for an element with
 * a box, and the only form of these there is to walk between: each is
 * declared as a `max()` or a `calc()` over custom properties (`--oku-run`,
 * `--furi-run`, `--reading-lane`) and resolves to a different number on
 * either side of the change.
 *
 * The box is what decides whether there is anything to walk, and a run can be
 * missing one on one side of a change and have one on the other — something
 * that was not on the screen a moment ago has not travelled to where it now
 * is. It appears where it belongs, as it always did.
 *
 * **The display switches are no longer how that happens.** They used to hide
 * a run with `display: none`, which took its box with it; they now fade it
 * with `filter: opacity(0)` (see the visibility section of kunten.css), which
 * keeps the box throughout — that is what lets the fade and this walk run
 * together on an annotation that is both moving and going. The one run that
 * still arrives without a previous box is one the 連用形-て redraw writes for
 * the first time, so the guard stays, with a narrower reason than it had.
 *
 * `auto` reads as 0, which is the answer rather than a fallback: `top` is
 * `auto` on a `.furigana` the centring rule has not claimed, and a run that
 * is not offset from its own place in the line is offset from it by nothing
 * — which is exactly the value the centring rule's `top` walks back to when
 * the lane gains an okurigana and the reading stops being centred. */
function usedOffset(el: HTMLElement | null, property: "top" | "left"): number | null {
  if (!el || !el.getClientRects().length) return null;
  const value = parseFloat(getComputedStyle(el)[property]);
  return Number.isFinite(value) ? value : 0;
}

/** Brings a run the change has just written up where it belongs, over the
 * same interval everything travelling beside it takes — so the switch has one
 * answer and not a walk followed by an apparition.
 *
 * Hands back the `Animation` for the one caller that has to be able to stop
 * one: the character reveal below, whose cancel has to leave no animation
 * running. Every other caller ignores it, and may — a fade with the default
 * `fill: none` writes no inline style and takes itself out of
 * `document.getAnimations()` the moment it finishes. */
function fadeIn(run: HTMLElement, timing: KeyframeAnimationOptions): Animation {
  return run.animate([{ opacity: 0 }, { opacity: 1 }], timing);
}

function placementOf(cell: HTMLElement): Placement {
  const rt = cell.querySelector<HTMLElement>("rt");
  const okurigana = cell.querySelector<HTMLElement>(".okurigana");
  const furigana = cell.querySelector<HTMLElement>(".furigana");
  return {
    cell: cell.getBoundingClientRect(),
    lane: usedOffset(rt, "left"),
    hasOkurigana: okurigana !== null,
    okuTop: usedOffset(okurigana, "top"),
    okuLeft: usedOffset(okurigana, "left"),
    hasFurigana: furigana !== null,
    furTop: usedOffset(furigana, "top"),
  };
}

/** Runs `apply` — a change to what the kundoku panel's annotations *are* or
 * to which of them are shown — and walks everything it moves from where it
 * was to where that leaves it.
 *
 * Nothing declarative can express this: what moves comes out of layout being
 * redone, which no transition covers. So the old placement is measured, the
 * change applied, the new placement measured, and the difference played back
 * as a displacement returning to zero. Which is FLIP, and the only part of it
 * that needs saying twice is the identity: `apply` may replace every node on
 * the page, so the two measurements are keyed rather than paired off by
 * position — see `keyedCells`.
 *
 * **One function for both kinds of change, deliberately.** The three display
 * switches repaint (a class on `<body>`); the 連用形-て switch redraws both
 * panels from the tree, because the て is part of what the generator writes
 * rather than part of what CSS shows. They are two ways of arriving at a new
 * layout and not two kinds of movement: the same runs move, placed by the
 * same rules, and a second function would be a second description of this
 * panel's geometry to keep in step with kunten.css. What the redraw needs
 * over the repaint is the key, and a key costs the repaint nothing — the same
 * elements come back under the same names.
 *
 * The four things that move, each named by the rule that moves it:
 *
 *  - **The okurigana's `top`.** Rule 3 places the run by its penultimate kana
 *    and rule 4 pushes it clear of where the reading ends, and `.okurigana`'s
 *    `top` is the `max()` of the two. A switch releases the push (`--furi-run`
 *    zeroed on the `<rt>`); the て lengthens the run (`--oku-run`), which
 *    walks rule 3's half of the `max()` up the lane. Measured on 酒蟲, the て
 *    switch: six runs travel — 令 and 使's シメ→シメテ and 不's ズ→ズシテ one
 *    kana up the lane, 14.67px, 無's ク→クシテ the same, 貧's シク→シクシテ and
 *    暴's ニ→ニシテ two kana, 29.33px. Every one of them is a whole number of
 *    kana now that three kana come to the character exactly; they used to be
 *    15.2, 13.6, 30.4 and 32. The other 15 of the 23 cells the switch rewrites do not
 *    move at all, and should not — rule 3's `max(1, n - 1)` puts a one-kana
 *    and a two-kana run in the same place, so 飲's ミ→ミテ lengthens without
 *    shifting, and where the reading is long enough rule 4 is what is holding
 *    the run anyway. The `< 0.5px` guard is what keeps those 15 still while
 *    the six travel.
 *
 *  - **The `<rt>`'s `left`, and the okurigana's `left` against it.** Rule 5:
 *    a lane that can no longer hold both runs sends the reading one kana
 *    outside and walks the okurigana back by the same kana, so that only the
 *    reading moves. The て is what tips two lanes over — 暴's にはか/ニシテ and
 *    貧's まづ/シクシテ, 14.66px out. The two halves are one placement and are
 *    only ever right together, which is why both are walked and why they are
 *    asked for in the same task.
 *
 *  - **The furigana's `top`.** A reading with nothing else in its lane is
 *    centred against its character rather than hung from its top; a lane that
 *    gains an okurigana loses that, and the reading slides 14.67px up to the
 *    character's top. Both of 見's and 視's み do this when the bare テ arrives
 *    beside them — measured — and it is one event with the テ's own arrival,
 *    so the two settle together.
 *
 *  - **The cell.** Almost never, and the exception is new — see `cellWalk`
 *    below, which is where the rule about it is. This was written when the
 *    `<rt>` was still in
 *    flow, where switching a layer off shortened the annotation column beside
 *    each character and every character after it came up to close the gap —
 *    32 of 36 characters moving, 13 into a different column, the furthest by
 *    314px. Every annotation is out of flow now (see kunten.css's header), so
 *    a cell is exactly one character tall whatever it carries and neither a
 *    switch nor a longer okurigana shortens anything: measured, 0 of 359
 *    cells move on 酒蟲 under the て switch, as 0 of 36 move under the other
 *    three. **That measurement no longer covers the て switch**, and what
 *    broke it is not in this panel at all: the switch changes how many
 *    characters the prose holds, `fitPassageExtent` re-answers the division
 *    with it, and the coarse half of that answer is whole characters of
 *    height moved into this panel — one of which re-breaks every column here.
 *    `cellWalk` is what that asks for. A `.kanji-cell` is an inline *block*
 *    and takes a transform, which carries its annotations with it, so
 *    anything that goes back into flow is still covered without being asked.
 *
 * **The 踊り字 is the one annotation this walk does not name, and should not.**
 * Asked again when the mark came back below its character: `Placement` records
 * what moves, and a `.odoriji` never does. It is pinned at `top: 100%; right:
 * 0` against `.kanji-glyph` — two constants, and neither reads `--furi-run` or
 * `--oku-run`, which are the only things any of these switches changes. Nor
 * can it appear or disappear across one: the 振り仮名 switch fades it with
 * `filter: opacity(0)`, which is visibility and not existence — and now
 * emphatically so, the box staying put throughout — exactly as the
 * 送り仮名 switch hides an okurigana that was there all along and is not faded
 * back in; and the 連用形-て switch writes *endings*, never readings, so a
 * mark decided from the reading alone (see `cellFor`) stands on both sides of
 * it. What is left is the cell's own travel, and a `.kanji-cell` is an inline
 * block whose transform carries everything inside it, this mark included.
 * Naming it here would add a measurement that is the same number twice, and a
 * fade-in for a run that is never new.
 *
 * Which is also why every run takes its own placement properties and not a
 * transform: the cell's transform already applies to them, so a second one
 * would have to be measured against the cell to keep from counting the cell's
 * travel twice, where these resolved offsets are the movement itself and say
 * nothing about what the cell is doing. (A transform would not bite on the
 * furigana in any case — it is an inline box, and confirmed inert against one
 * in this panel.)
 *
 * **A run the change writes for the first time fades in; one it unwrites is
 * simply gone.** The asymmetry is the situation's and not a preference: a テ
 * that did not exist has no position to travel from, so the most that can be
 * said of it is that it belongs here now, which a fade over the same interval
 * says. A テ that has been unwritten has no position to travel *to*, and its
 * node went with the redraw — fading it out would mean holding a copy of it
 * in the finished page, and every other reader of this DOM (the pLaTeX
 * scraper, `publishAnnotationOverhang`, the inspector) would then have to be
 * told to ignore an annotation the tree does not have. Two runs appear on
 * 酒蟲, 見's テ and 視's テ, and the same two disappear when the switch goes
 * back off — measured, 12 animations one way and 10 the other.
 *
 * The distinction that decides this is *existence*, not visibility, which is
 * why `Placement` records the two apart: an okurigana the 送り仮名 switch had
 * merely hidden is not new when it comes back, and the three display switches
 * go on behaving exactly as they did.
 *
 * The scroll capture in `main.ts` is what makes the two measurements
 * comparable at all, and not only a courtesy to the reader: these are
 * viewport rectangles and resolved offsets read off a panel that the redraw
 * resets to its own reading start and the capture puts straight back, all
 * within this one task. A redraw that left the panel scrolled elsewhere would
 * measure every cell as having travelled the width of the text. */
/** Below this is not a movement a reader can see. `animateKakikudashiReflow`'s
 * `STILL_PX`, stated again here because the two panels are measured by two
 * modules and neither imports the other's private constants. */
const STILL_PX = 0.5;

/** **Whether a cell that moved may be walked to where it now is, and by how
 * much.** `null` where it must not be — because it did not move, or because
 * it did not *travel*.
 *
 * The distinction is `animateKakikudashiReflow`'s `pushedAlongTheFlow`, and it
 * is the same distinction for the same reason. This panel is set vertical-rl,
 * so a column is a fixed vertical band and "the same column" is "the same
 * `left`". A cell further down the column it was already in was pushed along
 * it, and a reader watching it slide sees what happened. A cell in a
 * *different* column was not pushed anywhere: the column length changed and
 * the whole text was set again. Flying it there describes a journey the layout
 * never made.
 *
 * ── Why this is needed, the note above having measured no cell moving ────
 * That measurement — 0 of 359 cells on 酒蟲, under every switch — was taken
 * when nothing a switch did could change the column *length*. The 連用形-て
 * switch now can: it changes how many characters the prose holds, so it
 * changes the answer `fitPassageExtent` gives, and the coarse half of that
 * answer is `--kundoku-extra-slots` — whole characters of height moved across
 * the rail into this panel. One step is 88px, a whole character of column, so
 * every column in the panel re-breaks and very nearly every cell in it lands
 * somewhere else.
 *
 * Walked, that is the whole text flying across the panel at once, most of it
 * diagonally; and it is worth saying plainly that this is not the panel
 * declining to show a change. **The change it would be showing is not one
 * that happened to any word.** The passage was re-set at a different column
 * length, which is a fact about the page and not about any character in it,
 * and the characters simply stand where the new setting puts them. What still
 * animates is everything *inside* the cells — the readings, the okurigana,
 * the connective inking in — which is what the switch actually changed, and
 * which is measured in offsets resolved against each cell's own box and so is
 * untouched by the cell having been re-set (see the note above).
 *
 * The prose panel needs no such amendment: `pushedAlongTheFlow` has drawn this
 * line there since the walk was written, and a re-set word there fades rather
 * than flies.
 *
 * Pure, and tested in `tests/renyouTeFit.test.ts`, so the rule can be checked
 * without a layout engine — which is the only place it can be checked at all
 * from here. */
export function cellWalk(
  was: { left: number; top: number },
  now: { left: number; top: number },
): { dx: number; dy: number } | null {
  const dx = was.left - now.left;
  const dy = was.top - now.top;
  if (Math.abs(dx) < STILL_PX && Math.abs(dy) < STILL_PX) return null;
  // A different column: re-set, not travelled.
  if (Math.abs(dx) >= STILL_PX) return null;
  return { dx, dy };
}

export function animateAnnotationShift(apply: () => void): void {
  const before = new Map<string, Placement>();
  for (const [key, cell] of keyedCells()) before.set(key, placementOf(cell));

  apply();

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (typeof Element.prototype.animate !== "function") return; // no Web Animations (jsdom)

  // Every measurement first, then every animation. The reads are all taken
  // against one settled layout, so none of the writes can invalidate one that
  // has not happened yet; and it puts every animation in this one task, which
  // is what gives them a common start time. That matters rather than being
  // tidiness — the reading's lane and the okurigana's walk-back are two halves
  // of one placement, and a pair that started a frame apart would show the
  // okurigana riding out with the reading and coming back.
  const walks: { cell: HTMLElement; was: Placement; now: Placement }[] = [];
  for (const [key, cell] of keyedCells()) {
    const was = before.get(key);
    if (was) walks.push({ cell, was, now: placementOf(cell) });
  }

  const timing: KeyframeAnimationOptions = { duration: REFLOW_MS, easing: "ease-out" };
  /** Whether a placement property is on the screen on both sides of the
   * change and resolved to somewhere else. Below half a pixel is not a
   * movement a reader can see, and anything that did not move must not stir
   * while the things that did are travelling. */
  const travelled = (from: number | null, to: number | null): boolean =>
    from !== null && to !== null && Math.abs(from - to) >= 0.5;

  for (const { cell, was, now } of walks) {
    const travel = cellWalk(was.cell, now.cell);
    if (travel) {
      cell.animate(
        [{ transform: `translate(${travel.dx}px, ${travel.dy}px)` }, { transform: "translate(0, 0)" }],
        timing,
      );
    }

    const rt = cell.querySelector<HTMLElement>("rt");
    if (rt && travelled(was.lane, now.lane)) {
      rt.animate([{ left: `${was.lane}px` }, { left: `${now.lane}px` }], timing);
    }

    const okurigana = cell.querySelector<HTMLElement>(".okurigana");
    if (okurigana && !was.hasOkurigana) {
      fadeIn(okurigana, timing);
    } else if (okurigana && (travelled(was.okuTop, now.okuTop) || travelled(was.okuLeft, now.okuLeft))) {
      // Both offsets in one keyframe list rather than two animations, so the
      // run cannot be walked down the lane and back out of it on two clocks.
      // Either is non-null exactly when the other is (a run with a box has
      // both, one without has neither), so a pair that travelled leaves no
      // null to be written into a keyframe.
      okurigana.animate(
        [
          { top: `${was.okuTop}px`, left: `${was.okuLeft}px` },
          { top: `${now.okuTop}px`, left: `${now.okuLeft}px` },
        ],
        timing,
      );
    }

    const furigana = cell.querySelector<HTMLElement>(".furigana");
    if (furigana && !was.hasFurigana) {
      // The same treatment the okurigana gets, for the same reason, and no
      // switch reaches it: the 連用形-て switch writes endings and never a
      // reading, so a `.furigana` is always there on both sides of it. It is
      // written this way round because the rule is about a run the change has
      // just written, not about which of the two runs it is — and any other
      // redraw put through this walk would want it.
      fadeIn(furigana, timing);
    } else if (furigana && travelled(was.furTop, now.furTop)) {
      // `position` is stated on both keyframes, and never changes value: it is
      // there because `top` bites on nothing otherwise. The centring rule
      // makes a reading `position: relative` only while it is *being* centred,
      // so the run this walk is asked about is static on one side of the
      // change and relative on the other, and a static box ignores `top`
      // entirely (confirmed against this panel — as is this form of saying it,
      // which walks the reading exactly as an inline `position: relative`
      // does, and unlike one leaves nothing behind on the element). A browser
      // that declines to honour it drops the walk and the reading arrives
      // where it belongs without travelling, which is what happens today.
      // `.furigana { position: relative }` in kunten.css would retire the
      // whole question.
      furigana.animate(
        [
          { position: "relative", top: `${was.furTop}px` },
          { position: "relative", top: `${now.furTop}px` },
        ],
        timing,
      );
    }
  }
}

/** Furigana (a content word's dictionary reading) is hiragana; okurigana
 * (inflectional kana, and — per the same convention real kanbun annotation
 * uses — a *function word's* reading generally, since it's a grammatical
 * gloss rather than an independent word's pronunciation) is katakana. Both
 * live in the same `<rt>`, which is the lane beside the character; each is
 * wrapped in a span of its own and placed there by its own rule, the
 * furigana against the character's top and the okurigana against its foot
 * (rules 3 and 4 — see kunten.css). Every annotation is positioned against
 * `.kanji-glyph`, the box that is exactly the character.
 *
 * How long each run is goes onto the element as a custom property, since
 * the rules are arithmetic in the two lengths and CSS cannot count
 * characters. Counted rather than measured, and exact: these are kana set
 * vertically at `line-height: 1`, where every one advances a full em of its
 * own size, small kana included. */
/** `kanaOnly`: marks this cell with `data-kana-only` — purely a hook for
 * `kanbun/texAnnotation.ts`'s DOM-scraper, which needs to know (something
 * the DOM otherwise doesn't expose) whether *this exact token* is one whose
 * kanji `generateKakikudashi` drops entirely in the running prose (a
 * grammar-word gloss — discourse particles, negation, modal auxiliaries,
 * 而, 於, and any other override-table reading) versus a content word whose
 * kanji it keeps. Never affects rendering — the kundoku panel shows the
 * base glyph either way. */
/** `kanaReading`: the dictionary form of the grammar word this cell's
 * okurigana spells, recorded on the cell as `data-kana-reading` for the cell
 * that has no furigana at all — postposed negation, a modal or causative
 * auxiliary, a sentence-final particle read after its character, and an
 * override-table gloss that states no ending of its own. All four put the
 * whole of their reading in the okurigana slot: 不 is a bare 不 beside ザル.
 *
 * It is there for the furigana menu, which names the reading on screen by
 * comparing its candidates against the `<rt>` — and on these cells that
 * comparison has nothing to look at, the furigana slot being empty. What
 * stands in the okurigana slot instead is the word *inflected for this
 * occurrence* (one ず is written ズ, ザル, ザルニ or ズト as the clause
 * requires; しむ is written シメ), which no dictionary citation equals, so
 * reading the kana back off the page would not name the word either. The
 * form is chosen here, out of the paradigm each branch below draws it from,
 * so the citation is stated here too rather than inferred back out of the
 * kana by a second copy of this dispatch living in the inspector — the same
 * reason `negationEnding` and `sentenceFinalParticleFor` are called rather
 * than reimplemented. Never affects rendering.
 *
 * Only ever set for a reading that is *wholly* in the okurigana slot. A cell
 * whose reading stands over its character — a split override (每's ごと + ニ),
 * a particle read in place of its character (也 なり) — is already named by
 * the furigana comparison, and stating it a second way here would give the
 * menu two answers to one question. */
export function cellFor(
  base: string,
  reading: string | undefined,
  okurigana: string | undefined,
  kunten: string | undefined,
  tokenId: number,
  kanaOnly = false,
  /** A 再読文字's second reading, set down the character's left-hand side —
   * see `.reread-second`. */
  rereadSecond?: string,
  kanaReading?: string,
): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "kanji-cell";
  cell.dataset.tokenId = String(tokenId);
  if (kanaOnly) cell.dataset.kanaOnly = "true";
  if (kanaReading) cell.dataset.kanaReading = kanaReading;

  const glyph = document.createElement("span");
  glyph.className = "kanji-glyph";
  glyph.append(base);

  if (kunten) {
    const mark = document.createElement("span");
    mark.className = "kunten-glyph";
    mark.textContent = kunten;
    glyph.append(mark);
  }

  // Anchored inside `.kanji-glyph` like the kunten mark, and for the same
  // reason: it belongs the same distance from the character itself as the
  // furigana on the other side, and `.kanji-cell`'s box is stretched by the
  // ruby.
  if (rereadSecond) {
    const second = document.createElement("span");
    second.className = "reread-second";
    second.textContent = toKatakana(rereadSecond);
    // How long the run is, for the placement arithmetic in `.reread-second`:
    // it has to know its own height to centre itself against the character,
    // and to tell whether it is too tall to be centred at all. Counted rather
    // than measured, and exact — these are all plain kana set vertically at
    // `line-height: 1`, where every character advances one full em, small
    // kana included. Two of them fit beside a 44px character at the furigana
    // size; がごとし's five do not.
    second.style.setProperty("--reread-run", String(rereadSecond.length));
    glyph.append(second);
  }

  // The 踊り字, when the reading this character is given is a doubled word —
  // 益 ますます, 抑 そもそも. Anchored inside `.kanji-glyph` like the kunten
  // mark and the second reading, for the reason all three are: what it has to
  // hang off is the character itself, and `.kanji-cell`'s box is stretched by
  // the ruby. It goes below-right, the mirror of the kaeriten's below-left
  // (see `.odoriji` in kunten.css).
  //
  // Decided from `reading` alone, here, rather than anywhere earlier: this is
  // the one place that knows which reading the character actually ends up
  // wearing, after the overrides, the menu's hand-picked choice, the compound
  // furigana and the historical-kana pass have all had their say. A character
  // whose reading changes gains or loses its mark on the same redraw, with
  // nothing needing to be told.
  //
  // Appended after the base text rather than before it, so `texAnnotation.ts`,
  // which scrapes the character out of `glyph.childNodes[0]`, still reads a
  // bare 益 — the mark is an annotation on the reading and the exported line
  // spells that reading out in full, where a 〻 would be a second way of
  // saying it.
  const odoriji = iterationMarkFor(reading);
  if (odoriji) {
    const mark = document.createElement("span");
    mark.className = "odoriji";
    mark.textContent = odoriji;
    glyph.append(mark);
  }

  if (reading || okurigana) {
    const ruby = document.createElement("ruby");
    ruby.append(glyph);
    const rt = document.createElement("rt");
    // How far down the lane the reading reaches, which is what the okurigana
    // has to be pushed clear of (rule 4). On the <ruby> rather than inline on
    // the <rt>, so the rules that have to cancel the push — the reading
    // switched off, or sent outside — can override it on the <rt> itself
    // rather than losing to an inline style.
    ruby.style.setProperty("--furi-run", String(reading?.length ?? 0));
    if (reading) {
      // Wrapped rather than appended as bare text so that furigana and
      // okurigana — which share this one <rt> — can be shown and hidden
      // independently of each other.
      const furigana = document.createElement("span");
      furigana.className = "furigana";
      furigana.textContent = reading;
      rt.append(furigana);
    }
    if (okurigana) {
      const oku = document.createElement("span");
      oku.className = "okurigana";
      oku.textContent = toKatakana(okurigana);
      // Which kana sits level with the character's foot is a function of how
      // many there are (rule 3), so the count goes to CSS.
      oku.style.setProperty("--oku-run", String(okurigana.length));
      rt.append(oku);
    }
    // Rule 5. The two runs share one lane, the reading from the character's
    // top and the okurigana at its foot, and where they cannot both fit it is
    // the reading that gives way — the okurigana stays where rule 3 puts it,
    // and the reading moves to the lane outside rather than the characters
    // moving apart to make room.
    if ((reading?.length ?? 0) + (okurigana?.length ?? 0) > annotationCapacity()) {
      ruby.classList.add("reading-outside");
    }
    ruby.append(rt);
    cell.append(ruby);
  } else {
    cell.append(glyph);
  }

  return cell;
}

/** Extra okurigana this token needs beyond its own reading — a morph-driven
 * auxiliary, or a synthesized copula for a bare nominal-predicate root —
 * appended to whatever okurigana the token already has. Same source of
 * truth as the kakikudashi generator (`conjugationContext.ts`), so a なり
 * the generator inserts out of nothing (no source token at all) still
 * shows up here, attached to the predicate it belongs to. */
function withExtraEnding(okurigana: string | undefined, token: Token, root: Token | undefined, plan: ReadingPlan): string | undefined {
  const extra = extraEndingFor(token, root, plan.sentence);
  if (!extra) return okurigana;
  // `synthesizedRenyouTe` rides along with every `selectedForm` in this file, as
  // it does in `generator.ts`, so the two panels write the same 連用形-て — and
  // writes nothing at all while the switch is off. See `renyouTe.ts`.
  const selected = selectedForm(extra, plan, token.id);
  return (okurigana ?? "") + selected.text + synthesizedRenyouTe(selected, nextMeaningfulToken(plan, token.id));
}

/** A case particle (を/に) this token takes, appended as trailing okurigana
 * — see `caseParticleFor`, and `particleStack.ts` for the guard that decides
 * whether it may actually be written here. Kundoku conventionally supplies this even though
 * nothing in the source text realizes it, same as the kakikudashi generator
 * appends it directly to the word's own text. */
function withCaseParticle(
  okurigana: string | undefined,
  token: Token,
  plan: ReadingPlan,
  resolve: ReadingResolver,
  afterId: number = token.id,
): string | undefined {
  const particle = writtenCaseParticle(token, plan, resolve, afterId);
  if (!particle) return okurigana;
  return (okurigana ?? "") + particle;
}

/** The closing of a quoted/reported-speech complement of a speech verb
 * (rendered katakana in the okurigana slot per the usual function-word
 * convention) on the token that ends it — see `ReadingPlan.quoteEndIds` and
 * `depClassification.ts`'s `isSpeechQuoteComplement`. Applied as the
 * outermost wrap in every dispatch branch below, since the quote can end on
 * any kind of token (a plain verb, a sentence-final particle, a negation,
 * the last member of a compound...).
 *
 * What is appended is `quoteClosing`'s and not a bare と: the quoted complement
 * of a verb of *asking* is a question, and a question closes 〜やと — the や
 * inside the quotation, where it is what makes the quoted sentence a question,
 * and the と outside it, where it is what reports the quotation. 問：「需何藥？」
 * drew 需 フト here against a prose panel already writing 需ふやと. Both panels
 * now call the one function, which is that function's own stated reason for
 * existing. */
function withQuoteEnd(okurigana: string | undefined, tokenId: number, plan: ReadingPlan): string | undefined {
  if (!plan.quoteEndIds.has(tokenId)) return okurigana;
  return (okurigana ?? "") + quoteClosing(tokenId, plan);
}

/** Just the furigana-reading half of the per-token dispatch below — used
 * for an ordinary standalone token (as `reading`) and, individually, for
 * each member of a compound span or multi-character token (see the span
 * and multi-character branches in `renderSentence`): each character gets
 * its own reading, never a single fused whole-word reading spanning the
 * group. Negation/discourse/auxiliary/而 tokens never appear as compound
 * members in this treebank (those relations mark grammatical function
 * words, not nominal compounds), so this only needs the ziReading/
 * VERB_LEXICON/override/kanjidic paths. */
/** A `VERB_LEXICON` entry's own `reading` (see that file's doc for why this
 * can't just be `kanjidicLookup.ts`'s generic kun'yomi lookup), historical-
 * kana-corrected the same way the generic kanjidic path is — the same
 * `historicalKana[token.text][reading]` lookup `lookupKanji` makes, keyed by
 * *kanji spelling* for the same cross-homonym-safety reason documented there,
 * and then the same `fullSizeKana` fold over what it does not cover.
 *
 * The lexicon's readings come from Wiktionary's classical conjugation tables
 * and are written historically already, which is the whole reason it is
 * preferred to kanjidic here — but only where the extraction found such a
 * table. Where it did not, the reading it fell back on is a modern one, and
 * 39 entries carry a small kana because of it (則 のっと, 仰 おっしゃ, 尊
 * たっと, 全 まった). Those reach the page through this function and nothing
 * else: `generator.ts` keeps the kanji in the running prose and shows only
 * the okurigana, so this is the one place a lexicon reading is displayed.
 *
 * …and the same *guard* on that lookup, which is what `kanjidicLookup.ts`
 * shares `seriesAmbiguousReading` for. The index records no series, so a
 * reading a character has in both of them cannot be looked up there at all —
 * 謂's kun stem い collided with its on'yomi イ, whose derived ゐ this
 * function then drew over the character: 謂 printed ゐフ where 謂ふ is いフ.
 * The generic kanjidic path has refused that lookup for as long as the index
 * has existed, and this path is where a character with a lexicon entry — 謂
 * has one, 四段ハ行 — went instead. */
function lexiconFurigana(
  token: Token,
  sentence: Sentence,
  historicalKana: HistoricalKanaIndex | null,
  kanjidic?: KanjidicIndex | null,
): string | undefined {
  const entry = VERB_LEXICON[token.lemma];
  // **The fixed form's own boundary, where the entry states one.** 曰 read as
  // the quotative is 曰(いは)く — the whole of いは over the character and only
  // the く beside it — while the very same entry's `reading` is the い that the
  // *naming* verb 曰(い)ふ conjugates on. One entry, two boundaries; see
  // `LexiconEntry.fixedFurigana`.
  //
  // The gate is the one the okurigana branch already spends on the same token
  // (`useFixedReading` in `renderSentence`), asked here rather than restated,
  // so that the ruby this function draws and the okurigana that branch writes
  // cannot divide the one word in two different places.
  const reading = entry?.fixedFurigana && !isNamingUse(token, sentence) ? entry.fixedFurigana : entry?.reading;
  if (!reading) return undefined;
  if (seriesAmbiguousReading(kanjidic, token.text, reading)) return fullSizeKana(reading);
  return historicalKana?.[token.text]?.[reading] ?? fullSizeKana(reading);
}

export function furiganaFor(
  token: Token,
  sentence: Sentence,
  resolve: ReadingResolver,
  historicalKana: HistoricalKanaIndex | null,
  /** Optional, and consulted for one thing only: whether the lexicon reading
   * below may be looked up in the historical-kana index at all (see
   * `lexiconFurigana`). Omit it — as a test with no index loaded does — and
   * every reading comes back exactly as it did before the guard existed. */
  kanjidic?: KanjidicIndex | null,
  /** The reading-order plan, and consulted for one thing only: the **one
   * paradigm whose furigana inflects**.
   *
   * ア行下二段 has no stem, so the kanji itself carries a different mora in each
   * form — 得(え)ず against 得(う) and 得(う)る (see `inflectedReading`). Every
   * other class answers with a reading that does not move, and for those this
   * is never spent at all.
   *
   * The plan rather than a form, because a form cannot be *given* here without
   * the two panels coming apart: the 訓読文 has one in hand at its call site and
   * the 書き下し文's ruby does not, and a furigana decided from two different
   * forms is precisely the divergence this shared function exists to prevent.
   * Handed the plan, both panels reach the same `decideConjForm` call this file
   * already makes beside the okurigana — so the kana over the character and the
   * kana beside it are one decision.
   *
   * Optional, and omitting it — as a test with no reading order does — gives
   * back the citation reading every caller got before this existed. */
  plan?: ReadingPlan,
): string | undefined {
  // Ahead of every rule below, for the same reason the resolver checks it
  // first: this is a correction of whatever they would have produced.
  const chosen = chosenReadingText(token);
  if (chosen) return chosen;
  const zi = ziReading(token, sentence);
  if (zi) return zi;
  const resolved = resolve(token, sentence);
  /** The reading as this token's own form writes it. The identity for every
   * paradigm but ア行下二段, and for every caller that passed no plan — so this
   * wraps the three lexicon-fed answers below without moving any of them. */
  const inForm = (reading: string | undefined): string | undefined => {
    if (reading === undefined || !plan) return reading;
    const lex = lexiconEntryFor(token, resolved, sentence);
    if (!readingInflects(lex?.conjClass)) return reading;
    // The very expression `renderSentence` spends on the okurigana beside this
    // reading — `rereadGovernedForm` first, `conjugationSubject` as the subject
    // of the question — so the two halves of the word cannot be written in two
    // different forms.
    const form =
      rereadGovernedForm(token.id, plan) ??
      decideConjForm(conjugationSubject(token, sentence), nextMeaningfulToken(plan, token.id), sentence, lex!.conjClass, resolve);
    return inflectedReading(lex!.conjClass, reading, form);
  };
  // A reading the *syntax* chose outranks the lexicon, which holds one
  // reading per lemma and so cannot express a choice that varies within the
  // sentence: 立 is たツ or たテル depending on whether it has an object, and
  // 破 is read on'yomi inside 大破. See `readingResolver.ts`'s `beatsLexicon`.
  // Consulted only for that flag, so every lemma nothing in the sentence
  // moved still goes through the lexicon exactly as before.
  // `usesLexiconEntry` is the same POS gate the okurigana branch below puts on
  // the same lookup — shared rather than restated, so the two cannot drift.
  // It was missing here, and the drift was on screen: 縛/驚/覺/解 arrive PROPN
  // from the parser, failing the gate below and passing this one, so each was
  // glossed with its lexicon kun'yomi in the prose (which reads its ruby from
  // this function) beside the resolver's on'yomi in the 訓読文.
  if (usesLexiconEntry(token) && VERB_LEXICON[token.lemma] && !resolved.beatsLexicon) {
    return inForm(lexiconFurigana(token, sentence, historicalKana, kanjidic));
  }
  // …and the same reading for an entry the *syntax* chose for a lemma
  // `VERB_LEXICON` does not hold at all. The predicate 以 is the case: its
  // paradigm comes from `predicateYiLexiconEntry` and its ending is written in
  // the okurigana slot by the branch that shares `lexiconEntryFor` with the
  // prose panel, so without this the character was drawn 以テス with nothing at
  // all over it — the reader's ruling puts もつ there.
  //
  // Under the same `beatsLexicon` stand-down as the line above (a reading the
  // syntax chose is `resolved.reading`, and the fall-through below is where it
  // belongs), and gated on the lexicon *not* holding the lemma so that no word
  // this function already answers for changes: a positive comparison 如/若
  // reaches `lexiconEntryFor` too, and both of those lemmas are in the table.
  if (usesLexiconEntry(token) && !VERB_LEXICON[token.lemma] && !resolved.beatsLexicon) {
    const chosen = lexiconEntryFor(token, resolved, sentence)?.reading;
    if (chosen) return inForm(fullSizeKana(chosen));
  }
  if (resolved.spellOutInProse && token.pos !== "PRON") return undefined; // written out in kana, so nothing goes over the character
  return inForm(resolved.reading || undefined);
}

/** One cell's worth of a span, per character of it: the text drawn in the
 * cell, the reading set over it, the kunten mark written below it, and the id
 * a click on it inspects.
 *
 * **A span is a run of characters, and the parser's rows are not all one
 * character wide.** This built one member per *token* and so drew 一番僧 as two
 * cells — 一, and a second cell holding both of 番僧 under a single ばんそう —
 * where the panel's whole convention for a compound is a cell and a reading per
 * character (see `compoundGroupCell`, and the fused-token branch in
 * `renderSentence`, which has always cut its one row into characters).
 *
 * Long-standing, and it is the *names* it fell on — 公叔文子, 王孫賈, 陳成子,
 * 蘧伯玉, 季桓子, 叔孫武叔, all of them rows the parser drew wider than one
 * character. Over `kanbun-info-parses.conllu`: 340 of 7,258 spans hold a row of
 * more than one character, 247 of them distinct words. The lexical-word branch
 * of `findCompoundSpans` did not introduce it — 206 of those 340 are spans that
 * branch has nothing to do with — but it is what brought it to the reader, who
 * had 番僧 standing alone until 一 was fused to it. `compoundCharacters` is
 * where the cut is made now, for this panel and for the ruby the 書き下し文 sets
 * over the same word.
 *
 * The two things a *row* owns rather than a character are settled exactly as
 * the fused-token branch settles them, and for its reasons: the row's kunten
 * mark goes below the last of its characters, which is where a reader following
 * the marks leaves the row from, and every character of a row carries that
 * row's id, so a click anywhere in 番僧 inspects the token 番僧 is.
 *
 * The fallback reading is asked about the character and not the row, since it
 * answers for one cell — but about the row itself wherever the row is one
 * character wide, so that no reading this panel already draws depends on a
 * copied token rather than the token the sentence holds. */
export function compoundSpanMembers(
  span: CompoundSpan,
  sentence: Sentence,
  glyphs: Map<number, string>,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): { text: string; furigana: string | undefined; kunten: string | undefined; id: number }[] {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const cells = compoundCharacters(span.tokenIds.map((id) => byId.get(id)!));
  const furiganas = compoundFurigana(
    cells.map((cell) => cell.text),
    span.text,
    jmdict,
    kanjidic,
    historicalKana,
    (i) => {
      const { token, text } = cells[i];
      return furiganaFor(token.text === text ? token : { ...token, text }, sentence, resolve, historicalKana, kanjidic);
    },
  );
  return cells.map((cell, i) => ({
    text: cell.text,
    furigana: furiganas[i],
    kunten: cell.tokenLast ? glyphs.get(cell.token.id) : undefined,
    id: cell.token.id,
  }));
}

/** Whether a compound's members are about to be pulled apart, and so need
 * the connecting line drawn between them.
 *
 * The line is not decoration and not a claim that these characters are one
 * word — the characters say that themselves, standing side by side. It is
 * there for the one case where standing side by side stops meaning it: the
 * kaeriten take the eye off the column, and a reader following them has to
 * be told that these two are read together anyway. Where nothing comes
 * between the members, nothing has to be said, and a line drawn there is a
 * mark on the page answering a question no reader asked.
 *
 * Two ways they come apart, and the second is the one that fires today:
 *
 *  - the reading order separates them — some other token is read between
 *    two characters that are written together. This cannot currently
 *    happen, and deliberately: `computeReadingOrder` is handed the same
 *    `findCompoundSpans` result this panel renders from, and emits a span's
 *    token ids together in source order wherever its carrier would have
 *    gone (see `emit` in reorderEngine.ts), so a span is contiguous in
 *    `plan.order` by construction. It is checked anyway because it is the
 *    thing the line is *for*, and because that guarantee lives in another
 *    file: if the engine ever places a member on its own, the line has to
 *    appear without anyone remembering to ask for it here. A single fused
 *    token's members share one id and can never be separated at all.
 *
 *  - a kaeriten lands between them. A mark is written below its character
 *    (rule 6), so a mark under any member but the last falls in a gap
 *    *inside* the group — the reader is being sent away from the column
 *    from a point halfway through the compound. That is exactly the case
 *    the line exists for. A mark under the last member sits after the
 *    whole group and takes the group with it, so it needs no line.
 *
 *    Which member carries a mark is a fact about the parse, not about the
 *    span: `buildKundokuGlyphMap` marks a splice group's `rankTokenIds`,
 *    and an INVERT group names the *last*-read token of each child (so a
 *    span read as a child is marked on its last member) but the span's own
 *    `carrierOf` where the span is the group's governor — and a carrier can
 *    be any member. 教誨其子 is the case: 教誨 is the governor of an
 *    inverted 其子, `carrierOf` picks 教 (誨 is attached to it from inside
 *    the span), and the ㆓ is written under 教, between the two characters. */
function compoundNeedsTie(members: { kunten: string | undefined; id: number }[], plan: ReadingPlan): boolean {
  if (members.slice(0, -1).some((m) => m.kunten)) return true;

  const ids = [...new Set(members.map((m) => m.id))];
  if (ids.length < 2) return false;
  const ranks = ids.map((id) => plan.order.indexOf(id));
  // A member the plan never places says nothing either way — treat the
  // group as whole rather than tying it on the strength of a missing id.
  if (ranks.some((rank) => rank < 0)) return false;
  return Math.max(...ranks) - Math.min(...ranks) !== ranks.length - 1;
}

/** Renders a compound's members (either a real multi-token span, or the
 * individual characters of a single token the tokenizer already fused —
 * see the two call sites in `renderSentence`) with exactly the same
 * conventions either way: each member is a plain, individually-spaced
 * `.kanji-cell` with its own furigana; one shared group-level okurigana
 * (case particle / extra ending, keyed off `groupToken`'s own dep/pos —
 * the span's carrier, or the token itself for a single fused token)
 * attaches only to the last member; `.compound-group` draws the kanbun
 * connecting line between the characters (see kunten.css), when the
 * kaeriten are about to break them up (see `compoundNeedsTie`). */
function compoundGroupCell(
  members: { text: string; furigana: string | undefined; kunten: string | undefined; id: number }[],
  groupToken: Token,
  lastMemberId: number,
  root: Token | undefined,
  plan: ReadingPlan,
  resolve: ReadingResolver,
  suru?: string,
): HTMLElement {
  // `suru` — the group's own サ変 ending, for a span JMdict lists as a
  // する-verb — stands *in place of* the copula/morph ending, not beside it,
  // mirroring the per-token lexicon branch below (which skips its own
  // `extraEndingFor` for the same reason): a word carrying its own conjugated
  // ending has said everything the sentence needs of it, and 蠕動シナリ is not
  // a form. Passed in rather than worked out here because only one of this
  // function's two call sites can have one — the other renders a single token
  // the *tokenizer* fused, which is not a span and has no span reading to
  // conjugate.
  const extra = suru === undefined ? extraEndingFor(groupToken, root, plan.sentence, true) : undefined;
  // The 連用形-て switch again, riding along with `selectedForm` exactly as it
  // does at generator.ts's matching span branch, and writing nothing at all
  // while it is off — see `renyouTe.ts`.
  const extraSelected = extra ? selectedForm(extra, plan, lastMemberId) : undefined;
  const extraEnding =
    extra && extraSelected !== undefined
      ? extraSelected.text + synthesizedRenyouTe(extraSelected, nextMeaningfulToken(plan, lastMemberId))
      : undefined;
  const groupOkurigana = withQuoteEnd(
    withCaseParticle(suru ?? extraEnding, groupToken, plan, resolve, lastMemberId),
    lastMemberId,
    plan,
  );
  const group = document.createElement("span");
  group.className = "compound-group";
  // A data attribute rather than a second class: the class is what makes
  // this a group at all (the positioning parent every member's geometry is
  // measured against, and what `positionCompoundLines` walks), and whether
  // the line is drawn is a state of that group rather than a different kind
  // of thing.
  //
  // It is also what decides whether the group may break across a column:
  // being one word is no reason to hold characters back from the column end
  // (a printed text wraps a compound like anything else), but a *tie* is a
  // mark drawn down the gap between the members, and a mark cannot be made
  // across a column boundary. So the constraint is hung off this same
  // attribute — see `.compound-group[data-tied]` in kunten.css — rather than
  // off a second test that could come to disagree with this one.
  if (compoundNeedsTie(members, plan)) group.dataset.tied = "true";
  members.forEach((member, i) => {
    const isLast = i === members.length - 1;
    group.append(cellFor(member.text, member.furigana, isLast ? groupOkurigana : undefined, member.kunten, member.id));
  });
  return group;
}

/** One blank character cell — 一字下げ, the indent a new paragraph takes in
 * Japanese typesetting.
 *
 * An element rather than a bare ideographic space, because this panel's
 * character spacing is a margin on `.kanji-cell` rather than letter-spacing
 * on an ancestor (see kunten.css): a plain space would occupy a glyph's
 * width but not the gap that follows it, so an indent of n cells came out
 * narrower than the n characters it is meant to line up with. */
function indentCell(): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "indent-cell";
  cell.textContent = "\u3000";
  return cell;
}

/** Reproduces the source's own line structure ahead of `token`.
 *
 * A `<br>` starts a new column here, this text being vertical: lines in the
 * source become columns on the page, which is what a line break *is* in
 * tategaki.
 *
 * Indentation is one blank cell per leading whitespace character in the
 * source, so what was typed is what appears, just measured in characters
 * rather than in spaces. A new paragraph takes one cell where the source
 * gave it none; where the source indented it, that indent stands rather
 * than being added to. */
/** How many blank cells a break takes: one per leading whitespace character
 * in the source, or — where the source gave a new paragraph none — the one
 * cell 一字下げ asks for.
 *
 * Its own function because the bare render has to take exactly the same
 * number (see `bareItemsFor`). The two draw the same line of the same text a
 * few hundred milliseconds apart, and an indent that changed width between
 * them would push the whole rest of the column sideways under the reader's
 * eye. */
function breakCellCount(layout: { breakBefore?: LineBreakKind; indent: number }): number {
  return layout.indent > 0 ? layout.indent : layout.breakBefore === "para" ? 1 : 0;
}

function appendSourceBreak(frag: DocumentFragment, token: Token): void {
  const layout = sourceLayoutOf(token);
  if (!layout) return;
  if (layout.breakBefore) frag.append(document.createElement("br"));
  const cells = breakCellCount(layout);
  for (let i = 0; i < cells; i++) frag.append(indentCell());
}

function renderSentence(
  sentence: Sentence,
  resolve: ReadingResolver,
  root: Token | undefined,
  plan: ReadingPlan,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): DocumentFragment {
  const glyphs = buildKundokuGlyphMap(plan);
  const spans = findCompoundSpans(sentence, { kanjidic, jmdict });
  // Which of this sentence's tokens stand inside a 《…》, read in source order
  // — which is the order this loop walks in, though the answer is kept by id
  // so that the compound branch and the fused-token branch can ask it too.
  // One sentence at a time, which is what bounds an unclosed 《; see
  // `titleReader`.
  const titles = titleSpansOf(sentence.tokens);

  const spanStart = new Map<number, CompoundSpan>();
  const spanMember = new Set<number>();
  for (const span of spans) {
    spanStart.set(span.tokenIds[0], span);
    for (const id of span.tokenIds) spanMember.add(id);
  }

  const frag = document.createDocumentFragment();

  for (const token of [...sentence.tokens].sort((a, b) => a.id - b.id)) {
    if (spanMember.has(token.id) && !spanStart.has(token.id)) continue; // already rendered as part of its span

    appendSourceBreak(frag, token);

    const span = spanStart.get(token.id);
    if (span) {
      // extraEndingFor's root check needs the *carrier* (the member that
      // actually carries the span's syntactic relation), but selectForm's
      // "what comes next in reading order" check needs the *last* member's
      // own position — the group's shared ending attaches after the whole
      // span, so it's the last member's neighbor (e.g. a following
      // negation), not the carrier's own neighbor, that decides mizen vs.
      // shuushi (君子 -> 君子ならずや, mizen from what follows 子, even
      // though 君 — the carrier — is what makes it root-nominal).
      const carrier = carrierOf(span, sentence);
      const lastMemberId = span.tokenIds[span.tokenIds.length - 1];
      const members = compoundSpanMembers(span, sentence, glyphs, resolve, jmdict, kanjidic, historicalKana);
      // A span JMdict lists as a する-verb conjugates サ変, exactly as 獨酌スル
      // and 封シテ do — 蠕動 was drawn as two bare characters until it did. The
      // string is `compoundSuruOkurigana`'s, shared with generator.ts's own
      // span branch so that the ending hung off this group's last member and
      // the one that panel prints after the same span cannot come apart.
      // The 連用形-て switch has to recover the form that string was
      // conjugated with, `compoundSuruOkurigana` returning only the string
      // itself — see `compoundSuruRenyouTe`, and generator.ts's matching span
      // branch, which spends it the same way. Off, it adds nothing.
      // **The title guard, mirroring `generator.ts`'s own.** A span that is a
      // whole unpunctuated sentence is a title and takes no morphology — see
      // `isUnpunctuatedTitleSpan`, and the reader's report that the rule had
      // reached the 書き下し文 and not this panel, which is exactly the kind of
      // divergence the two panels' shared helpers exist to prevent. Written as
      // the same call on the same two ids so the panels cannot answer it
      // differently.
      const suru = isUnpunctuatedTitleSpan(span.tokenIds[0], lastMemberId, plan)
        ? undefined
        : compoundSuruOkurigana(carrier, lastMemberId, plan, resolve);
      frag.append(
        compoundGroupCell(
          members,
          carrier,
          lastMemberId,
          root,
          plan,
          resolve,
          suru === undefined ? undefined : suru + compoundSuruRenyouTe(carrier, lastMemberId, plan, resolve, suru),
        ),
      );
      continue;
    }

    // The part of speech as well as the relation: a mark left alone in a
    // sentence of its own — which is what the segmenter does with a closing
    // quote after a full stop — heads that sentence and so is tagged ROOT,
    // and was being drawn as though it were a character of the text.
    if (token.dep === PUNCT_DEP || token.pos === "PUNCT") {
      // A title's own 《 and 》 are set as nothing at all: no glyph and no
      // cell, so the mark cannot take a place in the line, cannot stack in a
      // gap with the marks beside it (`indexPunctRuns`), and cannot be glued
      // to the character after it. What stands for it is the 傍線 the
      // characters between the pair wear — see `titleSpansOf`. The line break
      // a bracket may carry has already been appended above, so a source that
      // opened a column on one keeps its column.
      if (titles.marks.has(token.id)) continue;
      const cell = document.createElement("span");
      // `punct-cell` is what takes its advance away again: a mark of
      // punctuation is crammed into the space between two characters rather
      // than being given a place of its own in the line (rule 2 — see
      // kunten.css).
      cell.className = "kanji-cell punct-cell";
      cell.dataset.tokenId = String(token.id);
      const written = kundokuPunct(token.text, endsSentence(sentence, token));
      // A bracket is set a step below the rest of the apparatus — see
      // `.punct-cell[data-punct-bracket]` in kunten.css. Marked from the
      // written mark rather than the source one, since that is what is on
      // the page and what the rule colours.
      if (BRACKET_PUNCT.has(written)) cell.dataset.punctBracket = "true";
      cell.append(written);
      appendPunct(frag, cell, token.text);
      continue;
    }

    // The tokenizer itself sometimes fuses a nominal compound (e.g. 君子)
    // into one multi-character token instead of two linked by `flat` — from
    // the display's perspective this should look identical to a real
    // multi-token span either way (individual per-character furigana, one
    // connecting line, one shared okurigana on the last character), so it
    // goes through the exact same rendering, keyed off this one token's own
    // dep/pos throughout (there's only one token's worth of grammatical
    // information to go on).
    if (token.text.length > 1) {
      const chars = [...token.text];
      const tokenKunten = glyphs.get(token.id);
      // The hand-picked reading goes to `compoundFurigana` rather than being
      // left to the per-character fallback, because the two would ask for it
      // in different units: this one token's `misc` holds one reading for the
      // whole word, and `furiganaFor` — asked here about a single character
      // at a time, with the token's own `misc` still attached — hands that
      // whole-word reading back for *every* character. `compoundFurigana`
      // divides it across them instead, and (this is what keeps the fallback
      // safe) never reaches the fallback at all once it has one.
      const furiganas = compoundFurigana(chars, token.text, jmdict, kanjidic, historicalKana, (i) => furiganaFor({ ...token, text: chars[i] }, sentence, resolve, historicalKana, kanjidic), chosenReadingText(token));
      const members = chars.map((ch, i) => ({
        text: ch,
        furigana: furiganas[i],
        // Only one real token id exists for the whole fused run, so any
        // kunten mark it carries can only be shown once — attached to the
        // last character, same as the group's shared okurigana — and every
        // member shares that one token's own id for click-to-inspect.
        kunten: i === chars.length - 1 ? tokenKunten : undefined,
        id: token.id,
      }));
      frag.append(compoundGroupCell(members, token, token.id, root, plan, resolve));
      continue;
    }

    // Ahead of every branch below, which claim these characters on features
    // they genuinely have (未 is tagged Polarity=Neg, 須 comes through as an
    // auxiliary) and would print the second reading as this cell's own
    // okurigana — 未 rendered as 未ズ, with the negation sitting before the
    // verb it negates instead of after it. Both readings belong to this
    // character, but on opposite sides of it.
    if (isRereadUse(token, sentence)) {
      const entry = rereadCharacter(token.text)!;
      // The *second* reading is asked for and not read off the table, which is
      // the whole of what `entry.second` would be. 未's ず inflects for what
      // stands after the clause it closes on — before an assertive 也 it is the
      // ざり paradigm's 連体形 ざる — and `rereadSecondReading` is where that is
      // decided, for both panels. This one printed 未之有也 as
      // いまだこれ有ら**ズ** while the prose beside it wrote
      // いまだこれ有ら**ざる**なり, 175 characters of the gold apart, because it
      // took the string from the table the prose only starts from.
      //
      // The resolver travels with the plan for `isNominalizerAhead`'s reason —
      // a following 者 makes the ず attributive only under its nominalizing
      // reading — and the closing token the inflection is measured against is
      // the function's own to find (`rereadCloseId`): this cell is the 再読文字
      // itself, drawn where the character stands, and the clause it ends is
      // somewhere to its left.
      const second = rereadSecondReading(token, plan, resolve);
      // The *first* reading's own division, asked of the same function
      // `generator.ts` asks. This panel has always kept the character here; the
      // division is what puts the same kana beside it that the prose now writes
      // after it — 未[いま|ダ], where the prose writes 未だ. An entry that states
      // none keeps the whole reading in the furigana slot, as all of them did.
      const firstParts = rereadFirstParts(entry);
      frag.append(
        cellFor(
          token.text,
          firstParts ? firstParts.reading : entry.first,
          // Hiragana, as every other call site passes: `cellFor` katakana-izes
          // the okurigana slot itself.
          firstParts ? firstParts.okurigana : undefined,
          glyphs.get(token.id),
          token.id,
          false,
          second,
        ),
      );
      continue;
    }

    // A reading picked by hand outranks every context-specific reading below
    // it — the grammar-word branches, 子's and 於's special cases, and the
    // lexicon — because each of those is this app's own guess at what the
    // character is doing, and the choice is the reader overruling that guess.
    // They ignored it: 未 with ひつじ picked went on rendering as 未ズ, and the
    // whole point of picking a reading is that it appears.
    //
    // Behind the re-read check, not in front of it, since that consults the
    // choice itself (see `isRereadUse`) — a re-read reaching this line has
    // been left in its construction by that check, or was never in one.
    //
    // This branch's standing hazard — that sitting above everything means
    // silently skipping everything, which three separate bugs have come out
    // of — is written out at its twin in generator.ts. Read it before adding
    // a rule below this line.
    //
    // Furigana rather than the okurigana slot the branches below use, and the
    // kanji kept: a picked reading comes off the kanjidic candidate list, so
    // it is a dictionary reading of the character rather than a grammatical
    // gloss standing in for it (see `chosenReading`'s own note on the tag).
    //
    // The ending is inflected for where the character stands rather than left
    // in its dictionary form, and the sentence still gets whatever ending it
    // needs of this token — a synthesized なり/あり included, which this
    // branch used to drop by `continue`ing past `extraEndingFor`.
    // `pickedEnding` decides both, and is shared with generator.ts so the two
    // panels cannot come to disagree about them. Concatenated here rather
    // than kept apart, which is all the difference between the panels: a cell
    // has one okurigana slot, where the prose has a piece per part.
    const picked = chosenReadingParts(token);
    if (picked) {
      const ending = pickedEnding(picked, token, root, plan, resolve);
      // The 連用形-て switch, between the word's own ending and the synthesized
      // one exactly where generator.ts puts it (there they are separate
      // pieces; here one slot). `pickedEnding` now reports the form and class
      // it conjugated with, so this is told rather than made to re-derive them.
      // Off, it adds nothing. See `pickedRenyouTe`.
      const pickedTe = pickedRenyouTe(ending, nextMeaningfulToken(plan, token.id));
      // A picked **particle** takes the same two display moves an
      // override-sourced one does further down this loop (see the
      // `spellOutInProse` branch): its reading goes in the okurigana slot beside
      // the character rather than as furigana over it, and the cell is marked
      // `kanaOnly` so the prose panel writes the kana in place of the kanji.
      // Decided by `chosenSpellsOutInProse`, which generator.ts asks too — the
      // two panels must not disagree about one pin.
      const kanaOnly = chosenSpellsOutInProse(token);
      // **…except a sentence-final particle, which reads over the character.**
      // The two display moves above are one decision in `chosenSpellsOutInProse`
      // and they are two different questions — *does the prose drop the kanji*
      // and *which slot do the kana go in* — and a sentence-final particle
      // answers them differently: the prose writes や in place of 乎, and the
      // 訓読文 draws it over the character. That is the reader's own ruling (see
      // `SENTENCE_FINAL_WORD_LEMMAS`) and the discourse branch below has always
      // obeyed it; this branch, which stands *above* that one because a pick
      // outranks every guess the app makes, did not.
      //
      // What the reader saw: 乎's menu offers **か** as well as や, and choosing
      // it put か *beside* the character — where the identical か the app itself
      // chooses inside a 豈…乎 frame goes *over* it. One character, one reading,
      // two slots, decided by who picked it. `readsAsSentenceFinalWord` is the
      // one predicate both branches now ask.
      //
      // `kanaOnly` itself is unchanged and still true here, so the prose is
      // untouched — it writes か either way, which is what `generator.ts`'s own
      // picked branch already does through `chosenSpellsOutInProse`.
      const overCharacter = kanaOnly && readsAsSentenceFinalWord(token, sentence);
      const inOkuriganaSlot = kanaOnly && !overCharacter;
      const pickedOkurigana = (inOkuriganaSlot ? picked.reading : "") + ending.okurigana + pickedTe + ending.extra;
      frag.append(
        cellFor(
          token.text,
          inOkuriganaSlot ? undefined : picked.reading,
          withQuoteEnd(withCaseParticle(pickedOkurigana || undefined, token, plan, resolve), token.id, plan),
          glyphs.get(token.id),
          token.id,
          kanaOnly,
        ),
      );
      continue;
    }

    // 子: し ("master/teacher") unless it carries its own possessive
    // modifier, in which case こ ("child") — see `ziReading`. Checked here,
    // ahead of the generic kanjidic fallback below (which would otherwise
    // always give こ, kanjidic's own default reading, regardless of context).
    const zi = ziReading(token, sentence);
    if (zi) {
      frag.append(
        cellFor(
          token.text,
          zi,
          withQuoteEnd(withCaseParticle(withExtraEnding(undefined, token, root, plan), token, plan, resolve), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    // 於 always inverts before its governor and reads either より
    // (source/standard of comparison) or おいて (bare location) — see
    // `yuParts`, which is the one place the two senses are told apart.
    // Checked here, ahead of the generic override fallback below, purely so
    // this shares the same `withQuoteEnd`/okurigana treatment as the other
    // special-cased function words above rather than going through the plain
    // override lookup.
    //
    // The split `yuParts` returns is the split between the two slots, and it
    // is the same one `generator.ts` writes in the prose:
    //
    //  - **より is a case particle**, so it carries no reading of its own and
    //    the character is not written at all in the prose — 取之於藍 is
    //    藍より取る. Okurigana slot only, and `kanaOnly`, which is what tells
    //    `texAnnotation.ts` the prose drops this kanji.
    //  - **おいて is a verb form and keeps its kanji** — 日中に於いて, never
    //    日中におい て. お goes over the character and いて beside it, so the
    //    two panels show the same word, and the cell is *not* `kanaOnly`: the
    //    prose writes 於 out. The boundary is お + いて and not おい + て — see
    //    `yuParts` for KANJIDIC2's two entries and why 於ける settles it.
    const yu = yuParts(token, sentence);
    if (yu) {
      frag.append(
        cellFor(
          token.text,
          yu.reading,
          withQuoteEnd(yu.okurigana, token.id, plan),
          glyphs.get(token.id),
          token.id,
          yu.reading === undefined,
        ),
      );
      continue;
    }

    // Sentence-final particles, postposed negation, and modal auxiliaries
    // (可/能/須/當/應/欲) are all grammatical markers, not an independent
    // word's dictionary reading — their reading goes in the *okurigana*
    // slot (katakana, bottom-right), never furigana, same convention as
    // real kanbun annotation. All three also get their reading from the
    // same single source of truth the kakikudashi generator uses
    // (sentenceFinalParticle/NEGATION/AUXILIARY_LEMMAS+selectForm), rather
    // than whatever readingResolver's independently-curated override table
    // happens to give, so the two panels can't silently disagree — and
    // 可's mizenkei chains correctly before a following negation (不可 ->
    // べからず), not a bare "べし"+ず.
    // `isSentenceFinalParticleUse` stands beside the dep test, not in place of
    // it, and for the reasons generator.ts's copy of this condition gives: the
    // dep test admits every `discourse@sp` token whether or not the table knows
    // its lemma, and the predicate adds the one particle the parser mis-tags —
    // 否 in 君飲嘗不醉否？, which arrives VERB/`comp:obj` and was showing the
    // verb 否ム. Both panels test the same thing here so that neither can read
    // the character differently from the other.
    //
    // **`discourse@sp` alone**, the same narrowing generator.ts's copy carries
    // and made at the same time: bare `discourse` is the sentence-*initial*
    // marker, not a sentence particle, and admitting it drew カナ over a 夫 that
    // opens its sentence and left 其 and 蓋 with no annotation at all. Both
    // panels must move together here — a 夫 read それ in the prose and かな in
    // the ruby is exactly the split this shared condition exists to prevent.
    //
    // **And a third condition beside those two**: the 也 of the `AB也者` frame,
    // read なる. 14 of its 80 gold tokens wear `mod`/`comp:obj` and reach
    // neither test, and the resolver's 提示 entry was drawing ヤ over them.
    // `generator.ts` carries the identical third condition — a 也 read なる in
    // the prose and ヤ in the ruby is exactly the split this shared condition
    // exists to prevent. See `isPresentativeCopula`.
    if (
      token.dep === "discourse@sp" ||
      isSentenceFinalParticleUse(token, sentence) ||
      isPresentativeCopula(token, sentence)
    ) {
      // A particle whose kana are read *in place of the character* gets them
      // over it, not beside it: 乎 reads as や (or か), 也 as なり, 耳 as のみ and
      // 哉 as かな, each of them a word of the sentence the way これ is a reading
      // of 之. **Every particle the table reads is one of these**, on the
      // reader's own ruling — see `SENTENCE_FINAL_WORD_LEMMAS`, whose closing
      // note is where that is stated and which is built as every entry with a
      // non-empty reading. (An earlier sentence here named 乎's や and 哉's かな
      // as *endings completing the predicate they follow*, and so as the other
      // side of the division. That division is gone: the set has held them since
      // the reader overturned it, and the comment was left behind.) 矣 is on
      // neither side and needs no rule, reading as the empty string.
      // The quote-closing ト stays in the okurigana slot either way — it
      // attaches after the word, not over the character.
      // Suppressed where it would repeat the predicate's own copula (君子仁也
      // is 君子仁なり, not 仁なりなり) — see `repeatsPredicateCopula`.
      // `sentenceFinalParticleFor`, not the bare table lookup: which particle
      // a 乎 reads depends on its sentence, not on its lemma alone — a 乎 in a
      // clause carrying a rhetorical 豈 reads か rather than the default や.
      // The prose panel already asks the sentence-aware question, so the bare
      // lookup here was a live divergence (數有りか against 乎[や]).
      const particle = (repeatsPredicateCopula(token, sentence) ? "" : sentenceFinalParticleFor(token, sentence)) || undefined;
      // Asked through `readsAsSentenceFinalWord` rather than off the set
      // directly, because the hand-picked branch above has to reach the same
      // answer and cannot re-derive the two conditions that got the token here.
      const overCharacter = particle !== undefined && readsAsSentenceFinalWord(token, sentence);
      frag.append(
        cellFor(
          token.text,
          overCharacter ? particle : undefined,
          withQuoteEnd(overCharacter ? undefined : particle, token.id, plan),
          glyphs.get(token.id),
          token.id,
          true,
          undefined,
          // Only where the particle went beside the character: read *over* it
          // it is the furigana, and the menu already names it from there.
          overCharacter ? undefined : particle,
        ),
      );
      continue;
    }
    if (isNegationUse(token)) {
      frag.append(
        cellFor(
          token.text,
          undefined,
          // `negationEnding`, not `negationForm`: everything a negation piece
          // writes, which is the ず/ぬ/ざる *and* the case particle owed by the
          // clause it closes. A negation is postposed past its predicate, so on
          // a negated clause the predicate is no longer what stands at the
          // clause's end and the particle written there lands inside the
          // negation — 苦不得飲 drew 得 に ズ. The ざる carries it instead, and
          // 不 reads ザルニ. Calling the one function `generator.ts` calls also
          // closes a divergence this site had on its own: it never passed
          // `rereadGovernedForm`, which that panel did.
          // The resolver goes with it, for the ぞ inside an interrogative word:
          // 何ぞ〜ざる is 係り結び and the ざる is decided from the reading, which
          // `negationEndingParts` cannot see on its own. `generator.ts` passes
          // the same one, so the two panels cannot write different negations.
          withQuoteEnd(negationEnding(token, plan, resolve), token.id, plan),
          glyphs.get(token.id),
          token.id,
          true,
          undefined,
          // The paradigm's own citation, which is the one thing the four
          // forms `negationForm` chooses between have in common — see
          // `cellFor`'s `kanaReading`.
          NEGATION.primary,
        ),
      );
      continue;
    }
    const aux = auxiliaryFormFor(token, sentence);
    if (aux) {
      const selected = selectedForm(aux, plan, token.id);
      const auxTe = synthesizedRenyouTe(selected, nextMeaningfulToken(plan, token.id));
      // 可's own division, asked of the same function `generator.ts` asks — べ
      // over the character and からず beside it, where that panel writes
      // 可からず. Every other auxiliary comes back undefined and keeps the
      // kana-only slot it has always had; see `KANJI_RETAINED_AUXILIARIES`.
      const retainedAux = retainedAuxiliaryParts(token.lemma, selected.text);
      const auxOkurigana = (retainedAux ? retainedAux.okurigana : selected.text) + auxTe;
      frag.append(
        cellFor(
          token.text,
          retainedAux?.reading,
          withQuoteEnd(auxOkurigana, token.id, plan),
          glyphs.get(token.id),
          token.id,
          !retainedAux,
          undefined,
          // `primary`, not the `selected` form above: 令 written シメ and 使
          // written シム are one word, しむ, and that is the word the menu
          // offers. Withheld where the reading is drawn over the character
          // instead, which is where the menu can already see it — the same
          // division the override branch below makes for a split entry.
          retainedAux ? undefined : aux.primary,
        ),
      );
      continue;
    }
    // て/して liaison (see `teOrShite`) — same shared decision the
    // kakikudashi generator uses, so both panels render the same gloss.
    if (token.lemma === "而") {
      // `reading` is set only where 而 is read as a word of its own (而して),
      // and goes over the character; て and して are endings and sit beside it.
      // The resolver goes with it, for the reason `generator.ts` gives at the
      // same call: the stand-down over a preceding span's にして is decided in
      // part by a dictionary fact. Both panels must ask it the same way.
      const eru = teOrShite(plan, token.id, resolve);
      frag.append(
        cellFor(
          token.text,
          eru.reading,
          withQuoteEnd(eru.okurigana, token.id, plan),
          glyphs.get(token.id),
          token.id,
          true,
          undefined,
          // て and して are one word — the connective ending, its し supplied by
          // liaison after a negation, which is what `EruConnective` says they
          // are — so both name the same menu entry. Only where nothing is read
          // over 而 itself: 而して is 而's own reading and stands in the
          // furigana slot, where the menu can already see it.
          eru.reading || !eru.okurigana ? undefined : CONVERB.primary,
        ),
      );
      continue;
    }

    // Gated on `usesLexiconEntry` — a lexicon entry represents that lemma's
    // verb/adjective/copula sense specifically (its conjugation), not every
    // use of the character; see that predicate for what the gate admits and
    // why the same call stands in `furiganaFor` above and in generator.ts's
    // matching branch, so all three ask one question and the two panels
    // cannot silently disagree about a character.
    // `beatsLexicon` stands the lexicon down for a reading the syntax chose,
    // matching `furiganaFor` above and the generator's own copy of this
    // condition. That reading then supplies a stand-in entry of its own
    // (`syntheticLexiconEntry`, the same helper generator.ts calls) carrying
    // the class the stood-down entry was holding, so it is still conjugated
    // here rather than shown in citation form — 立㆑たテ before a following て,
    // not 立㆑たツ.
    // …and a タリ suffix reaches it by its own gate instead, `usesLexiconEntry`
    // having no arm a PART-tagged 然 can pass and `VERB_LEXICON` holding the
    // standalone 然り for it. All of that now lives in `lexiconEntryFor`, one
    // function shared with generator.ts's identical branch rather than a
    // ternary copied into each — which is the same reason the three sites
    // already share `usesLexiconEntry` itself.
    const resolvedForLex = resolve(token, sentence);
    // The sentence goes with it for the one entry chosen by syntax rather than
    // by lemma — a positive comparison 如/若 is ごとし and a negated one 如く.
    // Passed here as well as in generator.ts because the two panels must not
    // inflect one character by two paradigms; see `comparisonLexiconEntry`.
    const lex = lexiconEntryFor(token, resolvedForLex, sentence);
    if (lex) {
      // Same okurigana verbLexicon.ts/classicalConjugation.ts pipeline the
      // kakikudashi generator uses, so both panels agree — e.g. 知 before a
      // postposed 不 shows conjugated ラ (mizenkei), not the dictionary-form
      // ル a static kanjidic lookup would give. Applied *after* the form is
      // decided, never before it (conjugatedOkurigana takes the form as an
      // input, not the other way around).
      // extraEndingFor (copula/morph-ending) deliberately not applied here:
      // generator.ts's own VERB_LEXICON branch `continue`s before reaching
      // its extraEndingFor check too (a lexicon entry is POS=VERB/ADJ, so
      // the copula check wouldn't fire anyway). `converbSuffix` is the one
      // morph-driven ending a lexicon word *does* still need — see its own
      // doc for why VerbForm=Conv specifically can't just go through
      // extraEndingFor like the copula case does.
      // A hand-picked reading never reaches here — it is taken by its own
      // branch, far above, ahead of every context-specific reading including
      // this one.
      const nextForLex = nextMeaningfulToken(plan, token.id);
      const useFixedReading = lex.fixedReading && !isNamingUse(token, sentence);
      // Named rather than written inline into `conjugatedOkurigana` because
      // `converbSuffix` below now needs the same answer: a 已然形 takes ば and
      // must not also take て, and the form is the only thing that says so.
      // One evaluation, so the ending and the て cannot be decided from two
      // different forms — the discipline `lex.conjClass` is already passed by.
      const lexForm =
              // A governing 再読文字 dictates the form outright — 未 wants
              // 未然形 whatever else follows — and is consulted ahead of the
              // ordinary context rules, exactly as generator.ts does. Without
              // it the two panels disagreed about the same character: 未來
              // read いまだ來たらず in the kakikudashibun and きタル in the ruby,
              // the second reading being no token of its own for
              // `decideConjForm` to see following the predicate.
              // The resolver goes through with it, exactly as it does in
              // generator.ts: a following 者 is attributive only under its
              // もの reading, and nothing but the resolver knows which of its
              // two readings this one took (see `isNominalizerAhead`).
              // The subject of the form question is `conjugationSubject`, not
              // the token itself — a タリ suffix writes its group's ending while
              // the stem is what holds the group onto the sentence. Same
              // substitution generator.ts makes, and `nextForLex` stays this
              // token's own neighbour in both.
        rereadGovernedForm(token.id, plan) ??
        decideConjForm(conjugationSubject(token, sentence), nextForLex, sentence, lex.conjClass, resolve);
      const conjugated = useFixedReading ? lex.fixedReading! : conjugatedOkurigana(lex, lexForm);
      // A form the entry states **whole** takes neither connective below — the
      // string is a finished word rather than a stem awaiting one. Asked here
      // and in generator.ts's matching branch, off the same entry and the same
      // form, so the two panels write the same okurigana. See
      // `writesStatedForm`, and `PREDICATE_YI` (以て, where the paradigm gives
      // 以てし and the 連用形-て switch gave 以てして).
      const stated = !useFixedReading && writesStatedForm(lex, lexForm);
      const converbTe = stated
        ? ""
        :
        // `lex`'s own class, the one the okurigana above was conjugated with —
        // never a fresh lookup, which would test the shape of a 連用形 this
        // token did not take. Undefined on the `fixedReading` path, which has
        // no paradigm at all, and that is the right answer there. Same
        // argument generator.ts passes, so the two panels cannot disagree
        // about whether the て is written — and the form beside it, for the
        // same reason, so they cannot disagree about the 已然形 either.
        converbSuffix(token, nextForLex, lex.conjClass, lexForm);
      // The 連用形-て switch, spent beside `converbSuffix` and passed exactly
      // what generator.ts's matching branch passes it, so the okurigana this
      // panel hangs off the character and the prose that panel prints cannot
      // come apart. Off by default, and then this adds nothing — see
      // `renyouTe.ts`. Withheld on the `fixedReading` path, where `lexForm`
      // was used to write nothing: that entry is invariant, and generator.ts
      // leaves the branch before its own call for the same reason.
      const okurigana =
        conjugated +
        converbTe +
        (useFixedReading || stated
          ? ""
          : renyouTeSuffix({ form: lexForm, conjClass: lex.conjClass, okurigana: conjugated, converbTe, nextToken: nextForLex }));
      frag.append(
        cellFor(
          token.text,
          // `furiganaFor`, not `lexiconFurigana` directly: a synthesized
          // entry's reading is the resolver's, already historical-kana
          // corrected there, while a real entry's is the lexicon's and still
          // needs correcting. `furiganaFor` is where that fork is already
          // decided (on the same `beatsLexicon` this branch keys off), so
          // going through it keeps one answer to "what is this token's
          // furigana?" rather than a second copy that could disagree.
          // The plan goes with it, and only here: this is the branch that
          // conjugates, and ア行下二段's furigana moves with the very form the
          // okurigana above was written in (see `furiganaFor`'s `plan`).
          furiganaFor(token, sentence, resolve, historicalKana, kanjidic, plan),
          withQuoteEnd(withCaseParticle(okurigana || undefined, token, plan, resolve), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    const resolved = resolve(token, sentence);

    // Ahead of the override branch below, and standing it down for the
    // kanji-retained adverbs — the same order `generateKakikudashi` puts these
    // two in, and for the same reason.
    //
    // These words reach this panel through the override table (they are in it),
    // so `spellOutInProse` was true for them and the branch below drew the whole
    // reading as one katakana run in the okurigana slot, with no furigana and
    // the cell tagged `kanaOnly` — 亦 came out マタ beside a bare 亦. That tag is
    // a claim that the prose drops the character, and `KANJI_RETAINED_ADVERBS`
    // is precisely the statement that it does not: the prose panel writes 亦 and
    // 必ず. An adverb is a content word with a dictionary reading of its own,
    // exactly as an adjective is, so it is annotated the way one is — the
    // reading over the character, the table's okurigana beside it — and the cell
    // is not `kanaOnly`, because the character survives into the prose.
    //
    // `retainedAdverbParts` is that split, and it lives beside the table in
    // `classicalEnding.ts` so the two panels and the furigana menu divide the
    // word in one place (see `KANJI_RETAINED_ADVERBS`). The okurigana it
    // divides at is KANJIDIC2's own dot, read out of the index by the resolver
    // and arriving on the resolved reading — the same value the prose panel
    // appends, from the same place, so the two cannot drift. It declines where
    // the resolver's reading does not end in that okurigana, which is what
    // keeps a reading the table does not describe out of it: 必 arrives from
    // the kanjidic path already divided into かなら + ず, so its reading ends in
    // neither, and it is drawn by the ordinary furigana branch below exactly as
    // it always was.
    //
    // `retainedAdverbApplies` is the same stand-down the prose panel's own call
    // makes, because it is the same call: a reading the *syntax* chose is not
    // this adverb's own word (獨酌 is どく・しやく, not 獨り酌), and neither is a
    // token of a listed character standing in a role the table does not name (與
    // is と on 1,406 prepositional tokens against 61 comitative ones). Both
    // conditions live beside the table in `classicalEnding.ts`, so the two panels
    // divide these words on one answer rather than on two.
    const retainedAdverb = retainedAdverbApplies(token.lemma, resolved)
      ? retainedAdverbParts(resolved.reading, resolved.retainedAdverbOkurigana)
      : undefined;
    if (retainedAdverb) {
      frag.append(
        cellFor(
          token.text,
          retainedAdverb.reading,
          // No `withExtraEnding`: the table's okurigana is the whole of this
          // word's ending, exactly as the prose panel's own branch treats it
          // (it pushes its piece and closes the token without consulting the
          // morph-driven ending at all).
          withQuoteEnd(withCaseParticle(retainedAdverb.okurigana || undefined, token, plan, resolve), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    // readingResolver's override table is mostly the curated set of kanbun
    // grammar words (case-marking particles, etc.) whose "reading" is a
    // Japanese grammatical gloss rather than the character's own dictionary
    // pronunciation — same distinction generator.ts already makes
    // (kanji-retained vs. kana-only) to decide whether a word keeps its
    // kanji in kakikudashi. Here it decides which annotation slot the
    // reading goes in: furigana for a real dictionary reading (kanjidic/
    // jmdict) OR a pronoun (之/我/自 etc. — a pronoun is a genuine word with
    // its own reading, not a grammatical inflection marker, even though its
    // reading happens to live in the override table); okurigana for
    // everything else the override table covers (particles, sentence-final
    // markers).
    // Same "override" source condition generateKakikudashi keys its
    // kanji-drop off (see cellFor's `kanaOnly` doc) — computed once here so
    // both branches below tag their cell identically regardless of which
    // display slot (furigana vs. okurigana) the reading itself lands in.
    const kanaOnlyInProse = !!resolved.spellOutInProse;
    if (resolved.spellOutInProse && token.pos !== "PRON") {
      // No withExtraEnding here — the override table's entries are already
      // complete, self-contained grammatical glosses, so e.g. 以's own
      // VerbForm=Conv morph must not *also* tack on a further て (もってて)
      // on top of もって, which already carries that sense.
      // An override entry that supplies its own `okurigana` is declaring a
      // split rather than a single gloss: 毎 is ごと — a reading of the
      // character itself, so furigana — followed by the ending に. An entry
      // with no okurigana of its own is the other kind, a whole gloss
      // standing in for the character, which belongs in the okurigana slot
      // entire. Both still read as bare kana in the prose panel, which is
      // what `kanaOnlyInProse` above is for and why this only moves the
      // annotation slot, not the kakikudashi.
      const split = resolved.okurigana !== undefined;
      const okurigana = split ? resolved.okurigana! : (resolved.reading ?? "");
      frag.append(
        cellFor(
          token.text,
          split ? resolved.reading || undefined : undefined,
          withQuoteEnd(withCaseParticle(okurigana || undefined, token, plan, resolve), token.id, plan),
          glyphs.get(token.id),
          token.id,
          kanaOnlyInProse,
          undefined,
          // Only on the unsplit entry — the split one wrote its reading over
          // the character, where the menu can already see it.
          split ? undefined : resolved.reading || undefined,
        ),
      );
    } else {
      // A 形容動詞 tagged ADV lands here, its 連用形 written by the resolver
      // rather than by the conjugation pipeline — 暴 in 忽覺咽中暴癢 is 暴(には)カニ.
      // That に is the ナリ活用 paradigm 連用形 the 連用形-て switch is chiefly
      // about, and generator.ts spends it at its own matching fallback so the
      // two panels write the same word. Off, it adds nothing, and the okurigana
      // below is then `resolved.okurigana` untouched — `undefined` included.
      const adverbialTe = adverbialRenyouTe(token, resolved, nextMeaningfulToken(plan, token.id));
      const withAdverbialTe = adverbialTe ? (resolved.okurigana ?? "") + adverbialTe : resolved.okurigana;
      frag.append(
        cellFor(
          token.text,
          resolved.reading || undefined,
          // `endingComplete` skips the morph-driven ending for a reading that
          // already carries all of its own — the same exemption the override
          // branch above makes, reached by a different route. See its doc.
          withQuoteEnd(
            withCaseParticle(
              resolved.endingComplete ? withAdverbialTe : withExtraEnding(withAdverbialTe, token, root, plan),
              token,
              plan,
              resolve,
            ),
            token.id,
            plan,
          ),
          glyphs.get(token.id),
          token.id,
          kanaOnlyInProse,
        ),
      );
    }
  }

  markTitleCells(frag, titles);
  return frag;
}

/** Puts the 傍線 class on every cell of a title, whatever branch above drew
 * it.
 *
 * A pass over the finished fragment and keyed by token id, rather than a line
 * added to each of the branches: a title's characters reach the page as plain
 * cells, as members of a `.compound-group` (書名 are nominal, and 論語 is
 * exactly the kind of pair `findCompoundSpans` ties), and as the several cells
 * a tokenizer-fused token is spread over — three shapes, one of which is
 * nested two deep, and all three of which carry the id on the cell already.
 *
 * The punctuation inside a title is marked too, though it draws no line of its
 * own: a `.punct-cell` takes no advance, so the line bridging the gap it sits
 * in is the previous character's, and what the mark has to do is not *end* the
 * run — see `closeTitleRuns`. */
function markTitleCells(root: ParentNode, titles: TitleSpans): void {
  if (titles.inside.size === 0) return;
  for (const cell of root.querySelectorAll<HTMLElement>(".kanji-cell[data-token-id]")) {
    if (titles.inside.has(Number(cell.dataset.tokenId))) cell.classList.add(TITLE_CLASS);
  }
}

/** Marks the last character of each title, which is the one whose line stops
 * at its own foot instead of running on into the gap after it.
 *
 * The line is drawn per character and has to be continuous over a run of them,
 * so each character's line reaches a whole `--kanji-gap` past its own foot —
 * to the next character's head — and the last one must not (see
 * `.kanji-cell.title-line` in kunten.css). Nothing in CSS can ask "is the next
 * cell in the column also in this title": the cells of a title are not always
 * siblings (a `.compound-group` and a `.no-break-unit` both nest them), and
 * document order across the whole column is the only place the run is visible
 * as a run — the same reason `indexPunctRuns` is a pass and not a rule.
 *
 * Re-run over the whole column whenever a wave of the parse replaces a region
 * of it, and so it clears its own marks first: a run whose members changed
 * must not keep an ending it had before. */
function closeTitleRuns(column: HTMLElement): void {
  for (const marked of column.querySelectorAll<HTMLElement>("[data-title-end]")) delete marked.dataset.titleEnd;
  /** The last cell seen that is in a title *and* draws a line — a punct cell
   * inside one draws none and so can never be a run's end. */
  let last: HTMLElement | null = null;
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    if (cell.classList.contains(TITLE_CLASS)) {
      if (cell.querySelector(".kanji-glyph")) last = cell;
      continue;
    }
    if (last) last.dataset.titleEnd = "true";
    last = null;
  }
  if (last) last.dataset.titleEnd = "true";
}

/** Sets each tied `.compound-group`'s `--line-top`/`--line-bottom`
 * (consumed by kunten.css's `::before` connecting line) from the *actual*
 * rendered position of its first and last `.kanji-glyph` — not the group's
 * own box, which also includes ruby/kunten annotations that can make a
 * member taller without making the glyph itself any taller (see
 * kunten.css's doc).
 *
 * The first glyph's *foot* and the last glyph's *top*, not their centres:
 * the line lives in the gaps between the characters and never runs beside
 * one (see the `::before` rule, which paints only the gaps out of the span
 * these two leave). Measured rather than written down for the reason the
 * centres were: what the two ends have to be flush with is where the glyphs
 * actually landed.
 *
 * Must run after the tree is attached to the real document
 * (`container.append` below) — `getBoundingClientRect` on a still-detached
 * `DocumentFragment` returns all-zero rects, so this can't happen inside
 * `compoundGroupCell` itself while the group is still being assembled
 * off-document. Untied groups are skipped: they draw nothing, so there is
 * nothing to place. */
export function positionCompoundLines(root: HTMLElement): void {
  for (const group of root.querySelectorAll<HTMLElement>(".compound-group[data-tied]")) {
    const cells = group.querySelectorAll<HTMLElement>(".kanji-cell");
    const firstGlyph = cells[0]?.querySelector<HTMLElement>(".kanji-glyph");
    const lastGlyph = cells[cells.length - 1]?.querySelector<HTMLElement>(".kanji-glyph");
    if (!firstGlyph || !lastGlyph) continue;
    const groupRect = group.getBoundingClientRect();
    const top = firstGlyph.getBoundingClientRect().bottom - groupRect.top;
    const bottom = groupRect.bottom - lastGlyph.getBoundingClientRect().top;
    group.style.setProperty("--line-top", `${top}px`);
    group.style.setProperty("--line-bottom", `${bottom}px`);
  }
}

/** Real 行末禁則 (kinsoku shori) forbids an opening quote/bracket from
 * *ending* a column, even though it's the one class of punctuation allowed
 * to *start* one (see `OPENING_PUNCT`/`appendPunct`'s own 行頭禁則 handling
 * for every other punctuation mark) — plain CSS line-breaking can't apply
 * that rule to `.kanji-cell`'s opaque atomic boxes any more than it can the
 * closing-punct case, so this is a DOM pass over the whole finished column,
 * gluing any still-standalone opening-punct cell to whatever rendered unit
 * immediately follows it — crossing a `.sentence-gap` boundary if that's
 * where it falls (`querySelectorAll` here returns every sentence's
 * top-level cells/groups flattened into one document-order sequence, and
 * `Node.append` moves a node into a new parent regardless of where it
 * started, so this works the same whether or not that boundary is
 * crossed). Run once after the whole tree is built rather than threaded
 * through `renderSentence`'s many append call sites — the finished DOM
 * already has everything this needs to know (is this cell an opening-punct
 * cell; is there anything after it). Two consecutive opening-punct cells
 * (「『, vanishingly rare) still end up transitively glued: the second
 * merge finds the first one already moved inside a `.no-break-unit` and
 * simply nests a further one there, `replaceWith` following it to its
 * current parent either way. */
/** Numbers each mark of punctuation by how many marks already share the gap
 * it is being crammed into, so `.punct-cell` can set them beside each other
 * across the column (see its rule in kunten.css). A mark's index is 0 unless
 * the cell before it is itself a mark, and an index of 0 is left unset: the
 * first mark of a run is drawn exactly where a lone mark is, and only the
 * ones after it move.
 *
 * A pass over the finished column rather than a count kept while building,
 * for two reasons the DOM makes plain: consecutive marks are not siblings —
 * `appendPunct` nests each glued unit inside the last, so 之。」 puts the 」
 * beside a wrapper rather than beside the 。 — and a run can cross a
 * sentence, this parser leaving a closing quote after a full stop alone in a
 * sentence of its own. Document order is the only place the run is visible
 * as a run, and it is exactly what a pass over it reads. */
function indexPunctRuns(column: HTMLElement): void {
  let run = 0;
  /** The character the run hangs off, whose kaeriten (if it has one) is the
   * only thing under a closing bracket that the raise has to clear. */
  let host: HTMLElement | null = null;
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    if (!cell.classList.contains("punct-cell")) {
      run = 0;
      host = cell;
      continue;
    }
    if (run > 0) {
      cell.style.setProperty("--punct-index", String(run));
      // A closing bracket rides a third of a character higher than the stack
      // puts it — see `.punct-cell[data-punct-raised]` in kunten.css. Marked
      // here rather than matched in CSS because the raise applies only to a
      // bracket that *follows* another mark: a lone one keeps the place every
      // lone mark keeps, and a stylesheet cannot ask whether the custom
      // property above was set.
      if (BRACKET_PUNCT.has(cell.textContent ?? "") && !OPENING_PUNCT.has(cell.textContent ?? "")) {
        // How far it rides depends on what is under it. A kaeriten is the one
        // thing in that space, and with no kaeriten to clear the bracket takes
        // the whole half character, tucking right up under the mark it
        // follows; with one, it takes the sixth that leaves the mark its room.
        cell.dataset.punctRaised = host?.querySelector(".kunten-glyph") ? "kaeriten" : "full";
      }
    }
    run += 1;
  }
}

function glueOpeningPunctForward(column: HTMLElement): void {
  const units = Array.from(column.querySelectorAll<HTMLElement>(".sentence-gap > *"));
  for (let i = 0; i < units.length - 1; i++) {
    const el = units[i];
    if (!el.classList.contains("kanji-cell") || !OPENING_PUNCT.has(el.textContent ?? "")) continue;
    const next = units[i + 1];
    const glued = document.createElement("span");
    glued.className = "no-break-unit";
    el.replaceWith(glued);
    glued.append(el, next);
  }
}

/** Everything a character hangs below itself — the reading, the okurigana,
 * a 再読文字's second reading, the kaeriten, the 踊り字. `.kanji-cell` and
 * `.kanji-glyph` are both exactly one character tall whatever they carry
 * (every annotation is out of flow), so none of these is inside any box that
 * could be measured instead.
 *
 * The 踊り字 belongs here for the same reason the kaeriten does, and reaches
 * exactly as far: both are pinned at `top: 100%` and are one em of the
 * annotation size tall, so both bottom out one `--size-furigana` — 14.67px —
 * below the character's foot.
 *
 * Which is not always shallower than the reading that produced it, so it is
 * not a formality. A reading with nothing else in its lane is *centred*
 * against its character rather than hung from its top; 益's ますます, four kana
 * on a 44px character, reaches 14.66px past the foot, which is the 踊り字's own
 * depth to the pixel — the two now bottom out level, three kana coming to the
 * character exactly.
 *
 * And on 酒蟲 the deepest thing on the page is neither: it is a two-mark
 * kaeriten, 一 over レ, two `--size-kunten` glyphs stacked below the foot for
 * 32px. That is what `--annotation-overhang` currently holds, and it is why
 * these five selectors are a list rather than the readings alone. */
const ANNOTATION_PARTS = ".furigana, .okurigana, .reread-second, .kunten-glyph, .odoriji";

/** Publishes how far the deepest annotation on the page reaches below its
 * character's foot, which is what the panel has to leave room for below the
 * last character of a column (see `--panel-margin-bottom` in
 * typography.css, which takes the larger of its own margin and this).
 *
 * The panel's height is rounded down to a whole number of characters, and
 * what a column leaves after its last character is that character's own gap
 * — 44px at the current scale, sized for the *character* and not for what
 * hangs off it. (It was that gap plus an 11px bottom margin until the two
 * panels' margins were made to sum to the one above them; the margin is zero
 * now unless this measurement is what raises it, which is the whole of what
 * it is still for.) A reading is pinned to the character's top and runs one
 * kana per 14.67px, so it reaches `run - --size-main` below the foot and
 * needs more than 44px from six kana on: six is 88px against the 88px a
 * character and its gap come to, so the sixth kana ends exactly level with
 * the panel's edge, seven is 102.67px and would be cut 14.67px short by
 * `.tategaki`'s own `overflow-y: hidden`, and eight 29.33px — at every panel
 * height, since the rounding makes the shortfall the same wherever the
 * column ends. Both lengths are real: kanjidic carries 64 readings of seven
 * kana or more (up to twelve), and any of them can be picked from the
 * readings menu. None of them is cut, because this is what stops it: the
 * `max()` takes the margin to exactly `overhang - gap`, which is the
 * shortfall to the pixel.
 *
 * Measured rather than derived: the placement of both runs is a stack of
 * `max()`es in kunten.css (rules 3, 4 and 5), and restating it here in
 * TypeScript would be a second copy of that arithmetic to keep in step.
 * What is wanted is one number — how deep the deepest one actually went —
 * and the laid-out page is where that is written.
 *
 * The switches are lifted for the measurement and put straight back, within
 * the one task, so nothing is painted in between. The reason is no longer
 * that a hidden run has no box — the switches fade rather than remove now,
 * and the boxes survive. It is that `body.hide-furigana rt:has(.okurigana)`
 * zeroes `--furi-run`, which walks the okurigana *up* its lane: measured with
 * the 振り仮名 switch on, the deepest run is shallower than it will be, and
 * the overhang would be under-reserved. A page rendered with the readings
 * switched off would then clip them the moment they were switched back on —
 * which redraws nothing and so would never be re-measured.
 *
 * Costs nothing on ordinary text: rule 5 keeps a lane to at most
 * `annotationCapacity()` kana, which is 73.33px against the 88px a character
 * and its gap come to, so the margin stays at zero and the `max()` never
 * fires. On 酒蟲 what it publishes is not a reading at all but the deepest
 * kaeriten (see `ANNOTATION_PARTS`), 32px, still well inside the 44px the
 * trailing gap leaves on its own. */
function publishAnnotationOverhang(column: HTMLElement): void {
  const switches = ["hide-furigana", "hide-okurigana", "hide-kunten"].filter((name) => document.body.classList.contains(name));
  document.body.classList.remove(...switches);

  let deepest = 0;
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    const glyph = cell.querySelector<HTMLElement>(".kanji-glyph");
    if (!glyph) continue;
    const foot = glyph.getBoundingClientRect().bottom;
    for (const part of cell.querySelectorAll<HTMLElement>(ANNOTATION_PARTS)) {
      deepest = Math.max(deepest, part.getBoundingClientRect().bottom - foot);
    }
  }

  document.body.classList.add(...switches);
  // On `:root`, where `--panel-margin-bottom` is declared and where both of
  // its readers — the panel's own padding and the grid row that holds it
  // (tategaki.css) — can see it. A whole pixel up, so a fractional
  // shortfall can never take the last kana with it.
  document.documentElement.style.setProperty("--annotation-overhang", `${Math.ceil(deepest)}px`);
}

/** One sentence's markup: the `.sentence-gap` span, everything inside it, and
 * the side-table entry that lets a click on one of its cells find its way
 * back to the token it came from.
 *
 * Its own function because two callers build these now. The whole-tree render
 * below walks the finished tree and builds every one of them; the progressive
 * parse builds them a wave at a time as the parser answers, and splices each
 * wave's worth into a column already on the screen (see
 * `revealAnnotatedSentences`). Both must produce the same markup for the same
 * sentence, or the page a reader ends up with would depend on which route
 * drew it — so there is one place that says what a sentence looks like. */
function sentenceGapFor(
  sentence: Sentence,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
  /** Whether the inspector may answer for these characters — **the edit
   * gate**, and see the note above `revealAnnotatedSentences` for why it is
   * this and not a flag somewhere in the inspector. */
  register: boolean,
): HTMLElement {
  const plan = computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict }));
  assignKundokuTen(plan); // mutates plan.spliceGroups' depth/isRe in place
  const root = findRoot(sentence);
  const wrapper = document.createElement("span");
  wrapper.className = "sentence-gap";
  wrapper.append(renderSentence(sentence, resolve, root, plan, jmdict, kanjidic, historicalKana));
  if (register) registerSentence(wrapper, sentence);
  return wrapper;
}

/** One sentence's `.sentence-gap`, reusing the element built for it last time
 * when nothing this panel reads about the sentence has changed since.
 *
 * **Why this is safe to key on the sentence alone.** Every reading and every
 * relation a token can carry lives on the `Token` objects themselves — the
 * kaeriten (`assignKundokuTen`), the reading order (`computeReadingOrder`) and
 * the furigana/okurigana (`renderSentence`) are all pure functions of one
 * `Sentence` plus the session-wide resolver/indices/`renyouTeOn` flag, with no
 * hidden read of anything another sentence holds — unlike the prose panel,
 * which threads a first-mention ledger across the whole tree (see
 * `KakikudashiView.ts`), the kundoku panel has no such cross-sentence state:
 * a click that never touches sentence *N* can never change what sentence *N*
 * draws. That is also the invariant the reader gave for the panel's own
 * layout, one level down: no character ever moves, so an unaffected
 * sentence's cells are not merely unchanged in *content*, they are the exact
 * same DOM nodes a browser has already laid out, which is what makes reusing
 * them rather than rebuilding them sound and not just convenient.
 *
 * The cache is a `WeakMap` keyed on the `Sentence` object (see
 * `sentenceMemo.ts`), so it costs nothing beyond what a normal render was
 * already going to build: a full render populates it exactly once per
 * sentence at no extra cost, and an edit's incremental redraw is what reads
 * it back. */
const kundokuGapMemo = createSentenceMemo<HTMLElement>();

function memoizedSentenceGap(
  sentence: Sentence,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): { gap: HTMLElement; hit: boolean } {
  const fingerprint = sentenceFingerprint(sentence, String(renyouTeOn()));
  const { value, hit } = kundokuGapMemo.compute(sentence, fingerprint, () =>
    sentenceGapFor(sentence, resolve, jmdict, kanjidic, historicalKana, true),
  );
  return { gap: value, hit };
}

/** The passes that only the *finished* column can be put through, and the
 * wiring that only a finished column needs.
 *
 * Three of the four have to see the whole thing at once, and one of those
 * three is why the progressive reveal cannot run them as it goes:
 *
 *  - `glueOpeningPunctForward` **moves nodes across sentence boundaries** —
 *    an opening bracket at the end of one sentence is put into a
 *    `.no-break-unit` together with the first unit of the next one, and that
 *    wrapper stays in the first sentence's span. Run while the column is
 *    still half bare, it would leave a cell belonging to a region that the
 *    reveal is about to replace parked inside a region that it isn't, and the
 *    replacement would strand it. So it runs once, here, when there is
 *    nothing left to replace.
 *  - `indexPunctRuns` reads document order across sentences (a closing quote
 *    after a full stop is a sentence of its own), but only writes custom
 *    properties, so the reveal *can* re-run it per wave and does.
 *  - `publishAnnotationOverhang` measures every cell on the page, which is
 *    both too expensive to repeat per wave and pointless before the last
 *    annotation is on it.
 *
 * `setupTokenInspector` guards against being attached twice, so calling it
 * here covers both routes; `setReadingIndex` is set per render rather than
 * once at setup because the index arrives asynchronously and the first render
 * can precede it. */
export function settleKundokuColumn(
  container: HTMLElement,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): void {
  const column = container.querySelector<HTMLElement>(":scope > .tategaki-column");
  if (!column) return;
  glueOpeningPunctForward(column);
  indexPunctRuns(column);
  closeTitleRuns(column);
  positionCompoundLines(column);
  publishAnnotationOverhang(column);
  setReadingIndex(kanjidic, historicalKana, jmdict);
  setupTokenInspector(container);
}

export function renderKundokuView(
  container: HTMLElement,
  tree: TokenTree,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null = null,
  kanjidic: KanjidicIndex | null = null,
  historicalKana: HistoricalKanaIndex | null = null,
  /** The 廣韻's rimes, for a text that turns out to be verse. Optional and
   * last, like the three indexes above it and for their reason: it arrives
   * asynchronously and the first render can precede it, and a panel drawn
   * without it is the panel this app drew before the annotation existed
   * rather than a broken one. */
  rimes: RimeIndex | null = null,
): void {
  container.replaceChildren();
  const column = document.createElement("div");
  column.className = "tategaki-column text-main";
  for (const sentence of tree.sentences) {
    // Through the memo rather than `sentenceGapFor` directly: a full render
    // is also where the cache is *populated* (a `WeakMap`, so a document this
    // is the first render of just pays what building the gap always cost),
    // and routing every construction through one place is what keeps a
    // reused element and a freshly built one from ever being allowed to
    // differ. See `redrawKundokuSentencesInPlace`, the other caller.
    column.append(memoizedSentenceGap(sentence, resolve, jmdict, kanjidic, historicalKana).gap);
  }
  container.append(column);
  settleKundokuColumn(container, jmdict, kanjidic, historicalKana);
  // **After the settle and not before.** `glueOpeningPunctForward` moves cells
  // between sentences and walks `.sentence-gap > *`; a child it was never
  // written against sitting in that list while it runs is the kind of thing
  // that goes wrong quietly. Nothing this adds is a `.kanji-cell` either — see
  // `annotateVerseRimes` for the three passes that count them.
  //
  // Only here, though the progressive parse also settles a column of its own
  // (`main.ts`, before `animateAnnotationShift`): that column is replaced by
  // this render a moment later, so this is where both routes end up and one
  // call covers them.
  if (rimes) annotateVerseRimes(column, tree, rimes);
  // Reading starts at this (vertical-rl) panel's own *right* edge —
  // `scrollLeft = 0` is that start, not the browser's own idea of "start"
  // carried over from whatever position scroll-anchoring (or a previous
  // render's leftover scrollLeft on this same, reused container element)
  // last left it at. Without this, a fresh render can open already
  // scrolled partway through the text, cutting off content at *both*
  // edges instead of showing the beginning. Set after the new content is
  // in the DOM, since scrollWidth isn't known beforehand.
  //
  // Instant, overriding the `scroll-behavior: smooth` the panel carries in
  // tategaki.css: this is a reset, not a journey, and the reader should never
  // watch the panel travel to it. It also has to *finish* within this call,
  // because a re-render of the text already on screen puts the panel straight
  // back where the reader had it (`ScrollSync.captureScroll`) — a smooth reset
  // would still be animating underneath that restore.
  container.scrollTo({ left: 0, behavior: "instant" });
}

/** Redraws only the sentences a hand edit actually touched, in a column
 * `renderKundokuView` has already built — the kundoku half of the incremental
 * edit path (`main.ts`'s `redrawInPlace`).
 *
 * **What "touched" means here is exact, not approximate**: `memoizedSentenceGap`
 * recomputes every sentence's fingerprint and only rebuilds the ones whose
 * fingerprint no longer matches what is already on screen — so this walks
 * every sentence (cheap: string comparison, no dictionary lookup, no DOM) but
 * only *builds* the ones an edit changed, and only *touches the DOM* for
 * those. An edit to one token in a thousand-sentence document rebuilds one
 * `.sentence-gap`; every other sentence's cells are the exact elements the
 * last render put there; no reading is re-resolved, no reading order
 * recomputed, for any of them.
 *
 * Returns whether anything was actually dirty, so the caller can skip the
 * (comparatively cheap, but not free) whole-column settle passes entirely
 * when nothing changed — which cannot happen for a real token edit (something
 * always changed), but matters for the 連用形-て switch when it is toggled
 * back to a state whose sentences are all still cached from before the
 * *previous* toggle (see `sentenceFingerprint`'s `extra`).
 *
 * Positional splicing (`column.children[i]`) rather than a second `Sentence
 * -> Element` map: sentence count and order are invariant under every edit
 * the inspector offers (see `editHistory.ts`'s own `Snapshot`, which is
 * positional for the same reason), so `tree.sentences[i]`'s gap is always
 * `column.children[i]`, and a full render leaves that just as true as this
 * function does. */
export function redrawKundokuSentencesInPlace(
  container: HTMLElement,
  tree: TokenTree,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
  rimes: RimeIndex | null,
): boolean {
  const column = container.querySelector<HTMLElement>(":scope > .tategaki-column");
  // No column to splice into — the panel is empty, or was never rendered by
  // this module at all. Falling back to the full render is always correct
  // and is what every route into this app already does the first time.
  if (!column) {
    renderKundokuView(container, tree, resolve, jmdict, kanjidic, historicalKana, rimes);
    return true;
  }
  let dirty = false;
  tree.sentences.forEach((sentence, i) => {
    const { gap, hit } = memoizedSentenceGap(sentence, resolve, jmdict, kanjidic, historicalKana);
    if (hit) return;
    dirty = true;
    const old = column.children[i];
    if (old) old.replaceWith(gap);
    else column.append(gap);
  });
  if (!dirty) return false;
  // The same whole-column bookkeeping `renderKundokuView` always ran, in the
  // same order, over the column as it now stands — see `settleKundokuColumn`'s
  // own note on why each of its four passes needs the *finished* column
  // rather than a per-sentence scope. None of them is skipped for being
  // "probably unaffected": they were never a cost this change set out to cut
  // (see the profiling report) — what it cuts is the reading resolution,
  // reading order and per-token DOM construction above, which these passes
  // never did.
  settleKundokuColumn(container, jmdict, kanjidic, historicalKana);
  if (rimes) annotateVerseRimes(column, tree, rimes);
  return true;
}

/* ── The text before the parse, and the annotations after it ───────────────
 *
 * A submitted text is drawn immediately, out of the characters themselves,
 * and each sentence's apparatus is written over it as the parser answers for
 * that sentence. What follows is the two halves of that: the bare column, and
 * the replacement of one region of it by the sentences the parse made of it.
 *
 * **The characters do not move between the two.** Not by good fortune — by
 * three properties of the stylesheet, each of which is load-bearing here and
 * none of which this file is at liberty to break:
 *
 *  - `.text-main` fixes the column pitch at `--line-height-main`, a plain
 *    number, so a column is exactly as wide as the type scale says whatever
 *    hangs beside its characters. Ruby does not widen it.
 *  - Every annotation is out of flow (`position: absolute` on the `<rt>` and
 *    on each of the marks), so nothing in a cell but the character itself has
 *    a place in the line. `.kanji-cell` and `.kanji-glyph` are one character
 *    tall whatever they carry — which `publishAnnotationOverhang` already
 *    states, for its own reasons.
 *  - The advance is `--kanji-advance`, and the panel's height is rounded down
 *    to a whole number of them (tategaki.css), so how many characters stand
 *    in a column is a function of the type scale and the panel, not of the
 *    text.
 *
 * So a bare cell and its annotated replacement occupy the same slot, and the
 * character the reader is looking at when its reading arrives is still under
 * their eye. The count of cells is the same too: `splitProvisional` counts
 * the characters this draws, and every branch of `renderSentence` writes one
 * cell per character of the token it is given — a fused token and a compound
 * span both spread their characters over one cell each.
 *
 * **What does move, once, at the end** is the whole panel, and it is not this
 * mechanism's doing: the prose panel's fit takes height from the kundoku
 * panel in whole characters (`--kundoku-extra-slots`), and that fit cannot
 * run until there is prose to measure. `main.ts` puts that single change
 * through `animateAnnotationShift`, so the characters walk to their new
 * places rather than jumping — but they do go somewhere. See `onParseText`. */

/** Which provisional region a bare `.sentence-gap` stands for, so the reveal
 * can find the ones a wave has answers for. Only ever on a bare span: the
 * annotated spans that replace it carry no such attribute, which is also how
 * a region already revealed is told from one still waiting. */
const PROVISIONAL_ATTR = "provisionalRegion";

/** One character's cell, with nothing beside it.
 *
 * Deliberately not `cellFor(ch, undefined, undefined, undefined, id)`, which
 * would produce exactly this markup and one thing more: a `data-token-id`.
 * That attribute is what makes a cell a thing to click — `.kanji-cell[data-
 * token-id] .kanji-glyph` in kunten.css is where the affordance is, and
 * `resolveEntry` is what would answer the click, with nothing to answer it
 * from. A character with no analysis yet should not look as though it has
 * one. */
function bareCell(ch: string): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "kanji-cell";
  const glyph = document.createElement("span");
  glyph.className = "kanji-glyph";
  glyph.append(ch);
  cell.append(glyph);
  return cell;
}

/** Whether nothing but closing brackets follows `index` in `chars` — the
 * character-level twin of `endsSentence`, and it decides the same thing for
 * the same reason: 也。」 ends at the 。, not at the 」.
 *
 * As there, it settles only a mark whose own class says nothing (see
 * `japanesePunct`), which for the marks this material actually uses is none
 * of them. It is written out anyway so that the bare render and the annotated
 * one cannot come to disagree about a mark that does reach it. */
function endsRegion(chars: readonly string[], index: number): boolean {
  return chars.slice(index + 1).every((ch) => BRACKET_PUNCT.has(ch));
}

/** What one provisional region puts in the column, before any of it is a DOM
 * node.
 *
 * Separated out from the markup because this — and only this — is the part
 * that has to agree with the annotated render, and it is the part that can be
 * checked without a browser. `char` and `punct` are the two kinds of
 * `.kanji-cell`, `indent` is `indentCell`, and `break` is the `<br>` that
 * starts a new column.
 *
 * The agreement it has to keep, in the terms `renderSentence` states it in:
 *
 *  - one item per non-whitespace character of the region, in source order,
 *    because every branch of `renderSentence` writes one cell per *character*
 *    of the token it is handed — a token the tokenizer fused and a compound
 *    span both spread theirs over one cell each;
 *  - `punct` for the characters that will come back tagged PUNCT, with the
 *    mark written exactly as `kundokuPunct` will write it then;
 *  - the same leading structure `appendSourceBreak` will lay down from the
 *    layout the parse carries — which is `breakCellCount`, shared, rather
 *    than the same arithmetic written twice. */
export type BareItem =
  | { kind: "break" }
  | { kind: "indent" }
  | { kind: "char"; text: string; title?: true }
  | { kind: "punct"; text: string; title?: true };

export function bareItemsFor(region: ProvisionalSentence): BareItem[] {
  const items: BareItem[] = [];
  if (region.breakBefore) items.push({ kind: "break" });
  const lead = breakCellCount(region);
  for (let i = 0; i < lead; i++) items.push({ kind: "indent" });

  const chars = [...region.body];
  // The same reading of 《…》 the annotated render makes, one region at a time
  // — here off the characters themselves, there off the tokens, and both
  // through `parse/punctuation.ts` so that the mark cannot be dropped at one
  // stage and set at the other. A title's brackets take no cell at either
  // stage, which is what keeps every character in the same place when the
  // parse arrives.
  const readTitle = titleReader();
  let spaces = 0;
  chars.forEach((ch, i) => {
    // Whitespace *inside* a region is only ever spaces (a newline ends one),
    // and `annotateSourceLayout` records a run of them as the following
    // token's indent — so they come out as blank cells there, and must here.
    if (/\s/.test(ch)) {
      spaces++;
      return;
    }
    const role = readTitle(ch);
    // Set as nothing, and before the pending indent is flushed: a run of
    // spaces before a 《 belongs to the character the bracket opens on, and
    // must still be there for it.
    if (role === "mark") return;
    for (let n = 0; n < spaces; n++) items.push({ kind: "indent" });
    spaces = 0;
    const title = role === "inside" ? { title: true as const } : {};
    items.push(
      isPunctuationMark(ch)
        ? { kind: "punct", text: kundokuPunct(ch, endsRegion(chars, i)), ...title }
        : { kind: "char", text: ch, ...title },
    );
  });
  return items;
}

/** How many cells one region draws — the currency the reveal advances in.
 *
 * **Not `ProvisionalSentence.length`**, and the difference is exactly a
 * title's brackets. That number is a count of the region's own characters, and
 * it has to stay one: `partitionByRegion` settles it against `sentenceLength`,
 * which counts the characters of a parsed sentence's tokens, and a 《 is a
 * token of the text however it is set. What the reveal counts is cells —
 * `animateCharacterReveal` walks the `.kanji-cell`s of the column — and 《 and
 * 》 are set as nothing and have none. Counted the two ways, the frontier
 * would fall two characters short of the end of a text holding one title, and
 * the last region would never be reported as drawn.
 *
 * So: this for the frontier, `length` for the partition. Both are read off
 * `bareItemsFor`, which is what actually draws the column, rather than
 * predicted from the source a second time.
 *
 * **It is this column's count and no one else's.** The 書き下し文 panel writes
 * 《 and 》 as characters and advances on them (see the note at the head of
 * `renderKakikudashiView`), so its numbers and these are not the same numbers
 * — and nothing asks them to be. The frontier is driven off the kundoku column
 * alone (`animateCharacterReveal` in main.ts), and the prose's own disclosure
 * is paired to it sentence by sentence, off that column's cell bounds and this
 * panel's `.sentence-gap`s, never off a character count. */
export function bareCellCount(region: ProvisionalSentence): number {
  return bareItemsFor(region).filter((item) => item.kind === "char" || item.kind === "punct").length;
}

/** One provisional region's bare markup. */
function bareGapFor(region: ProvisionalSentence, index: number): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "sentence-gap";
  wrapper.dataset[PROVISIONAL_ATTR] = String(index);
  const frag = document.createDocumentFragment();

  for (const item of bareItemsFor(region)) {
    if (item.kind === "break") {
      frag.append(document.createElement("br"));
    } else if (item.kind === "indent") {
      frag.append(indentCell());
    } else if (item.kind === "char") {
      const cell = bareCell(item.text);
      if (item.title) cell.classList.add(TITLE_CLASS);
      frag.append(cell);
    } else {
      const cell = document.createElement("span");
      cell.className = "kanji-cell punct-cell";
      if (item.title) cell.classList.add(TITLE_CLASS);
      if (BRACKET_PUNCT.has(item.text)) cell.dataset.punctBracket = "true";
      cell.append(item.text);
      // Glued to whatever precedes it unless it is an opening bracket —
      // 行頭禁則, exactly as in `renderSentence`, so a column break can no more
      // strand a mark at stage one than it can afterwards.
      appendPunct(frag, cell, item.text);
    }
  }

  wrapper.append(frag);
  return wrapper;
}

/** Draws a submitted text at once, out of its own characters — stage one of a
 * parse, before the parser has been asked anything.
 *
 * Characters and punctuation, and nothing else: every annotation this panel
 * carries is derived from the parse, and there is no parse. The marks are
 * still written the way this panel writes marks (`japanesePunct` — a ， is a
 * 、 here whatever the source typed), because that is a rule about setting
 * Japanese and not about the analysis, and a mark that changed shape when its
 * sentence was annotated would be a flicker in the one place the reader is
 * most likely to be looking.
 *
 * `--annotation-overhang` is put back to nothing rather than measured. It is
 * how deep the deepest annotation on the page reaches, it feeds the panel's
 * bottom margin and so the column length, and the page it describes has just
 * been replaced by one with no annotations at all — left at the last
 * document's value it would shorten this one's columns for a reason that no
 * longer exists. Written directly rather than through
 * `publishAnnotationOverhang`, which would measure every cell of a document
 * just submitted only to arrive at the zero this states. */
export function renderBareKundokuView(container: HTMLElement, regions: readonly ProvisionalSentence[]): void {
  container.replaceChildren();
  document.documentElement.style.setProperty("--annotation-overhang", "0px");
  const column = document.createElement("div");
  column.className = "tategaki-column text-main";
  // What this column says about itself for as long as it is this one: the
  // annotations on it are provisional and nothing on it can be edited. Only
  // the reveals write into this column, and the render that ends the parse
  // builds a new one, so the attribute goes when the state does without
  // anyone having to remember to take it off. See the note above
  // `revealAnnotatedSentences` for what it answers.
  column.dataset.annotations = "streaming";
  regions.forEach((region, i) => column.append(bareGapFor(region, i)));
  container.append(column);
  indexPunctRuns(column);
  closeTitleRuns(column);
  // The same reset, for the same reason, as at the foot of `renderKundokuView`
  // — and it belongs here rather than there for this route, because this is
  // the render that puts a new text on the screen. The reveals that follow
  // splice into a column already in place and must leave the reader's place
  // in it alone.
  container.scrollTo({ left: 0, behavior: "instant" });
}

/** Brings the characters of the column up one at a time, fading each one in,
 * and says how many are up as it goes. Where there is a prose panel, brings
 * its characters up beside them, sentence for sentence.
 *
 * **One mechanism, two situations**, and it is worth saying why the same one
 * serves both, because they look unalike:
 *
 *  - A *submitted* text is disclosed bare, while the parser is being loaded
 *    and asked; `main.ts` sends each region off as this reports its last
 *    character up, and the apparatus is written over it as the answers land.
 *    There is no prose panel yet, so there is nothing beside it to disclose.
 *  - A *saved* text is disclosed already annotated. There is no parse to wait
 *    for — the tree came off the disk complete — so the whole panel, prose
 *    and all, is rendered first and this then discloses it. The reveal is
 *    presentation, not a wait being covered, and it takes in both panels.
 *
 * What makes one function enough is that neither case is a *build*. The
 * column is complete and settled before the first frame — every cell in its
 * final place, the compound ties measured, the prose panel's fit already
 * taken off the grid where there is a prose panel — and all this does is take
 * the `visibility` off the cells on a schedule and fade each one up as it
 * goes. `visibility` rather than `display` is the whole of the first half: a
 * hidden cell keeps its box, so nothing reflows, nothing is appended, and
 * each character appears *in the place it will occupy* rather than pushing
 * the ones after it along. On the saved-text path that has a consequence
 * worth stating plainly — **no character moves at any point**, because the
 * one thing that used to move them (the prose panel's fit, arriving with the
 * parse) has already happened.
 *
 * `visibility` rather than `opacity: 0` for the waiting state is the other
 * half, and it is about the pointer rather than the paint — see `ink` below,
 * which is where the fade, the hit testing and the stacking are argued
 * together.
 *
 * The cells are hidden here rather than by whoever built them, in the same
 * task as the build, so there is no frame in which the finished page is on
 * the screen before this begins. The prose is hidden in the same task and by
 * the same line of reasoning.
 *
 * **The two panels are synchronised sentence by sentence and not character by
 * character**, because they do not hold the same characters — see
 * `proseShownBy` in `provisionalSentences.ts`, which is the whole of the
 * arithmetic and states the two ends that have to coincide. What this
 * function adds to it is the currency: which cells belong to which sentence,
 * read off the column on the screen.
 *
 * The schedule is by elapsed time rather than by frame, so it takes the same
 * wall-clock time whatever the display refreshes at, and a frame that arrives
 * late brings up every character it was due for rather than falling behind.
 *
 * **And it is by elapsed time rather than by character**, which is what lets a
 * long complete tree be disclosed at all. The step comes from `charStepMs`,
 * which holds the house rate until a text is long enough that the house rate
 * would take longer than `CHAR_REVEAL_MAX_MS`, and then shortens so that the
 * whole reveal lands on that budget instead. Nothing in this loop knows the
 * difference: it already brought up whatever a frame was due (three characters
 * at 60Hz on a short text), and on a long one it brings up thirty. The
 * arithmetic and what it does to the fade's depth are at `CHAR_REVEAL_MAX_MS`.
 *
 * **A character that is on the page answers for itself, from the instant it
 * arrives.** That is not something this function arranges — it is what
 * `visibility` gets us for nothing, and it is argued at `ink` below — but it is
 * the property the whole of the complete-tree route's editability rests on, so
 * it is worth naming here: the inspector resolves a click through the cells
 * and the `.sentence-gap`s that `renderKundokuView` has *already* built and
 * registered, and this touches neither. A cell waiting its turn declines
 * because it is not being hit-tested; a cell that is up answers whether or not
 * the reveal has finished, and whether the reveal has one second left to run
 * or twenty.
 *
 * **An opening bracket is never drawn alone** — see `showableChars`, which
 * has the reason and the treatment. So what is on the screen can lag the
 * schedule by a character or two, and `onShown` reports what is *shown*
 * rather than what is due: on the parse path a region whose last character is
 * a bracket still in the buffer is not complete, and is not dispatched, until
 * that bracket is on the page.
 *
 * Returns a cancel, which brings the rest of **both** panels up at once — at
 * once, with the fades turned off and the ones in flight cancelled — and
 * reports the whole of the column shown. Everything that takes the panel over
 * needs it: a second text, a clear, and (on the saved path) the reader's
 * first edit or display switch, which redraws the column out from under this
 * and would otherwise leave it un-hiding cells that are no longer on the
 * page — worse under the 連用形-て switch, which re-answers the fit and can
 * move every character while forty of them are mid-fade. The
 * prose is brought up by the same call, so the edit that cancels the reveal
 * finds a prose panel at full ink to redraw. */
export function animateCharacterReveal(
  container: HTMLElement,
  onShown: (charsShown: number, total: number) => void,
  /** The prose panel's characters, one list per `.sentence-gap` and in the
   * same order — `markProseForReveal`'s answer, or nothing where there is no
   * prose panel to disclose. Only the complete-tree route passes it: the
   * parse path's prose panel is empty until the parse settles, and there is
   * nothing there to bring up. */
  prose: readonly (readonly HTMLElement[])[] = [],
): () => void {
  const column = container.querySelector<HTMLElement>(":scope > .tategaki-column");
  const cells = column ? [...column.querySelectorAll<HTMLElement>(".kanji-cell")] : [];
  const total = cells.length;

  // Only a punctuation cell can hold a bracket, and it holds the mark exactly
  // as this panel wrote it — which is the form the buffer has to test, since
  // it is what would be sitting at the column's foot. Every other cell
  // answers with nothing rather than with a character it might share a string
  // with (a kanji cell's text carries its kaeriten along).
  const chars = cells.map((cell) => (cell.classList.contains("punct-cell") ? (cell.textContent ?? "") : ""));

  let cancelled = false;
  /** Whether a character being disclosed is faded in or simply un-hidden.
   * The cancel turns it off before it discloses the rest of the text, which
   * is what makes the cancel a *switch* and not a very fast animation. */
  let fades = true;
  // `typeof Element` first: this function is reachable in the node test
  // environment, where `Element` is not merely without `animate` but is not
  // declared at all, and reading `.prototype` off it would throw before the
  // stand-down below could be reached.
  const canFade = typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
  const timing: KeyframeAnimationOptions = { duration: CHAR_FADE_MS, easing: "ease-out" };
  /** Every fade still running, so the cancel can stop them. A fade takes
   * itself out of this on its own when it finishes, so what the set holds is
   * the leading edge and nothing else — `CHAR_FADE_MS / step` of them wherever
   * the reveal has got to, which is forty-three on any text the house rate
   * serves and as many as four hundred on a very long one (see
   * `CHAR_REVEAL_MAX_MS`, where the count is costed). */
  const running = new Set<Animation>();

  /** Brings one character up. **`visibility` off first and only then the
   * fade**, and the order is the whole of how the hit-testing works out:
   *
   *  - Before its moment a character is `visibility: hidden`, which keeps its
   *    box (so nothing reflows and nothing moves) and takes it out of hit
   *    testing entirely. That is the property the complete-tree route needs
   *    and the reason the pre-state is not `opacity: 0`, which paints nothing
   *    but answers a click, a drag and a drop as though it were there — a
   *    reader could retag a character they cannot see.
   *  - From its moment it is on the page, faintly at first, and it is
   *    hit-testable from that instant. That is the right way round even at
   *    `CHAR_FADE_MS`: the character *has* arrived, it is where it will stay,
   *    and a character the reader can see but which declines their click for
   *    a quarter of a second would be the stranger of the two rules by far.
   *    The rule the reveal owes them is about characters whose moment has not
   *    come, and `visibility` keeps it exactly.
   *
   * **On the stacking context.** An opacity below 1 makes one, and a cell
   * mid-fade is one — which matters for exactly one rule, `.token-cell-head
   * .kanji-glyph`'s `z-index: 1` (kunten.css), whose job is to lift a boxed
   * character's casing above the *other* cells' annotations. Confined to a
   * stacking context of its own, it cannot.
   *
   * The window is one fade long, so at `CHAR_FADE_MS` it is a quarter of a
   * second rather than the sliver a short fade would have left, and there are
   * forty-odd cells in it at a time rather than a dozen. It is still the same
   * small thing: it needs the reader to click during the reveal *and* the
   * head of what they clicked to be within `CHAR_FADE_MS` of its own arrival,
   * and what it costs then is that a neighbouring cell's reading crosses the
   * 2px casing band around the box for the remainder of that fade. No
   * geometry changes, the box moves nowhere, and the head's own annotations
   * are its children and are unaffected. Left as it is rather than papered
   * over: the alternative is no fade on any cell that might one day be boxed,
   * which is no fade at all. Reasoned from the stylesheet; not seen in a
   * browser. */
  const ink = (el: HTMLElement): void => {
    el.style.removeProperty("visibility");
    if (!fades || !canFade) return;
    const fade = fadeIn(el, timing);
    running.add(fade);
    fade.onfinish = () => running.delete(fade);
  };

  let shown = 0;
  const showTo = (target: number): void => {
    for (; shown < target; shown++) ink(cells[shown]);
  };

  // No `requestAnimationFrame` in a node test environment, and nothing to
  // disclose in an empty panel — both end the same way, with the whole text
  // up, which is the right answer for anything that cannot animate. Nothing
  // has been hidden at this point, in either panel, so "the whole text up" is
  // simply the page as it was rendered.
  if (total === 0 || typeof requestAnimationFrame !== "function") {
    onShown(total, total);
    return () => {};
  }

  for (const cell of cells) cell.style.visibility = "hidden";
  for (const sentence of prose) for (const unit of sentence) unit.style.visibility = "hidden";

  /** Where each kundoku sentence's characters begin and end in `cells`, which
   * is the currency the schedule is written in — so this is read off the
   * column that is actually on the screen rather than counted out of the tree.
   *
   * That is not fastidiousness. `sentenceLength` counts the characters of a
   * sentence's tokens; the column draws a `.kanji-cell` per character of a
   * fused token *and* one for each mark of punctuation the panel writes, and
   * `glueOpeningPunctForward` has by now moved the first cell of a sentence
   * that opens after a bracket into the previous sentence's span. The cells
   * are what the reveal advances through, so the cells are what the sentence
   * boundaries have to be found among. (The glue's displacement is left
   * exactly as it is: it moves one cell across one boundary, so a sentence is
   * at worst one character — 6ms — longer or shorter than its prose thinks,
   * and correcting for it would mean disclosing the column in an order other
   * than the one it is written in.)
   *
   * A gap with no cells of its own takes no time and sits where the previous
   * one ended, which is what `proseShownBy` reads as "land the whole of this
   * sentence's prose at once". */
  const gaps = column ? [...column.querySelectorAll<HTMLElement>(":scope > .sentence-gap")] : [];
  const gapAt = new Map<HTMLElement, number>(gaps.map((gap, i) => [gap, i]));
  const bounds = gaps.map(() => ({ from: -1, to: -1 }));
  cells.forEach((cell, at) => {
    const gap = cell.closest<HTMLElement>(".sentence-gap");
    const i = gap ? gapAt.get(gap) : undefined;
    if (i === undefined) return;
    if (bounds[i].from < 0) bounds[i].from = at;
    bounds[i].to = at + 1;
  });
  let after = 0;
  for (const bound of bounds) {
    if (bound.from < 0) {
      bound.from = after;
      bound.to = after;
    }
    after = bound.to;
  }

  /** The prose, paired with the kundoku sentence it is the prose *of*.
   *
   * By index, the two panels each writing one `.sentence-gap` per sentence of
   * the same tree in the same order. A prose sentence with no kundoku sentence
   * to pair with — the counts having somehow come apart — is given the empty
   * range at the end of the column, which lands it whole at the moment the
   * last character of the text does. That keeps the two guarantees that
   * matter when the pairing fails: nothing is left permanently invisible, and
   * the two panels still finish together. */
  const schedule = prose.map((units, i) => {
    const bound = bounds[i] ?? { from: total, to: total };
    return { from: bound.from, to: bound.to, units };
  });
  const proseShown = schedule.map(() => 0);
  const showProseTo = (i: number, target: number): void => {
    const units = schedule[i].units;
    for (; proseShown[i] < target; proseShown[i]++) ink(units[proseShown[i]]);
  };

  /** How long each character waits behind the one before it, for a column of
   * this length. The house rate on anything under the knee — which is every
   * text the parse route reveals and every sample this app ships — and shorter
   * on a long complete tree, so that the whole reveal lands on
   * `CHAR_REVEAL_MAX_MS`. Read once here rather than per frame: it is a fact
   * about the column, and the column does not change length under a reveal.
   *
   * `charsDrawnBy` derives the same number from `total` on its own; the prose
   * has to be *told*, its own `from`/`to` being positions in this column. The
   * two must agree or the panels come apart — see `proseShownBy`. */
  const stepMs = charStepMs(total);

  const start = performance.now();
  const step = (): void => {
    if (cancelled) return;
    const elapsed = performance.now() - start;
    const due = charsDrawnBy(elapsed, total);
    const ending = due >= total;
    // The end of the text flushes whatever the buffer is holding, stated here
    // against the cells rather than left to `showableChars`'s own flush — so
    // that a `chars` list which somehow came out shorter than the column
    // still cannot leave a cell hidden for good.
    showTo(ending ? total : showableChars(chars, due));
    // And the same flush for the prose, for the same reason and one more: the
    // schedule is arithmetic over floating-point time, and the guarantee that
    // the two panels end together should not rest on a division coming out
    // exactly. When the column is done, the prose is done.
    for (let i = 0; i < schedule.length; i++) {
      const { from, to, units } = schedule[i];
      showProseTo(i, ending ? units.length : proseShownBy(elapsed, from, to, units.length, stepMs));
    }
    onShown(shown, total);
    // `due`, not `shown`: a buffered bracket at the very end of the text is
    // flushed when `due` reaches the end, and stopping on `shown` would end
    // the loop a frame before it could be.
    if (!ending) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  return () => {
    if (cancelled) return;
    cancelled = true;
    // The whole text at once, in both panels, and *at once* rather than very
    // quickly: the fades are turned off before the rest is disclosed and the
    // ones already in flight are cancelled. A cancelled Web Animation with the
    // default `fill: none` removes its effect there and then, so what is left
    // on the page is the page as it was rendered — no animation running, and
    // no inline style but the `visibility` this takes off.
    fades = false;
    for (const fade of running) fade.cancel();
    running.clear();
    showTo(total);
    for (let i = 0; i < schedule.length; i++) showProseTo(i, schedule[i].units.length);
    onShown(total, total);
  };
}

/** When each sentence of one wave starts fading in, relative to the wave's
 * arrival.
 *
 * A wave holds anything from one sentence to sixty-four, and the reveal has
 * to read as a sweep across it in either case: a fixed step per sentence
 * would be right for two and would take eight seconds over sixty. So the step
 * is the interval divided by the count — every wave's fades *begin* within
 * one `REFLOW_MS` of each other however many there are, and the wave has
 * settled one `REFLOW_MS` after that. Waves arriving one after another
 * continue the sweep down the page on their own.
 *
 * No second constant: the spread and the fade are the same interval, which is
 * the strongest form of "one gesture, one speed" available here. */
export function revealDelays(count: number): number[] {
  if (count <= 0) return [];
  const step = REFLOW_MS / count;
  return Array.from({ length: count }, (_, i) => i * step);
}

/** Replaces one run of bare regions with the sentences the parser made of
 * them, and brings the apparatus up over the characters.
 *
 * `from`/`to` are a half-open range of provisional region indices, and
 * `sentences` is what the parse produced for exactly that range — see
 * `partitionByRegion`, which is what pairs them up and why the range is a
 * range rather than a single region.
 *
 * The characters are rewritten rather than kept, which sounds worse than it
 * is: the replacement holds the same characters in the same order, and (see
 * the note at the head of this section) in the same places. What the reader
 * sees appear is the apparatus, and only the apparatus is faded — the
 * characters are already on the screen and must not blink on the way to
 * themselves.
 *
 * `indexPunctRuns` is re-run over the whole column because a run of marks can
 * cross a sentence, so where the new marks stack depends on what precedes
 * them; it only writes custom properties, so re-running it is free of
 * consequence. `positionCompoundLines` is scoped to the new sentences, each
 * tie being measured entirely within its own group.
 *
 * The compound tie itself does not fade. It is drawn by kunten.css off
 * `--line-top`/`--line-bottom` on the group, so there is no element of its own
 * to animate, and a group's opacity is its characters' as well. It appears
 * with its sentence.*
 * **These sentences are not registered with the inspector, and that is the
 * edit gate.** `registerSentence` is what lets `resolveEntry` get from a
 * clicked cell to the token it stands for, and every way into an edit goes
 * through it: the retag menus, the readings menu, the head drag, and the
 * selection and the analysis overlay that precede them. Withheld, all of them
 * decline — not by a check written into each, but because there is nothing to
 * answer with. Which is the truth of the situation and not a lock placed over
 * it: these annotations are about to be replaced wholesale by the single-shot
 * parse (`main.ts`), so an edit made against them would be an edit made
 * against a tree the app is about to throw away. The registration happens in
 * the render that follows that swap, and edits begin there.
 *
 * The cells keep their `data-token-id` even so, unlike the bare cells they
 * replace, because `animateAnnotationShift` keys its two readings by it (see
 * `keyedCells`) and the swap's own settling is measured across exactly this
 * column. What that costs is the one thing this cannot fix from here: the
 * `cursor: grab` those cells advertise is kunten.css's, keyed on the
 * attribute, and it goes on promising a drag that will not start. The column
 * carries `data-annotations="streaming"` for a rule to answer it — see
 * `main.ts`'s report. */
export function revealAnnotatedSentences(
  container: HTMLElement,
  from: number,
  to: number,
  sentences: readonly Sentence[],
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null = null,
  kanjidic: KanjidicIndex | null = null,
  historicalKana: HistoricalKanaIndex | null = null,
): void {
  const column = container.querySelector<HTMLElement>(":scope > .tategaki-column");
  if (!column) return;
  const bare: HTMLElement[] = [];
  for (let i = from; i < to; i++) {
    const el = column.querySelector<HTMLElement>(`:scope > .sentence-gap[data-provisional-region="${i}"]`);
    if (el) bare.push(el);
  }
  // Nothing to stand in for — the panel has been cleared, or a second parse
  // has replaced it, since this wave was asked for. Dropping the answer is
  // right: it is about a text that is no longer on the screen.
  if (bare.length === 0) return;

  const gaps = sentences.map((sentence) =>
    sentenceGapFor(sentence, resolve, jmdict, kanjidic, historicalKana, false),
  );
  // A region the parse produced nothing for would otherwise leave its bare
  // characters on the page with no way ever to annotate them. Keeping the
  // bare span is the lesser wrong: the characters stay, unannotated, rather
  // than vanishing.
  if (gaps.length === 0) return;
  bare[0].replaceWith(...gaps);
  for (const el of bare.slice(1)) el.remove();

  indexPunctRuns(column);
  // For the reason `indexPunctRuns` is here: a title can no more be read off
  // one sentence than a run of marks can, the last character of one being the
  // last only if what follows it in the column is not in the same title.
  closeTitleRuns(column);
  for (const gap of gaps) positionCompoundLines(gap);

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (typeof Element.prototype.animate !== "function") return; // no Web Animations (jsdom)
  const delays = revealDelays(gaps.length);
  gaps.forEach((gap, i) => {
    // `fill: "backwards"` is not decoration: without it a run with a delay on
    // it is drawn at full strength until its delay elapses and only then
    // snaps to nothing to begin fading, which is the flash this is meant to
    // replace.
    const timing: KeyframeAnimationOptions = {
      duration: REFLOW_MS,
      easing: "ease-out",
      delay: delays[i],
      fill: "backwards",
    };
    for (const part of gap.querySelectorAll<HTMLElement>(ANNOTATION_PARTS)) fadeIn(part, timing);
  });
}
