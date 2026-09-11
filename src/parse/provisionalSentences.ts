import { MAX_CHUNK_CHARS } from "./chunkText.ts";
import { isBracket, isOpeningBracket, isSentenceFinalPunct } from "./punctuation.ts";
import type { LineBreakKind } from "./sourceLayout.ts";
import type { Sentence } from "./types.ts";

/** ── Sentence boundaries before there is a parse ──────────────────────────
 *
 * A submitted text is drawn before the parser has been asked anything — a
 * character at a time on a short text, and at once on a long one — and each
 * region is asked about the moment its last character is on the screen. Both
 * halves of that need to know where the sentences are, and at the moment the
 * text is drawn the only thing that knows is the text itself.
 *
 * (That "at once on a long one" is this route's rule and not the app's. A text
 * whose tree is already complete is drawn a character at a time however long
 * it is — there is no parse to pace, so there is no cap. See `RevealContext`
 * in the second half of this file, which is where the two are told apart. The
 * *division* below is only ever this route's: it exists because there is no
 * parse yet, and a complete tree has one.)
 *
 * So the division here is made out of the source's own punctuation and line
 * structure, and it is called **provisional** because the parser has its own
 * opinion and has not given it yet. The whole design rests on one relation
 * between the two, which is worth stating exactly because it is what makes
 * the reveal safe:
 *
 *   **The parser's final division is a refinement of this one.** Every
 *   boundary drawn here is also a boundary in the finished tree, and the
 *   parser may add more inside a region but can never cross one.
 *
 * That is not a hope about the model. It is a fact about the two passes
 * `main.ts` runs over the parse output, and it holds for either kind of
 * disagreement:
 *
 *  - **The parser divides where this does not.** `splitIntoSentences` cuts
 *    after every sentence-final punctuation token and before every token that
 *    opens a new line — the same two rules as below — so a division it makes
 *    inside a region simply stands, and the region receives two sentences
 *    instead of one. This is the ordinary case on unpunctuated input, where
 *    the wheel's `sent_join` segments by its own lights and this file, having no
 *    punctuation to read, offers the whole line as one region.
 *
 *  - **The parser runs past a boundary this draws.** `splitIntoSentences`
 *    severs it regardless: a sentence spanning a 。 or a line break is cut at
 *    it and each fragment re-rooted. So a parser sentence that straddles a
 *    region is gone by the time the reveal sees it.
 *
 * The one direction that could break the relation is a *merge* across a
 * region boundary, and `mergeAtMedialPunctuation` is the only thing that
 * merges. It joins a sentence to the one before it only when that one ends
 * in a **medial** mark (、：；), and it refuses even then if the second opens
 * a new line. A region ends at a sentence-final mark or at a line break, and
 * at neither of those can that test pass. So no merge can span a region.
 *
 * What is left is a residue this cannot legislate away: the tokenizer might
 * fuse a boundary mark into a neighbouring word, so that the character counts
 * on the two sides never coincide. `partitionByRegion` below is where that is
 * handled, and it handles it by revealing the regions in question *together*
 * rather than by guessing which characters went where. */

/** One provisional sentence: a run of the source that the reveal treats as a
 * unit, with everything the bare render needs to draw it and everything the
 * parse needs to cut a slice for it. */
export interface ProvisionalSentence {
  /** Offset in the source of this region's first character — *after* the
   * whitespace that precedes it, which belongs to the boundary and not to
   * either side of it. */
  start: number;
  /** Offset just past its last character. */
  end: number;
  /** `source.slice(start, end)` — its own characters, and any whitespace
   * *between* them (never a newline: a newline ends a region). */
  body: string;
  /** How many non-whitespace characters `body` holds, counted in code points
   * exactly as `renderSentence` counts them when it draws one cell per
   * character of a fused token. This is the currency `partitionByRegion`
   * settles the accounts in, so it has to be counted the same way on both
   * sides. */
  length: number;
  /** Whether this region opens a new line or a new paragraph in the source —
   * `sourceLayout.ts`'s own two kinds, since it is that module's answer this
   * is standing in for until the parse arrives. */
  breakBefore?: LineBreakKind;
  /** Leading whitespace on that line, in source characters. */
  indent: number;
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** Non-whitespace characters, in code points. */
export function charCount(text: string): number {
  let n = 0;
  for (const ch of text) if (!isWhitespace(ch)) n++;
  return n;
}

/** Divides `source` at every boundary that can be read off the text alone.
 *
 * Two rules, and they are deliberately the same two `splitIntoSentences`
 * applies to the finished tree — cut *after* a sentence-final mark, which
 * closes what precedes it, and *before* a new line, which opens what follows
 * it. Written against characters here rather than against tokens, that being
 * the whole point: there are no tokens yet.
 *
 * A run of marks divides at each of them, so 。」 comes out as a region
 * ending at the 。 and a region holding the 」 alone — which is exactly what
 * the parser does with a closing quote after a full stop, and what the
 * kundoku panel is already written to draw (see `endsSentence`).
 *
 * Whitespace is consumed at the boundary it falls on and counted there, in
 * `sourceLayout.ts`'s own terms: two newlines or more open a paragraph, one
 * opens a line, and whatever follows the last newline is the indent. Spaces
 * with no newline among them indent without opening anything, which is that
 * module's rule too. */
export function splitProvisional(source: string): ProvisionalSentence[] {
  const regions: ProvisionalSentence[] = [];
  let open: { start: number; breakBefore?: LineBreakKind; indent: number } | null = null;
  /** Just past the last non-whitespace character taken in, which is where a
   * region ends — trailing whitespace belongs to the boundary. */
  let lastEnd = 0;
  let newlines = 0;
  let indent = 0;
  let firstOfAll = true;
  let cursor = 0;
  /** How many quotation brackets are open. A sentence-final mark inside one
   * does not end the region — see the `close()` call at the foot of the loop. */
  let quoteDepth = 0;

  const close = (): void => {
    if (open === null) return;
    const body = source.slice(open.start, lastEnd);
    regions.push({
      start: open.start,
      end: lastEnd,
      body,
      length: charCount(body),
      ...(open.breakBefore ? { breakBefore: open.breakBefore } : {}),
      indent: open.indent,
    });
    open = null;
  };

  for (const ch of source) {
    const at = cursor;
    cursor += ch.length;
    if (isWhitespace(ch)) {
      if (ch === "\n") {
        newlines++;
        indent = 0; // only whitespace *after* the last newline indents
      } else {
        indent++;
      }
      continue;
    }
    // A line break closes whatever was open: the break is a boundary in its
    // own right, and the region that follows it carries the break so that the
    // render can put the column change back where the source had it.
    if (newlines > 0) close();
    if (open === null) {
      open = {
        start: at,
        // The very first character of the document opens no line, however the
        // text begins — `annotateSourceLayout`'s own `firstOfAll` rule.
        breakBefore: firstOfAll ? undefined : newlines >= 2 ? "para" : newlines === 1 ? "line" : undefined,
        indent,
      };
      firstOfAll = false;
    }
    newlines = 0;
    indent = 0;
    lastEnd = cursor;
    if (isBracket(ch)) {
      // Clamped at zero so an unmatched closing bracket cannot drive the
      // count negative and disable every boundary after it. A text is as
      // likely to be missing an opener as a closer, and neither should cost
      // the reader the rest of the document.
      quoteDepth = isOpeningBracket(ch) ? quoteDepth + 1 : Math.max(0, quoteDepth - 1);
    }
    // **A 。 inside a quotation ends no region, and this is the whole of
    // "defer to the parser".** A region is what gets *dispatched* — the
    // pipeline is handed one region at a time — so a cut here is a hard
    // boundary the parser cannot see across, whatever its own segmenter would
    // have done with the text. 異史氏曰：「日盡一石…乎？或言：『…。』然歟否歟？」
    // was handed over as four separate calls, so the 曰 in the first never had
    // the rest of its own complement to govern, and the quotative と landed at
    // the end of the *first* sentence instead of after the last. Kept whole,
    // the quotation reaches the parser as one string and its segmentation is
    // the parser's to make.
    //
    // A line break still closes a region wherever it falls, quotation or not
    // (see the `newlines` test above): that is a fact about how the source is
    // laid out rather than about where a sentence ends, and the regions carry
    // it so the panels can put the column change back. No quotation in the
    // reader's own text spans one.
    if (quoteDepth === 0 && isSentenceFinalPunct(ch)) close();
  }
  close();
  return regions;
}

/* ── When the characters appear, and when each region is asked about ──────
 *
 * Stage one is no longer one synchronous render. The characters arrive one
 * at a time, and a region is sent to the parser at the moment its last
 * character is on the screen — display and dispatch interleaved, which is
 * what replaced the fixed doubling of waves this file used to plan.
 *
 * Everything below is the arithmetic of that, kept apart from the DOM so it
 * can be tested without one. `KundokuView.ts` owns the cells; this owns the
 * schedule. */

/** How long each character waits behind the one before it.
 *
 * A note on what this can and cannot mean: a frame is 16.7ms on a 60Hz
 * display, so a step shorter than that reveals characters in *groups* of
 * however many the elapsed time has passed — three, here. That is not a
 * compromise being hidden; it is the only thing a screen can do, and at this
 * step it reads as the text flowing onto the page rather than as a key being
 * struck. The schedule is written against elapsed time and not against frames
 * so that it takes the same wall-clock time on a 120Hz display as on a 60Hz
 * one. */
export const CHAR_REVEAL_MS = 6;

/** How long one character takes to come up, in milliseconds.
 *
 * **260, which is `REFLOW_MS`** — the interval this app settles the text
 * itself over. It is stated in `KundokuView.ts`, again as `FADE_MS` in
 * `KakikudashiView.ts`, and again as a transition in `kunten.css`; this is a
 * fourth place, for the reason the other three give. One gesture, one speed.
 *
 * The house has two intervals and the choice between them is not close. 160ms
 * is what a label answering a gesture takes — the analysis overlay, the
 * menus — things that come up *over* the text and go away again. 260 is what
 * the text takes, and the note at `REFLOW_MS` says why the two differ: it
 * "moves the text itself rather than bringing a label up over it, and
 * something the reader has to follow from one place to another needs longer
 * than something that merely appears". A character arriving on the page is
 * the text itself in the plainest sense the app has.
 *
 * The parse path settles it beyond argument. There the characters come up
 * under this constant and the apparatus is written over them under
 * `REFLOW_MS` (see `revealAnnotatedSentences`) — the same page, often the
 * same character, within a second of each other. Two intervals there would be
 * one event answering at two speeds.
 *
 * ── What that comes to on the page ────────────────────────────────────────
 * The frontier advances a character every `CHAR_REVEAL_MS`, so at any instant
 * `CHAR_FADE_MS / CHAR_REVEAL_MS` characters — forty-three — are somewhere
 * between nothing and full ink. A kundoku column here is short, this panel
 * being a strip above the prose: the 359 characters of 酒蟲 are set in 69 columns
 * (`fitPassageExtent`'s own figure), about five to a column, so the leading
 * edge is some eight columns deep and the text arrives as a gradient rather
 * than as a line.
 *
 * **The gradient is the effect and not the price of it.** It is what a fade
 * of this length *is*; the alternative — a depth of a dozen characters,
 * chosen so that the newest character is unambiguously the newest — is a
 * softened snap called a fade. What the reader is shown is a page being
 * written on, not a cursor travelling down one.
 *
 * At 60Hz that is 15.6 frames and at 120Hz 31, so it is a fade on any
 * display. It is also what makes the frontier's own coarseness invisible:
 * the characters arrive in groups of three to the frame (see
 * `CHAR_REVEAL_MS`), and at this depth each group comes in at its own alpha
 * rather than three at once at full ink.
 *
 * One consequence, stated here because the budgets are stated at
 * `PARSE_REVEAL_MAX_CHARS` and `CHAR_REVEAL_MAX_MS`: a character reaches full
 * ink `CHAR_FADE_MS` after its own moment, so a text at the parse route's
 * threshold is finished at 2.66s rather than at 2.40s, and one on the six-
 * second budget at 6.26s. Both budgets are about when the frontier *arrives*
 * — the tail is one fade long whatever the length of the text, and whatever
 * step `charStepMs` put the frontier on.
 *
 * **The prose panel takes this same duration and not this same depth**, which
 * is the one place the two quantities come apart. Sentence for sentence the
 * prose holds more characters than the kanbun does (it writes the kana out),
 * so its own step is shorter than `CHAR_REVEAL_MS` and 260ms of it covers
 * more characters — some sixty-five where the prose runs half again as long,
 * which against a prose column of about ten is six or seven columns. That is
 * the right way round, and it is nearly the same depth *in columns* as the
 * panel above. The two panels are one gesture and have to answer over one
 * span, which is the rule `FADE_MS` in `KakikudashiView.ts` already states
 * for the 連用形-て switch ("a panel that answered over a different span from
 * the one beside it would read as two things happening"); the edge is deeper
 * in prose characters only because prose characters are closer together in
 * time, and what the reader sees is the two frontiers keeping pace. */
export const CHAR_FADE_MS = 260;

/** The longest text drawn a character at a time **while the parser has still
 * to answer for it**, in characters.
 *
 * ── The cap is about the parse, not about the length ──────────────────────
 * This used to be the app's only answer to "how long is too long", and it was
 * asked on both routes into the reveal. It is asked on one of them now, and
 * the name says which: `RevealContext` below is the distinction, and the
 * reason it exists is that the two routes are not paying for the same thing.
 *
 * On the **parse** route the characters are drawn ahead of their analysis, and
 * the frontier is not merely a picture: `nextBatch` dispatches a region at the
 * moment its last character lands, so the schedule below is what paces the
 * calls to the parser. Slowing it down slows the *parse* down — the reader
 * waits longer for the first annotated sentence, not merely for the last
 * character — and a chapter revealed at any rate at all would hold the last of
 * its regions back from the worker for as long as the reveal lasted. That is
 * what the cap buys, and it is why the fallback is not optional here.
 *
 * On the **complete-tree** route there is nothing behind the characters: the
 * tree came off the disk or out of an uploaded file, whole, and the page was
 * rendered in full before the first character was hidden. Nothing waits on the
 * frontier because nothing is being computed. The reveal is presentation, so
 * its only cost is the reader's patience — and patience is answered by
 * `CHAR_REVEAL_MAX_MS` below, which bounds the whole reveal in time rather
 * than refusing lengths outright.
 *
 * ── The budget this states, which is the parse route's ────────────────────
 * 2.4 seconds — call it nine of the 260ms this app settles everything else in
 * — and at 6ms a character that is 400 of them:
 *
 *   - a couplet, 20 characters ........  120ms
 *   - 春望, 40 characters ..............  240ms
 *   - 酒蟲, 359 characters ............. 2.15s, just inside
 *   - the threshold, 400 ............... 2.40s
 *   - 論語學而, 666 characters ......... would be 4.00s — drawn at once
 *   - one parser chunk, 1500 ........... would be 9.0s — drawn at once
 *   - a chapter, 10,000 ................ would be 60s — drawn at once
 *
 * Note what the fallback does *not* cost: the parse is unaffected. A text
 * drawn at once has every region ready at once, and the dispatch below simply
 * finds them all ready — which is the state the app was in before any of this
 * existed. */
export const PARSE_REVEAL_MAX_CHARS = 400;

/** The longest a reveal may take from its first character to its last, in
 * milliseconds — **the complete-tree route's budget**, and the answer to the
 * question the length cap above answers by refusing.
 *
 * ── Why the rate cannot simply be kept ────────────────────────────────────
 * `CHAR_REVEAL_MS` is a rate, and a rate times a length is a duration that has
 * no ceiling. 論語學而 — the app's own longest sample, 666 characters — is 4.0
 * seconds at the house rate, which is fine; a stored 老子 of five thousand is
 * half a minute, and ten thousand is a full one. A reader who opened a saved
 * text to work on it should not be watching it arrive for a minute, and the
 * old answer (refuse, and draw it at once) is the one the reader asked us to
 * stop giving.
 *
 * So the rate gives way and the *duration* is held. Past
 * `CHAR_REVEAL_MAX_MS / CHAR_REVEAL_MS` = 1,000 characters the step shortens
 * so that the whole text lands on the budget, which is the same thing as
 * saying the frontier advances by more than one character per tick — it
 * already did (see `CHAR_REVEAL_MS`: three to the frame at 60Hz), and this
 * only lets it advance by more.
 *
 *   length      step      duration    edge, in characters
 *   ────────────────────────────────────────────────────────
 *      40    6.0 ms       0.24 s       43   春望
 *     359    6.0 ms       2.15 s       43   酒蟲
 *     666    6.0 ms       4.00 s       43   論語學而
 *   1,000    6.0 ms       6.00 s       43   the knee
 *   2,000    3.0 ms       6.00 s       87
 *   5,000    1.2 ms       6.00 s      217
 *  10,000    0.6 ms       6.00 s      433
 *
 * ── What happens to the fade, which is the thing to be careful about ──────
 * That table's last column is `CHAR_FADE_MS / step` — how many characters are
 * somewhere between nothing and full ink at any instant. It grows, and the temptation is
 * to read that as the gesture dissolving: at ten thousand characters the
 * leading edge is 433 characters deep, some eighty columns, which on a long
 * document is most of the panel.
 *
 * **But the edge is one fade long in *time* at every length, and that is the
 * invariant that matters.** 260ms of travel, whatever the rate; it is wider in
 * characters only because the frontier is crossing more of them per
 * millisecond. That is what a soft edge on a faster-moving thing looks like,
 * and it is the same gesture seen at speed rather than a different one. The
 * alternative — shortening `CHAR_FADE_MS` in step with the rate to hold the
 * edge at forty-three characters — was rejected twice over: it would put the
 * fade at 26ms on a long text, under two frames, which is no fade at all; and
 * it would break the one-gesture-one-speed rule that constant is *named* for
 * (it is `REFLOW_MS`, and the note there gives the argument).
 *
 * What the deeper edge does cost is concurrency: 433 opacity animations in
 * flight at the extreme, against forty-three today. They are compositor-driven
 * and short, and the *number created* is the text's length either way — only
 * the rate they are created at changes (1,667 a second at ten thousand
 * characters, against 167 today). Reasoned, not measured; there is no browser
 * in this checkout.
 *
 * ── Why six seconds ───────────────────────────────────────────────────────
 * Because 1,000 characters is where the house rate runs out, and 1,000
 * characters is the natural unit here: a 論語 book, a 道德經 chapter, the size
 * of thing this app's saved-text store actually holds. Every shipped sample is
 * inside the knee (666 at the largest), so nothing the reader is likely to
 * meet first is sped up at all — the compression only ever applies to text the
 * house rate could not have served. */
export const CHAR_REVEAL_MAX_MS = 6000;

/** How long each character waits behind the one before it, for a text of this
 * length — `CHAR_REVEAL_MS` until the budget above bites, and then whatever
 * spends the budget exactly.
 *
 * A length of zero answers with the house rate rather than dividing by it: a
 * text with no characters has no schedule, and every caller clamps to `total`
 * anyway. */
export function charStepMs(totalChars: number): number {
  if (!(totalChars > 0)) return CHAR_REVEAL_MS;
  return Math.min(CHAR_REVEAL_MS, CHAR_REVEAL_MAX_MS / totalChars);
}

/** Which of the two situations the text is being drawn in — **the whole of
 * what decides whether a long one is drawn progressively**, and named rather
 * than passed as a bare boolean because the distinction is the argument.
 *
 *  - `"awaiting-parse"`: the characters are ahead of their analysis, and the
 *    frontier is dispatching regions to the parser as it goes. Capped at
 *    `PARSE_REVEAL_MAX_CHARS`; see there for what the cap is protecting.
 *  - `"already-parsed"`: the tree is complete and the page is fully drawn
 *    behind the hidden cells. No length is refused; `CHAR_REVEAL_MAX_MS`
 *    bounds the reveal in time instead. */
export type RevealContext = "awaiting-parse" | "already-parsed";

/** Whether a text of this many characters is drawn progressively.
 *
 * `reducedMotion` is the reader's own setting and is **absolute**: it skips
 * the animation entirely, at every length and in either context, and nothing
 * else here can override it. It is asked for by the caller rather than read
 * here so that this file stays free of the DOM.
 *
 * Below that, the only question is the one `RevealContext` names. A text of
 * zero characters is refused in both: there is nothing to disclose, and an
 * animation over no characters would hold an empty panel for its duration. */
export function shouldRevealProgressively(
  totalChars: number,
  reducedMotion: boolean,
  context: RevealContext,
): boolean {
  if (reducedMotion || !(totalChars > 0)) return false;
  return context === "already-parsed" || totalChars <= PARSE_REVEAL_MAX_CHARS;
}

/** How many characters are on the screen `elapsedMs` into the animation.
 *
 * Floored, so nothing is shown before its own moment has come: the first
 * character appears one step in, not at zero. Clamped to `total`, so a caller
 * that keeps asking after the end keeps getting the end.
 *
 * The step is `charStepMs(total)` rather than `CHAR_REVEAL_MS` flat — the two
 * are the same number for every text under the knee, which is every text the
 * parse route ever reveals and every sample this app ships. */
export function charsDrawnBy(elapsedMs: number, total: number): number {
  if (!(elapsedMs > 0)) return 0;
  return Math.min(total, Math.floor(elapsedMs / charStepMs(total)));
}

/** How many characters of **one prose sentence** are on the screen
 * `elapsedMs` into the same animation — the 書き下し文 panel's half of the
 * reveal, on the complete-tree route where there is a prose panel to disclose.
 *
 * ── What is being synchronised, and in what currency ──────────────────────
 * The two panels hold the same sentences and not the same characters: the
 * prose writes the readings out, so 學而時習之 is five characters above and
 * まなびてときにこれをならふ below. A single rate cannot serve both — run the
 * prose at 6ms a character and it finishes long after the kanbun, run the
 * kanbun at the prose's rate and it finishes long before — and either way the
 * reader is watching two texts that have stopped being the same text.
 *
 * So the rate is not shared. The **sentence** is:
 *
 *   sentence *i* of the prose starts when sentence *i* of the kundoku column
 *   starts, and finishes when it finishes.
 *
 * `from` and `to` are that sentence's half-open range of kundoku characters,
 * counted in the currency `animateCharacterReveal` advances in — one per
 * `.kanji-cell`, punctuation included — so `from * stepMs` is the moment the
 * sentence's first character is due and `to * stepMs` the moment its last one
 * is, `stepMs` being the column's own step (`charStepMs`, the house rate on
 * any text under the knee). `units` is how many characters the prose has for
 * the same sentence, and the step this implies — `(to - from) / units`
 * characters' worth of time per prose character — is derived per sentence and
 * is never 6ms except by coincidence.
 *
 * The two ends coincide exactly rather than nearly, which is the property
 * worth stating because it is what makes the panels end together: the
 * kundoku's character `from` appears at `(from + 1) * stepMs`, and
 * the floor below first reaches 1 at `from * stepMs + span / units`,
 * which is the same instant when the two counts agree and the correct
 * proportional instant when they do not; the floor first reaches `units` at
 * exactly `to * stepMs`, which is the instant the kundoku's last
 * character of the sentence appears. Since the sentences partition the column,
 * the last prose character of the last sentence lands with the last character
 * of the text.
 *
 * ── The two degenerate cases ──────────────────────────────────────────────
 * **A prose sentence with no characters** — a sentence whose whole prose is a
 * line break, say — has nothing to show and shows nothing. It cannot divide
 * by zero because `units` is the divisor's *numerator* here, not its
 * denominator; the guard is against being asked for a proportion of nothing.
 *
 * **A kundoku sentence with no characters** (`to === from`) has no span to
 * spread the prose across, so its prose lands whole at the one moment it
 * has — the instant the sentence would have begun. That is a division by zero
 * avoided by answering the question rather than by clamping afterwards: a
 * sentence of no duration discloses its prose in no time. It arises where a
 * `.sentence-gap` came out with no `.kanji-cell` in it at all, which the
 * renderer does not do today and which this must survive anyway, since the
 * alternative is prose left permanently invisible.
 *
 * Monotonic in `elapsedMs`, which the reveal relies on exactly as it relies
 * on `charsDrawnBy` being monotonic: a character once shown is never taken
 * back. */
export function proseShownBy(
  elapsedMs: number,
  from: number,
  to: number,
  units: number,
  /** The kundoku column's own step — `charStepMs(total)` for the text this
   * sentence belongs to.
   *
   * It has to be *passed* rather than derived, because what this converts is a
   * position in the kundoku column into a moment, and the column's step is a
   * fact about the whole text while `from` and `to` are facts about one
   * sentence of it. Handed the house rate by default, which is the right
   * answer for every text under the knee (see `charStepMs`) and keeps this
   * readable as the arithmetic it was written as. Get it wrong and the two
   * panels come apart — the prose would run to a clock the column above it is
   * not keeping — which is the one thing the pairing exists to prevent. */
  stepMs: number = CHAR_REVEAL_MS,
): number {
  if (units <= 0) return 0;
  const start = from * stepMs;
  if (!(elapsedMs > start)) return 0;
  const span = (to - from) * stepMs;
  if (!(span > 0)) return units;
  return Math.min(units, Math.floor(((elapsedMs - start) / span) * units));
}

/** How many of the first `charsDrawn` characters may actually be put on the
 * screen — which is all of them, unless the last of them is an opening
 * bracket.
 *
 * **The bracket is held back until the character it opens is ready too.**
 * 行頭禁則 forbids an opening bracket from ending a column, and the browser
 * enforces it — but only once there is a following character for it to be
 * held to. During the reveal there is a moment when the 「 is the last
 * character drawn, with nothing after it yet, and it sits at the column's
 * foot until the next character arrives and pulls it down to the next column.
 * A jump, in the panel the reader is watching.
 *
 * So it is not drawn alone. A run of them (『「) buffers as a unit, since the
 * same objection applies to each; and the end of the text flushes
 * unconditionally, so a text that ends on an opening bracket — malformed, but
 * possible — still draws its last character rather than holding it back
 * forever waiting for a successor that does not exist.
 *
 * **This is not `glueOpeningPunctForward`, and could not be.** That rule
 * solves the *settled* half of the same problem: given a column and every
 * character in it, wrap the bracket and what follows it in one unbreakable
 * unit so the browser cannot put a break between them. It works on a page
 * that is complete. Here the bracket is last because nothing follows it
 * **yet**, and no wrapper can hold a character to one that has not been
 * drawn. The only fix available in time is not to draw it, which is this. The
 * rule is the same rule; the mechanism has to be different because the
 * problem is temporal and not typographic.
 *
 * Monotonic in `charsDrawn`, which the reveal relies on: a character once
 * shown is never taken back. */
export function showableChars(chars: readonly string[], charsDrawn: number): number {
  if (charsDrawn >= chars.length) return chars.length;
  let shown = Math.max(0, charsDrawn);
  while (shown > 0 && isOpeningBracket(chars[shown - 1])) shown--;
  return shown;
}

/** How many regions are *complete* once `charsDrawn` characters are up —
 * the frontier the dispatch below is allowed to reach.
 *
 * A region counts only when its last character is on the screen. A region
 * half drawn is not a sentence anyone can be asked about, and annotating it
 * would put an analysis over characters the reader has not been shown.
 *
 * **Asked with the characters actually shown**, which is `showableChars`
 * above and not the raw count — a region whose last character is a buffered
 * opening bracket is not complete, and must not be dispatched, until that
 * bracket is on the page. (A region *can* end in one: `splitProvisional` cuts
 * before a line break as well as after a full stop, so a line ending in 「 is
 * a region ending in 「.) The two are the same number for every region that
 * does not, which is nearly all of them. */
export function regionsDrawnBy(lengths: readonly number[], charsDrawn: number): number {
  let drawn = 0;
  let chars = 0;
  for (const length of lengths) {
    if (chars + length > charsDrawn) break;
    chars += length;
    drawn++;
  }
  return drawn;
}

/** How many regions the first request carries.
 *
 * One, so that the reader has an annotated sentence in front of them at the
 * earliest moment the parser can produce one — the cold load having already
 * cost them several seconds, the first thing off the back of it should not
 * also be the whole document. */
const FIRST_BATCH_REGIONS = 1;

/** The ceiling on any later one, in regions.
 *
 * The character cap is the real constraint — it is what keeps each `nlp()`
 * call inside what a browser tab can hold, and it is `chunkText`'s own cap for
 * exactly that reason. This second cap only bites on text whose regions are
 * very short, where the character budget would otherwise buy hundreds of them
 * at once: the reveal is a sweep across the sentences of one answer (see
 * `revealDelays` in `KundokuView.ts`), and a sweep across four hundred of them
 * is not one a reader can follow. */
const MAX_BATCH_REGIONS = 64;

/** What to ask the parser for next: a half-open `[from, to)` range of
 * regions, or `null` when there is nothing to ask about yet.
 *
 * **This is what replaced the wave doubling**, and the difference is where the
 * throttle comes from. The old plan was a fixed schedule — one region, then
 * two, four, eight — computed before anything was on the screen. This is not a
 * schedule at all: it is asked, each time the worker falls idle, what is
 * *ready and not yet asked about*, and it hands over as much of that as fits.
 * Two things regulate it, and neither is a constant chosen for the purpose:
 *
 *  - **The frontier.** `ready` is `regionsDrawnBy` above — how much of the
 *    text is on the screen. While the characters are still arriving this is
 *    the binding constraint, and since they arrive roughly one region at a
 *    time, so do the requests. That is the user's rule ("each sentence parsed
 *    as soon as it is complete") holding of its own accord rather than being
 *    imposed by a batch size.
 *
 *  - **The worker.** There is one, and it takes one request at a time. Regions
 *    that came ready while it was busy are all handed over together on the
 *    next turn, up to `maxChars`. So the batches grow exactly as far as the
 *    parser falls behind the display and no further — which is the doubling's
 *    purpose (amortise the per-call round trip) obtained from the situation
 *    instead of from a guess about it.
 *
 * The first request is one region whatever is ready, because time-to-first-
 * annotation is the thing the whole arrangement exists to shorten and a first
 * batch sized by the character cap would spend it. After that there is no
 * ramp: a text drawn at once goes straight to full-cap requests, which is
 * faster to full throughput than doubling was and — now that the single-shot
 * re-parse follows (see `main.ts`) — costs nothing that is not repaired.
 *
 * **Every batch boundary is a region boundary**, which is what keeps this from
 * costing anything the app was not already paying: `chunkText` already cuts
 * the document only at sentence-final punctuation, and `splitIntoSentences`
 * already severs the finished tree at every one of those and at every line
 * break, so no arc that survives today crosses a batch boundary either.
 *
 * A region longer than the cap goes out on its own regardless — the worker's
 * own `chunkText` subdivides it if it has to, and since the pieces still
 * belong to the one region the reveal is unaffected. */
export function nextBatch(
  lengths: readonly number[],
  dispatched: number,
  ready: number,
  maxChars: number = MAX_CHUNK_CHARS,
): [number, number] | null {
  const limit = Math.min(ready, lengths.length);
  if (dispatched >= limit) return null;
  const want = dispatched === 0 ? FIRST_BATCH_REGIONS : MAX_BATCH_REGIONS;
  let to = dispatched;
  let chars = 0;
  // `to === dispatched` on the first turn, so a single over-long region is
  // always taken rather than the loop returning an empty range it cannot fill.
  while (to < limit && to - dispatched < want && (to === dispatched || chars + lengths[to] <= maxChars)) {
    chars += lengths[to];
    to++;
  }
  return [dispatched, to];
}

/** One thing the reveal replaces at once: a run of provisional regions, and
 * the parsed sentences that stand in for them. */
export interface RevealUnit {
  /** Half-open range of region indices, relative to whatever list the
   * caller's `regionLengths` came from. */
  regions: [number, number];
  /** Half-open range into the wave's sentence list. */
  sentences: [number, number];
}

/** Matches a wave's parsed sentences up with the regions they came from.
 *
 * By character count, and by nothing else. There is no offset information in
 * the parse output — the tokens carry no source positions — so the only
 * common currency is how many characters have gone by, which both sides can
 * count and which `splitIntoSentences` preserves exactly (it renumbers ids
 * and repairs heads; it never drops a token).
 *
 * Ordinarily every region's total is reached exactly at the end of some
 * sentence, since the parser's division refines this one (see the note at the
 * head of this file), and the answer is one unit per region.
 *
 * **When the two disagree** — a boundary mark the tokenizer fused into the
 * word beside it, so that no sentence ends where a region does — the totals
 * simply never coincide there, and the regions on either side are emitted as
 * *one* unit holding all the sentences across them. That is the whole
 * treatment, and it is deliberately not a guess: nothing here tries to
 * apportion a straddling sentence's characters between two regions, because
 * the panel would then have to show half a sentence's annotation. Revealing
 * the pair together is always right and merely coarser, and the worst case —
 * no coincidence anywhere in the wave — degrades to revealing the wave in one
 * go, which is what a wave-sized reveal would have been anyway.
 *
 * A trailing remainder (sentences left over, or regions with nothing to fill
 * them) closes as a final unit, so every region in the range is always
 * accounted for and none is left bare on the page. */
export function partitionByRegion(
  regionLengths: readonly number[],
  sentenceLengths: readonly number[],
): RevealUnit[] {
  const units: RevealUnit[] = [];
  let si = 0;
  let ri = 0;
  let unitStartS = 0;
  let unitStartR = 0;
  let sChars = 0;
  let rChars = 0;

  while (si < sentenceLengths.length) {
    sChars += sentenceLengths[si];
    si++;
    // Take in every region the sentences so far have covered. `<=` rather
    // than `<`: a region whose end the sentences have exactly reached is
    // covered, and is what the coincidence test below is looking for.
    while (ri < regionLengths.length && rChars + regionLengths[ri] <= sChars) {
      rChars += regionLengths[ri];
      ri++;
    }
    if (rChars === sChars) {
      units.push({ regions: [unitStartR, ri], sentences: [unitStartS, si] });
      unitStartS = si;
      unitStartR = ri;
    }
  }

  if (si > unitStartS || ri < regionLengths.length) {
    units.push({ regions: [unitStartR, regionLengths.length], sentences: [unitStartS, si] });
  }
  return units;
}

/** The number of characters a parsed sentence holds, in the same units
 * `ProvisionalSentence.length` is counted in. */
export function sentenceLength(sentence: Sentence): number {
  let n = 0;
  for (const token of sentence.tokens) n += charCount(token.text);
  return n;
}
