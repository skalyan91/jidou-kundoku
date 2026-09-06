import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import type { JmdictIndex } from "../reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { compoundFurigana } from "../reading/compoundFurigana.ts";
import { chosenReadingText } from "../reading/chosenReading.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { generateKakikudashiPiecesForTree, sentenceSeparator, type Piece } from "../kakikudashi/generator.ts";
import { createRubyLedger, glossWords, rubyFor, type RubyIndices, type RubyLedger } from "../kakikudashi/rubyGloss.ts";
import { BRACKETS, OPENING_BRACKETS } from "../parse/punctuation.ts";
import { furiganaFor } from "./KundokuView.ts";

/** One glossed word's annotation, and which pieces it covers. */
interface WordRuby {
  /** The kana over the word, one entry per *character* of it — 黃帝 is
   * ["くわう", "てい"]. Kept split rather than joined because each character
   * is written as a `<ruby>` of its own, holding that character and the kana
   * of that character alone (see `spreadRubyShares`). */
  readings: string[];
  /** The pieces the word is written from, in order — one for a lone token,
   * several for a compound. */
  pieceIndexes: number[];
  /** How much of each of those pieces' own text the ruby covers: the token's
   * kanji and nothing after it. A piece can carry conjugated okurigana (學び)
   * or a case particle past its kanji, and both are already kana on the page —
   * inside the <ruby> they would widen the base past the characters the
   * reading is of, and the annotation would centre over 學び instead of 學. */
  baseLengths: number[];
}

/** The glosses one sentence's pieces earn, keyed by the *first* piece of each
 * glossed word — empty for most sentences, since ruby only ever goes on a
 * word's first mention in the whole text (see `rubyGloss.ts` for what earns
 * one, and how rare that is meant to be). */
function glossesFor(
  pieces: readonly Piece[],
  sentence: Sentence,
  resolve: ReadingResolver,
  indices: RubyIndices,
  ledger: RubyLedger,
): Map<number, WordRuby> {
  const ruby = new Map<number, WordRuby>();
  if (!indices.jmdict || !indices.kanjidic) return ruby;

  // The 訓読文 panel's own readings, asked exactly as that panel asks them: a
  // whole span (or multi-character token) resolved together, a lone character
  // on its own. Two panels showing two readings of one word would be worse
  // than showing none, so this goes through the same pair of functions rather
  // than through a second route that happens to agree today.
  const readingsOf = (tokens: readonly Token[], text: string): (string | undefined)[] => {
    const chars = [...text];
    if (chars.length === 1) return [furiganaFor(tokens[0], sentence, resolve, indices.historicalKana, indices.kanjidic)];
    // A fused multi-character token can carry a reading the reader picked
    // for the whole word, which the 訓読文 panel divides across its
    // characters — so this asks for it the same way, or the same word would
    // be glossed differently in the two panels, which is the one thing this
    // shared route exists to prevent. A span cannot: its members are
    // separate tokens, and their own chosen readings reach the fallback
    // below on their own.
    const fused = tokens.length !== chars.length;
    return compoundFurigana(
      chars,
      text,
      indices.jmdict,
      indices.kanjidic,
      indices.historicalKana,
      (i) => {
        // A span has one token per character and a fused multi-character token
        // has one token for all of them; either way the fallback needs the token
        // that character came from, with that character as its text.
        const owner = fused ? tokens[0] : tokens[i];
        return furiganaFor({ ...owner, text: chars[i] }, sentence, resolve, indices.historicalKana, indices.kanjidic);
      },
      fused ? chosenReadingText(tokens[0]) : undefined,
    );
  };

  for (const word of glossWords(pieces, sentence, findCompoundSpans(sentence, indices), readingsOf, indices)) {
    if (!rubyFor(word, indices, ledger)) continue;
    // Keyed on the word's first piece; the render loop below reads the entry
    // there and consumes the rest of the word's pieces with it.
    ruby.set(word.pieceIndexes[0], {
      // Split per character, and set over that character — モノルビ. 黃's
      // くわう is 33px of kana over a 24.81px step and overhangs it, which is
      // what mono-ruby does; where the overhang would print over the kana of
      // the character beside it, the two runs are moved apart along the column
      // (`spreadRubyShares`) and neither share leaves its own character.
      //
      // Two arrangements this has been through and is not. Group ruby — one
      // run centred over the whole compound — fits by construction and reads
      // wrong: centring くわうてい over 黃帝 leaves neither character with its
      // own kana above it, and a reader cannot tell which half is which.
      // 熟語ルビ then gave each character its own share but let a long one
      // borrow room from the rest of the word, which is the same failure in
      // small: a share that has borrowed is a share sitting over the wrong
      // character.
      // Every entry is present: `glossReason` refuses a word with a reading it
      // could not resolve, so a gloss here always has one per character. Said
      // with a coalesce rather than a filter, which would silently shorten the
      // list and put every later character's kana over the wrong character.
      readings: word.readings.map((reading) => reading ?? ""),
      pieceIndexes: word.pieceIndexes,
      baseLengths: word.tokens.map((token) => token.text.length),
    });
  }
  return ruby;
}

/** How far each share has to move along the column to keep clear of the
 * shares beside it — **モノルビ (mono-ruby): every share over its own
 * character, always**, and this is the whole of what that costs.
 *
 * *Where the placement went.* It is in the stylesheet now, and there is
 * nothing left here to place: one `<ruby>` per character (see
 * `renderKakikudashiView`) makes each share's containing block its own
 * character's box, so `top: 50%` with a half-height translate centres it on
 * that character and on nothing else. No arithmetic, no dependence on the
 * fitted advance, and the placement a script pass would have computed is what
 * a reader sees before any script has run. What this adds is a displacement
 * *from* that centre, and only where two annotated characters are neighbours.
 *
 * *What this replaces.* 熟語ルビ (jukugo ruby): each share over its own
 * character *where it fitted*, and where it did not, the run borrowed room
 * from the rest of the compound — a forward pass pushing a share later where
 * the one above had not finished, a backward pass pulling the run back inside
 * the word. It was defensible and it was wrong for this panel, because
 * borrowing moves kana off the character they are the reading of: on 酒蟲 it
 * put 山's さん 8.2px below 山 and 中's ちゆう 2.7px above 中, and a reader
 * cannot be asked to work out which half of a compound a run of kana belongs
 * to by measuring. Mono-ruby is the convention that answers the question the
 * gloss is asked — *what does this character say* — and it is the one the
 * panel now follows without exception.
 *
 * *What a share wider than its character does.* It **overhangs**, which is
 * what mono-ruby does everywhere it is set: 驚's きやう is 33px of kana over
 * a 22px character and hangs 5.5px into the lane above and below it, which in
 * a panel this sparsely glossed is ordinarily empty prose (see `rubyGloss.ts`
 * — a neighbour has to earn a gloss of its own, and the density rule makes
 * that rare). Free, and no rule is needed for it.
 *
 * The one case that is not free is two *annotated* characters side by side,
 * where two overhangs meet in the same lane and print over each other. Both
 * shares are centred, so their inked lengths collide exactly when they
 * average more than one character's step: 長山 is 33px of ちやう beside 22px
 * of さん against a 24.85px advance, so 2.65px of kana over kana. Looked at,
 * that is not a near-miss to be tolerated — う and さ run together and 長山's
 * five kana read as one undivided run, which is the very thing mono-ruby is
 * for. It happens to 14 of the 70 annotated characters of 酒蟲, in 6 runs —
 * 長山, 獨酌, 半尺, 良醞一器, 咽中 and 甕中, every one of them a three-kana
 * share beside shorter ones — and to different characters at a different
 * panel height, since which characters are neighbours is a fact about the
 * wrap.
 *
 * ── The spread ─────────────────────────────────────────────────────────
 * **Every kana stays at its full size and its natural spacing, and the two
 * shares move apart along the column by exactly the overlap.** A share is a
 * rigid run of kana that may sit a little off its character's centre; it is
 * never squeezed, and there is no width anywhere in what this returns.
 *
 * Stated as positions: with `p[i]` the centre of share `i` and `ink[i]` its
 * inked length, two neighbours clear each other exactly when
 *
 *     p[i+1] - p[i] >= (ink[i] + ink[i+1]) / 2
 *
 * — the two half-lengths that face each other. A forward pass over the run
 * pushes each share just far enough down the column to satisfy that against
 * the one before it, which is the least motion that can satisfy them all
 * (each share moves only when it must, and only by what is missing). The run
 * as a whole has then drifted downward, so it is shifted back by the mean of
 * its own displacements: the constraints are all differences and are blind to
 * a common shift, so the mean is free to spend on symmetry, and spending it
 * means neither end of a run carries the whole of the correction.
 *
 * On 酒蟲 at the shipped panel height the largest displacement any share
 * takes is 1.99px — a fifth of a kana, a twelfth of a character — so every
 * share is still plainly over the character it is the reading of, which is
 * the only thing mono-ruby asks.
 *
 * Not *covering* it, quite: a two-kana share is exactly as wide as its
 * character, so moving it at all leaves 1.35px of the character's foot
 * uncovered at one end. That is a distinction without a reading: a one-kana
 * share covers half its character and has always done so, and what a reader
 * looks for over a character is kana centred on it, not kana reaching its
 * corners. Displacement is bounded by the crowding, and the crowding on this
 * text is at most 2.7px.
 *
 * ── What was here before, and what changed the answer ──────────────────
 * The longer of the two used to be **condensed** by exactly the overlap —
 * `letter-spacing` on that one `<rt>`, bringing 長山's ちやう in from 33px to
 * 27.6px, three quarters of its natural spacing. It kept every share dead
 * centre on its character, which is the one thing it had over this, and it
 * paid for that in the kana: a reading set tight beside readings set loose,
 * on the 6 longer shares of those 14, with the reader given no reason for the
 * difference. Nothing about the arrangement was visible except the
 * unevenness.
 *
 * The bound it lived under is also gone with it. Condensation could only take
 * a share down to one step and no further, so a five-kana share beside a
 * three-kana one — eight kana over two characters, 88px of reading in 49.6px
 * of column — had no answer at all. The spread has no such bound: it moves
 * shares apart, and there is always room to move them, so the arrangement
 * degrades into a longer chain of small displacements rather than into an
 * illegible run.
 *
 * ── What the spread costs, which is one cue and 0.67px ──────────────────
 * The condensation was the only thing marking **where one reading ends and
 * the next begins**. Neither arrangement leaves a gap at the seam — the
 * constraint above is an equality when it binds, so the last kana of one
 * share ends exactly where the first kana of the next begins — but the
 * condensed share's kana were set tighter than its neighbour's, and that
 * difference in rhythm was itself the boundary. Spread, every kana on the
 * page is at one spacing, and where a share ends is told by the alignment
 * alone: each run is centred on its own character, and a reader looking at a
 * character finds its kana over it. That is mono-ruby's own answer to the
 * question and the reason the convention exists; it is a weaker cue than the
 * rhythm was, and it is the one the panel now rests on.
 *
 * And the re-centring moves shares that had no problem: in 長山 both ends
 * travel, 長 by -1.32px and 山 by +1.32px, where the forward pass alone would
 * have left 長 exactly where it was and pushed 山 the whole 2.65. In 良醞一器
 * it is starker — 醞 is the only share that was crowded and it moves 1.99px,
 * while 良, 一 and 器 each give up 0.66px they were not asked for. Left
 * untuned: the alternative is to anchor the run at its first share, which
 * makes the first character of every crowded run the one that never moves and
 * the last the one that moves most, and there is no reason in the text for
 * either end to be privileged. Spread evenly, the largest displacement in the
 * run is as small as it can be. That is deliberate and is the shift being spent
 * (above) rather than a side effect — but it does mean a share can be off its
 * character's centre without having been crowded from the side it moved
 * toward.
 *
 * `counts` is one entry per character of a run of *adjacent annotated
 * characters* — the caller's business, since adjacency is a fact about the
 * laid-out column and not about the word (a compound broken across a column
 * break has its halves in two different lanes, and they cannot collide). A
 * run with nothing to solve comes back all zeroes and the caller writes
 * nothing. */
export function spreadRubyShares(counts: readonly number[], advance: number, kana: number): number[] {
  // The *inked* length, which is what collides: n kana and the n-1 gaps
  // between them, the trailing space after the last one being nothing to see.
  const ink = counts.map((n) => n * kana);
  // Where each share's centre sits before anything moves: its character's
  // centre, one advance apart down the column. Measured from the first
  // share's, so the numbers below are displacements from the stylesheet's own
  // placement and not viewport coordinates.
  const at = counts.map((_, i) => i * advance);
  for (let i = 0; i + 1 < counts.length; i++) {
    at[i + 1] = Math.max(at[i + 1], at[i] + (ink[i] + ink[i + 1]) / 2);
  }
  const shift = at.map((p, i) => p - i * advance);
  // A common shift satisfies every constraint equally, so the run is put back
  // on its own centre of gravity: the mean displacement, taken off all of
  // them.
  const mean = shift.reduce((sum, d) => sum + d, 0) / (shift.length || 1);
  return shift.map((d) => d - mean);
}

/** Applies that to a rendered column: finds the runs of annotated characters
 * that are genuinely side by side, and spreads the crowded ones apart.
 *
 * **Adjacency is measured and not inferred.** Two shares are in each other's
 * way only if their characters are one step apart *in the same column*, which
 * is a fact about the finished layout: a word is free to break across a column
 * break now (see `renderKakikudashiView`), and the halves of one that has are
 * in two different lanes with nothing to collide over. Reading it off the
 * boxes also catches the case a per-word rule could not see at all — two
 * separately glossed words that happen to abut, which `rubyGloss.ts`'s density
 * rule makes rare rather than impossible.
 *
 * The base characters are what is measured, never the annotations: an `<rt>`
 * is out of flow and the 振り仮名 switch may have it faded to nothing at the
 * moment this runs, while a `<ruby>`'s own box is ordinary in-flow prose and
 * is there whether or not anything is being shown. The kana's length is read
 * off the computed `font-size` for the same reason, and because that a kana's
 * step equals the annotation's font-size is a property of full-width kana set
 * upright — 2 kana at 11px come to 22px, confirmed by measurement.
 *
 * The displacement is written as a `margin-top`, which against the
 * stylesheet's `top: 50%` and half-height translate is the share's centre
 * stepped off its character's centre (see `.text-kakikudashi rt` in
 * typography.css). Nothing this writes can change what it measured: the
 * `<rt>` is absolutely positioned, so it takes no room in the line, and the
 * run of characters it was measured against is where it was.
 *
 * Zero is written as no property at all rather than as `0px`, so that a share
 * that is not displaced carries no inline style to read past. */
function spreadCrowdedRuby(column: HTMLElement): void {
  const glosses = [...column.querySelectorAll<HTMLElement>("ruby")];
  if (glosses.length === 0) return;
  const columnStyle = getComputedStyle(column);
  const size = parseFloat(columnStyle.fontSize);
  const tracking = parseFloat(columnStyle.letterSpacing); // "normal" parses to NaN
  const advance = size + (Number.isNaN(tracking) ? 0 : tracking);
  if (!Number.isFinite(advance) || advance <= 0) return;
  const shareOf = (gloss: HTMLElement) => gloss.querySelector<HTMLElement>(":scope > rt");
  const first = shareOf(glosses[0]);
  const kana = first ? parseFloat(getComputedStyle(first).fontSize) : NaN;
  if (!Number.isFinite(kana) || kana <= 0) return;

  const boxes = glosses.map((gloss) => gloss.getBoundingClientRect());
  /** One maximal run of characters that are neighbours down one column, ended
   * by anything else: unglossed prose between two glosses, a column break, a
   * sentence's own line break. Half a pixel of tolerance because the used
   * advance is the asked-for one snapped to the layout grid. */
  let start = 0;
  for (let at = 1; at <= glosses.length; at++) {
    const joined =
      at < glosses.length &&
      Math.abs(boxes[at].left - boxes[at - 1].left) < 0.5 &&
      Math.abs(boxes[at].top - boxes[at - 1].top - advance) < 0.5;
    if (joined) continue;
    const run = glosses.slice(start, at);
    const shares = run.map(shareOf);
    const counts = shares.map((share) => [...(share?.textContent ?? "")].length);
    spreadRubyShares(counts, advance, kana).forEach((moved, i) => {
      const share = shares[i];
      if (!share) return;
      if (moved === 0) share.style.removeProperty("margin-top");
      else share.style.marginTop = `${moved}px`;
    });
    start = at;
  }
}

/** The tracking this panel is drawn at, as a fraction of the character — the
 * `0.15em` that stands in `.text-kakikudashi`'s own rule and is what the fit
 * below departs from as little as it can. Stated here as well because the fit
 * needs it as a number, and a stylesheet's value cannot be read before there
 * is an element set in it. */
const DESIGN_TRACKING_EM = 0.15;

/** How much of the column's measure the fit declines to claim, **per
 * character**.
 *
 * The whole point of the exercise is that `slots * advance` should come to
 * the measure exactly — the kundoku panel's column does, 4 x 88px into 352px
 * of measure, and this panel's should read as the same page. *Exactly* is the
 * one thing a browser will not promise: a used letter-spacing is snapped to
 * the layout grid (1/64px in Chromium, 1/60px in Gecko), so an advance asked
 * for as 24.9px can be laid out a fraction long, and ten characters of
 * round-up spill past the measure and cost a whole character.
 *
 * So the guard is exactly what the snapping can take and not a pixel more:
 * **half a layout unit per character**, at the coarser of the two grids. Ten
 * characters give back 0.083px in total, which is a twelfth of a pixel at the
 * foot of a 249px column — the column reads as flush, because at that size it
 * is flush.
 *
 * It used to be a flat half pixel, which is 6 times what the snapping can
 * take at ten characters and left the last glyph a visible fraction short.
 * The reason it was flat was that the arithmetic was thought of as one column
 * needing one allowance; the allowance is really per character, because that
 * is where the rounding happens.
 *
 * Erring short, never long, and that is deliberate: the cost of claiming too
 * much is a character dropped from every column of the text, and the cost of
 * claiming too little is a hairline of slack at the column's foot — where the
 * last character's own trailing tracking already sits, so it lands in space
 * that is empty in the design rather than between two glyphs. */
const FIT_GUARD_PER_SLOT_PX = 1 / 120;

/** The band the fitted tracking has to fall in to be used at all.
 *
 * Fitting moves the advance by at most half a slot — the measure is divided
 * by the *nearest* whole number of characters, so the further the count is
 * from fitting the more the tracking has to give — and half a slot is a
 * small fraction of the advance while the column holds many characters and a
 * large one while it holds few. At ten characters the tracking stays within
 * 0.09em–0.21em of the 0.15em it is drawn at, which is a change a reader
 * would have to measure to see. At three it could be asked to go negative.
 * So there is a floor and a ceiling, and outside them the panel keeps the
 * tracking it was drawn at and accepts the part-slot: a column of three
 * characters is a panel dragged shut, and letting the fit set the type solid
 * to save a fraction of one of them would be answering a question nobody
 * asked. */
const FIT_MIN_TRACKING_EM = 0.05;
const FIT_MAX_TRACKING_EM = 0.3;

/** **The fit.** The tracking that makes a column of `measure` hold a whole
 * number of characters, or `null` where the panel should keep the tracking it
 * is drawn at.
 *
 * `measure` is the column's usable length — the panel's content box along the
 * column, which under vertical-rl is its height less its top and bottom
 * padding. `size` is the character, and `design` the tracking in
 * `.text-kakikudashi`.
 *
 * The count is the *nearest* whole number of characters rather than the
 * largest that fits, which is what keeps the tracking near the value the
 * panel was drawn at: rounding down would mean never tightening, so a column
 * 9.8 characters long would be set at nine characters and a tracking half
 * again as loose, where rounding to ten costs 0.44px a character and gains a
 * character of text in every column.
 *
 * Having chosen the count, the tracking is the whole of what is left over
 * divided among the characters, less the guard above — so the characters fill
 * the measure rather than stopping a tracking short of it. On the shipped
 * panel at 792px that is 249px of measure over ten characters: an advance of
 * 24.89px against the 24.81px the old guard left, and the difference is 0.08px
 * a character.
 *
 * Pure, and separately tested, because the arithmetic is the whole of the
 * decision and a layout engine is not needed to check it. */
export function fittedTracking(measure: number, size: number, design: number): number | null {
  if (!(measure > 0) || !(size > 0)) return null;
  return stretchedTracking(measure, size, Math.round(measure / (size + design)));
}

/** The same arithmetic asked the other way round: the tracking that makes
 * **exactly `slots`** characters fill `measure`, or `null` where that would
 * take the type outside the band above.
 *
 * `fittedTracking` picks the count and returns the tracking; this is handed
 * the count. They are one function — the one above now calls this one — and
 * the reason for the second door is the search below: `matchedSlots` chooses
 * a column length in order to make the passage run a certain distance, and
 * that length is generally *not* the one the measure rounds to. Asked for it
 * this way, the panel is still exactly full; there is simply more or less air
 * between the characters.
 *
 * ── Which is where a whole panel's worth of dead space used to go ─────────
 * The shorter column used to be got by writing a shorter *box*: an inline
 * height of `slots` design advances on the `.tategaki`, inside a grid row
 * sized to the panel's whole share. The difference stood below the text as
 * empty panel — and it was not small or rare. Swept from 700px to 1200px of
 * `.main` in twenty-pixel steps, on a text with 63 characters of prose: air
 * below the last line at fifteen of the twenty-six heights, 704px of it in
 * total, and 95.6px at the worst — a band deeper than three lines of the
 * prose it sits under, and growing without bound as the window grows, since
 * the box was pinned while the row kept getting taller. A reader saw 92px of
 * it and asked what it was for.
 *
 * Spending it on the tracking instead costs the search some reach, because
 * the band is narrow — a column can be asked to hold between `measure /
 * (size + 0.3em)` and `measure / (size + 0.05em)` characters, a range of
 * about a fifth — where writing a short box could ask for any count at all.
 * What that costs is written up at `fitPassageExtent`, measured rather than
 * guessed. What it buys is that **every division the search can now choose is
 * one the panel is completely full in**, at every window height rather than
 * at the ones where the arithmetic happened to come out even. */
export function stretchedTracking(measure: number, size: number, slots: number): number | null {
  if (!(measure > 0) || !(size > 0) || !(slots >= 1)) return null;
  const tracking = measure / slots - size - FIT_GUARD_PER_SLOT_PX;
  if (tracking < size * FIT_MIN_TRACKING_EM || tracking > size * FIT_MAX_TRACKING_EM) return null;
  return tracking;
}

/** The fewest and the most characters a column of `measure` can be set to
 * hold with the panel still full — the band above, read as a range of counts
 * rather than as a yes or no about one of them.
 *
 * `fewest` is at the loosest tracking the band allows and `most` at the
 * tightest, so every count between them has a tracking, and no count outside
 * them has one. `null` where the band is empty, which is a measure too short
 * to hold a whole character at any legible tracking.
 *
 * Pure, like everything else the fit reasons with, and the boundary the
 * search's walk stops at. */
export function columnCounts(measure: number, size: number): { fewest: number; most: number } | null {
  if (!(measure > 0) || !(size > 0)) return null;
  const fewest = Math.ceil(measure / (size + size * FIT_MAX_TRACKING_EM + FIT_GUARD_PER_SLOT_PX));
  const most = Math.floor(measure / (size + size * FIT_MIN_TRACKING_EM + FIT_GUARD_PER_SLOT_PX));
  return most >= fewest && fewest >= 1 ? { fewest, most } : null;
}

/** Publishes that tracking on the panel, for `.text-kakikudashi` to read.
 *
 * Measured here in script rather than declared in the stylesheet, which is
 * the opposite of what the kundoku panel does one file over
 * (`.kundoku-panel .tategaki` in tategaki.css rounds its own height in CSS,
 * saying there that a resize listener is the wrong instrument for something
 * CSS already knows). The difference is what there is to know. That panel's
 * height is a percentage of the layout and CSS can round it; this panel's is
 * the `1fr` *remainder* of a grid row whose first track is itself a rounding,
 * and there is no expression in a stylesheet for a used height arrived at
 * that way. A size container would give CSS one — `100cqi` inside a
 * `container-type: size` panel resolves to exactly this measure, confirmed by
 * measurement — and it was not taken: the print bands printLayout.ts builds
 * are `.tategaki`s of their own outside this panel, where `100cqi` would
 * silently resolve against the viewport instead, and the ruby placement below
 * needs a script pass on resize whatever the tracking is set from. One pass,
 * one place.
 *
 * The property goes on the *panel* and not on `:root`: it is this panel's
 * measure, and a global would reach the print bands and the kundoku panel,
 * neither of which is set to it. */
function fitColumnTracking(container: HTMLElement, column: HTMLElement): void {
  const style = getComputedStyle(container);
  const measure =
    container.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const size = parseFloat(getComputedStyle(column).fontSize);
  const tracking = fittedTracking(measure, size, size * DESIGN_TRACKING_EM);
  // Removed rather than set to the design value, so that the fallback in
  // `.text-kakikudashi` is the one place the drawn tracking is written down.
  if (tracking === null) container.style.removeProperty("--tracking-kakikudashi");
  else container.style.setProperty("--tracking-kakikudashi", `${tracking}px`);
}

/* ── ぶら下げ, computed rather than measured ────────────────────────────────
 *
 * A 、 or 。 that will not fit at the foot of a column hangs into the margin
 * below it instead of taking the character before it down to the next column.
 * That is the conventional partner to 禁則, and it is what JIS X 4051 gives
 * 句点 and 読点; without it those marks are handled by 追い出し, and every
 * column that ends in one is a character short of its complement.
 *
 * CSS has a property for exactly this — `hanging-punctuation: allow-end` —
 * and it is Safari's alone: Chrome through 154 and Firefox through 158 do not
 * implement it (checked against caniuse; global support about 16%). It was
 * shipped here for one round with no substitute, on the reasoning that the
 * only CSS device available in the other two engines is a negative advance,
 * which would take the room away from marks mid-column too, and that applying
 * it *only* to the marks at a column's foot
 * needs a measure-and-write pass that does not converge: hang the mark, the
 * column frees a character, the next character rises into it, the mark is no
 * longer at the foot, and the class comes off again.
 *
 * **That argument is about measure-and-mutate, and this panel does not have
 * to measure.** `fittedTracking` above chooses a tracking so that a whole
 * number of characters exactly fills the column's measure: every character in
 * this panel advances by exactly `measure / slots`, the glyphs are all
 * ideographic or kana and so all one em, and nothing in the flow is
 * proportional. Where a column breaks is therefore *arithmetic on the
 * character sequence* — walk the prose, count `slots` characters, and the
 * next character is at the boundary. Nothing is measured, so nothing has to
 * be measured again, and the oscillation has nothing to oscillate between.
 *
 * The second half of the convergence answer is what ぶら下げ *is*. A hanging
 * mark does **not** buy the column a character: it takes the position it
 * would have had — the first of the next column — and overhangs the margin
 * from there, so the column still holds exactly `slots` characters of text
 * and the mark is extra, painted outside the measure. The walk is therefore
 * strictly forward: at each boundary the decision depends only on characters
 * already placed, and hanging a mark advances the walk past it rather than
 * changing where the boundary was. One pass, no fixed point.
 *
 * So the model is computed here and written onto the page as a class, and the
 * CSS property is **not** shipped alongside it — see `.kakikudashi-panel
 * .tategaki` in tategaki.css, which says why one mechanism in every engine is
 * worth more than two mechanisms in two.
 *
 * ── What this asks of the browser, which is the honest part ────────────────
 * The class gives the mark a `letter-spacing` of `-1em`
 * (`.text-kakikudashi .hanging-mark`, typography.css), which cancels the
 * glyph it advances and leaves the panel's own tracking off it, so it costs
 * the line nothing: `slots` characters plus a mark of no advance is still
 * exactly the measure, the line fits, and the break falls after the mark
 * rather than before it. The mark's glyph starts at the column's foot and
 * runs one em into the padding, which is what hanging looks like.
 *
 * The one thing that can go wrong is the model disagreeing with the browser
 * about where a column breaks, because then the give-back lands on a
 * mark that is *not* at a foot and the character after it is laid on top of
 * it. The advance cannot disagree — it is arithmetic — so the whole of the
 * risk is 禁則: the sets below have to be the ones the line breaker is using.
 * That is why `.text-kakikudashi` declares `line-break: normal` rather than
 * leaving it at `auto`, which the spec expressly lets a UA resolve to `loose`
 * for short lines — and these lines are six characters long. **Not verified
 * in any browser from here; there is none in this environment.** The pure
 * function below is tested directly instead, which is the part that can be.
 */

/** The marks that hang: 句点 and 読点, and nothing else.
 *
 * The same set `hanging-punctuation: allow-end` hangs, and the same set JIS X
 * 4051 gives ぶら下げ to.
 *
 * ── The closing brackets are not here, and this is where that is paid for ──
 * It is the previous round's decision kept, but it is no longer free: the walk
 * hangs before it pushes, so a bracket is now the *only* thing left that can
 * push a character down. Four reasons to keep it out, and one number.
 *
 *  - A closing bracket's partner in Japanese typesetting is 詰め — 行末約物
 *    半角, the mark set at half its advance inside the line, which is the same
 *    device `.punct-cell` uses one panel up — not ぶら下げ. JIS X 4051 gives
 *    ぶら下げ to 句読点 and to nothing else.
 *  - Room. The panel's inset is 55px against an advance of 25.3px, so one mark
 *    hangs with 30px of clearance and a 。」 pair would hang with 4.4px —
 *    standing at the panel's own edge. On paper it is worse: printLayout.ts
 *    gives the band exactly one advance of inset (7mm, bought off the kundoku
 *    band), and `overflow: hidden` would cut the second mark in half.
 *  - It would not stop at the pair. A lone 」 at a boundary is far commoner
 *    than 。」, so putting brackets in this set is really the decision to hang
 *    brackets generally — a mark of *structure* outside the block, where the
 *    reader looks for the block's own edge rather than for its punctuation.
 *  - And 。」 is not a shape this generator writes. `sentenceSeparator` returns
 *    nothing before a closing bracket and `deferredMark` puts the owed mark
 *    *past* it (see generator.ts), so a quotation closes 」と。 and not 。」 —
 *    which is what tests/prosePunctuation.test.ts asserts. Only a source that
 *    punctuates 、 immediately inside a closing bracket could produce one.
 *
 * The number: modelled on a passage of 酒蟲's shape and punctuation density,
 * at the six characters to the column the shipped page comes to, hanging the
 * brackets as well would shorten the passage by a further **0.7 of a column**
 * out of 109 — under a per cent, and under one column. See "the extent table"
 * in tests/kakikudashiHang.test.ts, which computes it.
 *
 * ，． are included though this panel never writes them: `medialPunctuation`
 * writes every medial mark as 、 and `sentenceSeparator` every final one as
 * 。 (see `parse/punctuation.ts`), so the set is wider than the text. It is
 * the *typographic* class that is being named, and naming it short would make
 * the function wrong for a text this generator does not happen to produce
 * today. */
const HANGING_MARKS: ReadonlySet<string> = new Set(["、", "。", "，", "．", "､", "｡"]);

/** 行頭禁則: what may not stand at the head of a column.
 *
 * This is not a rule this module imposes — the browser's own line breaker
 * imposes it, from UAX #14, on the plain prose in this panel, and has done
 * since before any of this. What the set is for is that the model has to
 * *predict* it: a column whose head would be one of these does not begin
 * there, and the break moves back a character (追い出し). Get the set wrong
 * and every column after the first such break is off by one, and every hang
 * after it lands on a mark that is not at a foot.
 *
 * So it is UAX #14's non-starters as CSS `line-break: normal` leaves them,
 * and not JIS X 4051's fuller list:
 *
 *  - the stops and commas above, and the closing brackets (classes CL/CP);
 *  - ！？：； (EX/IS), which this panel never writes but which cost nothing
 *    to name;
 *  - the small kana and the 長音符 (NS). These the panel *does* write — もつて
 *    and もって both occur in the readings — and `normal` keeps them
 *    non-starters where `loose` would not.
 *
 * The iteration marks 々ゝゞ〻 are **not** here, and that is the one place
 * `normal` differs from the UAX #14 default: it allows a break before them.
 * They are also not in this panel's prose (see `render/odoriji.ts`, which
 * writes 〻 into the kundoku panel's character grid and not into this one).
 *
 * `line-break: strict` would be the better typography — it is what a Japanese
 * book does, and it would put the small kana back — but it is a change to
 * every column count in the panel and would want its own round. If it is ever
 * taken, the small kana and 長音符 stay here and the iteration marks join
 * them, in the same commit as the declaration. */
const MAY_NOT_BEGIN_COLUMN: ReadonlySet<string> = new Set([
  ...HANGING_MARKS,
  ...[...BRACKETS].filter((mark) => !OPENING_BRACKETS.has(mark)),
  "！", "？", "!", "?", "：", "；", ":", ";", "・",
  "ー", "ｰ",
  "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ", "ゎ", "ゕ", "ゖ",
  "ァ", "ィ", "ゥ", "ェ", "ォ", "ッ", "ャ", "ュ", "ョ", "ヮ", "ヵ", "ヶ",
]);

/** 行末禁則: what may not stand at the foot of a column — the opening
 * brackets, which belong to what follows them. The other half of what the
 * line breaker does that plain arithmetic would not, and modelled for the
 * same reason: an 「 pushed down to the next column moves the boundary.
 *
 * **The one rule in this file the page does not leave to the line breaker.**
 * 行頭禁則 above is a rule the engine keeps over a run of text and the model
 * only has to anticipate; this one has to be kept *for* it, because the
 * character after a bracket is often a `<ruby>` — a box, not a character — and
 * a rule about characters is not obviously a rule about a seam between two
 * boxes. `glueOpeningBracketsForward` below puts the pair in one
 * `.no-break-unit` so that the break is impossible rather than merely
 * forbidden, and this set is then what the model reads the same arrangement
 * off. The two must stay the same set. */
const MAY_NOT_END_COLUMN: ReadonlySet<string> = OPENING_BRACKETS;

/** The class the hang is written as. */
const HANG_CLASS = "hanging-mark";

/** What the walk below comes to: which characters hang, and how many columns
 * the passage then runs to. */
export interface HangPlan {
  /** Indices — by *character*, not by UTF-16 unit — of the marks that hang. */
  hangs: number[];
  /** Where every column begins — the index of its first character, one entry
   * per column, so `columns.length` is how far the passage runs.
   *
   * Nothing on the page reads it: the extent is measured off the laid-out box
   * (`passageExtent`), which is the only thing that can answer for a layout
   * engine. It is returned because it is the model's actual claim — *these*
   * are the breaks the browser will make — and a claim that is only implied
   * cannot be checked. It is also the quantity the panel's whole geometry is
   * chosen from, so what hanging does to the division between the two panels
   * can be worked out here rather than watched for. */
  columns: number[];
}

/** **The model.** Walks the prose and answers which marks hang, given a
 * column of `slots` characters.
 *
 * `text` is the panel's flow, one character per character of it, with a
 * newline standing for the source's own column breaks (the `<br>` a `layout`
 * piece writes). Everything else is a character that advances one slot: the
 * indent's 　 does, a glossed character does — its `<rt>` is out of flow and
 * is not in this sequence — and a mark of punctuation does, this panel
 * setting its marks at their full advance.
 *
 * The walk fills a column to `slots` and then asks what to do with the next
 * character:
 *
 *  - **A mark hangs** where the character after it could legally begin a
 *    column. It takes no room in the column it hangs from and none in the one
 *    that follows, so the walk simply steps past it — which is the whole of
 *    why this terminates where a measure-and-mutate pass does not.
 *  - **A mark does not hang** where the character after it could not begin a
 *    column either (a 。 followed by a 」). Hanging only the first of the two
 *    would leave the second at a column's head, and 禁則 is the rule this is
 *    the partner to, not the rule it is allowed to break. The pair goes down
 *    together, by 追い出し, exactly as the browser would send it.
 *  - **Anything else starts a new column**, and where it may not — a mark, a
 *    closing bracket, a small kana — characters are pulled back off the
 *    previous column until the head is legal and the foot is not an opening
 *    bracket. That is 追い出し. For the head it is what the browser is already
 *    doing to this text; for the foot it is what
 *    `glueOpeningBracketsForward` has made it do, the bracket and the
 *    character after it being one unbreakable unit on the page — so the
 *    character this pulls back is the character the engine carries down.
 *
 * ── Hanging is tried first, and the order is the whole point ───────────────
 * 追い出し does not push the mark by itself. No break is allowed before a 、
 * or a 。, so a mark that will not fit takes **the character before it** down
 * to the next column as well, and the column it leaves ends a character short
 * of its complement. That is the cost hanging exists to spare: a mark that can
 * overhang the margin moves nothing, and the column keeps every character it
 * was going to hold.
 *
 * So the hang is asked *before* the pull-back, and nothing is pulled back for
 * a mark that could have hung. The two branches above are in that order, and
 * the ordering is asserted rather than asserted-in-a-comment: over every
 * arrangement of 文。」「っ up to eight characters long, at two, three and four
 * to the column — 488,280 passages — no column comes out short while a mark
 * that could have hung stood at its boundary
 * (tests/kakikudashiHang.test.ts).
 *
 * Nothing is pulled back for a mark that *could not* hang either, unless the
 * pull-back is genuinely the only legal break: 。」 is the one such pair this
 * generator could write, and there the mark and the bracket go down together
 * because the alternative is hanging the bracket. See `HANGING_MARKS` for why
 * that is declined and what it costs.
 *
 * The pull-back leaves at least one character in the column it takes from and
 * refuses to move more than a column's worth, so a pathological run of
 * non-starters cannot empty a column or overfill the next one. Neither guard
 * fires on ordinary prose: at a boundary at most a mark and a bracket are
 * ever in question.
 *
 * Pure, and separately tested, in the same way and for the same reason
 * `fittedTracking` and `matchedSlots` are — the arithmetic is the whole of
 * the decision, and this is the only part of the hang that can be verified
 * without a browser. */
export function planHangingMarks(text: string, slots: number): HangPlan {
  const hangs: number[] = [];
  const columns: number[] = [];
  const characters = [...text];
  if (!(slots >= 1)) return { hangs, columns };
  /** The indices standing in the column now open. */
  let column: number[] = [];
  const close = () => {
    if (column.length > 0) columns.push(column[0]);
    column = [];
  };
  for (let at = 0; at < characters.length; at++) {
    const character = characters[at];
    // The source's own break. Whatever is in hand is a column, however short.
    if (character === "\n") {
      close();
      continue;
    }
    if (column.length < slots) {
      column.push(at);
      continue;
    }
    const next = characters[at + 1];
    if (HANGING_MARKS.has(character) && (next === undefined || next === "\n" || !MAY_NOT_BEGIN_COLUMN.has(next))) {
      hangs.push(at);
      close();
      continue;
    }
    // 追い出し. The new column starts at this character; while it may not, or
    // while what would be left at the foot of the old one may not stand
    // there, the boundary moves back one character.
    const moved = [at];
    while (
      column.length > 1 &&
      moved.length < slots &&
      (MAY_NOT_BEGIN_COLUMN.has(characters[moved[0]]) || MAY_NOT_END_COLUMN.has(characters[column[column.length - 1]]))
    ) {
      moved.unshift(column.pop()!);
    }
    close();
    column = moved;
  }
  close();
  return { hangs, columns };
}

/** **The shape the walk below needs of a node**, and no more of one than
 * that: what kind of node it is, what it is called, what it holds and what is
 * inside it.
 *
 * A real `Text` and a real `Element` both satisfy it — the walk runs on the
 * live panel exactly as it did — and so does a plain object, which is the
 * whole reason the interface is written down. There is no browser in this
 * repository's test environment, so the one part of the hang that reads the
 * page could not be checked at all while it was stated in terms of
 * `document.createTreeWalker`; stated in terms of this, it is a pure function
 * of a tree and `tests/kakikudashiHangWiring.test.ts` walks the shapes
 * `renderKakikudashiView` writes.
 *
 * `nodeName` rather than `tagName`, which is the only concession the change
 * asks of the caller: `tagName` is an `Element`'s alone, and the walk has to
 * ask the question of a node before it knows which it is. For an HTML element
 * the two are the same upper-case string. */
export interface FlowNode {
  /** `1` for an element, `3` for text — `Node.ELEMENT_NODE` and
   * `Node.TEXT_NODE`, written as their values because `Node` is a browser
   * global and this walk is no longer entitled to one. */
  readonly nodeType: number;
  /** `"RT"`, `"BR"`, `"SPAN"`, `"#text"` — upper-case for an element. */
  readonly nodeName: string;
  readonly childNodes: ArrayLike<FlowNode>;
  /** The characters, on a text node. */
  readonly data?: string;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Where one character of the flow is written: the text node holding it and
 * how far into that node it starts. `length` is in UTF-16 units, so that an
 * astral character is split off whole. */
export interface FlowCell {
  node: FlowNode;
  offset: number;
  length: number;
}

/** The panel's flow, character by character, with the node each character
 * came out of.
 *
 * `<rt>` is skipped entirely: a gloss is `position: absolute` (see
 * `.text-kakikudashi rt` in typography.css) and out of the line's flow, so
 * its kana are not characters of the column and counting them would put every
 * boundary after the first gloss in the wrong place. `<br>` contributes a
 * newline and no cell, which is what the model reads as a forced break.
 *
 * Walked over the live DOM rather than rebuilt from the pieces, because what
 * is wanted is the sequence the *line breaker* sees, and that is the DOM —
 * the pieces do not know about the sentence separator written straight onto
 * the `.sentence-gap`, nor about a mark the gloss branch lifted into a tail
 * span of its own.
 *
 * **Exported, and stated against `FlowNode` rather than against the DOM's own
 * types.** This is the half of ぶら下げ that decides *which characters* the
 * class lands on, and until it was written this way it was the only half that
 * could not be checked from here: `planHangingMarks` is exhaustively tested
 * over 488,280 passages, and the mapping from one of its indices to a
 * character on the page was tested not at all. The correspondence it has to
 * keep — one flow character per character the browser lays out, an `<rt>`'s
 * kana counted nowhere, a `<br>` counted as exactly one newline — is a fact
 * about a tree and not about a layout, so it is checkable, and
 * `tests/kakikudashiHangWiring.test.ts` checks it against the shapes
 * `renderKakikudashiView` writes. */
export function proseFlow(root: FlowNode): { text: string; cells: (FlowCell | null)[] } {
  const characters: string[] = [];
  const cells: (FlowCell | null)[] = [];
  /** Depth-first in document order, which is the order the line breaker reads
   * the panel in. A plain recursion rather than a `TreeWalker`: the two visit
   * exactly the same nodes in exactly the same order, and this one needs no
   * `document` to be handed one — see `FlowNode`. */
  const walk = (node: FlowNode): void => {
    if (node.nodeType === TEXT_NODE) {
      const data = node.data ?? "";
      for (let at = 0; at < data.length; ) {
        const character = String.fromCodePoint(data.codePointAt(at)!);
        characters.push(character);
        cells.push({ node, offset: at, length: character.length });
        at += character.length;
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    // A gloss is out of flow and contributes nothing — neither its kana nor a
    // cell — so the subtree is not entered at all.
    if (node.nodeName === "RT") return;
    if (node.nodeName === "BR") {
      characters.push("\n");
      cells.push(null);
      return;
    }
    const children = node.childNodes;
    for (let at = 0; at < children.length; at++) walk(children[at]);
  };
  const children = root.childNodes;
  for (let at = 0; at < children.length; at++) walk(children[at]);
  return { text: characters.join(""), cells };
}

/** ── 行末禁則 on the page, where the model alone could not reach it ─────────
 *
 * `MAY_NOT_END_COLUMN` above says an opening bracket may not stand at a
 * column's foot, and `planHangingMarks` keeps that rule scrupulously. But the
 * model does not *break* the lines. It predicts where the browser will break
 * them, so that the marks it hangs are the marks the browser leaves at a foot;
 * every 禁則 in it is a rule the line breaker is already keeping and the model
 * has only to anticipate. 行頭禁則 is UAX #14's own non-starters over a run of
 * text, and `line-break: normal` on `.text-kakikudashi` pins which set that is.
 *
 * 行末禁則 is the one rule that cannot be left at that, because of what this
 * panel puts in the middle of its prose. **A glossed character is a `<ruby>`
 * at `display: inline-block`** (`.text-kakikudashi ruby`, typography.css) — an
 * atomic inline, a box and not a character — and 「 followed by a glossed
 * character is therefore text, then a box, with the break opportunity at the
 * seam between them. CSS Text says an atomic inline is line-broken as though
 * it were U+FFFC, which under UAX #14's LB14 (`OP ×`, with no exception for
 * the object replacement character) forbids that break as firmly as the model
 * does. That is the specification; whether a given engine carries its 禁則
 * across the boundary into a box is a different question, and not one that can
 * be asked from here. **There is no browser in this environment.**
 *
 * The panel above does not ask it either. `glueOpeningPunctForward`
 * (KundokuView.ts) glues its own opening brackets to whatever follows rather
 * than trust the answer — "plain CSS line-breaking can't apply that rule to
 * `.kanji-cell`'s opaque atomic boxes" — and that is the *easier* case to
 * doubt, since between two boxes UAX #14 itself allows the break (LB20). This
 * is the harder case and the same remedy.
 *
 * ── What a disagreement costs, which is not only the bracket ──────────────
 * A break the model did not predict puts every later column boundary one
 * character out, and the hang is written against the model's boundaries: a
 * mark the model has at a foot is mid-column by the time the class reaches it,
 * and `.text-kakikudashi .hanging-mark`'s `letter-spacing: -1em` then lays the
 * character after it straight on top of it. One bracket at a foot is one
 * bracket the reader can see and a passage of hangs landing a character wide.
 *
 * So the rule is made structural rather than predicted, in the way the panel
 * above makes it: the bracket and the character after it go into one
 * `.no-break-unit` (`white-space: nowrap`, tategaki.css), inside which there
 * is no soft-wrap opportunity for any engine to take. What is left to the line
 * breaker is where to break *around* that unit, which is the thing it is good
 * at — and 追い出し follows from it: a unit that will not fit at a foot goes
 * down whole, which is exactly the one character `planHangingMarks` pulls back
 * (see its `MAY_NOT_END_COLUMN` branch). The model is unchanged by this and
 * did not need to change; it was already right, and this is the engine being
 * brought up to it.
 *
 * ── Glued whatever follows, and not only a gloss ──────────────────────────
 * Where the next character is plain text the engine is very likely keeping the
 * rule already: same table, same run, the same line breaker whose 行頭禁則 the
 * model is written to predict. The glue there is belt beside braces, and it is
 * written that way because the rule is absolute and there is nothing here to
 * ask — an opening bracket in this panel is now never the last thing in its
 * box, whatever kind of thing comes after it. The cost is one inline span per
 * bracket in the text, carrying no style of its own but the nowrap.
 *
 * Not verified in any browser from here. What is verified is the plan and its
 * agreement with the model, in tests/kakikudashiBracketGlue.test.ts. */

/** One character of the flow as the glue has to address it.
 *
 * A `<ruby>` **is** the character — it is a box, and it moves whole — so it
 * carries no offset. Anything else is a character *inside* a text node, and
 * the offset and length are what slice it out, in UTF-16 units so that an
 * astral character is split off entire. The same pair `FlowCell` carries, and
 * meaning the same thing. */
export interface GlueUnit {
  node: FlowNode;
  /** Where the character starts in a text node; 0 for a `<ruby>`. */
  offset: number;
  /** How long it is there; 0 for a `<ruby>`, which is sliced out of nothing. */
  length: number;
  /** Whether `node` is the character itself rather than the text it is
   * written in. */
  atomic: boolean;
}

/** An opening bracket and the character it may not be parted from. */
export interface BracketGlue {
  bracket: GlueUnit;
  held: GlueUnit;
}

/** **The plan.** Every opening bracket under `root` that has a character after
 * it, paired with that character.
 *
 * The walk is `proseFlow`'s walk and must stay it — the two have to agree
 * about what a character of this panel is, or the model would be counting a
 * sequence the glue has divided differently. `<rt>` contributes nothing, being
 * out of flow; a `<ruby>` is one character and is not entered, which is the
 * one departure and the whole point of this pass (the *box* is what has to
 * move, not the base text inside it).
 *
 * **A `<br>` ends the search rather than being glued across.** It is the
 * source's own column break, and `white-space: nowrap` does not suppress a
 * forced one — nor should it: where the source itself broke the line after an
 * opening bracket, that is the source's line structure and not a soft wrap
 * this panel chose. The model reads the same `\n` the same way.
 *
 * A `<ruby>`'s character is never an opening bracket, so the walk does not
 * read one out of the box: a gloss's base is kanji and nothing else (see
 * `WordRuby`, and the branch in `renderKakikudashiView` that writes it).
 *
 * Called **per `.sentence-gap`**, so a bracket standing at the very end of a
 * sentence is left alone rather than glued to the sentence after it. That is a
 * hole and a deliberate one: crossing the boundary would move a character into
 * a span whose `data-token-id`s are numbered for a different sentence — which
 * is a thing the kundoku panel does and printLayout.ts has to know about (see
 * "a cell borrowed from the next sentence" there) — and this panel does not
 * need it. The parser cuts a quotation at the 。 inside it and leaves the
 * *closing* bracket stranded, never the opening one: 「 reaches this panel
 * with its quotation (see `splitProvisional`, and `generateKakikudashiForTree`
 * on where the two hands of a pair end up).
 *
 * Pure, and stated against `FlowNode` for the reason `proseFlow` is: what has
 * to be true is a fact about a tree, so it is checkable with no document in
 * the environment. */
export function planBracketGlue(root: FlowNode): BracketGlue[] {
  const glues: BracketGlue[] = [];
  /** The opening bracket last seen, still waiting for its character. */
  let open: GlueUnit | null = null;
  const meet = (unit: GlueUnit, character: string): void => {
    if (open) glues.push({ bracket: open, held: unit });
    open = OPENING_BRACKETS.has(character) ? unit : null;
  };
  const walk = (node: FlowNode): void => {
    if (node.nodeType === TEXT_NODE) {
      const data = node.data ?? "";
      for (let at = 0; at < data.length; ) {
        const character = String.fromCodePoint(data.codePointAt(at)!);
        meet({ node, offset: at, length: character.length, atomic: false }, character);
        at += character.length;
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    if (node.nodeName === "RT") return;
    if (node.nodeName === "BR") {
      open = null;
      return;
    }
    if (node.nodeName === "RUBY") {
      meet({ node, offset: 0, length: 0, atomic: true }, "");
      return;
    }
    const children = node.childNodes;
    for (let at = 0; at < children.length; at++) walk(children[at]);
  };
  const children = root.childNodes;
  for (let at = 0; at < children.length; at++) walk(children[at]);
  return glues;
}

/** The node that has to move into the glue, which is the smallest thing
 * carrying this character and no other character of the flow.
 *
 * Three things it has to keep, and they are the reasons this is not simply the
 * text node:
 *
 *  - **A `<ruby>` moves whole.** Its `<rt>` is a sibling of the base inside it
 *    (`.text-kakikudashi rt`, `position: absolute`), so moving the base alone
 *    would leave the kana behind on the character's old side of the break.
 *  - **A character stays inside a `.kaki-token` of its own id.** That span is
 *    what `highlightKakikudashi` (tokenInspector.ts) marks and what
 *    `printLayout.ts` reads a page's tokens off; a character lifted out of one
 *    would stop answering to the character it came from in the panel above.
 *    Where the span holds nothing else, the span itself is what moves; where it
 *    holds more, a shallow clone of it — same id, same sentence — is opened in
 *    place and takes the character, which is the "one token owning several
 *    spans" a glossed word's base and tail already are.
 *  - **A glue already round it moves instead of it.** 「『 glues twice, and the
 *    second glue has to take the first entire rather than reach inside it and
 *    part 『 from what it is holding. Transitive nesting, exactly as
 *    `glueOpeningPunctForward` describes it.
 *
 * Answers `null` for an offset the node no longer has, which cannot happen on
 * the order the caller walks in and is a refusal rather than a throw if it
 * ever does: a bracket left unglued is the panel as it was. */
function movableFor(unit: GlueUnit): ChildNode | null {
  let node: ChildNode;
  if (unit.atomic) {
    node = unit.node as unknown as ChildNode;
  } else {
    let written = unit.node as unknown as Text;
    if (unit.offset + unit.length > written.data.length) return null;
    if (unit.offset > 0) written = written.splitText(unit.offset);
    if (written.data.length > unit.length) written.splitText(unit.length);
    node = written;
  }
  const glued = node.parentElement?.closest<HTMLElement>(".no-break-unit");
  if (glued) return glued;
  // Out of any wrapper the character is the whole of — a `.renyou-te`
  // connective is the only one this panel writes inside a `.kaki-token`, and
  // it must travel with its character or the reflow would have nothing left to
  // fade. Stops at the token span, which is what the clone below is for.
  while (
    node.parentElement &&
    !node.parentElement.classList.contains("kaki-token") &&
    !node.parentElement.classList.contains("sentence-gap") &&
    node.parentElement.childNodes.length === 1
  ) {
    node = node.parentElement;
  }
  const owner = node.parentElement;
  if (!owner || !owner.classList.contains("kaki-token")) return node;
  if (owner.childNodes.length === 1) return owner;
  const kept = owner.cloneNode(false) as HTMLElement;
  owner.insertBefore(kept, node);
  kept.append(node);
  return kept;
}

/** **The glue, on the page.** Puts every opening bracket and the character
 * after it inside one `.no-break-unit`, so that no engine can break between
 * them. See the note above for why this is done to the DOM rather than left to
 * the line breaker and predicted.
 *
 * Back to front, so that two glues sharing one text node cannot invalidate
 * each other's offsets — the same reason and the same direction
 * `applyHangingMarks` and `markProseForReveal` take, and here it also settles
 * 「『: the inner pair is glued first and the outer one then finds a
 * `.no-break-unit` to take whole.
 *
 * Adds no character and no advance: `.no-break-unit` is `display: inline` with
 * nothing on it but the nowrap, the tracking is a `letter-spacing` applied per
 * character and not per box, and every other pass over this panel reads it
 * through a walk that does not care how the tree is divided. So the column
 * census is the census it was, and the fit that follows is fitting the same
 * text. **Not verified in a browser; there is none here.**
 *
 * Once per render and never undone. The structure does not depend on the
 * column length — the fit walks a dozen of those, and the hang is cleared and
 * rewritten at each — so this runs before the fit and stands for as long as
 * the panel does. */
function glueOpeningBracketsForward(column: HTMLElement): void {
  for (const gap of column.querySelectorAll<HTMLElement>(":scope > .sentence-gap")) {
    const glues = planBracketGlue(gap);
    for (let at = glues.length - 1; at >= 0; at--) {
      const held = movableFor(glues[at].held);
      const bracket = movableFor(glues[at].bracket);
      if (!held || !bracket) continue;
      const glue = document.createElement("span");
      glue.className = "no-break-unit";
      bracket.replaceWith(glue);
      glue.append(bracket, held);
    }
  }
}

/** ── The prose panel's half of the character reveal ───────────────────────
 *
 * `animateCharacterReveal` (KundokuView.ts) discloses the 訓読文 column one
 * `.kanji-cell` at a time. On the complete-tree route — a saved text, an
 * uploaded CoNLL-U file — the prose panel is on the page and settled before
 * the first character is disclosed, and it is disclosed alongside it, one
 * character at a time and sentence for sentence.
 *
 * The kundoku panel can be animated as it stands because it is already one
 * element per character. This panel is not: a `.kaki-token` is a run of prose
 * of any length, written as a text node unless something inside it needed a
 * span of its own. So the reveal's units have to be *made*, and the two
 * functions below are the two halves of making them — the plan, which is a
 * fact about a tree and is checked in `tests/proseReveal.test.ts`, and the
 * DOM surgery that carries it out, which is not checkable here (there is no
 * document in this environment) and is written to be as small as it can be
 * given that.
 *
 * The rules are `proseFlow`'s rules, with two departures, and stating them
 * against that function rather than afresh is deliberate: the two walks must
 * agree about what a character of this panel *is*, or the hang and the reveal
 * would be counting different things down the same column.
 *
 *  - **A `<ruby>` is one unit, and the walk does not enter it.** `proseFlow`
 *    recurses in and takes the base character out of the text node inside;
 *    that is right for the hang, which is asking which characters the line
 *    breaker laid out. It is wrong here, because the `<rt>` hangs off that
 *    `<ruby>` (`.text-kakikudashi rt`, `position: absolute`) and is a sibling
 *    of the base rather than a descendant of it — disclosing the base alone
 *    would put a character's kana on the page before the character, and
 *    disclosing them separately would put them there after it. A gloss is one
 *    character *and* the reading of that one character; it appears once. So
 *    the `<ruby>` is the unit, and its opacity is the base's and the kana's
 *    together.
 *
 *  - **Whitespace is not a unit.** The indent after a `<br>` is the only
 *    whitespace this panel writes, and its counterpart in the kundoku column
 *    is an `indent-cell` — which is not a `.kanji-cell`, so the reveal there
 *    neither hides nor counts it. Skipping it here is what keeps the two
 *    panels counting the same thing; and there is nothing to fade in an
 *    invisible character in any case.
 *
 * `<rt>` is skipped, as there, because it comes with its `<ruby>`. `<br>`
 * contributes no unit, having no ink — it is a column break, and a column
 * break that waited its turn would leave the character after it stranded at
 * the foot of the wrong column.
 *
 * Everything else is entered and everything else's text is taken, which is
 * how the units come to cover the marks that live outside any `.kaki-token`:
 * the sentence separator written straight onto the `.sentence-gap`
 * (`sentenceSeparator`), the closing と a quotation puts past its bracket, a
 * `.renyou-te` connective, a `.hanging-mark` span the fit has wrapped round a
 * mark at a column's foot. None of those is special-cased, and none may be:
 * a character the walk missed would be hidden by nothing and so would appear
 * before its turn, and — worse — a character wrapped twice would be counted
 * twice and would put its sentence out of step with the column beside it. */

/** One character of the prose, as the reveal has to address it: either a node
 * that is already exactly one character (a `<ruby>`), or a character inside a
 * text node, which the DOM half will have to lift out into a span. */
export type ProseUnit =
  | { kind: "node"; node: FlowNode }
  | { kind: "character"; node: FlowNode; offset: number; length: number };

/** The prose reveal's units under one `.sentence-gap`, in document order.
 *
 * Stated against `FlowNode` for the reason `proseFlow` is (see there): the
 * correspondence this has to keep — one unit per character the reader sees,
 * a gloss's kana counted with its character and nowhere else — is a fact
 * about a tree, so it is checkable in a test environment with no document in
 * it, and `tests/proseReveal.test.ts` checks it against the shapes
 * `renderKakikudashiView` writes. */
export function proseRevealUnits(root: FlowNode): ProseUnit[] {
  const units: ProseUnit[] = [];
  const walk = (node: FlowNode): void => {
    if (node.nodeType === TEXT_NODE) {
      const data = node.data ?? "";
      for (let at = 0; at < data.length; ) {
        const character = String.fromCodePoint(data.codePointAt(at)!);
        if (!/\s/.test(character)) units.push({ kind: "character", node, offset: at, length: character.length });
        at += character.length;
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    if (node.nodeName === "RT" || node.nodeName === "BR") return;
    if (node.nodeName === "RUBY") {
      units.push({ kind: "node", node });
      return;
    }
    const children = node.childNodes;
    for (let at = 0; at < children.length; at++) walk(children[at]);
  };
  const children = root.childNodes;
  for (let at = 0; at < children.length; at++) walk(children[at]);
  return units;
}

/** **The DOM half.** Gives every character of the prose an element of its own
 * to be faded, and hands back one list per `.sentence-gap`, in order, for
 * `animateCharacterReveal` to disclose.
 *
 * A character that is already an element (a `<ruby>`) is handed back as it
 * stands. A character inside a text node is lifted into a plain `<span>` — the
 * same surgery `applyHangingMarks` performs a few lines above, down to the
 * `splitText` idiom and to working **back to front** through each node, so
 * that splitting at a later character cannot invalidate an earlier one's
 * offset. Reversing the whole list gives that per node, the units of any one
 * node being in ascending order within it.
 *
 * ── Why the spans are safe, and why they are never taken off again ────────
 * **They are the wrapper `applyHangingMarks` already writes, without the
 * class.** That mechanism wraps a mark of punctuation in a bare `<span>`
 * whenever the fit puts one at a column's foot, and it does so *after* the
 * fit has measured the column and *between* the trials of the fit's own
 * search — so a bare span round a character of this panel is not a new thing
 * being asked of the layout, it is a thing the layout does on every render
 * already. What it must not do is change where the characters fall, and it
 * does not: a non-replaced inline box is not a break opportunity, the panel's
 * spacing is a `letter-spacing` (see `.text-kakikudashi` in typography.css)
 * which is applied per character and not per box, and every other pass over
 * this panel reads it through `proseFlow`, which walks text nodes and does
 * not care how they are divided.
 *
 * **Not verified in a browser; there is none in this environment.** What
 * would settle it is a column census either side of this call — the count of
 * `.sentence-gap` line fragments, or `column.getBoundingClientRect().width`,
 * which under vertical-rl is `columns x pitch` (see `passageExtent`) — and
 * the expectation is that the two readings are identical.
 *
 * The wrappers are left in the page when the reveal ends. Taking them off
 * would be a second mutation, at the one moment the route has promised the
 * reader that nothing moves — and if the neutrality argued above ever failed,
 * unwrapping would be *when* it showed, as a jump at the end of the reveal
 * rather than a difference nobody sees. They cost nothing where they stand:
 * they carry no class and no style, they are not `.kaki-token`s so
 * `keyedKakiTokens` and `highlightKakikudashi` count the same spans as
 * before, and the next redraw of this panel builds the DOM afresh without
 * them. */
export function markProseForReveal(container: HTMLElement): HTMLElement[][] {
  const column = container.querySelector<HTMLElement>(":scope > .tategaki-column");
  if (!column) return [];
  const sentences: HTMLElement[][] = [];
  for (const gap of column.querySelectorAll<HTMLElement>(":scope > .sentence-gap")) {
    const units = proseRevealUnits(gap);
    const made: HTMLElement[] = [];
    // Back to front, then reversed at the end, so that what is handed back is
    // in reading order while the surgery is done in the order that keeps the
    // offsets good.
    for (let at = units.length - 1; at >= 0; at--) {
      const unit = units[at];
      if (unit.kind === "node") {
        made.push(unit.node as HTMLElement);
        continue;
      }
      let node = unit.node as Text;
      if (unit.offset > 0) node = node.splitText(unit.offset);
      if (node.data.length > unit.length) node.splitText(unit.length);
      const span = document.createElement("span");
      node.replaceWith(span);
      span.append(node);
      made.push(span);
    }
    made.reverse();
    sentences.push(made);
  }
  return sentences;
}

/** How many characters the column now holds, read off the layout the page is
 * actually set in rather than re-derived from the fit.
 *
 * The measure is the container's content box along the column — its height
 * less the padding at each end, under vertical-rl — and the advance is the
 * character plus the tracking the panel has published, both from computed
 * style. Flooring is what a line breaker does, and it lands on the fitted
 * count without being told about it: `fittedTracking` leaves the column a
 * guard's worth of slack (a twelfth of a pixel at ten characters), so the
 * quotient is the count and a hair over.
 *
 * One reading for every caller, which is the point. The screen panel is
 * fitted and holds `round(measure / design advance)`; a print band is not
 * fitted at all and holds `floor(measure / design advance)` with the
 * remainder sitting at its foot (see printLayout.ts). Dividing what is
 * actually there by what is actually there answers both without either
 * having to say which it is. */
function heldSlots(container: HTMLElement, column: HTMLElement): number {
  const panel = getComputedStyle(container);
  const measure =
    container.getBoundingClientRect().height - parseFloat(panel.paddingTop) - parseFloat(panel.paddingBottom);
  const text = getComputedStyle(column);
  const size = parseFloat(text.fontSize);
  const tracking = parseFloat(text.letterSpacing);
  const advance = size + (Number.isFinite(tracking) ? tracking : 0);
  if (!(measure > 0) || !(advance > 0)) return 0;
  return Math.floor(measure / advance + 1e-6);
}

/** Takes back every hang under `root`, putting the text nodes back the way
 * the render wrote them.
 *
 * Exported for printLayout.ts, which clones this panel's `.sentence-gap`
 * spans into bands of a different column length: a mark still wearing the
 * class is a mark with its advance given back in the middle of a print
 * column, and the character after it laid on top of it. The clone is stripped
 * as it is dealt, before the fit test that decides which page it lands on,
 * and the bands are hung afresh once the pages are settled.
 *
 * `normalize()` and not merely the unwrapping, because the model walks text
 * nodes and an unwrapped mark left as a text node of its own is a sequence
 * split where the render did not split it. It is the same sequence either
 * way, but the nodes the next pass splits should be the nodes it started
 * from. */
export function clearHangingMarks(root: HTMLElement): void {
  for (const worn of [...root.querySelectorAll<HTMLElement>(`.${HANG_CLASS}`)]) {
    worn.replaceWith(...worn.childNodes);
  }
  root.normalize();
}

/** **The hang, on the page.** Takes back whatever was hung for the column
 * this panel was set to before, works out what hangs at the column it is set
 * to now, and wraps each of those marks in a span of its own for
 * `.text-kakikudashi .hanging-mark` to take the advance off.
 *
 * **A plain `<span>` and nothing on it but the class**, which is what that
 * rule is written against: the mark is a non-replaced inline box, and the
 * rule says there why the give-back is a `letter-spacing` and no longer a
 * margin.
 *
 * Cleared first and unconditionally, rather than diffed: the count changes
 * under this panel constantly — the fit walks a dozen column lengths on every
 * render and again on every resize — and a mark left hanging at a count it no
 * longer belongs to is the one failure this mechanism has.
 *
 * The marks are wrapped back to front so that two hangs in one text node do
 * not invalidate each other's offsets: splitting at the later one leaves the
 * earlier one's node and offset exactly as they were.
 *
 * The span is inert to everything else that reads this panel. It is not a
 * `.kaki-token`, so `keyedKakiTokens` counts the same spans across a redraw
 * and `highlightKakikudashi` (tokenInspector.ts) marks the same ones; it is
 * inside whichever `.kaki-token` held the mark, so the mark still belongs to
 * its token; and `.sentence-gap` — which is what `scrollSync.ts` aligns the
 * panels on — is a level above it. */
export function applyHangingMarks(container: HTMLElement, column: HTMLElement): void {
  clearHangingMarks(column);
  const slots = heldSlots(container, column);
  if (slots < 1) return;
  const flow = proseFlow(column);
  const plan = planHangingMarks(flow.text, slots);
  for (let i = plan.hangs.length - 1; i >= 0; i--) {
    const cell = flow.cells[plan.hangs[i]];
    if (cell === null || cell === undefined) continue;
    // `proseFlow` is written against `FlowNode` so that the walk can be
    // checked without a document (see there); on this path the node it hands
    // back is the live `Text` it came out of, and splitting one is the whole
    // of what is done to it.
    let node = cell.node as Text;
    if (cell.offset > 0) node = node.splitText(cell.offset);
    if (node.data.length > cell.length) node.splitText(cell.length);
    const mark = document.createElement("span");
    mark.className = HANG_CLASS;
    node.replaceWith(mark);
    mark.append(node);
  }
}

/** **How far a passage runs**, which is the quantity the two panels are being
 * matched on: the width of the one `.tategaki-column` a panel's whole text is
 * wrapped in. Under vertical-rl that box is the passage itself — columns
 * stacked right to left, one pitch apart — so its width is `columns x pitch`
 * and nothing else.
 *
 * `getBoundingClientRect().width` on that box rather than the panel's
 * `scrollWidth`, which is the same number only while the text is longer than
 * the panel is wide. A text short enough to fit reports the panel's own width
 * instead, so a `scrollWidth` comparison would say two short passages are the
 * same length whenever both fit — which is the one case where the answer is
 * most obviously visible on the page. */
function passageExtent(column: HTMLElement): number {
  return column.getBoundingClientRect().width;
}

/** The passage this panel is being matched to: the kundoku text above it, in
 * the box that holds the whole of it, so that `passageExtent` can be asked how
 * far it runs.
 *
 * Reached from the `.main` grid rather than by the `#kundoku-view` id: what is
 * wanted is "the other panel of the same page", and the print bands
 * printLayout.ts builds are `.tategaki`s outside any `.main` at all — so a
 * band, or a panel rendered into a fixture with no sibling, finds nothing here
 * and keeps the plain fit.
 *
 * Measured rather than derived. The number of columns a passage comes to is
 * the browser's own line breaking — 禁則 keeps a mark of punctuation off the
 * head of a column, a tied compound may not break at all (see
 * `.compound-group[data-tied]` in kunten.css) — and an arithmetic model of it
 * (characters divided by characters per column, rounded up per source line)
 * runs short: on 酒蟲 at ten characters to the column that model says
 * sixty-six columns where `.text-kakikudashi` in typography.css records
 * having measured sixty-seven. There is nothing to be gained by predicting a
 * number the layout is standing right there holding. */
function kundokuColumn(main: HTMLElement): HTMLElement | null {
  return main.querySelector<HTMLElement>(".kundoku-panel .tategaki > .tategaki-column");
}

/** **The split.** How many whole extra characters the kundoku column is being
 * given, out of the panel below it.
 *
 * The two panels share one height — they are the two text rows of the same
 * grid — so this is not a height for one of them but the division between
 * them, and the property is written on the grid that makes it. What it steps
 * by is `--kanji-advance`: the kundoku column has to hold a whole number of
 * characters, so the only heights it can take are 88px apart, and the free
 * variable is which of them. See `#app:not(.kakikudashi-collapsed) .main` in
 * tategaki.css, which is the rule this reaches.
 *
 * Removed rather than set to zero, so that "the layout as the stylesheet
 * describes it" is a state with nothing written on the element at all. */
function setKundokuSteps(main: HTMLElement, steps: number): void {
  if (steps === 0) main.style.removeProperty(KUNDOKU_STEPS_PROPERTY);
  else main.style.setProperty(KUNDOKU_STEPS_PROPERTY, String(steps));
}

const KUNDOKU_STEPS_PROPERTY = "--kundoku-extra-slots";

/** How far the split may be pushed, and how little prose may be left.
 *
 * A step takes 88px from the prose panel, which is three and a half of its
 * characters, so a couple of steps is the whole of what any ordinary panel
 * has to give — the bound is a guard against a pathological geometry looping,
 * not a limit anyone should reach. The floor is the more considered of the
 * two: a prose column of two characters is not prose, and it is also where
 * `fittedTracking` starts declining to fit at all (see its band), so below
 * three the count this module reasons in stops being the count on the page. */
const MAX_KUNDOKU_STEPS = 6;
const MIN_PROSE_SLOTS = 3;

/** Sets this panel's text to a column of exactly `slots` characters, or to
 * whatever its own share comes to where `slots` is `null` — and in **both**
 * cases the panel is full to its padding.
 *
 * This is the *fine* control, and `setKundokuSteps` above is the coarse one.
 * The split can only move in whole kundoku characters, 88px at a time, which
 * is three and a half characters of prose, so between one step and the next
 * there is a great deal of room the split cannot reach. Setting a shorter
 * column is how the panel reaches it: fewer characters to the column is more
 * columns, and more columns is a longer passage.
 *
 * ── The shorter column is now a looser tracking, not a shorter box ────────
 * It used to be a height written on the `.tategaki` — `slots` design advances
 * — inside a grid row still sized to the panel's whole share, and the
 * difference stood below the text as empty panel. That is where 92px of blank
 * under a five-line passage came from, and the case against it is at
 * `stretchedTracking`, with the sweep that measured it.
 *
 * What is written instead is the tracking that makes exactly `slots`
 * characters fill the share there already is. The count is the one asked for
 * either way; what differs is that the height it does not spend on characters
 * goes between them rather than under them. So the panel has no empty band at
 * any window height, and `.tategaki`'s box, its content box and its column all
 * end together — the property `.kundoku-panel .tategaki` has always had in
 * that panel's own terms, arrived at here by the other road, since a prose
 * advance is a quantity this module chooses and a kundoku advance is not.
 *
 * The cost is that the reachable counts are now a band and not an open range,
 * `fitPassageExtent` says what that costs the match, and `columnCounts` is
 * where the two edges of it are worked out. */
function setColumnSlots(container: HTMLElement, column: HTMLElement, slots: number | null): void {
  // Never a height. The box is the panel's whole share at every candidate, and
  // the count is got from the tracking instead — see `stretchedTracking`, and
  // the panel's worth of dead space that used to be the price of the other
  // way. The `removeProperty` is not vestigial: `holdPanelMeasures` pins a
  // height here for the length of a rail's gesture, and this is what the fit
  // runs into if it is asked to re-derive before that hold is released.
  container.style.removeProperty("height");
  if (slots === null) fitColumnTracking(container, column);
  else {
    const style = getComputedStyle(container);
    const measure =
      container.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const size = parseFloat(getComputedStyle(column).fontSize);
    const tracking = stretchedTracking(measure, size, slots);
    // Only ever reached for a count the band can hold: `fitPassageExtent`
    // offers the search no other (see `reachable` there). The fallback is the
    // same one `fitColumnTracking` takes and is here so that a future caller
    // asking for the impossible gets the panel's own setting rather than a
    // silent lie about how many characters are in a column.
    if (tracking === null) container.style.removeProperty("--tracking-kakikudashi");
    else container.style.setProperty("--tracking-kakikudashi", `${tracking}px`);
  }
  // The hang last, and inside this function rather than beside its callers,
  // because it is a function of the count — and this is the one place the
  // count changes. Every candidate the search below tries goes through here,
  // so `passageExtent` measures a passage whose marks are already hanging and
  // the division between the panels is chosen from the page as it will be
  // set, rather than from the page as it would be without them. It has to be
  // after `fitColumnTracking`: the advance the model divides by is the
  // tracking that call has just published.
  applyHangingMarks(container, column);
}

/** What each column length came out at, per panel, for the text now in it.
 *
 * The extent of a passage set `slots` characters to the column is a fact
 * about the text and that number and nothing else — not about the panel's
 * height, which is what is being chosen, nor its width, which only decides
 * how much of the passage is on screen. So a measurement taken once stands
 * for as long as the text does, and a window dragged across the count that
 * would send the choice from one length to the next re-measures nothing: the
 * search below reads the same map it filled on the first render.
 *
 * Cleared by `renderKakikudashiView`, which is the only thing that changes
 * the text. */
const measuredExtents = new WeakMap<HTMLElement, Map<number, number>>();

/** **The match, at one split.** The prose column length that makes this
 * passage run as near as it can to `target`, given a panel that can hold
 * `ceiling` characters to the column.
 *
 * The reader's two texts are the same text, and until now they ended in
 * different places: the kundoku panel sets four characters to a column and
 * the prose ten, and the prose of a kanbun passage is between two and three
 * times as many characters as the kanbun — so at a column pitch of half the
 * kundoku panel's, the prose came to well under half the width. Counted
 * through the text pipeline on 酒蟲, against a panel of the shipped 792px
 * geometry: 271 kundoku cells at four to the column is 69 columns and 6072px,
 * where 652 characters of prose at ten to the column is 66 columns and
 * 2904px. (271 and not the 359 characters the source has, because a mark of
 * punctuation takes no advance in that panel at all — see `.punct-cell` in
 * kunten.css.) So the prose ended less than half way along the passage it
 * translates, and every scroll of the two panels together left one of them
 * looking at nothing.
 *
 * Making the prose column *shorter* is what lengthens the passage, which is
 * why the answer is a smaller number than the panel would otherwise hold. The
 * user asked for exactly that and said the short lines were welcome.
 *
 * ── Why this is a search and not a formula ──────────────────────────────
 * The extent wanted is `kundoku columns x 88`, and the prose extent
 * achievable is `prose columns(n) x 44` at whole `n` — a staircase, whose
 * steps near the answer are hundreds of pixels apart. There is generally no
 * `n` that lands on the target, so the whole of the decision is *which side
 * of it to miss on*, and that is a comparison between two measured numbers
 * rather than a division. Counted on 酒蟲 against the 792px geometry with the
 * split left where it was, the two candidates are five characters to the
 * column (131 columns, 5764px, 308px short of the kundoku's 6072) and four
 * (164 columns, 7216px, 1144px long): five, by a factor of nearly four.
 *
 * The candidates are walked downwards from the count the panel holds unaided,
 * because a shorter column can only make the passage longer, so the extents
 * are non-decreasing along the walk and the first one to reach the target is
 * the last one worth measuring. That count is also the ceiling: a column
 * longer than it is a text box taller than the panel, which `.main-panel`'s
 * own `overflow: hidden` would cut the foot off.
 *
 * The walk also stops at the *bottom*, and that bound is not in this function:
 * `extentAt` is handed in, and `fitPassageExtent` hands in one that answers
 * with an unreachable extent for any count the panel cannot be set to with no
 * part of it left empty (see `columnCounts`). An infinity is never better than
 * what is in hand and always counts as having reached the target, so the walk
 * ends there of its own accord. Which is why this function does not need to
 * know that the bound exists — it is a fact about the panel and this is a
 * search over the text.
 *
 * Each candidate costs one write and one measurement, which is a forced
 * layout of this panel; there are at most a dozen of them, they are cached
 * for the life of the text (see `measuredExtents`) and shared across every
 * split tried, since how long a passage runs at a given column length is a
 * fact about the text and that length alone.
 *
 * Pure, and separately tested, in the same way and for the same reason
 * `fittedTracking` is: `extentAt` is the only thing here that needs a layout
 * engine, and it is a parameter. */
export function matchedSlots(target: number, ceiling: number, extentAt: (slots: number) => number): number {
  if (!(ceiling >= 1)) return 1;
  const held = extentAt(ceiling);
  // A passage with no extent is a panel with nothing in it — a tree of no
  // sentences. Every candidate below would come back at nothing as well, so
  // the walk would be a dozen writes to answer a question about no text.
  if (!(held > 0)) return ceiling;
  let best = ceiling;
  let bestGap = Math.abs(held - target);
  // Only worth walking at all while the passage is still short of the target;
  // one already past it can only get longer.
  if (held < target) {
    for (let slots = ceiling - 1; slots >= 1; slots--) {
      const extent = extentAt(slots);
      const gap = Math.abs(extent - target);
      // Strictly better, so a tie keeps the longer column — the fuller panel,
      // and the state nearest the one this panel had before.
      if (gap < bestGap) {
        best = slots;
        bestGap = gap;
      }
      if (extent >= target) break;
    }
  }
  return best;
}

/** What a division of the page comes to: where the split is, how long the
 * prose column is under it, and how far the two passages then end apart. */
export interface Division {
  /** Whole kundoku characters' worth of height moved out of the prose panel. */
  steps: number;
  /** Characters to the prose column. */
  slots: number;
  /** How far this division pushes the column from the length the panel would
   * set itself — `ceiling - slots`, in characters.
   *
   * It used to mean the height the division gave up to nothing, because a
   * shorter column was got by writing a shorter box. It is not that any more
   * (see `setColumnSlots`): the panel is full at every count, and what a
   * shorter column costs is looser tracking rather than empty panel. The
   * number is the same one and it is still exactly the right tie-break —
   * among divisions the passages match equally well under, take the one whose
   * type is set nearest to the design. */
  unused: number;
  /** Whether the column is the length the panel sets itself at this split, in
   * which case nothing has to be asked of the tracking and the panel is left
   * exactly as `fitColumnTracking` would leave it. The same fact as
   * `unused === 0`, said as the caller uses it. */
  fills: boolean;
  /** How far apart the two passages end, in px. */
  gap: number;
}

/** **The whole match.** Walks the splits the two panels can be divided at,
 * asks `matchedSlots` for the best prose column at each, and answers with the
 * best pair.
 *
 * ── The two variables, and why there are two ───────────────────────────
 * The panels share one height, so giving the prose less is giving the kanbun
 * more, and the kundoku column may only hold a whole number of characters —
 * which makes the coarse variable a single integer, the number of 88px steps
 * moved across the rail. That is `setKundokuSteps`. But 88px is three and a
 * half characters of prose, so between one step and the next lies most of the
 * range; the fine variable is the prose column length within whatever share
 * is left, which is `setColumnSlots`. Both move the same quantity — how far
 * the passages run — from opposite ends, and neither reaches what the other
 * does. Counted on 酒蟲 at 792px:
 *
 *   step  kundoku            prose (fit)          best prose      mismatch
 *   0     4/col, 69 col      10/col, 66 col       5/col, 131 col  -308px  -5.1%
 *   1     5/col, 55 col       6/col, 110 col      6/col, 110 col     0px   0.0%
 *   2     6/col, 47 col       3/col, 218 col      3/col, 218 col +5456px +131.9%
 *
 * ── Those counts are the naive ones, and ぶら下げ has moved them ──────────
 * The three rows above count a prose column as `ceil(characters / slots)`,
 * which is no browser's behaviour: it lets a mark of punctuation begin a
 * column, and 禁則 does not. What the page was actually laid out at was longer
 * — 追い出し spends a column here and there, and the one measurement this
 * repository holds says so (sixty-seven columns at ten to the column against
 * the naive sixty-six, recorded in `.text-kakikudashi`, typography.css). So
 * the 0.0% on the middle row was never 0.0%: it was the passage running a
 * couple of columns *past* the kundoku one.
 *
 * `planHangingMarks` takes those columns back, and modelled on a passage of
 * this shape and punctuation it lands the step-1 row about one column short of
 * the target instead of two or three past it — a better match than the row
 * claims, from the other side. The step does not move: no step, at its own
 * best column length, is still seven columns further out. The table is left as
 * the reasoning of the round that wrote it; the arithmetic is in
 * tests/kakikudashiHang.test.ts, which computes all three regimes. None of it
 * changes what this function *does*, since every candidate is measured off the
 * page with its marks already hanging.
 *
 * One step, and at one step the prose panel's own share holds exactly the
 * column that matches, so nothing is given up to nothing either. Two steps
 * leaves 72px of prose panel, which is three characters to the column, and a
 * text set three to the column is more than twice as long as the kanbun it
 * translates. The step is coarse and the fine variable is what saves the
 * viewports where it lands badly: at 845px the best is no step at all with
 * the prose column cut from eight to six, which matches to the pixel where a
 * step would miss by 39%.
 *
 * ── The choice ─────────────────────────────────────────────────────────
 * Least mismatch first, since ending in the same place is the whole point.
 * Then the *fullest prose panel* — the fewest characters of its share left
 * unused — and only then the fewest steps.
 *
 * The middle term is what keeps this honest about where height goes. A step
 * hands 88px across the rail to the kanbun; shortening the column hands its
 * height to nothing, and leaves a deep margin under the prose. So where two
 * divisions match the page equally well, the one to take is the one that has
 * *moved* the height rather than merely declined to use it. Measured against
 * the model at 900px: with the split left alone the prose panel could hold
 * eleven characters to the column and the match wants six, so five characters
 * of panel — 117px — sit empty; one step gives that height to the kanbun
 * instead, and the seven the panel then holds is exactly the count the match
 * wants. Same page-length, nothing wasted, and a longer kundoku column into
 * the bargain.
 *
 * Fewest steps last rather than first, because a step is still a change to
 * the panel the reader is reading — it re-breaks every column of the kanbun —
 * and where a step buys neither a better match nor a fuller panel it has
 * bought nothing.
 *
 * ── The cost, and the loop that is not one ─────────────────────────────
 * Each step tried is a write to the grid and a measurement of both passages,
 * which is a forced layout of the whole page; there are two or three of them,
 * and the prose lengths they ask for are cached across all of them. The caller
 * writes to the grid it is laid out by, so it must not be driven by an
 * observer of anything it moves — see `observePanelFit`, which watches `.main`
 * itself, the one box in this that no split can resize.
 *
 * Pure, like `matchedSlots` and for the same reason. `apply` is what applies a
 * split and reports what the page then measures — the target to reach and the
 * column length the prose panel is left able to hold — or `null` where that
 * split leaves no panel worth setting; `extentAt` is how far this passage runs
 * at a column length. Between them they are the whole of what needs a browser,
 * and the choice between the answers they give does not. */
export function matchedDivision(
  maxSteps: number,
  apply: (steps: number) => { target: number; ceiling: number } | null,
  extentAt: (slots: number) => number,
): Division | null {
  let best: Division | null = null;
  for (let steps = 0; steps <= maxSteps; steps++) {
    const measured = apply(steps);
    // Out of panel: either this step has taken the prose past what is worth
    // setting, or there was never a panel here. Nothing further along the walk
    // can be better, since every further step takes another 88px from the same
    // box.
    if (measured === null) break;
    const slots = matchedSlots(measured.target, measured.ceiling, extentAt);
    const gap = Math.abs(extentAt(slots) - measured.target);
    const unused = measured.ceiling - slots;
    // Strictly better on the pair, so the last tie goes to the fewest steps —
    // this walk runs upwards from none.
    if (best === null || gap < best.gap || (gap === best.gap && unused < best.unused)) {
      best = { steps, slots, unused, fills: unused === 0, gap };
    }
  }
  return best;
}

/** The match on the page: applies each division, measures what it comes to,
 * and leaves the page set to the best of them.
 *
 * ── When this runs, and what asks for it ──────────────────────────────────
 * Every render of this panel, since a render is what puts a new prose in it;
 * and every resize of `.main`, through `observePanelFit`. Both reach it
 * through `renderKakikudashiView`, so **there is no route into new prose that
 * does not re-answer the division** — including the two that redraw a text the
 * reader already has open, an annotation edit and the 連用形-て switch
 * (`redrawInPlace` in main.ts, through `renderTree` and `adoptTree`).
 *
 * The switch is the one of those that changes the *length* of the prose, which
 * is what this measures: it writes a connective at every 連用形 that hands a
 * clause on, and on 酒蟲 that is 29 characters onto 652 (`animateKakikudashi
 * Reflow`'s own figure). Whether that moves the answer is a question about a
 * staircase — the achievable extents are `columns(n) x pitch` at whole `n`,
 * and the steps near the answer are hundreds of pixels apart — so a change of
 * a few per cent in the prose moves the chosen column length on some texts and
 * geometries and not on others. When it does not, the panel keeping the height
 * it had is the fit's answer and not the fit being skipped.
 *
 * ── The split moves at once, and must ─────────────────────────────────────
 * The reader sees the panels change size in one frame while the words settle
 * over `FADE_MS`, and that is deliberate on three counts, none of which needs
 * an interval of its own:
 *
 *  - **The search reads what it writes.** Every candidate here writes
 *    `--kundoku-extra-slots` onto `.main` and measures the page the next
 *    line. A transition on `grid-template-rows` would hand it an interpolated
 *    height and it would choose from a layout that never existed. app.css says
 *    this from the other side, which is why `.rows-animating` is on `#app` for
 *    the length of a rail click and never otherwise.
 *  - **The kundoku row is quantised and an interpolation is not.** A step is
 *    exactly `--kanji-advance`, so the row is a whole number of characters at
 *    both ends of the move; every value in between is a fraction of one, and
 *    the panel would re-break its columns at every frame of the way — the
 *    text flickering through half a dozen settings to arrive at the one that
 *    was chosen.
 *  - **A size change here is a consequence, not a gesture.** The rails animate
 *    because the reader asked for the panel to move and the movement *is* the
 *    answer. Here the reader asked for a connective; the panel resizing is
 *    what the page had to do to keep the two texts ending together, and it is
 *    the words settling into the new setting that they should be watching.
 *
 * What the panels then owe the reader is that nothing *flies*: a character
 * that was re-set at a new column length has not travelled, and neither panel
 * may say it has. `pushedAlongTheFlow` has drawn that line in this file since
 * the walk was written; `cellWalk` in `KundokuView.ts` is the same line, drawn
 * for the panel above on the day this became able to move a cell in it. */
function fitPassageExtent(container: HTMLElement, column: HTMLElement): void {
  const main = container.closest<HTMLElement>(".main");
  const kundoku = main && kundokuColumn(main);
  // No panel to match — a print band, a fixture, a document just closed. The
  // plain fit, as before.
  if (!main || !kundoku) {
    fitColumnTracking(container, column);
    applyHangingMarks(container, column);
    return;
  }
  const before = main.style.getPropertyValue(KUNDOKU_STEPS_PROPERTY);
  const extents = measuredExtents.get(container) ?? new Map<number, number>();
  measuredExtents.set(container, extents);

  /** The column length the panel holds at the split now applied — the count
   * `fittedTracking` chooses for it, and so the top of the search's walk.
   * Kept in a variable because `extentAt` below has to know which of its
   * candidates is the unaided one, and that changes with the split.
   *
   * The one place a candidate and the page come apart is where the fit
   * *declines* the panel — a measure so short that filling it at any count
   * would set the type outside `FIT_MIN_TRACKING_EM`/`FIT_MAX_TRACKING_EM`.
   * There the column is drawn at the design tracking and holds one character
   * fewer than this count, so an extent cached against the ceiling is really
   * the extent of the length below it and the choice can come out one step
   * off. Reasoned and not observed; it is a panel with two or three characters
   * to the column, which `MIN_PROSE_SLOTS` is already refusing to divide the
   * page at. It is now also the *only* way the panel can be left with any of
   * its share unspent, and what it leaves is under one character. */
  let ceiling = 0;
  /** The counts this share can be set to with the panel still full. Re-read at
   * every step, because it is a fact about the measure and the measure is what
   * a step moves. */
  let counts: { fewest: number; most: number } | null = null;
  const extentAt = (slots: number): number => {
    const seen = extents.get(slots);
    if (seen !== undefined) return seen;
    setColumnSlots(container, column, slots === ceiling ? null : slots);
    const measured = passageExtent(column);
    extents.set(slots, measured);
    return measured;
  };

  /** What the search may ask for, which is not every count it might like.
   *
   * `extentAt` above answers about the *text*: how far the passage runs at a
   * given column length, which is a fact about the characters and that length
   * and is cached for the life of the text. This answers about the *panel*:
   * whether this share can actually be set to that length with no part of it
   * left empty. The two are different questions and only the first is
   * cacheable — the same count fills the panel at one split and cannot at the
   * next, because a step moves 88px of measure.
   *
   * A count outside the band comes back as an unreachable extent rather than
   * as a short box with a hole beneath it. `matchedSlots` walks *down* from
   * the ceiling and breaks on the first candidate that reaches the target, so
   * an infinity stops the walk exactly at the band's edge — and correctly,
   * since reachability is upward-closed in the count and everything below is
   * out too. The ceiling itself is always offered: it is the setting the panel
   * takes when nothing is asked of it, and the one case that may leave a part
   * of a character over.
   *
   * ── What the band costs the match, measured ───────────────────────────
   * Swept from 700px to 1200px of `.main` in twenty-pixel steps, on a text of
   * 30 kanbun characters and 63 of prose: the division chosen is the same at
   * fourteen of the twenty-six heights and worse at twelve — by one prose
   * column at nine of them, by two at two, by four at one. Against that, the
   * empty band under the prose goes from as much as 95.6px to nothing at every
   * height. That trade is the reader's to reverse and not this file's to hide,
   * so: it is taken because the band is what a reader *sees*, on every page,
   * and grows without limit as the window does, where the mismatch is bounded
   * by a prose column or two and shows only as one passage ending short of the
   * other.
   *
   * It costs a long text nothing at all, which is worth knowing before
   * weighing it. `matchedSlots` only walks below the ceiling when the prose at
   * its own natural length already runs *shorter* than the kanbun — and the
   * prose of a kanbun text is two to three times its characters at half the
   * column pitch, so on anything but a short passage the ceiling is past the
   * target and the walk never starts. The dead space was a short-text
   * artefact, and so is what removing it costs. */
  const reachable = (slots: number): number =>
    slots === ceiling || (counts !== null && slots >= counts.fewest && slots <= ceiling)
      ? extentAt(slots)
      : Number.POSITIVE_INFINITY;

  /* `<= ceiling` and not `<= counts.most`, though the band often reaches a
   * count or two above it. Not an oversight: `matchedSlots` walks *downwards*
   * from the ceiling and never asks for anything above it, so offering more
   * would be describing a reach the search does not have — and a bound that
   * says what the caller will actually do is worth more than one that is
   * merely true. What it leaves on the table is small and was measured before
   * being left: over the same 700–1200px sweep, letting the search tighten
   * above the panel's own count would have improved the match at two of the
   * twenty-six heights. Taking it means teaching `matchedSlots` to walk both
   * ways, and its monotonicity argument — a shorter column can only lengthen
   * the passage, so the first candidate to reach the target is the last worth
   * measuring — is written for one direction. A change for its own round. */


  const best = matchedDivision(
    MAX_KUNDOKU_STEPS,
    (steps) => {
      setKundokuSteps(main, steps);
      // The panel's whole share, so the measure read is the share and not a
      // height left over from the last candidate.
      setColumnSlots(container, column, null);
      const style = getComputedStyle(container);
      const measure =
        container.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const size = parseFloat(getComputedStyle(column).fontSize);
      ceiling = Math.round(measure / (size * (1 + DESIGN_TRACKING_EM)));
      counts = columnCounts(measure, size);
      // The first division is the layout as it stands, so it is offered
      // whatever the panel holds; a division that *takes* height has to leave
      // enough behind to be prose.
      if (ceiling < (steps === 0 ? 1 : MIN_PROSE_SLOTS)) return null;
      const target = passageExtent(kundoku);
      return target > 0 ? { target, ceiling } : null;
    },
    reachable,
  );

  if (best === null) {
    // Nothing was measurable — the panel is collapsed, or holds no text. Put
    // the split back exactly as it was found rather than declaring it zero: a
    // collapsed panel is a panel that will be opened again, and the division
    // that was chosen for this text is still the right one when it is.
    if (before) main.style.setProperty(KUNDOKU_STEPS_PROPERTY, before);
    else main.style.removeProperty(KUNDOKU_STEPS_PROPERTY);
    setColumnSlots(container, column, null);
    return;
  }
  setKundokuSteps(main, best.steps);
  setColumnSlots(container, column, best.fills ? null : best.slots);
}

/** The panels being watched for a change of measure.
 *
 * A plain `Set` and not a `WeakSet`, which it was while the only question
 * asked of it was "has this one been observed already". The suspension below
 * has to be able to *walk* them — a fit deferred through a gesture has to be
 * run when the gesture ends, and a `WeakSet` cannot be iterated. What that
 * costs is a strong reference to `#kakikudashi-view`, which `main.ts` writes
 * into `#app` once at start-up and never replaces, so the set holds the one
 * element that outlives everything in the session anyway. */
const watched = new Set<HTMLElement>();

/** ── Not while the page is moving ─────────────────────────────────────────
 *
 * **The fit must not run on a layout that no final page will ever have.**
 *
 * A sidebar collapsing is a transition on `#app`'s columns, so `.main`'s own
 * box changes width on every frame of it — and `.main` is what the observer
 * below watches. Left to itself the callback therefore fires sixteen times
 * across one 260ms gesture, and each firing is `fitPassageExtent`: up to
 * seven candidate splits, each one a write to the grid followed immediately
 * by a read of it (a forced synchronous layout of the whole page), each one
 * preceded by a hanging-marks pass over the whole prose, and `spreadCrowdedRuby`
 * measuring every `<ruby>` in the panel at the end. Of the order of ten forced
 * layouts per frame, for sixteen frames, on top of whatever the browser is
 * doing to interpolate the tracks. That is what "choppy" is made of, and no
 * easing curve reaches it.
 *
 * app.css predicted this in writing where the transitions are declared — "if
 * the sidebars turn out to stutter in a browser, that hook is the fix, and it
 * is a flag on `observePanelFit` and nothing else" — and this is that flag.
 * They were right about the shape of it and right about the reason it was
 * left: the hook has to be *asked for* by whoever owns the gesture, which is
 * `main.ts`'s `toggleRail`.
 *
 * **What is given up by deferring is nothing**, which is worth stating because
 * it is what makes the deferral safe rather than merely cheap. Every quantity
 * this fit reasons from is a length measured *down a column*: the ceiling is
 * the panel's height over the advance, the target is the kundoku passage's
 * extent, and an extent is `columns x pitch` where the column count is a
 * function of the column's own length and the text. A sidebar changes the
 * panel's **width**, which decides only how much of the passage is on screen —
 * `measuredExtents`' own note says so — so the search re-derives the identical
 * split every frame and writes it back every frame. One fit at the end is not
 * an approximation of sixteen; it is the same answer, arrived at once.
 *
 * The one fit at the end is kept even so, and not skipped as provably
 * redundant: a window dragged *during* a gesture does change the height, the
 * observer's firings are indistinguishable from one another from in here, and
 * a single fit is a great deal cheaper than being wrong about that.
 *
 * Suspension is a session-wide flag rather than a per-panel one because a
 * gesture is: there is one `.main`, one set of rails, and one thing moving at
 * a time. */
let fitSuspended = false;
/** Whether a resize arrived while the fit was suspended, and so whether
 * resuming owes the page a fit. */
let fitDeferred = false;

/** Stops the fit for the length of a gesture — see the note above. Idempotent,
 * because the rails share one timer and a second click during a first one
 * keeps the licence rather than opening a second gesture. */
export function suspendPanelFit(): void {
  fitSuspended = true;
}

/** Lets it run again, and pays whatever the gesture deferred: one fit, on the
 * geometry the page has actually settled at. Nothing is owed where nothing
 * resized — the prose panel's own rail changes `.main`'s *rows* and not its
 * box, so it fires the observer not at all and resuming after one is free. */
export function resumePanelFit(): void {
  fitSuspended = false;
  if (!fitDeferred) return;
  fitDeferred = false;
  for (const container of watched) refitPanel(container);
}

/** The observer's whole callback, named so that `resumePanelFit` can run the
 * same thing the gesture stopped it running. */
function refitPanel(container: HTMLElement): void {
  const column = container.querySelector<HTMLElement>(":scope > .text-kakikudashi");
  if (!column) return;
  fitPassageExtent(container, column);
  spreadCrowdedRuby(column);
}

/** ── The other half of not re-measuring while the page moves ──────────────
 *
 * The fit above is what a gesture must not *run*. This is what a gesture must
 * not *let happen*: the text re-breaking as the boxes sweep between two sizes.
 *
 * A rail on the row axis is a transition on `.main`'s rows, so the two panels'
 * boxes travel continuously between their two heights — and text does not
 * travel, it re-breaks, at every height the sweep passes through that changes
 * how many characters a column holds. app.css counts them for the kundoku
 * panel at a 900px window: the row crosses 595, 683, 771 and 859px, so the
 * whole passage is set again four times over one 260ms gesture and four more
 * coming back. The prose panel is worse where the fit has left it on its whole
 * share, having no quantum to shelter behind — its column length changes on
 * every frame.
 *
 * Given a height outright, neither does. The boxes move, `.main-panel`'s
 * `overflow: hidden` shows less of the text as they do, and each passage
 * stands exactly as it was set until the movement stops. It is app.css's own
 * device for a sidebar — "given its open width outright and anchored to the
 * edge the column is shrinking *away from*, the same track change moves it
 * instead" — applied to the other axis, and it is the fix that file names in
 * advance for this exact symptom.
 *
 * **The held height is always a legal one.** The kundoku column may hold only
 * whole characters, and what is held is the height CSS has already rounded
 * down to a whole number of them; every height between the two ends of the
 * sweep is a fraction of a character, which is not a state that panel can
 * hold. So the text is never asked to occupy one — it keeps the quantum it has
 * and takes the new one in a single step at the end.
 *
 * Here rather than in `main.ts`, which owns the rails, because what is being
 * held is *the fit's own property*: `setColumnSlots` a few hundred lines up
 * writes this same inline height, and a hold that recorded the pin instead of
 * the declaration would quietly destroy the fine half of the fit's answer the
 * first time a reader shut the prose panel. The two live together so that
 * cannot drift apart. */
interface HeldMeasure {
  box: HTMLElement;
  /** What the element declared before the hold — `""` where it declared
   * nothing, which is the ordinary state of the kundoku panel (its height is
   * `round(down, 100%, --kanji-advance)` in tategaki.css) and never that of a
   * fitted prose panel. */
  declared: string;
}

let heldMeasures: HeldMeasure[] | null = null;

/** Pins each box at the height it is currently set to, recording what it
 * declared before.
 *
 * Every height is read before any is written. Neither write can move the other
 * box — they are separate rows of a grid whose own size is fixed — but a read
 * after a write in one pass is the shape of a forced layout, and this file
 * does not write that shape.
 *
 * A second call while a hold is standing keeps the first, which is what a
 * second rail click during a running gesture needs: the rails share one timer
 * and one licence, so there is one gesture, and recording the pin over the
 * declaration it replaced would lose the declaration for good. */
export function holdPanelMeasures(boxes: readonly HTMLElement[]): void {
  if (heldMeasures) return;
  const held = boxes.map((box) => ({
    box,
    declared: box.style.height,
    used: box.getBoundingClientRect().height,
  }));
  for (const { box, used } of held) box.style.height = `${used}px`;
  heldMeasures = held.map(({ box, declared }) => ({ box, declared }));
}

/** Puts back exactly what the hold found, and so lets each passage take its
 * new measure — once, now that the boxes have stopped.
 *
 * The declaration and not a re-fit, which is the whole of what this owes. The
 * prose panel's inline height *is* the fit's answer for this text at this
 * window, and a rail changes neither: it moves the division between the
 * panels, which `#app.kakikudashi-collapsed .main` overrides outright while
 * the panel is shut and tategaki.css's split restores when it opens. Where
 * something else did change under the gesture — a window dragged during it —
 * the observer saw it and `resumePanelFit` answers for it. */
export function releasePanelMeasures(): void {
  if (!heldMeasures) return;
  for (const { box, declared } of heldMeasures) {
    if (declared) box.style.height = declared;
    else box.style.removeProperty("height");
  }
  heldMeasures = null;
}

/** Re-fits the tracking and re-reads the crowding when the panel changes size,
 * which is the only thing that can invalidate either.
 *
 * A fitted tracking is a function of the panel's height, so it goes stale the
 * moment the window is dragged. The second half is a smaller matter than it
 * was: where the old placement *baked* the advance into an inline `top` on
 * every share — so that a resize left every compound's second character wearing
 * its first character's kana until this ran again — a mono-ruby share is
 * centred on its own character by the stylesheet, and comes out right on a
 * resize whether or not any script sees it. What `spreadCrowdedRuby` has to
 * redo is only which characters are *side by side*: a re-wrapped column puts
 * different neighbours next to each other, and a share moved off centre for a
 * neighbour it no longer has should be put back on it.
 *
 * A `ResizeObserver` and not a `window` resize listener: the panel's share of
 * the layout changes when the sidebar is collapsed or the kakikudashi panel
 * is opened, and neither of those resizes the window. Its callback runs
 * before paint, so the re-fitted column is the first one drawn rather than a
 * frame behind.
 *
 * **`.main` is what is watched, and no longer the `.tategaki` inside it.** The
 * two used to be the same box to a pixel and the inner one was the natural
 * thing to observe; `fitPassageExtent` now writes a height onto that box *and*
 * moves the division between the two panels, so an observer of either would be
 * feeding itself — several times over, on the search's own trial writes. The
 * grid cannot be fed: `.main` is a row of `#app`'s own `100vh` grid, and how
 * its height is divided between the panels inside it is not something its own
 * box hears about. Everything this callback needs still arrives through it:
 * the window resizing, and the sidebars collapsing, are exactly the two things
 * that change it.
 *
 * What no longer arrives is the kakikudashi panel being collapsed and opened
 * again, which changes the rows and not the grid — and that is right rather
 * than merely tolerable. The collapsed rule (app.css) overrides the split
 * entirely, so there is nothing to re-derive while it is shut; and the
 * viewport has not moved, so what was chosen for this text at this window is
 * still what it should open at.
 *
 * Re-fitting the *whole* match and not merely the tracking, because a resize
 * is exactly what can move the count of characters in a kundoku column, and so
 * how far the passage this one is matching runs. Which is also why the match
 * is not computed once from the text: it is a relation between two panels, and
 * their shared height is a function of the window.
 *
 * **Exported only so that `tests/panelFitGesture.test.ts` can drive the gate
 * below with a stand-in `ResizeObserver`.** `renderKakikudashiView` is the one
 * caller that belongs; there is nothing here for another module to want. */
export function observePanelFit(container: HTMLElement): void {
  if (watched.has(container) || typeof ResizeObserver !== "function") return;
  watched.add(container);
  new ResizeObserver(() => {
    // Deferred rather than dropped: the gesture that suspended this will
    // resume it, and whatever changed while it was suspended is answered then,
    // once, on the settled geometry. See the note at `fitSuspended`.
    if (fitSuspended) {
      fitDeferred = true;
      return;
    }
    refitPanel(container);
  }).observe(container.closest(".main") ?? container.parentElement ?? container);
}

/** Empties this panel and takes back everything the fit wrote for the text
 * that was in it — for a document closed, and for a tree that comes back with
 * no sentences in it. `main.ts` calls it wherever it puts `#app` into
 * `kakikudashi-empty`.
 *
 * Not `container.innerHTML = ""`, which is what this replaces, because the
 * fit does not confine itself to the column it is fitting. It writes an
 * inline height and a fitted `--tracking-kakikudashi` onto the container, and
 * — the two panels sharing one height, so that the coarse half of the match
 * is the *division* between them rather than a length of either —
 * a `--kundoku-extra-slots` onto the `.main` grid above. All three describe a
 * passage that is no longer here, and the one on the grid is the one that
 * would still be doing something: lengthening the kundoku column by whole
 * characters on account of prose that has been closed.
 *
 * The split is *removed* here rather than preserved, which is the opposite of
 * what `fitPassageExtent` does when it finds nothing measurable — and the two
 * cases are genuinely different. A collapsed panel still holds the text it was
 * fitted to and will be opened back onto it, so the division chosen for that
 * text is still the right one. A cleared panel holds nothing, and there is no
 * text for a division to be right for; the next one to arrive gets its own
 * from `fitPassageExtent`, off a fresh measurement, and should not begin from
 * a stale one.
 *
 * The cached extents go too, for the same reason `renderKakikudashiView`
 * clears them: they are the numbers of one passage and of no other.
 *
 * The `ResizeObserver` is deliberately left installed (see `observePanelFit`
 * — it is keyed on the container, which outlives every render). Its callback
 * looks for the column first and finds none while this state holds, so a
 * window dragged over an empty panel re-fits nothing and cannot write a split
 * back onto the grid. Reasoned from the code rather than observed. */
export function clearKakikudashiView(container: HTMLElement): void {
  container.replaceChildren();
  measuredExtents.delete(container);
  container.style.removeProperty("height");
  container.style.removeProperty("--tracking-kakikudashi");
  const main = container.closest<HTMLElement>(".main");
  if (main) setKundokuSteps(main, 0);
}

/** Spans (see `findCompoundSpans`) change reading order
 * (`computeReadingOrder`'s `spans` param) — must be the exact same detection
 * the kundoku panel uses, or the two panels could silently diverge on word
 * order.
 *
 * **Which now means the same *inputs*, not merely the same call.** The
 * detection was once driven by the parse alone, so passing a sentence was
 * enough to guarantee both panels one answer. It no longer is: the
 * lexical-word branch asks the reading layer whether a pair is one word
 * (`oneLexicalWordPair` — 大破敵軍 is 敵軍を大破す because of it, and 門人 is
 * 門人 rather than 門の人), and that question cannot be put without KANJIDIC2
 * and JMdict. A panel passing them where the other did not would fuse 大破 in
 * one column and split it in the next — the exact divergence this note has
 * always been about — so both indices go to both call sites here, as they do
 * in `KundokuView.ts`. */
export function renderKakikudashiView(
  container: HTMLElement,
  tree: TokenTree,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): void {
  container.replaceChildren();
  // A new text, so every column length this panel was ever set to has to be
  // measured again — the map is of *this* passage's extents (see
  // `measuredExtents`). Cleared before the search rather than after, so that a
  // render that throws cannot leave the next one reading another text's
  // numbers.
  measuredExtents.delete(container);
  const column = document.createElement("div");
  column.className = "tategaki-column text-kakikudashi";
  const indices: RubyIndices = { jmdict, kanjidic, historicalKana };
  // One ledger for the whole tree, not one per sentence: "the first occurrence"
  // means the first in the text a reader is reading, and 黃帝 named again three
  // sentences later is not a first mention.
  const ledger = createRubyLedger();
  // One pass over the whole tree, not one call per sentence: a quotation's
  // closing と is written *outside* the bracket that shuts it, and the parser
  // usually leaves that bracket in the **next** sentence — 子曰：「…。」 is cut
  // at the 。, stranding the 」 as a sentence of its own. So which sentence a
  // trailing と belongs to is a question only the whole tree can answer, and
  // asking it per sentence is what left the と inside the bracket here while
  // `KundokuView.ts` already wrote it outside. See
  // `generateKakikudashiPiecesForTree`.
  const piecesBySentence = generateKakikudashiPiecesForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );
  // One `.sentence-gap` span per sentence (mirroring KundokuView.ts's own
  // structure) rather than one flat text blob for the whole tree — plain
  // text carries no sentence-boundary information at all, which
  // `scrollSync.ts` needs to align this panel with the kundoku panel by
  // corresponding sentence rather than raw scroll offset.
  tree.sentences.forEach((sentence, i) => {
    const wrapper = document.createElement("span");
    wrapper.className = "sentence-gap";

    // One span per piece, tagged with the token it came from, so the
    // kundoku panel can highlight what a character became here (see
    // `highlightKakikudashi` in tokenInspector.ts). Built from the pieces
    // rather than by splitting the finished string: the string has no
    // record of which token produced which run of it, and a token's
    // contribution is not always contiguous with its neighbours' in the
    // source order.
    const pieces = piecesBySentence[i];
    const ruby = glossesFor(pieces, sentence, resolve, indices, ledger);
    /** `from` is where `text` starts inside the piece's own text — 0 for a
     * whole piece, and the base's length for the tail a glossed word lifts out
     * past its annotated characters. It exists only so that a marked
     * connective (see `Piece.renyouTe`) can be found in a slice as well as in
     * the whole.
     *
     * `readings` is one kana run per character of `text`, and is given only
     * for a glossed word's base. */
    const tokenSpan = (piece: Piece, text: string, from = 0, readings?: readonly string[]): HTMLElement => {
      const span = document.createElement("span");
      span.className = "kaki-token";
      span.dataset.tokenId = String(piece.tokenId);
      span.dataset.sentence = String(i);
      if (readings) {
        // **One `<ruby>` per character**, each holding that character and the
        // kana of that character and nothing else. It is the markup the thing
        // actually is — 長山 is 長 read ちやう and 山 read さん, not a pair of
        // characters with a pair of runs beside them — and it is what makes
        // the annotation *mono-ruby by construction*: the `<rt>` is positioned
        // against its own character's box, so the stylesheet can centre it on
        // that character without knowing anything about the word.
        //
        // A gloss's base is kanji and nothing else (see `WordRuby`), so no
        // connective, no okurigana and no particle can be in this text — those
        // are in the tail, which is written by the branch below.
        span.append(
          ...[...text].map((character, at) => {
            const gloss = document.createElement("ruby");
            gloss.append(character);
            const share = document.createElement("rt");
            // Coalesced rather than skipped: a missing entry must still cost a
            // share, or every later character's kana would sit over the wrong
            // character. `glossReason` refuses a word whose reading it could
            // not resolve, so this never fires.
            share.textContent = readings[at] ?? "";
            gloss.append(share);
            return gloss;
          }),
        );
        return span;
      }
      // The 連用形-て switch's connective in a wrapper of its own, so that
      // `animateKakikudashiReflow` below has something to fade. Every other
      // piece — which is every piece at all while the switch is off — is one
      // plain text node exactly as it always was.
      //
      // The bounds test is not a formality: the connective lands after a
      // word's okurigana, and a glossed word is written in two spans divided
      // at the end of its kanji, so the connective is in the *tail* and not in
      // the base. Whichever slice does not hold it writes itself whole.
      const te = piece.renyouTe;
      const at = te ? te.at - from : -1;
      if (te && at >= 0 && at + te.text.length <= text.length) {
        const connective = document.createElement("span");
        connective.className = "renyou-te";
        connective.textContent = te.text;
        // Guarded, because `append("")` is an empty text node and not nothing
        // — the settled DOM has to be the one a plain redraw builds, down to
        // the nodes.
        if (at > 0) span.append(text.slice(0, at));
        span.append(connective);
        const after = text.slice(at + te.text.length);
        if (after) span.append(after);
        return span;
      }
      span.textContent = text;
      return span;
    };
    /** Pieces already written as part of a glossed word. */
    const consumed = new Set<number>();
    pieces.forEach((piece, pieceIndex) => {
      if (consumed.has(pieceIndex)) return;
      if (piece.kind === "layout") {
        // The source's own line structure, carried as a newline followed by
        // its indent cells — a column break here, as in the kundoku panel.
        wrapper.append(document.createElement("br"));
        const indent = piece.text.slice(1);
        if (indent) wrapper.append(indent);
        return;
      }
      const written = (p: Piece): string => p.text + (p.caseParticle ?? "");
      const gloss = ruby.get(pieceIndex);
      if (gloss === undefined) {
        wrapper.append(tokenSpan(piece, written(piece)));
        return;
      }
      // **A glossed word is no longer a box.** It used to be one `<ruby>` with
      // the whole word's `.kaki-token` spans inside it and every share hung off
      // *its* edge, which made the word an inline block: atomic, unable to
      // break across a column, and so moved bodily to the next column whenever
      // it did not fit in what was left of this one. That left thirteen of the
      // sixty-seven columns of 酒蟲 short of the ten characters the fit had
      // just bought them; ten of them still are, and none of those ten is
      // short on account of a gloss any more — the column-by-column census of
      // this panel is now character-for-character identical to the census of
      // the same prose with every `<ruby>` unwrapped into plain text.
      //
      // What made the box necessary was 熟語ルビ, which measured a run against
      // the whole word and so needed the whole word to be one box to measure
      // against. Mono-ruby (see `spreadRubyShares`) anchors each share to
      // its own character instead, and the word stops being the unit that owns
      // the space — so the box can go, and the members below are written
      // straight into the line as the spans they are. A word may now break
      // wherever the line breaks, which for a run of kanji is anywhere at all;
      // what may *not* start a column is unchanged, since 禁則 is a rule about
      // the characters at the break and every character inside a gloss is a
      // kanji.
      //
      // Each member still keeps its own `.kaki-token` span and its own id for
      // the click-through highlight (see `highlightKakikudashi`). Kana already
      // on the page — a conjugated ending, a case particle — goes into a
      // further span of the same token's, so that it stays outside the
      // annotated characters while remaining part of what that token owns; the
      // highlight marks every span of an id, and one token owning several is
      // the ordinary case there already.
      const parts: HTMLElement[] = [];
      /** How many of the word's shares its earlier members have used up. */
      let taken = 0;
      for (let member = 0; member < gloss.pieceIndexes.length; member++) {
        const index = gloss.pieceIndexes[member];
        consumed.add(index);
        const memberPiece = pieces[index];
        const text = written(memberPiece);
        // Only the *last* member's kana can be lifted out of the base — a tail
        // in the middle of a word has the rest of the word after it and cannot
        // be moved out of it without reordering the text. No member but the
        // last one carries any today (a span's members are bare kanji, and an
        // on'yomi pair's modifier is `endingComplete`), so this is the safe
        // reading of a case that does not arise rather than a live branch.
        const baseLength = member === gloss.pieceIndexes.length - 1 ? gloss.baseLengths[member] : text.length;
        const base = [...text.slice(0, baseLength)];
        parts.push(tokenSpan(memberPiece, base.join(""), 0, gloss.readings.slice(taken, taken + base.length)));
        taken += base.length;
        if (text.length > baseLength) parts.push(tokenSpan(memberPiece, text.slice(baseLength), baseLength));
      }
      wrapper.append(...parts);
    });

    wrapper.append(sentenceSeparator(tree.sentences, i));
    column.append(wrapper);
  });
  // 行末禁則, before anything measures this column. An opening bracket may not
  // stand at a column's foot, and in this panel that has to be said to the DOM
  // rather than predicted — see `glueOpeningBracketsForward`, which says why
  // and what a disagreement with `planHangingMarks` would cost. On the
  // detached column: the pass reads the tree and nothing of the layout, so
  // there is no reason to make the browser lay the panel out twice.
  glueOpeningBracketsForward(column);
  container.append(column);
  // The tracking first, then the annotations, then the watch. The order is
  // load-bearing at the first step and only tidy at the last:
  // `spreadCrowdedRuby` measures which characters ended up side by side and
  // reads the advance off the column's computed `letter-spacing`, so it has to
  // run after the fit has published one — against the tracking the panel is
  // merely drawn at it would be answering about a layout the reader is not
  // looking at.
  //
  // Both after the column is in the document, so the boxes it measures and the
  // computed styles it reads are the ones the page is actually set in.
  //
  // The first step is now the whole of the fit and not only the tracking: the
  // column's *length* is chosen first — the length that runs this passage as
  // far across the page as the kundoku passage above it — and the tracking is
  // fitted to it inside `setColumnSlots`, at every candidate the search tries
  // and again at the one it settles on. So the tracking a share is spread
  // against below is still the tracking of the layout on screen.
  fitPassageExtent(container, column);
  spreadCrowdedRuby(column);
  observePanelFit(container);
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

/** How long this panel takes to settle — `KundokuView.ts`'s `REFLOW_MS`,
 * which is private to that module and is not worth an export edge for one
 * number. The two are the same interval on purpose: one flip of a switch is
 * one event, and a panel that answered over a different span from the one
 * beside it would read as two things happening.
 *
 * Named for the fade because a fade was once all this panel did. It now times
 * the walk below as well, and `kunten.css`'s visibility transition states the
 * same 260 for the same reason — three places, one gesture, one speed. (The
 * note at `REFLOW_MS` in KundokuView.ts still describes this constant as
 * timing only a connective; that is the one cross-reference this change
 * leaves a little behind, and it is a comment in a file this work does not
 * own.) */
const FADE_MS = 260;

/** Every connective the switch has written, keyed to survive a redraw.
 *
 * The same key `keyedCells` uses in `KundokuView.ts` and for its reason: this
 * panel is rebuilt wholesale from the tree, so no node the first call returns
 * is still in the document when the second runs, and the two sets can only be
 * compared by something the redraw carries across. The sentence, the token and
 * which of that token's connectives it is — a token owns at most one today
 * (a word carrying its own ending `continue`s past the branch that would
 * synthesize a second), but counting costs nothing and a walk over the page is
 * not entitled to assume it. */
function writtenConnectives(): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>("#kakikudashi-view .sentence-gap").forEach((sentence, index) => {
    const seen = new Map<string, number>();
    for (const connective of sentence.querySelectorAll<HTMLElement>(".renyou-te")) {
      const id = connective.parentElement?.dataset.tokenId ?? "-";
      const nth = (seen.get(id) ?? -1) + 1;
      seen.set(id, nth);
      found.set(`${index}:${id}:${nth}`, connective);
    }
  });
  return found;
}

/** Every `.kaki-token` span in the prose panel, under the same key
 * `writtenConnectives` above uses and for the same reason: this panel is
 * rebuilt wholesale from the tree, so the two sides of a redraw share no
 * nodes and can only be paired off by something the redraw carries across.
 *
 * The sentence, the token, and which span of that token it is. A token owns
 * more than one span often enough that the count is not a formality: a
 * glossed word is written as a base inside the `<ruby>` and a tail after it
 * (see `tokenSpan`'s callers), and both carry the same id.
 *
 * Collected per `.sentence-gap` and by `querySelectorAll` under it, so the
 * count walks document order whatever the nesting — a span inside a `<ruby>`
 * is not a sibling of the ones around it, so siblings are not the sequence. */
function keyedKakiTokens(): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>("#kakikudashi-view .sentence-gap").forEach((sentence, index) => {
    const seen = new Map<string, number>();
    for (const span of sentence.querySelectorAll<HTMLElement>(".kaki-token")) {
      const id = span.dataset.tokenId ?? "-";
      const nth = (seen.get(id) ?? -1) + 1;
      seen.set(id, nth);
      found.set(`${index}:${id}:${nth}`, span);
    }
  });
  return found;
}

/** Where one span begins on the screen, and whether it is in one piece.
 *
 * The *first* client rect and not the bounding box, because a `.kaki-token`
 * is an inline span and an inline span that wraps has one rect per fragment —
 * a bounding box over two fragments in two columns is a rectangle the span
 * does not occupy, and its `left` is neither column. What is wanted is where
 * the span *starts*, which is what a reader would call its position and what
 * the column test below is asking about.
 *
 * `fragments` is kept because a span in two pieces cannot be walked: a
 * relative offset moves every fragment of an inline box together, so pulling
 * the first one down its column drags the second one down the next column,
 * where nothing moved. Those are sent to the fade instead. */
export interface TokenBox {
  left: number;
  top: number;
  /** How many line fragments the span was broken into — 1 for almost every
   * span in the panel, since a piece is one to five characters. */
  fragments: number;
}

/** What one span is asked to do across a redraw. `walk` carries the FLIP
 * displacement: where the span *was*, relative to where it now is. */
export type ReflowStep =
  | { key: string; kind: "walk"; dx: number; dy: number }
  | { key: string; kind: "fade" };

/** Below this is not a movement a reader can see, and something that did not
 * move must not stir while the things that did are travelling. The same half
 * pixel `animateAnnotationShift` uses, and here it does double duty: at a
 * column pitch of 44px (`--column-pitch-kakikudashi`), a horizontal
 * difference is either under half a pixel or a whole column. */
const STILL_PX = 0.5;

/** **The classifier.** Whether a span that has moved got there by being
 * pushed along the flow, or by being re-wrapped onto a different column.
 *
 * This panel is running prose set `vertical-rl`, and the two are not the same
 * event. Text inserted above a word pushes it further down its column, and
 * that is genuine travel: the word was at one place in the line and is now at
 * another, and a reader watching it slide sees what actually happened. A word
 * that was at the foot of one column and is now at the head of the next did
 * not travel; the line ran out and it was set again somewhere else. Flying it
 * diagonally across the panel would animate a path the layout never took.
 *
 * A column is a fixed vertical band under `vertical-rl`, so "same column" is
 * simply "same `left`" — the panel is measured either side of one redraw with
 * the scroll put back where it was (see `main.ts`'s capture), so a column that
 * did not gain or lose a predecessor is at the same screen x both times.
 *
 * **The literal alternative is this function returning `true`.** Say
 * `return true` here and every span that moved is walked, re-wrapped ones
 * included, which is the naive FLIP: on 酒蟲's 連用形-て flip that is ~330
 * spans travelling at once, about half of them diagonally across a column
 * boundary. Nothing else has to change for it — `planKakikudashiReflow`
 * already carries the displacement for every span that moved, and the walk
 * below already knows how to play it. */
function pushedAlongTheFlow(was: TokenBox, now: TokenBox): boolean {
  if (was.fragments !== 1 || now.fragments !== 1) return false;
  return Math.abs(was.left - now.left) < STILL_PX;
}

/** The whole decision, as data: which spans walk, which fade, and which are
 * left alone. Kept apart from the DOM so that the rule can be tested without
 * a layout engine — this is a pure function of two sets of rectangles, and
 * `tests/kakikudashiReflow.test.ts` exercises it directly.
 *
 * Keyed on the *new* page: a span that was there and is gone has nothing to
 * animate (its node went with the redraw, and holding a copy of it in the
 * finished page is what `animateAnnotationShift` refuses for the same reason
 * — every other reader of this DOM would then have to be told to ignore
 * prose the tree does not have). A key on one side only is skipped, exactly
 * as `keyedCells`' is, which is what makes this safe for a redraw that adds
 * or drops a word. */
export function planKakikudashiReflow(
  before: ReadonlyMap<string, TokenBox>,
  after: ReadonlyMap<string, TokenBox>,
): ReflowStep[] {
  const steps: ReflowStep[] = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    // A span the redraw wrote for the first time has no position to have come
    // from, so the most that can be said of it is that it belongs here now.
    if (!was) {
      steps.push({ key, kind: "fade" });
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < STILL_PX && Math.abs(dy) < STILL_PX) continue;
    steps.push(pushedAlongTheFlow(was, now) ? { key, kind: "walk", dx, dy } : { key, kind: "fade" });
  }
  return steps;
}

/** Runs `apply` — any redraw of the prose panel from a tree the reader
 * already has open — and **settles the panel over one interval instead of
 * cutting to the new page.**
 *
 * Three things happen, all of them over `FADE_MS` and all of them started in
 * this one task so that they share a start time:
 *
 *  - **A word the new text pushed further along its column walks there.**
 *    This is a keyed FLIP, the same device `animateAnnotationShift` uses on
 *    the 訓読文, and the key is the same shape for the same reason (see
 *    `keyedKakiTokens`).
 *
 *  - **A word that was re-wrapped onto a different column fades in where it
 *    now is.** See `pushedAlongTheFlow`, which is the whole of that
 *    distinction and is one function so that the literal alternative — fly
 *    everything — is one line. A glossed word's kana travel with it either
 *    way, being inside its characters rather than beside them.
 *
 *  - **A connective the 連用形-て switch has just written inks in.** This was
 *    once the only thing this panel animated, under `animateRenyouTeArrival`,
 *    and it is folded in here rather than left beside it: the two used to be
 *    nested (the sidebar wrapped one inside the other), and with the walk
 *    added that would mean two measurement passes and two starts for one
 *    event. Its behaviour is unchanged — the same `.renyou-te` keys, compared
 *    the same way, faded the same distance over the same interval.
 *
 * **Why the panel gets a walk at all now, having deliberately not had one.**
 * The argument against it was never that prose should not move; it was that a
 * naive FLIP describes a movement that did not happen. On 酒蟲 the 連用形-て
 * switch inserts 29 characters, and every one of the 340 spans after the first
 * insertion shifts along the text — 331 of them, by 1 to 29 characters
 * (harness figures, from the app's own pipeline). Flying all 331 to their new
 * places says *the page rearranged itself*; leaving all 331 to cut says
 * nothing at all. Splitting them says the true thing: the ones still in their
 * own column were pushed along it and are shown being pushed, and the ones
 * that ran off the end of a column were re-set and are shown arriving.
 *
 * **On capping the travel at the first column break after each insertion.**
 * Considered and declined, because the classifier already caps it, and caps it
 * exactly: a span can only be walked while it is still in the column it was
 * in, so no walk can be longer than a column. What that comes to in practice,
 * on the same harness figures and a fixed-pitch estimate of the wrapping
 * (24–40 characters to a column): the median walk is 3 to 5 characters, or
 * 76–127px, and the walks are roughly half of the spans that move. The tail
 * reaches a full column — a span that happened to sit near the head of its
 * column can be pushed most of the way down it and still be in it — and that
 * is the only case a numeric cap would bite on. It is left alone because it is
 * *true*: that word really was pushed that far down that column, the words
 * that had been above it in it having gone to the previous one. A cap there
 * would replace a long movement that happened with a fade that says nothing.
 *
 * **Nothing here survives the animation.** No element exists for it — the
 * connective's own `<span>` is written by `renderKakikudashiView` whether or
 * not anything is animating — and every animation is a Web Animation with the
 * default `fill: none`, which writes no inline style and is out of
 * `document.getAnimations()` the moment it finishes. `.kaki-token`'s
 * `position: relative` (kunten.css) is a standing rule and not scaffolding:
 * with `top`/`left` at `auto` it moves nothing, and it is there because a
 * relative offset is the only way to walk an *inline* box — a transform does
 * not apply to one, which is what makes this walk different in kind from the
 * kundoku panel's, where a `.kanji-cell` is an inline block.
 *
 * Shaped as `apply => void` to match `animateAnnotationShift`, which the
 * 連用形-て path nests this inside: both panels are redrawn by one call, and
 * each of these takes its own before-reading around it. */
export function animateKakikudashiReflow(apply: () => void): void {
  const wasBoxes = new Map<string, TokenBox>();
  for (const [key, span] of keyedKakiTokens()) {
    const box = boxOf(span);
    if (box) wasBoxes.set(key, box);
  }
  const wasConnectives = new Set(writtenConnectives().keys());

  apply();

  // The same two stand-downs `animateAnnotationShift` makes, and the same
  // final state either way: the new page is already in the document, settled
  // and at full ink, and declining to animate is declining to walk *up* to
  // where it has been put.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (typeof Element.prototype.animate !== "function") return; // no Web Animations (jsdom)
  // Nothing to have come from: the panel was empty, or every span in it was
  // clipped out of existence. A redraw onto an empty panel is a new text
  // arriving rather than one changing, and `main.ts` keeps those out of here
  // in any case — this is the belt to that braces.
  //
  // This is also the whole of what the `kakikudashi-empty` state needs from
  // here, which is why there is no test for that class beside the collapsed
  // one below: a panel hidden for want of text has no keyed spans in it, so
  // it stands down on this line, before the classes are consulted at all.
  if (wasBoxes.size === 0) return;
  // A collapsed panel is a grid row of zero height with `overflow: hidden`
  // over it (see `#app.kakikudashi-collapsed .main` in app.css): the spans
  // still have rectangles, in a column of no height that wraps every
  // character on its own, and animating any of it would be animating a page
  // nobody is looking at. The same test `buildPrintLayout` asks.
  if (document.querySelector("#app")?.classList.contains("kakikudashi-collapsed")) return;

  // Every measurement first, then every animation — `animateAnnotationShift`'s
  // arrangement and its reasons. The reads are all taken against one settled
  // layout, so no write can invalidate one that has not happened yet; and it
  // puts every animation in this one task, which is what gives them a common
  // start time. A walk and a fade a frame apart would read as two events, and
  // on this panel they are overwhelmingly *adjacent words*.
  const spans = keyedKakiTokens();
  const nowBoxes = new Map<string, TokenBox>();
  for (const [key, span] of spans) {
    const box = boxOf(span);
    if (box) nowBoxes.set(key, box);
  }
  const steps = planKakikudashiReflow(wasBoxes, nowBoxes);

  const timing: KeyframeAnimationOptions = { duration: FADE_MS, easing: "ease-out" };
  /** The spans that are fading in as a whole. A connective inside one of them
   * is already being faded by its own ancestor, and giving it a second fade
   * would multiply the two alphas — a connective coming in visibly behind the
   * word it is part of. */
  const fading = new Set<HTMLElement>();
  // One step, one span, and **the span is what moves**. It used to be that a
  // glossed word's members were moved by moving the `<ruby>` around them,
  // because the kana hung off that `<ruby>`'s own edge and walking a member
  // alone would have slid the characters out from under their annotation. The
  // kana are inside the characters now — one `<ruby>` per character, its
  // `<rt>` positioned against it (see `renderKakikudashiView`) — so a member
  // span carries its own glosses wherever it goes, and there is nothing left
  // to retarget. A compound whose halves were re-wrapped into two different
  // columns is now free to say so: the half that stayed walks and the half
  // that was re-set fades, which is what happened to it.
  for (const step of steps) {
    const span = spans.get(step.key);
    if (!span) continue;
    if (step.kind === "walk") {
      // `left`/`top` and not a transform: see the header. Both offsets in one
      // keyframe list, so the two axes cannot be played on two clocks — a
      // walk is one movement, and a word that is drifting between columns
      // while it slides down one is not what happened.
      span.animate(
        [
          { left: `${step.dx}px`, top: `${step.dy}px` },
          { left: "0px", top: "0px" },
        ],
        timing,
      );
    } else {
      fading.add(span);
      span.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    }
  }

  for (const [key, connective] of writtenConnectives()) {
    if (wasConnectives.has(key)) continue;
    const owner = connective.parentElement;
    if (owner && fading.has(owner)) continue;
    connective.animate([{ opacity: 0 }, { opacity: 1 }], timing);
  }
}

function boxOf(span: HTMLElement): TokenBox | null {
  const rects = span.getClientRects();
  if (rects.length === 0) return null;
  // `getClientRects` gives an inline box's fragments in content order, so the
  // first is where the span begins.
  return { left: rects[0].left, top: rects[0].top, fragments: rects.length };
}
