import "./app.css";
// After app.css, deliberately: `@media print` adds no specificity of its
// own, so the print overrides only beat the screen rules if they come
// later in the bundle. A CSS `@import` can't express that (it is only
// valid at the top of a stylesheet), so the ordering lives here.
import "./render/print.css";
import { applyTranslations, getUiLang, onLangChange, t } from "./i18n/i18n.ts";
import { renderSidebar } from "./render/Sidebar.ts";
import {
  animateAnnotationShift,
  animateCharacterReveal,
  renderBareKundokuView,
  renderKundokuView,
  revealAnnotatedSentences,
  settleKundokuColumn,
} from "./render/KundokuView.ts";
import {
  animateKakikudashiReflow,
  clearKakikudashiView,
  holdPanelMeasures,
  markProseForReveal,
  releasePanelMeasures,
  renderKakikudashiView,
  resumePanelFit,
  suspendPanelFit,
} from "./render/KakikudashiView.ts";
import { parseConllu, validateConlluForLzh } from "./parse/conlluParser.ts";
import { annotateSourceLayout } from "./parse/sourceLayout.ts";
import { mergeAtMedialPunctuation, splitIntoSentences } from "./parse/splitSentences.ts";
import {
  nextBatch,
  partitionByRegion,
  regionsDrawnBy,
  sentenceLength,
  shouldRevealProgressively,
  splitProvisional,
} from "./parse/provisionalSentences.ts";
import { createFrontier } from "./parse/frontier.ts";
import { initParser, parseText as parseWithPyodide } from "./parse/pyodideClient.ts";
import type { Sentence, TokenTree } from "./parse/types.ts";
import type { ReadingResolver } from "./reading/types.ts";
import { createReadingResolver } from "./reading/readingResolver.ts";
import { loadKanjidicIndex, type KanjidicIndex } from "./reading/kanjidicLookup.ts";
import { loadJmdictIndex, type JmdictIndex } from "./reading/jmdictLookup.ts";
import { loadHistoricalKanaIndex, type HistoricalKanaIndex } from "./reading/historicalKana.ts";
import { setupScrollSync } from "./render/scrollSync.ts";
import { setupPrintLayout } from "./render/printLayout.ts";
import { setTokenEditHandler } from "./render/tokenInspector.ts";
import { setHistoryTree } from "./render/editHistory.ts";
import { renderSavedPanel } from "./render/SavedPanel.ts";

document.documentElement.lang = getUiLang();

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <aside class="sidebar" id="sidebar"></aside>
  <button class="rail rail-left" id="toggle-left" type="button" aria-expanded="true"></button>
  <main class="main" id="main">
    <section class="main-panel kundoku-panel">
      <h2 data-i18n="main.kundokuHeading"></h2>
      <div class="tategaki" id="kundoku-view"></div>
    </section>
    <button class="rail rail-kakikudashi" id="toggle-kakikudashi" type="button" aria-expanded="true"></button>
    <section class="main-panel kakikudashi-panel">
      <h2 data-i18n="main.kakikudashiHeading"></h2>
      <div class="tategaki" id="kakikudashi-view"></div>
    </section>
  </main>
  <button class="rail rail-right" id="toggle-right" type="button" aria-expanded="true"></button>
  <aside class="saved-panel" id="saved-panel"></aside>
`;
applyTranslations(app);
// The language toggle only flips the language; re-translating is done here
// so it reaches the *whole* document — the main panel headings sit outside
// the sidebar that owns the toggle. Status text is regenerated on the next
// parse rather than retranslated in place.
function syncDocumentTitle(): void {
  // The <title> isn't inside `#app`, so `applyTranslations` never reaches
  // it — set it from the same string the sidebar heading uses.
  document.title = t("app.title");
}
syncDocumentTitle();

onLangChange(() => {
  applyTranslations(app);
  syncDocumentTitle();
  // The saved-texts list is built in script, so its own translated bits
  // (the empty-state line, the delete button's labels) need rebuilding
  // rather than just re-walking `data-i18n` attributes.
  savedPanel?.refresh();
  syncRailLabels();
});

const kundokuView = document.querySelector<HTMLElement>("#kundoku-view")!;
const kakikudashiView = document.querySelector<HTMLElement>("#kakikudashi-view")!;
kundokuView.innerHTML = `<p class="main-empty" data-i18n="main.empty"></p>`;

/** **Whether the prose panel is on the page at all.**
 *
 * A class on `#app`, like the collapse below and for the reason given there —
 * the grid rows are described in one place in CSS rather than poked at from
 * script. Deliberately a *second* class and not that one:
 *
 *   - `kakikudashi-collapsed` is the reader's own preference. Only the rail
 *     sets it, it persists, and it is the answer to "do you want to see the
 *     prose".
 *   - `kakikudashi-empty` is a fact about the document. Only this function
 *     sets it, it is never written to storage, and it is the answer to "is
 *     there any prose to see".
 *
 * Keeping them apart is the whole point. Were the panel hidden by *collapsing*
 * it on a cold load, opening a text would have to un-collapse it — and would
 * throw away the choice of a reader who had shut the panel deliberately. Held
 * apart, a text arriving only clears the emptiness; whatever the rail last
 * said is still what the panel then does. And the rail is out of the page
 * while it is empty (app.css), so nothing can set the preference in a state
 * where the reader cannot see what they are setting it on.
 *
 * The panel is emptied through `clearKakikudashiView` rather than by clearing
 * its markup, because the fit writes outside the panel as well as inside it —
 * that module says what, and why the split must not be left on the grid.
 *
 * Called with the panel's own contents already decided: `true` immediately
 * *before* the render, since `fitPassageExtent` measures the panel it is
 * dividing and would find no height at all through a stylesheet that says the
 * panel is not there. */
function setKakikudashiPopulated(populated: boolean): void {
  app.classList.toggle("kakikudashi-empty", !populated);
  if (!populated) clearKakikudashiView(kakikudashiView);
}
// Cold load: no text, so no panel. The same call `clearAll` makes, so "just
// opened" and "cleared" stay the one state rather than two kept in step.
setKakikudashiPopulated(false);

applyTranslations(kundokuView);
const scrollSync = setupScrollSync(kundokuView, kakikudashiView);
// Printing goes through a paginated clone of these two panels rather than
// the panels themselves; `beforeprint` is the hook for both the button
// (window.print() fires it) and a plain Ctrl+P.
setupPrintLayout(kundokuView, kakikudashiView);

let resolverPromise: Promise<{
  resolver: ReadingResolver;
  jmdict: JmdictIndex;
  kanjidic: KanjidicIndex;
  historicalKana: HistoricalKanaIndex;
}> | null = null;
function getResolver() {
  if (!resolverPromise) {
    resolverPromise = Promise.all([loadKanjidicIndex(), loadJmdictIndex(), loadHistoricalKanaIndex()]).then(
      ([kanjidic, jmdict, historicalKana]) => ({
        resolver: createReadingResolver(kanjidic, jmdict, historicalKana),
        jmdict,
        kanjidic,
        historicalKana,
      }),
    );
  }
  return resolverPromise;
}

/** The running character animation's cancel, if there is one — module-level
 * so that whatever takes the panel over next can stop it, whichever route
 * that is. Four do: a new parse, a clear, a saved text being opened, and — on
 * the saved-text path, where the page is live while it is still being
 * disclosed — any redraw of the text already on it, which is an annotation
 * edit or the 連用形-て switch. That last pair share one line, in
 * `redrawInPlace`; see there. See `onParseText`'s own call for what
 * cancelling does there. */
let cancelCharacterReveal: (() => void) | null = null;

/** Whether the character animation runs for a text of this length, given the
 * reader's own motion setting. One question, asked identically on both routes
 * into it — the threshold is about how long a reader will watch a text
 * appear, and that does not depend on whether the annotations came from the
 * parser just now or off the disk. */
function revealsProgressively(totalChars: number): boolean {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return shouldRevealProgressively(totalChars, reducedMotion);
}

/** Puts a **complete** tree on the screen — one that arrived whole, with no
 * parse to wait for. Both routes to that are this: a saved text off the disk,
 * and an uploaded CoNLL-U file. They are one function because they are one
 * situation, and every property the reveal depends on comes from that:
 *
 *  - **The prose is computable at once**, so `renderTree` draws both panels
 *    before a character is disclosed and the panel is there from the first
 *    frame rather than appearing at the end.
 *  - **So is the fit.** It takes height from the kundoku panel in whole
 *    characters, and on the parse path it cannot run until the parse is done,
 *    which is why the column changes length under the reader at that moment.
 *    Here it has already run. The columns are their final length before the
 *    first character appears, and since a hidden cell keeps its box (see
 *    `animateCharacterReveal`), **no character moves at any point on this
 *    route**. That is the whole prize, and it is the parse path's one
 *    remaining compromise not being paid.
 *  - **Nothing is provisional**, so nothing is gated: edits are live from the
 *    first frame. A cell still waiting its turn is `visibility: hidden` and
 *    takes no pointer events, so a character the reader cannot see is a
 *    character that does not answer — a character *fading in* does answer,
 *    which is argued at `ink` in `animateCharacterReveal` — and the reader's
 *    first act on the page cancels the reveal (see `redrawInPlace`, which
 *    both the edits and the 連用形-て switch reach) so the text is whole the
 *    moment they act on it.
 *  - **And the prose is disclosed with it.** Being computable at once, it is
 *    on the page from the first frame, so it can be brought up character by
 *    character alongside the column instead of appearing at the end — held to
 *    it sentence by sentence, since the two panels hold different numbers of
 *    characters for the same sentence. See `proseShownBy`.
 *
 * **What it assumes about the tree, which is nothing.** A saved text is this
 * app's own export and is well formed; an uploaded file is a stranger's. So
 * the reveal is written to need none of what the one guarantees and the other
 * does not — no contiguous token ids, no ordering, no `# text`. It counts
 * `.kanji-cell` elements in the column that `renderTree` has already built,
 * whatever they turned out to be, and discloses them in document order. The
 * only reading of the tree itself is the character count below, and that
 * decides one thing: whether to animate at all. A count that came out wrong
 * on a malformed file would put the text on the screen at once, which is the
 * safe answer in either direction.
 *
 * A tree with no sentences animates nothing — `revealsProgressively` refuses
 * a length of zero, and an empty column has nothing to disclose in any case —
 * so a file that yielded nothing reaches the status line at once instead of
 * holding a blank panel for several seconds. The upload's own rejection
 * (`validateConlluForLzh`) happens before this is ever called. */
async function openCompleteTree(tree: TokenTree): Promise<void> {
  const { resolver, jmdict, kanjidic, historicalKana } = await getResolver();
  renderTree(tree, resolver, jmdict, kanjidic, historicalKana);
  setTree(tree);
  sidebar.setStatus(t("status.ready"));
  // After the render and after the status, in the same task: the page is
  // finished and settled, and this only decides what of it is visible.
  const characters = tree.sentences.reduce((n, sentence) => n + sentenceLength(sentence), 0);
  if (!revealsProgressively(characters)) return;
  const stop = animateCharacterReveal(
    kundokuView,
    (shown, total) => {
      // Its own reference, cleared only if it is still the running one — a
      // second document may have taken the panel over and installed its own by
      // the time this finishes.
      if (shown >= total && cancelCharacterReveal === stop) cancelCharacterReveal = null;
    },
    // **The prose comes up with it**, sentence for sentence — see
    // `proseShownBy`, which is the arithmetic, and `markProseForReveal`, which
    // gives each character of the prose an element to be faded. Only here: the
    // parse path's prose panel holds nothing until the parse settles, and
    // `renderTree` above has just drawn this one in full. Called
    // unconditionally past the `revealsProgressively` gate, so a text that is
    // drawn at once is never touched — a page nothing is going to hide should
    // not be cut into per-character spans for the sake of it.
    markProseForReveal(kakikudashiView),
  );
  cancelCharacterReveal = stop;
}

/** Stage four: the whole text in one call, or the streamed sentences if that
 * fails.
 *
 * Split out so the failure is a value rather than a branch in the middle of
 * the parse — the caller does the same thing with either answer, which is the
 * point (see stage four's note). The throw is swallowed here and nowhere
 * else: a stage-two failure loses the page and is reported, this one loses
 * only a repair. */
async function parseWholeText(text: string, streamed: Sentence[]): Promise<Sentence[]> {
  try {
    const whole = await parseWithPyodide(text);
    annotateSourceLayout(whole, text);
    return splitIntoSentences(mergeAtMedialPunctuation(whole)).sentences;
  } catch (err) {
    console.warn("Single-shot re-parse failed; keeping the streamed annotations.", err);
    return streamed;
  }
}

/** Counts the parses this session has started — see `onParseText`, which
 * takes a number off it and stops drawing the moment the number is no longer
 * the current one. */
let parseGeneration = 0;

/** Everything the last `renderTree` was given — kept so an in-place edit
 * from `tokenInspector.ts` (retagging a token, re-parenting one) can redraw
 * both panels from the same tree without the sidebar's parse path having to
 * run again. */
let lastRender: {
  tree: TokenTree;
  resolver: ReadingResolver;
  jmdict: JmdictIndex;
  kanjidic: KanjidicIndex;
  historicalKana: HistoricalKanaIndex;
} | null = null;

function renderTree(
  tree: TokenTree,
  resolver: ReadingResolver,
  jmdict: JmdictIndex,
  kanjidic: KanjidicIndex,
  historicalKana: HistoricalKanaIndex,
) {
  renderKundokuView(kundokuView, tree, resolver, jmdict, kanjidic, historicalKana);
  adoptTree(tree, resolver, jmdict, kanjidic, historicalKana);
}

/** Everything a render does *besides* drawing the kundoku panel: the tree
 * becomes the one the app holds, and the prose panel is drawn from it.
 *
 * Split out from `renderTree` for the progressive parse, which draws the
 * kundoku panel itself — a wave at a time, spliced into a column already on
 * the screen — and so must not have it drawn again underneath it, but needs
 * everything else here exactly as the other three routes get it. */
function adoptTree(
  tree: TokenTree,
  resolver: ReadingResolver,
  jmdict: JmdictIndex,
  kanjidic: KanjidicIndex,
  historicalKana: HistoricalKanaIndex,
) {
  lastRender = { tree, resolver, jmdict, kanjidic, historicalKana };
  // Re-rendering after an edit passes the same tree object, so the undo
  // history survives; a genuinely new one (a fresh parse, a saved text
  // reopened) replaces it and clears the history with it.
  setHistoryTree(tree);
  /** A tree with no sentences in it is not a text — it is an empty box, an
   * unparseable one, or a CoNLL-U file that turned out to hold nothing — and
   * it is counted here as *unpopulated* rather than as a document with empty
   * prose. Two reasons, and the second is the stronger.
   *
   * A panel is shown so that something can be read in it, and there is
   * nothing here to read: the kundoku panel above comes out just as blank, so
   * what a second empty box would say is not "the prose is empty" but "the
   * app is broken". The status line is where an input that yielded nothing is
   * reported, and it says so already.
   *
   * And the match is a relation between two passages. With no sentences there
   * is no kundoku extent to match, and `fitPassageExtent` would walk its
   * splits only to find every candidate measuring nothing — `matchedDivision`
   * would come back `null` from `target > 0`, and put the split back exactly
   * as it found it, which for a document just opened is whatever the *last*
   * document left there. Not rendering at all is the shorter road to the
   * right answer, and `clearKakikudashiView` takes the split off rather than
   * preserving it. */
  const populated = tree.sentences.length > 0;
  // Before the render, not after: see `setKakikudashiPopulated`.
  setKakikudashiPopulated(populated);
  // The same three indices the kundoku panel takes: this panel glosses a
  // word's first mention with ruby, and what earns a gloss is a dictionary
  // question (see `kakikudashi/rubyGloss.ts`).
  if (populated) renderKakikudashiView(kakikudashiView, tree, resolver, jmdict, kanjidic, historicalKana);
}

/** Draws the tree the reader already has open again — the one kind of redraw
 * that is a *change to a page* rather than the arrival of a new one.
 *
 * Two routes reach it: an annotation edit from the inspector, and the
 * 連用形-て switch. What they have in common is the whole reason this is one
 * function — the text on screen is the text that was on screen a moment ago,
 * so the reader's place in it must be kept and the difference between the two
 * states is something to be shown rather than cut to.
 *
 * **The scroll capture.** A render is written for a *new* text: each panel
 * resets itself to its own reading start on the way out, which is the right
 * opening position for a text just parsed and the wrong one for an edit made
 * halfway down a long one. Restoring here, rather than inside the inspector,
 * is what makes it cover every route into a redraw at once — the retag menus,
 * the reading menu, a head drag, undo, and the asynchronous second redraw
 * `relabelArcsUnder` makes when the parser's arc labels come back, which
 * would otherwise undo a restore that only spanned the edit itself.
 *
 * Restoring *before* returning also settles the selection's own
 * `scrollIntoView` (see `selectEntry`): the inspected character is back where
 * it was, so `inline: "nearest"` finds it already on screen and moves
 * nothing. Left to a panel reset to 0, that same call is what dragged the
 * character to the panel's edge and the reader with it.
 *
 * **The prose panel's walk, and why the capture is inside it.**
 * `animateKakikudashiReflow` measures every word in that panel either side of
 * this redraw, in viewport coordinates, and walks or fades each by what the
 * difference says (see `pushedAlongTheFlow`). Those two readings are only
 * comparable because the reset and the restore both fall *within* the call it
 * is given: a redraw that left the panel scrolled elsewhere would measure
 * every word as having crossed the panel. Nothing is painted in between, so
 * the reader never sees the trip to the start and back.
 *
 * **The three other routes into `renderTree` are deliberately not here**, and
 * they are `onParseText`, `onUploadConllu` and `onOpenSaved`. Each puts a
 * *different text* on the screen. There is no correspondence to animate — the
 * keys would match across two unrelated trees and walk word 12 of one text to
 * where word 12 of the other now stands — and no reader would read it as
 * anything but the page changing, which is what it is. `clearAll` empties the
 * panels outright and is the same case with nothing on the far side. The
 * kundoku panel draws the same line: `animateAnnotationShift` is asked for by
 * the switches, never by a parse. */
function redrawInPlace(): void {
  if (!lastRender) return;
  // **The disclosure stops here, whichever route asked for the redraw.**
  //
  // It used to be the edit handler's own line, on the reasoning that only an
  // edit could reach a page still being disclosed. The 連用形-て switch can
  // too, and it is worse than an edit when it does, because it moves the
  // page: it changes how many characters the prose holds, so `fitPassageExtent`
  // re-answers the division, and the answer can hand a whole character of
  // height across the rail — which re-breaks every column of both panels. Run
  // under a reveal, that is forty characters moving mid-fade, which is the one
  // thing the complete-tree route promises never happens (see `openCompleteTree`,
  // and `animateCharacterReveal`'s note on why no character moves there).
  //
  // So the cancel belongs at the funnel and not at one of the two mouths of
  // it: it covers both routes, it cannot be forgotten by a third, and it says
  // the same thing about both. Throwing a display switch is the reader saying
  // they are done watching, exactly as an edit is; the whole text comes up at
  // once, and what the redraw then re-fits is the page as the reader has it.
  //
  // On the parse path there is nothing to cancel by the time this can run:
  // `lastRender` is null for the length of the stream (see stage three), so
  // this returns above without touching the reveal that route is running.
  cancelCharacterReveal?.();
  const { tree, resolver, jmdict, kanjidic, historicalKana } = lastRender;
  animateKakikudashiReflow(() => {
    const restoreScroll = scrollSync.captureScroll();
    renderTree(tree, resolver, jmdict, kanjidic, historicalKana);
    restoreScroll();
  });
}

// The inspector edits `tree`'s own token objects in place, so re-running
// the same render is all that's needed to reflect an edit — in both panels,
// and (since it's the same `TokenTree` the sidebar already holds) in the
// CoNLL-U export too. The cancel that has to come first is inside
// `redrawInPlace` now rather than here; see there for why it moved.
setTokenEditHandler(redrawInPlace);

const sidebar = renderSidebar(document.querySelector<HTMLElement>("#sidebar")!, {
  /** A submitted text, in four stages: the characters one at a time, a parse
   * per sentence as each one finishes appearing, the apparatus over each
   * sentence as its answer lands, and then the whole text parsed once more
   * with the context that gives and the streamed result replaced by it.
   *
   * ── Stage one, the characters ─────────────────────────────────────────
   * `splitProvisional` divides the source by its own punctuation and line
   * breaks, and `renderBareKundokuView` draws it. The whole column is built in
   * the same task the button click reached — every cell, in its final place —
   * and on a short text the characters are then *disclosed* one at a time,
   * each fading in over `CHAR_FADE_MS` (`animateCharacterReveal`, which the
   * two complete-tree routes share). Nothing is appended and nothing reflows:
   * the panel's extent is what it will be from the first frame. What this
   * route cannot pass to that call is a prose panel, there being none until
   * the parse settles — the fade is the whole of what it shares with the
   * complete-tree routes.
   *
   * **On a long text they are not.** See `CHAR_REVEAL_MAX_CHARS`, which has
   * the arithmetic: at 6ms a character, 400 of them take 2.4 seconds and ten
   * thousand would take a minute. Past the threshold — and under
   * `prefers-reduced-motion`, whatever the length — the text simply appears,
   * which is what this route did until now. The parse is indifferent to which
   * of the two happened: a text drawn at once has every region ready at once.
   *
   * **This is the one route whose panel is bare while it discloses**, and it
   * is bare because there is nothing else to show yet. The two complete-tree
   * routes (`openCompleteTree`) disclose an annotated column with the prose
   * panel already beside it — see there for what that buys and why only they
   * can have it.
   *
   * The prose panel stays off the page throughout — `setKakikudashiPopulated
   * (false)` — which is the state it is already in for a document not yet
   * parsed, and that is also the answer to what the split does meanwhile: it
   * is *unset*, because `clearKakikudashiView` takes it off. The columns are
   * the length the type scale alone says, and no previous document's division
   * is on them.
   *
   * ── Stage two, the parse, and why it is not parallel ──────────────────
   * A region goes to the parser when its last character is on the screen, and
   * the answers are drawn as they land. That is *streaming*, not parallelism,
   * and the difference was costed rather than assumed.
   *
   * Genuine parallelism means one Pyodide per worker. This app vendors 20MB
   * of Pyodide runtime and 26.5MB of wheels, 19.4MB of which is the model
   * alone; a second worker refetches none of that (the browser cache holds
   * it) but pays all of the rest again — micropip unpacking 26.5MB of wheels
   * into its own MEMFS, `spacy.load` deserializing the model into its own
   * WASM heap, and that heap held for the life of the session. The cold load
   * is the app's longest wait as it is, and N workers means N of it and N
   * copies of the model resident. Against that, what parallelism buys is only
   * the parsing itself, which is the *short* half of the wait once the worker
   * is warm. So: one worker, and the sentences arrive in order, which is also
   * the order a reader reads them in.
   *
   * **The frontier is the only throttle**, and it replaced the doubling waves
   * this route used to plan. `nextBatch` is asked, each time the worker falls
   * idle, what is drawn and not yet asked about, and hands over as much of it
   * as fits in one `nlp()` call. While the characters are still arriving that
   * is about one region at a time; once they have all arrived it is as much as
   * the cap allows. Nothing schedules the growth — it is what falling behind
   * looks like.
   *
   * That the dispatch *follows* the animation rather than running ahead of it
   * is the load-bearing choice here, and it is worth saying what it buys
   * beyond doing what was asked. Everything is known in advance —
   * `splitProvisional` has every boundary before a character is drawn — so
   * running ahead was available and would have shaved the first region's
   * dispatch by the ~30ms its own characters take. What following buys instead
   * is that **an annotation can never arrive for a character that is not on
   * the screen**, so the reveal can splice its answer in the moment it lands
   * and needs no queue of its own. Thirty milliseconds against a cold load of
   * seconds, for a whole mechanism not written.
   *
   * ── Stage three, the reveal ───────────────────────────────────────────
   * Each answer is laid out, merged, split, and matched back to the regions it
   * came from (`partitionByRegion`); each match replaces its region's bare
   * characters with the annotated sentences and fades the apparatus in.
   *
   * **Nothing on the page can be edited while this runs.** Not the retag
   * menus, not the readings, not a head drag, not undo. Three things say so
   * and between them they cover every route in:
   *
   *  - the revealed sentences are not registered with the inspector
   *    (`revealAnnotatedSentences`), so `resolveEntry` answers nothing and
   *    every pointer gesture — selection, the analysis overlay, both retag
   *    menus, the readings menu, the drag — declines for want of a token;
   *  - `setHistoryTree(null)` empties the undo history, so Cmd+Z finds
   *    nothing to undo and falls through to the browser rather than
   *    restoring the *previous* document's tree over this one's page;
   *  - `lastRender` is cleared, so `redrawInPlace` — which the 連用形-て
   *    switch also reaches — has nothing to draw and does nothing, instead of
   *    drawing the previous document.
   *
   * It is stage four that makes this the right answer rather than a
   * precaution: the streamed trees are *replaced*, so any edit made against
   * them would be an edit thrown away. With nothing editable there is no hand
   * work to lose, and the replacement can be wholesale.
   *
   * ── Stage four, the single-shot re-parse ──────────────────────────────
   * The whole text, once, and the streamed sentences discarded in favour of
   * it. What it buys is context: a region parsed on its own is embedded
   * knowing only itself, where a whole-document call lets the tok2vec see its
   * neighbours. Per-sentence dispatch made that cost *worse* than the doubling
   * waves did — every sentence pays it now, not just the first few — and this
   * is what repairs it, which is the trade this round makes deliberately.
   *
   * **How much context, exactly.** Not unbounded: the worker's own
   * `chunkText` caps every `nlp()` call at `MAX_CHUNK_CHARS`, so this is a
   * re-parse at the full chunk width the app has always used, not a
   * whole-document embedding. On a text under 1500 characters that *is* the
   * whole document. On a longer one what it repairs is the opening — always
   * one region wide in the stream — and the chunk boundaries, which fall in
   * different places here than the frontier put them.
   *
   * The swap is an ordinary `renderTree` over the finished tree, and it is
   * silent where the two parses agree: the same characters in the same cells
   * with the same apparatus, so the replacement paints identically and the
   * only movement on the page is the one below, which was always going to
   * happen. Nothing fades. Nothing is preserved across it either, because
   * there is nothing to preserve — with the gate on, no selection and no menu
   * can exist to survive it. (`rerenderPreservingSelection` in the inspector
   * is the mechanism for the case where something can; it is not needed here,
   * and see the report for the one line it would take to make it available if
   * a later change lets a selection stand during the stream.)
   *
   * **If it fails**, the streamed tree stands. The reader keeps a complete,
   * fully annotated document — every annotation on it is a real parse of
   * their text — and the only difference is the width of the context behind
   * it, which is not a thing they can act on. So it is logged and not
   * reported: the page finishes exactly as it would have, edits enable, and
   * the status line says Ready because the app is. What must *not* happen is
   * the reverse — throwing away a page that works to report a repair that
   * did not.
   *
   * ── The settle ────────────────────────────────────────────────────────
   * The prose panel is drawn *once*, in that same swap, which is what makes
   * the fit measure once, against the passage it is actually dividing, and
   * against the *final* extent rather than the streamed one. It has a cost and
   * it is visible: the fit takes height from this panel in whole characters,
   * so the kundoku column changes length at that moment and the text the
   * reader has been watching since stage one reflows. There is no way to know
   * the division earlier — the prose is the parse's output — so the choice is
   * only between one reflow at the end and one per sentence.
   *
   * It goes through `animateAnnotationShift`, so the characters *walk* to
   * their new places over the same 260ms everything else in this app takes to
   * settle, rather than jumping. `captureScroll` holds their place across the
   * re-render — by pixel, as it does for every other one, which after a change
   * of column length is an approximation rather than an exact restoration of
   * the sentence they were looking at.
   *
   * ── scrollSync ────────────────────────────────────────────────────────
   * Nothing to do: it aligns the panels by counting `.sentence-gap`s and
   * returns early when the two counts differ, which they do throughout —
   * the prose panel is empty (no gaps at all) until the settle. The first
   * moment it can act is the first moment both panels hold the same text. */
  async onParseText(text) {
    sidebar.setParsing(true);
    // Nothing to export or save while a new text is on the screen unparsed —
    // the tree the buttons would act on is the *previous* document's.
    setTree(null);
    // And nothing to edit. Both of these are the previous document's too, and
    // leaving either behind is not merely untidy: an undo or a 連用形-て switch
    // during the parse would draw that document over this one's page. See the
    // gate in stage three.
    lastRender = null;
    setHistoryTree(null);
    // Whatever was still being disclosed belongs to a text that is no longer
    // on the screen. Cancelling releases anything its own parse loop is
    // waiting on, so that loop wakes, finds its generation superseded, and
    // stops.
    cancelCharacterReveal?.();

    const regions = splitProvisional(text);
    const lengths = regions.map((r) => r.length);
    setKakikudashiPopulated(false);

    const progressive = revealsProgressively(lengths.reduce((a, b) => a + b, 0));
    renderBareKundokuView(kundokuView, regions);
    sidebar.setStatus(t("status.loadingParser"), "busy");

    /** Which parse this is. An answer arrives long after it was asked for,
     * and it must never be drawn onto a page that has moved on — the bare
     * spans of a *second* text carry the same region numbers as the first's,
     * so a stale answer would find spans to replace and replace the wrong
     * ones.
     *
     * The panel is guarded already, mostly: the parse button is disabled while
     * a parse runs, and every other route (clearing, opening a saved text)
     * leaves a column with no region numbers in it at all, which the reveal
     * declines. This makes the rule explicit rather than a consequence of a
     * disabled button somewhere else. */
    const generation = ++parseGeneration;

    /** How much of the text is on the screen, as whole regions. The dispatch
     * loop below waits on it; the animation advances it. A text drawn at once
     * starts complete, and the loop then never waits. */
    const drawn = createFrontier(progressive ? 0 : regions.length, regions.length);
    const stopReveal = progressive
      ? animateCharacterReveal(kundokuView, (charsShown) => drawn.set(regionsDrawnBy(lengths, charsShown)))
      : null;
    // Cancelling the animation must also release anything waiting on the
    // frontier — otherwise a loop halfway through a superseded text would sit
    // on a `wait()` that nothing is ever going to resolve, and its `finally`
    // (which re-enables the buttons, among other things) would never run.
    const stopDisclosure = (): void => {
      stopReveal?.();
      drawn.release();
    };
    cancelCharacterReveal = stopDisclosure;

    try {
      // Both at once. The wheels are the long wait — 20MB of Pyodide and
      // 26.5MB of wheels — and the reading indices are fetched over the
      // network too; starting the parser here rather than awaiting the
      // resolver first is what keeps the two overlapping, as the single
      // `Promise.all` this replaced did.
      const parserReady = initParser();
      const { resolver, jmdict, kanjidic, historicalKana } = await getResolver();
      await parserReady;
      if (generation !== parseGeneration) return;
      sidebar.setStatus(t("status.parsing"), "busy");

      /** The streamed sentences, kept only against stage four failing. */
      const streamed: Sentence[] = [];
      let dispatched = 0;
      while (dispatched < regions.length) {
        const batch = nextBatch(lengths, dispatched, drawn.value);
        if (!batch) {
          // Nothing complete that has not been asked about — the characters
          // are still arriving. Wait for the next of them rather than
          // spinning.
          await drawn.wait();
          if (generation !== parseGeneration) return;
          continue;
        }
        const [from, to] = batch;
        // From the first character of the batch's first region to the last of
        // its last — so the whitespace *between* its regions comes along (the
        // line breaks the layout is measured from) and the whitespace before
        // it does not. What that leading whitespace said is passed separately,
        // as `breakBefore`: a slice taken out of the middle of a document no
        // longer carries the newline that opened it.
        const batchSource = text.slice(regions[from].start, regions[to - 1].end);
        const batchTree = await parseWithPyodide(batchSource);
        if (generation !== parseGeneration) return;
        // The same three passes the whole document goes through, over a slice
        // instead — the layout first, since the split reads it to know where
        // the lines are, and then the two corrections to the parser's
        // segmentation: it ends a sentence at ： and ；, which end none, and
        // it runs past ， and past a line break, which both do.
        annotateSourceLayout(batchTree, batchSource, regions[from].breakBefore);
        const split = splitIntoSentences(mergeAtMedialPunctuation(batchTree));
        const sentenceLengths = split.sentences.map(sentenceLength);
        for (const unit of partitionByRegion(lengths.slice(from, to), sentenceLengths)) {
          revealAnnotatedSentences(
            kundokuView,
            from + unit.regions[0],
            from + unit.regions[1],
            split.sentences.slice(unit.sentences[0], unit.sentences[1]),
            resolver,
            jmdict,
            kanjidic,
            historicalKana,
          );
        }
        streamed.push(...split.sentences);
        dispatched = to;
      }

      // ── Stage four ───────────────────────────────────────────────────────
      const sentences = await parseWholeText(text, streamed);
      if (generation !== parseGeneration) return;
      const tree: TokenTree = { source: "pyodide", sentences };
      // Once more over the whole document. Per batch the measurement was of a
      // slice, and a slice cannot see that its first token is also the
      // document's first token, or count an indent that a previous batch's
      // trailing whitespace carried. What is saved and exported is this
      // measurement, taken exactly as it always was — and on the single-shot
      // path it is a second reading of the same thing, which costs a walk and
      // keeps one rule for both.
      annotateSourceLayout(tree, text);

      // Before the swap rather than after, and that is the order rather than
      // the arrangement: `glueOpeningPunctForward` inside
      // `settleKundokuColumn` *moves cells between sentences* (an opening
      // bracket ending one sentence is glued to the first unit of the next,
      // and the wrapper stays in the first), and `animateAnnotationShift`
      // pairs its two readings by sentence, token id and which cell of that
      // token — keys a move across a sentence boundary changes. Run over the
      // streamed column first, the move is behind both readings and every key
      // names the same cell in each.
      //
      // What that costs is `--annotation-overhang`: it is published here too,
      // and if the deepest annotation on the page reaches past the panel's own
      // bottom margin the columns shorten by a character at this moment
      // without walking. It fires on almost nothing — 55px of margin against
      // the 32px a two-mark kaeriten reaches — and only on a reading of seven
      // kana or more.
      settleKundokuColumn(kundokuView, jmdict, kanjidic, historicalKana);
      animateAnnotationShift(() => {
        const restoreScroll = scrollSync.captureScroll();
        // Which is where the edits come back: this render registers every
        // sentence with the inspector, attaches it, and `adoptTree` inside it
        // gives the undo history its tree.
        renderTree(tree, resolver, jmdict, kanjidic, historicalKana);
        restoreScroll();
      });
      setTree(tree);
      sidebar.setStatus(t("status.ready"));
    } catch (err) {
      console.error(err);
      // The bare text stays on the screen. It is the reader's own text, they
      // asked to see it, and it is more use to them than the panel they had
      // before this — which was another document.
      sidebar.setStatus(t("error.parserUnavailable"), "error");
    } finally {
      // All of it, whichever way this ended. On the ordinary path the
      // animation is long finished and this is a no-op; on the error path it
      // is what keeps the last characters from being held back for a parse
      // that is never coming.
      stopDisclosure();
      if (cancelCharacterReveal === stopDisclosure) cancelCharacterReveal = null;
      // Only if this is still the parse the buttons are disabled *for*. A run
      // that has been superseded is finishing after something else took the
      // page over, and re-enabling the buttons on its way out would enable
      // them in the middle of that.
      if (generation === parseGeneration) sidebar.setParsing(false);
    }
  },

  /** An uploaded CoNLL-U file: the same situation as a saved text and, since
   * the user asked for it to behave like one, literally the same code —
   * `openCompleteTree`, which has the argument for all of it.
   *
   * What is different is only what happens *before* that call, and it is the
   * difference between this app's own export and a stranger's file. The
   * parse, the plausibility check and the rejection all happen first, so the
   * reveal never starts on a tree that is about to be turned away: an
   * implausible file sets the error and returns with the previous page still
   * on the screen, and a file that parsed to nothing reaches the status line
   * at once rather than holding a blank panel while an animation runs over no
   * characters.
   *
   * Any parse still in flight stops drawing here — the page is about to be
   * another document's — and whatever was left of the last disclosure is
   * stopped rather than left un-hiding cells in a column about to be
   * replaced. */
  async onUploadConllu(fileText) {
    parseGeneration++;
    cancelCharacterReveal?.();
    sidebar.setParsing(true);
    try {
      const tree = parseConllu(fileText);
      const validation = validateConlluForLzh(tree);
      if (!validation.valid) {
        console.warn("CoNLL-U plausibility warnings:", validation.warnings);
        sidebar.setStatus(t("error.invalidConllu"), "error");
        return;
      }
      await openCompleteTree(tree);
    } catch (err) {
      console.error(err);
      sidebar.setStatus(t("status.error"), "error");
    } finally {
      sidebar.setParsing(false);
    }
  },
  onClear() {
    clearAll();
  },
  /** The 連用形-て switch changes what the two panels write, so it needs the
   * same redraw an in-place edit needs, and gets it from the same place —
   * `redrawInPlace` above, which is the whole argument for the capture and
   * for the prose panel's walk.
   *
   * The sidebar runs this inside `animateAnnotationShift`, so the kundoku
   * panel's own before-reading is taken outside this call and its after-
   * reading once this has returned. Both panels' measurements therefore
   * straddle one reset-and-restore, and every animation either of them starts
   * lands in this one task and so shares a start time. */
  onRenyouTeChange: redrawInPlace,
});

/** Back to the opening state: the kundoku panel back to its placeholder, the
 * prose panel off the page again, nothing to export or save. The same two
 * calls that set the panels up in the first place (see above), so "cleared"
 * and "just opened" are the same thing rather than two states that have to be
 * kept in step — which now covers the prose panel's absence and the split on
 * the grid as well as the markup. */
function clearAll(): void {
  parseGeneration++; // whatever is still parsing must not draw onto an empty page
  cancelCharacterReveal?.();
  // Cleared as they are at the head of a parse, and for the same reason: an
  // undo or a 連用形-て switch after this must not put the document that was
  // just cleared back on the page.
  lastRender = null;
  setHistoryTree(null);
  kundokuView.innerHTML = `<p class="main-empty" data-i18n="main.empty"></p>`;
  setKakikudashiPopulated(false);
  applyTranslations(kundokuView);
  setTree(null);
  sidebar.setStatus("");
}

/** Both panels take a tree at once — the left one to enable its export and
 * print buttons, the right one its save button. */
function setTree(tree: TokenTree | null): void {
  sidebar.setTree(tree);
  savedPanel.setTree(tree);
}

const savedPanel = renderSavedPanel(document.querySelector<HTMLElement>("#saved-panel")!, {
  currentSource: () => sidebar.sourceText(),
  /** A saved text: straight from storage, and through `openCompleteTree` —
   * the same function the CoNLL-U upload calls, for the same reasons, which
   * that function states.
   *
   * The tree already carries any hand edits, and re-parsing `source` would
   * throw them away (as well as needing the parser up just to reopen
   * something already annotated). Which is the fact everything else about
   * this route follows from: there is nothing to wait for, so the prose panel
   * and the fit are both there from the first frame, no character moves, and
   * nothing is gated. */
  async onOpenSaved(source, tree) {
    parseGeneration++; // a new document, in one pass
    cancelCharacterReveal?.();
    sidebar.setSourceText(source);
    sidebar.setParsing(true);
    try {
      await openCompleteTree(tree);
    } catch (err) {
      console.error(err);
      sidebar.setStatus(t("status.error"), "error");
    } finally {
      sidebar.setParsing(false);
    }
  },
});
applyTranslations(document.querySelector<HTMLElement>("#saved-panel")!);

/** Collapsing either panel is a class on `#app`, so the grid columns (and
 * the rails' own arrows) are described in one place in CSS rather than
 * being poked at from script. The choice persists so a preferred working
 * layout survives a reload.
 *
 * Three classes are written here and `kakikudashi-empty` is not one of them,
 * which is the point of it being a separate class — see
 * `setKakikudashiPopulated`. Nothing below reads it, nothing below writes it,
 * and it is never stored: it is a fact about the document, and the document
 * does not survive a reload. What is restored on the next load is the
 * reader's three preferences, over a page that starts empty; the prose panel
 * then appears the moment a text does, still shut if that is how they left
 * it. */
const COLLAPSE_KEY = "jidou-kundoku:collapsed";
const railLeft = document.querySelector<HTMLButtonElement>("#toggle-left")!;
const railRight = document.querySelector<HTMLButtonElement>("#toggle-right")!;
const railKakikudashi = document.querySelector<HTMLButtonElement>("#toggle-kakikudashi")!;

function syncRailLabels(): void {
  const leftOpen = !app.classList.contains("left-collapsed");
  const rightOpen = !app.classList.contains("right-collapsed");
  railLeft.title = t(leftOpen ? "sidebar.collapseLeft" : "sidebar.expandLeft");
  railLeft.setAttribute("aria-label", railLeft.title);
  railLeft.setAttribute("aria-expanded", String(leftOpen));
  railRight.title = t(rightOpen ? "sidebar.collapseRight" : "sidebar.expandRight");
  railRight.setAttribute("aria-label", railRight.title);
  railRight.setAttribute("aria-expanded", String(rightOpen));
  const kakiOpen = !app.classList.contains("kakikudashi-collapsed");
  railKakikudashi.title = t(kakiOpen ? "main.collapseKakikudashi" : "main.expandKakikudashi");
  railKakikudashi.setAttribute("aria-label", railKakikudashi.title);
  railKakikudashi.setAttribute("aria-expanded", String(kakiOpen));
}

function persistCollapse(): void {
  try {
    localStorage.setItem(
      COLLAPSE_KEY,
      JSON.stringify({
        left: app.classList.contains("left-collapsed"),
        right: app.classList.contains("right-collapsed"),
        kakikudashi: app.classList.contains("kakikudashi-collapsed"),
      }),
    );
  } catch {
    // Unavailable (private mode) — the layout just won't persist.
  }
}

try {
  const stored = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  app.classList.toggle("left-collapsed", stored.left === true);
  app.classList.toggle("right-collapsed", stored.right === true);
  app.classList.toggle("kakikudashi-collapsed", stored.kakikudashi === true);
} catch {
  // Ignore a corrupt entry and open both.
}
syncRailLabels();

/** How long a collapse takes, and the same 260ms the app settles text at
 * everywhere else — `REFLOW_MS` in KundokuView.ts, `FADE_MS` in
 * KakikudashiView.ts, the visibility fade in kunten.css. Stated again here, as
 * those state it, rather than imported, and it has to be the same number as
 * the transitions in app.css that actually draw the movement: this is only
 * what takes the licence to move away again afterwards.
 *
 * The longer of the two house intervals rather than the 160ms of the analysis
 * box and the menus, and what decides it is the division between them rather
 * than the size of the movement: 160ms is what something takes to *appear
 * over* the page, and 260ms is what the page itself takes to settle. A rail
 * hands a whole column or a whole row from one panel to another and the text
 * re-breaks into it — the largest reflow the app performs, and the one thing
 * on the page a reader has to follow from one place to another. */
const COLLAPSE_MS = 260;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** One frame's grace on top of the interval, and the reason for it. The
 * transition does not begin when `toggleRail` runs — it begins at the next
 * style recalculation, which is up to a frame later — so a timer set to the
 * interval exactly comes due while the last frame or two is still travelling.
 * Taking the licence away then cancels the transition mid-flight and snaps the
 * tracks to their end values. Two frames at 60Hz, which is generous enough to
 * cover a display running slower and short enough that the licence is not
 * still lying around for the next thing that changes the layout. */
const COLLAPSE_GRACE_MS = 32;

/** The gesture's own licence to move, taken away again when it is over. */
let animatingTimer: ReturnType<typeof setTimeout> | undefined;


/** **A rail, as a movement of the grid itself.**
 *
 * The class on `#app` is still the whole of the state — the grid, the rails'
 * arrows and the stored preference all read it, exactly as they did when this
 * was three lines. All that is added is a second class that licences the
 * transitions in app.css for the length of the gesture, and a timer that takes
 * it away again.
 *
 * **The licence is the whole reason it is a class and not a plain
 * declaration.** Four things depend on nothing being able to animate except a
 * rail that was clicked:
 *
 *   - **The restore at page load.** `#app`'s three classes are written from
 *     `localStorage` before anything is drawn (above). With the transition
 *     declared unconditionally, a reader who had shut a panel would watch it
 *     close again on every reload — which is a bug wearing a flourish's
 *     clothes. Declared under this class, and this class only ever added by a
 *     click, the restore is a plain layout with nothing to interpolate.
 *
 *   - **A text arriving or being cleared.** That moves `.main` between the
 *     three-row layout and `kakikudashi-empty`'s single row, and track lists
 *     of *different lengths* do not interpolate — they fall back to a discrete
 *     transition, which under CSS's rules flips at the half-way point. A text
 *     would have appeared with its prose panel 130ms late. There is nothing to
 *     fix in that layout: it simply must not be a transition, and here it
 *     never is.
 *
 *   - **A window being dragged.** `#app`'s columns are `1fr` and two fixed
 *     tracks, so a resize changes the computed value of a property that would
 *     otherwise be transitioning, and the layout would lag the window edge.
 *
 *   - **The fit's own writes**, which is why the licence is *per axis* rather
 *     than one class for both. `fitPassageExtent` (KakikudashiView.ts) chooses
 *     the split between the panels by writing `--kundoku-extra-slots` onto
 *     `.main` and measuring what the page then comes to, synchronously, once
 *     per candidate. A transition on `grid-template-rows` in force at that
 *     moment would hand each measurement an interpolated height and the search
 *     would choose from a layout that no longer existed. So a sidebar licences
 *     the columns and nothing else, and the prose panel's rail licences the
 *     rows and nothing else; neither can reach the other's axis. app.css
 *     argues the same from its side.
 *
 *     The race that arrangement used to leave — the search running from
 *     `observePanelFit` on every frame of a sidebar collapse — is gone rather
 *     than narrowed: no fit runs during any gesture at all now. See
 *     `suspendPanelFit` below, and the note there for why deferring it costs
 *     the page nothing.
 *
 * Reduced motion takes none of it: the classes are written, the labels and the
 * preference follow, and the page is the page it would have settled on — the
 * stylesheet says the same thing again on its own side, so neither half of the
 * arrangement can animate under the preference on its own.
 *
 * A second click while the first is still running keeps the licence and
 * restarts the clock; the transition itself reverses from wherever it has got
 * to, which is a CSS transition's own behaviour and the reason this is one.
 * One timer for all three rails, since one licence covers whatever is moving
 * and the last click is the one whose settling matters. */
function toggleRail(collapsed: string, licence: "columns-animating" | "rows-animating"): void {
  if (!prefersReducedMotion()) {
    // ── Nothing may re-measure while the page is moving ─────────────────
    //
    // **The fit, on either axis.** `observePanelFit` watches `.main`, and a
    // sidebar changes `.main`'s own width on every frame — so, left alone, the
    // fit's whole search runs sixteen times over one gesture, each run a
    // handful of forced layouts of the entire page. That is the chop, and the
    // argument that one fit at the end is not merely cheaper but the *same
    // answer* is at `suspendPanelFit`. The prose panel's rail does not reach
    // the observer at all (it changes `.main`'s rows, not `.main`), and
    // suspending on its account costs nothing; the rule is easier to hold to
    // as "no fit runs while a rail is moving" than as an exception list.
    //
    // **The measure, on the row axis only.** See `holdPanelMeasures`: the two
    // passages keep the setting they have for the length of the gesture, so
    // the prose panel leaves the page looking exactly as it looked instead of
    // re-breaking its columns four times on the way out. The sidebars need
    // none of it — they change how much of a passage is on screen and not how
    // long its columns are, so nothing in either panel re-breaks.
    //
    // **And the disclosure, on the row axis only.** Releasing the hold lets
    // the kundoku column take its new quantum, which re-breaks the passage and
    // moves every character in it — the one thing the complete-tree routes
    // promise never happens while the reveal is running (see
    // `openCompleteTree`). So the prose rail brings the whole text up first,
    // on the same reading as `redrawInPlace`: asking the page to change shape
    // is the reader saying they are done watching. A sidebar rail is not that
    // and does not cancel: it translates the passage across the window without
    // re-breaking a column of it, which is not a movement the reveal is about.
    if (licence === "rows-animating") {
      cancelCharacterReveal?.();
      holdPanelMeasures([kundokuView, kakikudashiView]);
    }
    suspendPanelFit();
    // Before the state change, so that the style the browser computes at the
    // end of this task is one that both names the new tracks and has a
    // transition to reach them by.
    app.classList.add(licence);
    clearTimeout(animatingTimer);
    animatingTimer = setTimeout(() => {
      app.classList.remove("columns-animating", "rows-animating");
      // The measure back first and the fit second, in that order and in one
      // task: the fit measures the panel, and a fit run against a box still
      // pinned to the size it had before the gesture would answer for a page
      // that has just stopped existing.
      releasePanelMeasures();
      resumePanelFit();
    }, COLLAPSE_MS + COLLAPSE_GRACE_MS);
  }
  app.classList.toggle(collapsed);
  syncRailLabels();
  persistCollapse();
}

railLeft.addEventListener("click", () => toggleRail("left-collapsed", "columns-animating"));
railRight.addEventListener("click", () => toggleRail("right-collapsed", "columns-animating"));
railKakikudashi.addEventListener("click", () => toggleRail("kakikudashi-collapsed", "rows-animating"));
