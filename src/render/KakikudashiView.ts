import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import type { JmdictIndex } from "../reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { compoundFurigana } from "../reading/compoundFurigana.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { generateKakikudashiPieces, sentenceSeparator, type Piece } from "../kakikudashi/generator.ts";
import { createRubyLedger, glossWords, rubyFor, type RubyIndices, type RubyLedger } from "../kakikudashi/rubyGloss.ts";
import { furiganaFor } from "./KundokuView.ts";

/** One glossed word's annotation, and which pieces it covers. */
interface WordRuby {
  /** The kana over the word, one entry per *character* of it — 黃帝 is
   * ["くわう", "てい"]. Kept split rather than joined because each character's
   * share is set over that character (see `jukugoRubyOffsets`). */
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
    if (chars.length === 1) return [furiganaFor(tokens[0], sentence, resolve, indices.historicalKana)];
    return compoundFurigana(chars, text, indices.jmdict, indices.kanjidic, indices.historicalKana, (i) => {
      // A span has one token per character and a fused multi-character token
      // has one token for all of them; either way the fallback needs the token
      // that character came from, with that character as its text.
      const owner = tokens.length === chars.length ? tokens[i] : tokens[0];
      return furiganaFor({ ...owner, text: chars[i] }, sentence, resolve, indices.historicalKana);
    });
  };

  for (const word of glossWords(pieces, sentence, findCompoundSpans(sentence), readingsOf, indices)) {
    if (!rubyFor(word, indices, ledger)) continue;
    // Keyed on the word's first piece; the render loop below reads the entry
    // there and consumes the rest of the word's pieces with it.
    ruby.set(word.pieceIndexes[0], {
      // Split per character, and placed per character — 熟語ルビ. The word is
      // still the unit that owns the space (see `jukugoRubyOffsets`), which is
      // what makes that possible in a panel this tight: 黃's くわう is 33px
      // against a 25.3px advance and does not fit over 黃 alone, but the pair
      // has 50.6px for the five kana of くわうてい and very nearly does.
      //
      // Group ruby — one run centred over the whole compound — was tried first
      // and is what this replaces. It fits by construction, and it reads
      // wrong: centring くわうてい over 黃帝 leaves neither character with its
      // own kana above it, and a reader cannot tell which half is which.
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

/** Where each character's kana start, measured down the column from the top of
 * the word — 熟語ルビ (jukugo ruby) placement.
 *
 * The convention exists for exactly the case this panel is in. Mono-ruby puts
 * each character's kana over that character, which is what a reader wants and
 * what makes a compound's halves tellable apart; group ruby sets one run over
 * the whole word, which always fits but leaves no kana above any particular
 * character. Jukugo ruby is the first with the second's tolerance: each
 * character's share sits over its own character *where it fits*, and where it
 * does not, the run borrows from the rest of the compound rather than
 * colliding with its neighbour or spilling out of the word.
 *
 * Borrowing is all the two clamping passes are. The forward pass places every
 * share centred on its own character's glyph and pushes it later where the
 * previous share has not finished; the backward pass pulls the whole run back
 * inside the word. Between them, 少典 (せう + てん, two kana each) lands
 * exactly over 少 and 典 with nothing moved at all, while 一壺's single-kana こ
 * stays centred over 壺 although いち fills 一 completely.
 *
 * Only where the compound as a whole cannot hold its reading do the shares go
 * contiguous from the word's start, which is the arrangement that keeps every
 * share as near its own character as the total length allows and puts the
 * whole of the shortfall past the word's end. That is bounded and small: 黃帝
 * (くわう + てい) is 55px of kana over 50.6px of word, so 4.4px — the same
 * overhang the group ruby it replaces already had, into the lane of a
 * following word that is by definition unglossed (see `rubyGloss.ts`: a
 * neighbour would have to earn its own gloss, which the density rule makes
 * rare, and two glossed words in succession is rarer still).
 *
 * `advance` is one character's full step down the column (its size plus the
 * panel's tracking) and `size` the glyph within it — the glyph sits at the
 * head of its step, so a share is centred on `size`, not on `advance`, or
 * every annotation would ride half a tracking-width low. */
export function jukugoRubyOffsets(runs: readonly number[], advance: number, size: number): number[] {
  const word = runs.length * advance;
  const starts: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const centred = i * advance + (size - runs[i]) / 2;
    starts[i] = i === 0 ? Math.max(centred, 0) : Math.max(centred, starts[i - 1] + runs[i - 1]);
  }
  starts[runs.length - 1] = Math.min(starts[runs.length - 1], word - runs[runs.length - 1]);
  for (let i = runs.length - 2; i >= 0; i--) starts[i] = Math.min(starts[i], starts[i + 1] - runs[i]);
  // A first share pushed above the word's own top is the word saying it cannot
  // hold the run at all — there is nothing left to borrow from.
  if (starts[0] < 0) {
    let at = 0;
    for (let i = 0; i < runs.length; i++) {
      starts[i] = at;
      at += runs[i];
    }
  }
  return starts;
}

/** Applies those offsets to every gloss in a rendered column.
 *
 * Done here, after the column is in the document, rather than in CSS: the
 * placement depends on how many kana each character's share holds, which is a
 * per-word quantity no stylesheet can see. The two lengths it needs are read
 * off the computed styles rather than off the boxes — `advance` from the
 * column's own font-size and tracking, one kana's length from the <rt>'s
 * font-size — so this does not depend on the annotations being visible, and
 * keeps working when the 振り仮名 switch has them hidden at the moment of the
 * render (a measured box would be zero there, and every share would stack at
 * the word's top the moment the switch came back on).
 *
 * That a kana's step equals the <rt>'s font-size, and a base character's its
 * own size plus the tracking, is a property of full-width CJK glyphs set
 * upright in a vertical run — the annotation carries `letter-spacing: normal`
 * precisely so that its own step is the plain one. Both confirmed by
 * measurement: 3 kana at 11px come to 33px, and 2 base characters to 50.6. */
function placeJukugoRuby(column: HTMLElement): void {
  const annotated = column.querySelectorAll("ruby");
  if (annotated.length === 0) return;
  const columnStyle = getComputedStyle(column);
  const size = parseFloat(columnStyle.fontSize);
  const tracking = parseFloat(columnStyle.letterSpacing); // "normal" parses to NaN
  const advance = size + (Number.isNaN(tracking) ? 0 : tracking);
  if (!Number.isFinite(advance) || advance <= 0) return;

  for (const word of annotated) {
    const shares = [...word.querySelectorAll<HTMLElement>(":scope > rt")];
    if (shares.length === 0) continue;
    const kana = parseFloat(getComputedStyle(shares[0]).fontSize);
    if (!Number.isFinite(kana) || kana <= 0) continue;
    const runs = shares.map((share) => [...(share.textContent ?? "")].length * kana);
    jukugoRubyOffsets(runs, advance, size).forEach((start, i) => {
      shares[i].style.top = `${start}px`;
    });
  }
}

/** Spans (see `findCompoundSpans`) change reading order
 * (`computeReadingOrder`'s `spans` param) — must be the exact same
 * tree-based detection the kundoku panel uses, or the two panels could
 * silently diverge on word order. */
export function renderKakikudashiView(
  container: HTMLElement,
  tree: TokenTree,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): void {
  container.replaceChildren();
  const column = document.createElement("div");
  column.className = "tategaki-column text-kakikudashi";
  const indices: RubyIndices = { jmdict, kanjidic, historicalKana };
  // One ledger for the whole tree, not one per sentence: "the first occurrence"
  // means the first in the text a reader is reading, and 黃帝 named again three
  // sentences later is not a first mention.
  const ledger = createRubyLedger();
  // One `.sentence-gap` span per sentence (mirroring KundokuView.ts's own
  // structure) rather than one flat text blob for the whole tree — plain
  // text carries no sentence-boundary information at all, which
  // `scrollSync.ts` needs to align this panel with the kundoku panel by
  // corresponding sentence rather than raw scroll offset.
  tree.sentences.forEach((sentence, i) => {
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    const wrapper = document.createElement("span");
    wrapper.className = "sentence-gap";

    // One span per piece, tagged with the token it came from, so the
    // kundoku panel can highlight what a character became here (see
    // `highlightKakikudashi` in tokenInspector.ts). Built from the pieces
    // rather than by splitting the finished string: the string has no
    // record of which token produced which run of it, and a token's
    // contribution is not always contiguous with its neighbours' in the
    // source order.
    const pieces = generateKakikudashiPieces(plan, resolve);
    const ruby = glossesFor(pieces, sentence, resolve, indices, ledger);
    const tokenSpan = (piece: Piece, text: string): HTMLElement => {
      const span = document.createElement("span");
      span.className = "kaki-token";
      span.dataset.tokenId = String(piece.tokenId);
      span.dataset.sentence = String(i);
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
      // A glossed word's <ruby> wraps the `.kaki-token` spans rather than
      // sitting inside one: a compound is several tokens under one annotation,
      // and every one of them still has to carry its own id for the
      // click-through highlight (see `highlightKakikudashi`). Kana already on
      // the page — a conjugated ending, a case particle — goes into a further
      // span of the same token's after the </ruby>, so that it stays outside
      // the base while remaining part of what that token owns; the highlight
      // marks every span of an id, and one token owning several is the
      // ordinary case there already.
      const rubyEl = document.createElement("ruby");
      const tail: HTMLElement[] = [];
      for (let member = 0; member < gloss.pieceIndexes.length; member++) {
        const index = gloss.pieceIndexes[member];
        consumed.add(index);
        const memberPiece = pieces[index];
        const text = written(memberPiece);
        // Only the *last* member's kana can be lifted out of the base — a tail
        // in the middle of a word has the rest of the word after it and cannot
        // be moved past the </ruby> without reordering the text. No member but
        // the last one carries any today (a span's members are bare kanji, and
        // an on'yomi pair's modifier is `endingComplete`), so this is the safe
        // reading of a case that does not arise rather than a live branch.
        const baseLength = member === gloss.pieceIndexes.length - 1 ? gloss.baseLengths[member] : text.length;
        rubyEl.append(tokenSpan(memberPiece, text.slice(0, baseLength)));
        if (text.length > baseLength) tail.push(tokenSpan(memberPiece, text.slice(baseLength)));
      }
      // One <rt> per character, all after the base, and all taken out of flow
      // by the stylesheet — so the browser's own pairing of bases to
      // annotations decides nothing here, and `placeJukugoRuby` below is free
      // to put each share where the compound wants it.
      for (const reading of gloss.readings) {
        const rt = document.createElement("rt");
        rt.textContent = reading;
        rubyEl.append(rt);
      }
      wrapper.append(rubyEl, ...tail);
    });

    wrapper.append(sentenceSeparator(tree.sentences, i));
    column.append(wrapper);
  });
  container.append(column);
  // After the column is in the document, so the computed styles the placement
  // reads are the ones the page is actually set in.
  placeJukugoRuby(column);
  // Reading starts at this (vertical-rl) panel's own *right* edge —
  // `scrollLeft = 0` is that start, not the browser's own idea of "start"
  // carried over from whatever position scroll-anchoring (or a previous
  // render's leftover scrollLeft on this same, reused container element)
  // last left it at. Without this, a fresh render can open already
  // scrolled partway through the text, cutting off content at *both*
  // edges instead of showing the beginning. Set after the new content is
  // in the DOM, since scrollWidth isn't known beforehand.
  container.scrollLeft = 0;
}
