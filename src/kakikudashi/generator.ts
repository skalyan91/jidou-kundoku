import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { compoundSuruOkurigana } from "../reading/readingResolver.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import { sentenceFinalParticleFor } from "./conjugationContext.ts";
import {
  auxiliaryFormFor,
  passiveComplement,
  passiveForm,
  caseParticleFor,
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  extraEndingFor,
  findRoot,
  isNamingUse,
  isNegationUse,
  isSentenceFinalParticleUse,
  negationEnding,
  negationEndingParts,
  nextMeaningfulToken,
  pickedEnding,
  quoteClosing,
  repeatsPredicateCopula,
  selectedForm,
  conjugationSubject,
  lexiconEntryFor,
  teOrShite,
  yuParts,
} from "./conjugationContext.ts";
import {
  adverbialRenyouTe,
  compoundSuruRenyouTe,
  pickedRenyouTe,
  renyouTeSuffix,
  synthesizedRenyouTe,
} from "./renyouTe.ts";
import { COMMAS, FULL_STOPS, isBracket, isOpeningBracket, isSentenceFinalPunct, medialPunctuation } from "../parse/punctuation.ts";
import { sourceLayoutOf } from "../parse/sourceLayout.ts";
import { isRereadUse, rereadCharacter, rereadGovernedForm } from "./rereadCharacters.ts";
import { chosenReadingParts } from "../reading/chosenReading.ts";

type PieceKind = "token" | "discourse" | "ending" | "negation" | "punct" | "layout" | "quote";

export interface Piece {
  kind: PieceKind;
  text: string;
  /** Appended after `text` at output time (see `caseParticleFor`). */
  caseParticle?: string;
  /** Where the 連用形-て switch's connective sits inside `text`, when it wrote
   * one — see `withRenyouTe`. Absent for every piece while the switch is off,
   * which is every piece in the app's default state. */
  renyouTe?: { at: number; text: string };
  /** The source token this came from, so a panel can tie the two together
   * — clicking a character in the kundoku panel highlights what it became
   * here. Several pieces can share one id (a word and its ending), and one
   * token can be answerable for a piece that is not itself (a negation is
   * emitted from the 不 that causes it). */
  tokenId: number;
}

/** Records, on a piece whose text ends in one, **where the 連用形-て switch's
 * connective is** — so that the one consumer who has to be able to point at it
 * can: the 書き下し文 panel fades the connective in when the switch writes it
 * (see `animateRenyouTeArrival` in `KakikudashiView.ts`), and a panel rebuilt
 * wholesale from the tree has no earlier node to have compared against.
 *
 * **The text is untouched.** The connective is part of the word — 飲みて is one
 * word and not 飲み plus a decoration — so it stays concatenated into `text`
 * exactly as it was before this field existed, and every other reader of a
 * piece (the flattened string in `generateKakikudashi`, the ruby gloss's word
 * building in `rubyGloss.ts`, the plain-text export, every test) goes on seeing
 * the same string it always saw. This is a note in the margin, not a division
 * of the word.
 *
 * **An offset and not a bare suffix**, although the connective is written last
 * at every one of the eight emission sites below. Nothing appends to a piece
 * after it is pushed today — `markQuoteEnd` writes its closing と as a piece
 * of its own — but the offset is what makes that a property of this file
 * rather than a thing to be remembered: "the last n characters" is only the
 * connective for as long as nobody writes anything after it, and the と was
 * exactly that for as long as it was appended.
 *
 * The empty string is not a connective, and is what all five of `renyouTe.ts`'s
 * functions return whenever the switch is off — so an unmarked piece is the
 * default state, and the field never appears in it at all. */
function withRenyouTe(piece: Piece, te: string): Piece {
  if (te === "") return piece;
  return { ...piece, renyouTe: { at: piece.text.length - te.length, text: te } };
}

/** The connective a negation piece carries, asked of the function that wrote
 * it — `negationEnding` is the only thing that can write one (see
 * `NEGATION_CONVERB` in `conjugationContext.ts`), and `negationEndingParts` is
 * that same answer with the ずして's して held apart from the ず. It is "" in
 * both directions whenever the switch is off. */
function negationRenyouTe(token: Token, plan: ReadingPlan): string {
  return negationEndingParts(token, plan).connective;
}

/** The closing of a quoted/reported-speech complement of a speech verb — see
 * `ReadingPlan.quoteEndIds` and `depClassification.ts`'s
 * `isSpeechQuoteComplement`. Called right before every `continue`/loop-end
 * below, since the quote can end on any kind of token.
 *
 * **A piece of its own**, tagged with the quote-end token's own id, and not
 * text appended onto that token's piece the way the kundoku panel's
 * `withQuoteEnd` hangs its ト off that token's okurigana. The two panels are
 * not doing the same thing with it. A ト in the 訓読文 is written beside a
 * character, and a bracket is a character of the source that carries no
 * okurigana at all, so there the ト has nowhere else to go. Running prose has
 * no characters, only a string, and there the と is the quotation's closing
 * rather than part of the last word inside it: real kanbun writes 「…」と, the
 * と *outside* the bracket that shuts the quote, which is what the reader
 * asked for and what appending made impossible — the bracket is emitted from
 * the source token after this one, so anything glued onto the word before it
 * lands inside. `closeQuotesOutsideBrackets` below is what moves it out, and
 * it can only move a piece.
 *
 * This is the same division `markRereadClose` just below already makes, for
 * the same reason: a reading that belongs to one token but is written
 * somewhere other than that token's own place in the text is a piece, so that
 * it can be moved and so that it still answers to the character it came from.
 *
 * What is written is `quoteClosing`'s and not a bare と: the quoted complement
 * of a verb of *asking* is a question, and closes 〜やと — 問：「需何藥？」 is
 * 「なにの藥を需ふや」と問ふ. That function is shared with `KundokuView.ts` so
 * the string this panel writes and the one that panel hangs off the same token
 * cannot come apart.
 *
 * **The two halves of 〜やと are two pieces**, and the split is exactly the one
 * the line above states: 「なにの藥を需ふや」と, with the や *inside* the
 * bracket and the と outside it. The や is the quoted question's own
 * sentence-final particle — part of what was asked — while the と is the
 * reporting frame's, and only the second is the quotation's closing. Written
 * as one piece the whole 〜やと moved out past the bracket together
 * (「なにの藥を需ふ」やと), which un-asks the question inside the quotation
 * marks. Split here rather than in `quoteClosing`, whose one string is what the
 * kundoku panel hangs off the token as okurigana — that panel writes ヤト
 * beside one character and has no bracket to divide them at. */
function markQuoteEnd(pieces: Piece[], tokenId: number, plan: ReadingPlan): void {
  if (pieces.length === 0) return;
  const closing = quoteClosing(tokenId, plan);
  if (!closing) return;
  // The quotative is the last character of whatever `quoteClosing` returned;
  // anything in front of it belongs to the quoted clause. Guarded rather than
  // assumed, so a closing that is nothing but the quotative still emits one
  // piece and not an empty one beside it.
  const inner = closing.slice(0, -1);
  if (inner) pieces.push({ kind: "discourse", text: inner, tokenId });
  pieces.push({ kind: "quote", text: closing.slice(-1), tokenId });
}

/** A bracket the source shut a quotation with, as this panel emits it.
 *
 * Read off the text and not off the piece kind, because the two hands of one
 * pair do not arrive as the same kind of piece. A 」 *inside* a sentence is a
 * `punct` dependent and comes out of the loop's `punct` branch below; a 」 left
 * after a full stop heads a sentence of its own and the parser tags it that
 * sentence's ROOT, so it comes out of the generic fallback at the end of the
 * loop as an ordinary `token`. The same 」 either way — see the `punct`
 * branch's own note, which is about the same split. */
function isClosingBracketPiece(piece: Piece): boolean {
  return isBracket(piece.text) && !isOpeningBracket(piece.text);
}

/** Moves each quotation's closing と *outside* the bracket that shuts the
 * quotation — 「…」と and not 「…と」, which is how kanbun is written and what
 * the reader asked for.
 *
 * `quoteEndIds` marks the last non-punctuation token of the quoted
 * complement's own reading-order subtree (see `reorderEngine.ts`'s own
 * `markQuoteEnd`, and why it must skip the punctuation: the 訓読文 panel hangs
 * its ト off that token as okurigana, and a bracket carries none). So the と is
 * emitted one piece too early by construction, and every closing bracket
 * standing between that token and the end of the quotation follows it.
 * Skipping the brackets here rather than marking the bracket in the plan is
 * what keeps the two panels' one shared `quoteEndIds` saying one thing.
 *
 * A run and not a single bracket: 「…『…』」 shuts two quotations at once, and
 * a と that stopped inside the outer one would only have moved the problem in
 * by a character.
 *
 * **What this cannot do is write the second と.** `quoteEndIds` is a `Set`, so
 * two quotations ending on the one token — 曰：「甲曰：『乙』」, where 乙 is the
 * last token of both — arrive as a single id and are written with a single と,
 * which this now carries out past both brackets instead of leaving it in the
 * middle. Writing both would mean counting the quotations that close on a
 * token rather than recording that any does, which is a change to
 * `ReadingPlan` and so to `KundokuView.ts`'s `withQuoteEnd` as well. */
function closeQuotesOutsideBrackets(pieces: Piece[]): Piece[] {
  if (!pieces.some((piece) => piece.kind === "quote")) return pieces;
  const moved: Piece[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].kind !== "quote") {
      moved.push(pieces[i]);
      continue;
    }
    let after = i + 1;
    while (after < pieces.length && isClosingBracketPiece(pieces[after])) after++;
    for (let j = i + 1; j < after; j++) moved.push(pieces[j]);
    moved.push(pieces[i]);
    i = after - 1;
  }
  return moved;
}

/** Emits the second reading of any 再読文字 whose governed clause ends here
 * — ず after the predicate 未 negates, べし after the one 須 enjoins. The
 * predicate itself has already been conjugated into the form that reading
 * wants (see `rereadGovernedForm`), so this only has to emit.
 *
 * A piece of its own, tagged with the *re-read character's* id rather than
 * the predicate's, though it reads as one word with what precedes it. That
 * is what makes both halves of the reading answer to the character they came
 * from: a 再読文字 is the one token whose contribution to the prose is in two
 * places at once, and glued onto the predicate's piece the second half
 * answered to the predicate. Selecting 未 lit いまだ and left the ず it is
 * half of unmarked.
 *
 * Innermost first: `rereadCloseIds` lists them in the order their clauses
 * were closed, so a nested pair comes out ...んとせず rather than ...ずんとす. */
function markRereadClose(pieces: Piece[], tokenId: number, plan: ReadingPlan): void {
  const closing = plan.rereadCloseIds.get(tokenId);
  if (!closing || pieces.length === 0) return;
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  for (const rereadId of closing) {
    const entry = rereadCharacter(byId.get(rereadId)?.text ?? "");
    if (entry) pieces.push({ kind: "ending", text: entry.second, tokenId: rereadId });
  }
}

/** Everything that attaches *after* a token has been emitted: a speech
 * quote's closing ト, then any 再読文字 second reading. Paired in one call
 * because every emission site needs both, and eleven sites each remembering
 * two calls is eleven chances to remember only one. Order matters — the ト
 * closes the quotation, and a re-read governing it reads after that. */
function closeToken(pieces: Piece[], tokenId: number, plan: ReadingPlan): void {
  markQuoteEnd(pieces, tokenId, plan);
  markRereadClose(pieces, tokenId, plan);
}

/** Generates the kakikudashibun for a single sentence, given its reading
 * order (`plan.order`, token ids in Japanese reading order) and a resolver
 * for kanji->kana readings.
 *
 * Output is 漢字仮名混じり (kanji-kana mixed), not pure kana: content words
 * with a `verbLexicon.ts` entry are rendered as kanji + a correctly
 * conjugated okurigana — the form (mizen/renyou/shuushi) is chosen by
 * `conjugationContext.ts` from what follows in reading order, computed
 * directly from `plan.order` rather than by a placeholder-then-fixup pass,
 * so conjugation always happens strictly *after* the form is known, never
 * before it. Plain nouns keep their kanji with no reading shown at all (as
 * in real kakikudashibun, which carries no furigana); only genuine grammar
 * words (particles, pronouns, sentence-final markers — anything
 * `readingResolver` resolves via the override table) are spelled out in
 * kana. Historical kana usage (歴史的仮名遣い) comes from
 * `classicalConjugation.ts`'s paradigm tables and `verbLexicon.ts`'s
 * entries being authored that way directly, not from a generic conversion
 * pass. */
export function generateKakikudashiPieces(plan: ReadingPlan, resolve: ReadingResolver): Piece[] {
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  const root = findRoot(plan.sentence);
  const pieces: Piece[] = [];

  // A compound span's members are guaranteed contiguous in plan.order (see
  // reorderEngine.ts's carrier mechanism), so each is emitted as its own
  // plain kanji piece, then exactly one shared extra-ending/case-particle
  // — keyed off the span's *carrier* (see spanCarrier.ts), same as the
  // kundoku panel — attaches after the whole group. Checking `extraEndingFor`
  // per-member instead (the naive per-token loop below) would splice a
  // root-triggered copula *between* a compound's characters instead of
  // after them (e.g. 君子 -> 君なり子 instead of 君子なり).
  const spans = findCompoundSpans(plan.sentence);
  const spanOf = new Map<number, (typeof spans)[number]>();
  for (const s of spans) for (const id of s.tokenIds) spanOf.set(id, s);
  const handled = new Set<number>();

  for (const id of plan.order) {
    if (handled.has(id)) continue;
    const token = byId.get(id);
    if (!token) continue;
    // The source's own line structure, ahead of anything this token emits
    // — including a punctuation mark, which is skipped below but can still
    // be what a new line begins with. Carried as a newline in the string;
    // the panel turns it into a column break (see KakikudashiView), and a
    // plain-text export gets a real line break, which is what it wants.
    const layout = sourceLayoutOf(token);
    if (layout?.breakBefore) {
      const cells = layout.indent > 0 ? layout.indent : layout.breakBefore === "para" ? 1 : 0;
      pieces.push({ kind: "layout", text: "\n" + "\u3000".repeat(cells), tokenId: id });
    }

    if (token.dep === "punct") {
      // A bracket is written wherever it falls, and is the one mark that is
      // never a separator: it belongs to the clause it opens or closes rather
      // than standing between two of them. Dropped before this, which is how
      // 「 came to be missing from a reported speech whose 」 was present —
      // the 」 of 子曰：「…」 heads its own sentence (the parser tags a closing
      // quote left after a full stop as that sentence's ROOT, not as a punct
      // dependent), so it never reached this branch to be dropped by it, and
      // the two hands of one pair were decided by different code.
      if (isBracket(token.text)) {
        pieces.push({ kind: "punct", text: token.text, tokenId: id });
        continue;
      }
      // Sentence-final marks are supplied by the join instead (see
      // `generateKakikudashiForTree`), which is what decides where 、 and 。
      // fall between sentences. A medial 、 is a different thing: it
      // belongs to this sentence's own structure — 青、取之於藍 sets 青 off
      // as the topic — so it is carried through to where reading order
      // puts it, as any other token is.
      // A medial mark standing at the very end of a sentence is separating
      // it from the next one, which is the join's job — emitting it here as
      // well gave 子曰はく、、. Only one that falls *inside* a sentence is
      // this sentence's own punctuation.
      const lastId = Math.max(...plan.sentence.tokens.map((t) => t.id));
      const medial = isSentenceFinalPunct(token.text) || id === lastId ? null : medialPunctuation(token.text);
      if (medial) pieces.push({ kind: "punct", text: medial, tokenId: id });
      continue;
    }

    const span = spanOf.get(id);
    if (span) {
      for (const memberId of span.tokenIds) {
        handled.add(memberId);
        pieces.push({ kind: "token", text: byId.get(memberId)!.text, tokenId: memberId });
      }
      // extraEndingFor's root check needs the *carrier* (the member that
      // actually carries the span's syntactic relation), but selectForm's
      // "what comes next in reading order" check needs the *last* member's
      // own position — the group's shared ending piece is emitted after
      // the whole span, so it's the last member's neighbor (e.g. a
      // following negation), not the carrier's own neighbor, that decides
      // mizen vs. shuushi (君子 -> 君子ならずや, mizen from what follows 子,
      // even though 君 — the carrier — is what makes it root-nominal).
      const carrier = carrierOf(span, plan.sentence);
      const lastMemberId = span.tokenIds[span.tokenIds.length - 1];
      const caseParticle = caseParticleFor(carrier, plan.sentence);
      // A span JMdict lists as a する-verb conjugates サ変, exactly as 獨酌する
      // and 封して do — 蠕動 printed as two bare characters until it did. The
      // string is `compoundSuruOkurigana`'s, shared with KundokuView.ts so
      // that the ending this panel prints after the group and the one that
      // panel hangs off its last member cannot come apart.
      //
      // In place of the copula/morph ending rather than beside it, mirroring
      // the per-token lexicon branch below, which `continue`s past its own
      // `extraEndingFor` check for the same reason: a word carrying its own
      // conjugated ending has said everything the sentence needs of it, and
      // 蠕動しなり is not a form.
      const suruOkurigana = compoundSuruOkurigana(carrier, lastMemberId, plan, resolve);
      if (suruOkurigana !== undefined) {
        // `compoundSuruOkurigana` returns the finished string and not the form
        // it conjugated with, so the 連用形-て switch has to recover that — see
        // `compoundSuruRenyouTe`, which writes nothing unless the recovery
        // reproduces this very string, and nothing at all while the switch is
        // off.
        const suruTe = compoundSuruRenyouTe(carrier, lastMemberId, plan, resolve, suruOkurigana);
        pieces.push(withRenyouTe({ kind: "ending", text: suruOkurigana + suruTe, caseParticle, tokenId: lastMemberId }, suruTe));
        closeToken(pieces, lastMemberId, plan);
        continue;
      }
      const extraEnding = extraEndingFor(carrier, root, plan.sentence, true);
      if (extraEnding) {
        // `synthesizedRenyouTe` rides along with every `selectedForm` in this
        // file, and adds nothing at all unless the reader has turned the
        // 連用形-て switch on — see `renyouTe.ts`. `selectedForm` and not
        // `selectForm`: the switch needs the slot the ending came out of and
        // not only the kana, two of the tables holding one string in two slots.
        const selected = selectedForm(extraEnding, plan, lastMemberId);
        const te = synthesizedRenyouTe(selected, nextMeaningfulToken(plan, lastMemberId));
        pieces.push(withRenyouTe({ kind: "ending", text: selected.text + te, caseParticle, tokenId: lastMemberId }, te));
      } else if (caseParticle) {
        pieces[pieces.length - 1].caseParticle = caseParticle;
      }
      closeToken(pieces, lastMemberId, plan);
      continue;
    }

    // Ahead of the branches below, not after them: several of these
    // characters carry features that those claim first — 未 is tagged
    // Polarity=Neg like any negation, and 須/当 come through as auxiliaries
    // — so a re-read reaching them was emitting its second reading while
    // its first was silently swallowed (未果 came out 果たさず, with no
    // いまだ at all). Being read twice outranks whatever else the character
    // also is.
    if (isRereadUse(token, plan.sentence)) {
      pieces.push({ kind: "token", text: rereadCharacter(token.text)!.first, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // A reading picked by hand outranks every context-specific reading below
    // it — the grammar-word branches, 於's special case, and the lexicon —
    // because each of those is this app's own guess at what the character is
    // doing, and the choice is the reader overruling that guess. They ignored
    // it: 未 with ひつじ picked went on contributing a bare ず to the prose and
    // no 未 at all, so 未學禮 read 禮を學ばず.
    //
    // THE HAZARD THIS BRANCH IS: it sits above nearly everything and skips
    // whatever it does not do itself, silently. Three separate bugs have come
    // out of that one shape, each found on its own — it skipped the
    // conversion of kanjidic's modern ending into classical shape (道遠し
    // printed 道遠い), it skipped the conjugation pipeline (立てて printed
    // 立つて), and it skipped the synthesized sentence-final ending (a
    // quantity predication's あり vanished the moment its carrier's reading
    // was touched, and picking the original reading back did not bring it
    // back, because the choice was still stored). Being first is right: the
    // choice outranks every guess this app makes about the character. But
    // what it outranks is the *reading*, not the grammar around it — so
    // anything added below that is about where the word stands rather than
    // about which word it is has to be reached from here too. The same
    // applies to this branch's twin in KundokuView.ts, which is why both
    // spend `pickedEnding` rather than each deciding for itself.
    //
    // Behind the re-read check, not in front of it, since that consults the
    // choice itself (see `isRereadUse`). The kanji is retained and only the
    // ending written out, the same convention the `resolve()` fallback at the
    // end of this loop uses for any other kanjidic-sourced reading.
    //
    // The ending is inflected for where the character stands rather than left
    // in its dictionary form, and the sentence still gets whatever ending it
    // needs of this token — a synthesized なり/あり included, which this
    // branch used to drop by `continue`ing past `extraEndingFor`.
    // `pickedEnding` decides both, and is shared with KundokuView.ts so the
    // two panels cannot come to disagree about them. Emitted in the same two
    // pieces the generic fallback at the end of this loop uses, so the extra
    // ending stays outside the word's own ruby gloss.
    const pickedReading = chosenReadingParts(token);
    if (pickedReading) {
      const picked = pickedEnding(pickedReading, token, root, plan, resolve);
      // …and the 連用形-て switch is one of the things that is about where the
      // word stands rather than about which word it is, so it has to be
      // reached from here too — the hazard this branch's own doc above names.
      // `pickedEnding` reports the form and the class it conjugated with
      // beside the okurigana it wrote, so the switch reads them. See
      // `pickedRenyouTe`.
      const pickedTe = pickedRenyouTe(picked, nextMeaningfulToken(plan, token.id));
      pieces.push(
        withRenyouTe(
          {
            kind: "token",
            text: token.text + picked.okurigana + pickedTe,
            caseParticle: caseParticleFor(token, plan.sentence),
            tokenId: id,
          },
          pickedTe,
        ),
      );
      if (picked.extra) pieces.push({ kind: "ending", text: picked.extra, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // `isSentenceFinalParticleUse` stands beside the dep test rather than
    // replacing it. The dep test is the wider of the two — it admits every
    // `discourse` token, table entry or not, and a lemma the table does not
    // know renders as nothing at all — while the predicate is the
    // narrower: it is what catches a particle the parser has *mis-tagged*.
    // 否 is the one that needs it. It is a real verb as well as a particle
    // (否む, "to refuse") and the parser reads it as the verb, so 君飲嘗不醉否？
    // arrives with 否 tagged VERB/`comp:obj` of 醉 and reached no branch that
    // could read it や. Position is the discriminator and the predicate owns
    // it, which is what keeps 然歟否歟？'s 否 — ROOT, with a 歟 after it — the
    // verb it is. See `isSentenceFinalParticleUse`.
    if (token.dep === "discourse" || token.dep === "discourse@sp" || isSentenceFinalParticleUse(token, plan.sentence)) {
      // …unless it would write the copula its predicate already carries — see
      // `repeatsPredicateCopula`, the same doubling the negation branch below
      // guards against.
      // `sentenceFinalParticleFor`, not `sentenceFinalParticle`: 乎 reads か
      // rather than や inside a 豈…乎 frame, which is a fact about the sentence
      // and not about the lemma. `KundokuView.ts` must call the same function,
      // for the reason every other shared decision in this file is shared.
      const particle = repeatsPredicateCopula(token, plan.sentence) ? "" : sentenceFinalParticleFor(token, plan.sentence);
      pieces.push({ kind: "discourse", text: particle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // Handled as a dedicated piece kind here (not run through
    // resolve()/endingForMorph) because these tokens also carry
    // `Polarity=Neg` in their own morph features, and doing both would
    // double the negation text (亦説ばしからずずや instead of …ずや).
    if (isNegationUse(token)) {
      // `negationEnding` and not `negationForm`: a negation postposed past its
      // predicate is what stands at the end of that clause, so it writes the
      // case particle the clause owes as well as the ず — 苦不得飲 is
      // 飲むを得ざるに苦しむ, with both halves of that ざるに decided together.
      // Shared with KundokuView.ts's own negation branch for the reason every
      // other shared decision in this file is: the two panels cannot be allowed
      // to print different negations.
      const negation = negationEnding(token, plan);
      pieces.push(withRenyouTe({ kind: "negation", text: negation, tokenId: id }, negationRenyouTe(token, plan)));
      closeToken(pieces, id, plan);
      continue;
    }

    // Modal auxiliaries (可/能/須/當/應/欲) drop their own kanji entirely,
    // like negation, and conjugate the same way — べからず (不可), not a
    // naive 可+ず or べし+ず. kind:"negation" isn't accurate here (nothing
    // downstream currently keys off it besides the negation piece itself),
    // but reusing "token" keeps this in the ordinary liaison-eligible pool.
    // 受身 before the table: る vs らる depends on the verb underneath, so
    // it can't be a static entry, and 見 is only passive when tagged AUX
    // over a predicate (it is otherwise "to see", everywhere).
    const passive = passiveComplement(token, plan.sentence);
    const aux = passive ? passiveForm(passive) : auxiliaryFormFor(token, plan.sentence);
    if (aux) {
      const selected = selectedForm(aux, plan, token.id);
      const auxTe = synthesizedRenyouTe(selected, nextMeaningfulToken(plan, token.id));
      pieces.push(withRenyouTe({ kind: "token", text: selected.text + auxTe, tokenId: id }, auxTe));
      closeToken(pieces, id, plan);
      continue;
    }

    // て/して liaison (see `teOrShite`) is decided directly from the
    // dependency tree, not by inspecting an already-pushed piece's text, so
    // this must run as its own branch rather than inside the generic
    // resolve() fallback below.
    if (token.lemma === "而") {
      // Both halves, run together: the prose writes 而 out in kana either
      // way, so what the 訓読文 splits into furigana and okurigana is one word
      // here.
      const eru = teOrShite(plan, token.id);
      pieces.push({ kind: "token", text: (eru.reading ?? "") + eru.okurigana, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // 於 always inverts before its governor and reads より (source/standard
    // of comparison) or おいて (bare location — see `yuParts`). Checked here,
    // ahead of the generic override fallback below (which would otherwise
    // render it via overrides.json's own context-independent entry instead of
    // going through the okurigana slot the way every other special-cased
    // function word above does).
    //
    // The two senses are written differently, and `yuParts` is what says so:
    // より is a case particle and replaces the character (藍より取る, no 於 in
    // the prose at all), while おいて is a verb form written *on* it
    // (日中に於いて, never 日中におい て). A reading over the character is what
    // marks the second, so its presence is what decides whether the kanji is
    // kept — the same test `resolved.spellOutInProse` makes for every other
    // word, asked of the one function that decides this character.
    const yu = yuParts(token, plan.sentence);
    if (yu) {
      pieces.push({ kind: "token", text: (yu.reading ? token.text : "") + yu.okurigana, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    const caseParticle = caseParticleFor(token, plan.sentence);

    // Gated on `usesLexiconEntry` — a lexicon entry represents that lemma's
    // verb/adjective/copula sense specifically, not every use of the
    // character; see that predicate for what the gate admits, and for why
    // KundokuView.ts's two lexicon branches call the same function rather
    // than each restating the condition.
    //
    // A reading the *syntax* chose beats the lexicon (`beatsLexicon` — see
    // `readingResolver.ts`). The lexicon holds one reading per lemma, which is
    // exactly what a transitivity- or on'yomi-selected reading contradicts:
    // 立 is たツ or たテル depending on whether it has an object, and 破 in 大破
    // is read on'yomi, none of which one fixed entry can express. Consulted
    // only for that flag, so every lemma whose reading nothing in the sentence
    // moved still goes through the lexicon exactly as before.
    //
    // Standing the lexicon down loses its *class* along with its reading, so
    // the syntax-chosen reading brings its own — `syntheticLexiconEntry`,
    // shared with KundokuView.ts, so the branch below conjugates it by the
    // same pipeline instead of the reading falling through to the uninflected
    // citation form at the bottom of this loop.
    // …and a タリ suffix reaches this branch by its own gate rather than by
    // `usesLexiconEntry`, whose VERB/AUX test a PART-tagged 然 cannot pass and
    // whose `VERB_LEXICON` arm holds the *standalone* 然り. See
    // `lexiconEntryFor`, which is now where all of that is decided — one
    // function shared with KundokuView.ts's identical branch, in place of the
    // ternary each of them used to hold.
    const resolvedForLex = resolve(token, plan.sentence);
    // The sentence goes with it for the one entry chosen by syntax rather than
    // by lemma — a positive comparison 如/若 is ごとし and a negated one 如く.
    // See `comparisonLexiconEntry`.
    const lex = lexiconEntryFor(token, resolvedForLex, plan.sentence);
    if (lex?.fixedReading && !isNamingUse(token, plan.sentence)) {
      pieces.push({ kind: "token", text: token.text + lex.fixedReading, caseParticle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }
    if (lex?.conjClass) {
      const next = nextMeaningfulToken(plan, token.id);
      // A governing 再読文字 dictates the form outright — 未 wants 未然形
      // whatever else follows — so it is consulted ahead of the ordinary
      // context rules.
      // The resolver is handed over rather than a form decided without it:
      // a following 者 is attributive only under its もの reading, and only
      // the resolver knows which of its two readings this one took (see
      // `isNominalizerAhead`).
      // The form is decided from `conjugationSubject`, not from the token
      // itself: a タリ suffix writes the group's ending but its stem is what
      // holds the group onto the sentence. `next` stays this token's own
      // neighbour, which is where the ending lands. See that function.
      const form =
        rereadGovernedForm(id, plan) ??
        decideConjForm(conjugationSubject(token, plan.sentence), next, plan.sentence, lex.conjClass, resolve);
      // The class handed to `converbSuffix` is `lex`'s — the very one the
      // okurigana just before it was conjugated with — and not one looked up
      // afresh: whether a て may be written turns on the shape of *that*
      // 連用形. Where the syntax stood the lexicon down (`beatsLexicon`),
      // the two differ, and a lookup wrote 見えて — 見ゆ's stem with 見る's て.
      const okurigana = conjugatedOkurigana(lex, form);
      const converbTe = converbSuffix(token, next, lex.conjClass, form);
      // The 連用形-て switch, off by default and adding nothing at all in that
      // state (see `renyouTe.ts`). It is spent here, beside `converbSuffix`,
      // because this is the one point where the form, the class and the
      // okurigana actually written are all in hand — the three facts deciding
      // whether a further て may be added and what it is — and because standing
      // beside it is what keeps the two from doubling up: whatever
      // `converbSuffix` has already written, this declines to write again.
      const renyouTe = renyouTeSuffix({ form, conjClass: lex.conjClass, okurigana, converbTe, nextToken: next });
      pieces.push(
        withRenyouTe(
          { kind: "token", text: token.text + okurigana + converbTe + renyouTe, caseParticle, tokenId: id },
          renyouTe,
        ),
      );
      closeToken(pieces, id, plan);
      continue;
    }

    // An adverb that keeps its kanji in the prose — 亦, 必ず, 嘗て. The set is
    // `KANJI_RETAINED_ADVERBS` in `classicalEnding.ts`, whose table used to be
    // written here; the okurigana written after the kanji is KANJIDIC2's own
    // okurigana dot, read out of the index by the resolver and arriving here on
    // the resolved reading (see `retainedAdverbOkurigana` on `ResolvedReading`
    // for why it travels that way, and the table's own doc for why the set
    // could not stay in this file).
    //
    // Not for an adverb the resolver has read as half of a Sino-Japanese
    // compound. The okurigana is the one an adverb's *own* reading takes — 獨
    // standing alone is 獨り — which is the wrong word when the adverb is half
    // of one: 獨酌 is どくしやく, and 獨り酌 went into the prose beside a panel
    // already showing どく・しやく. `beatsLexicon` marks a reading the syntax
    // chose (see `ResolvedReading`), which is exactly the condition under which
    // this per-lemma rule should stand down, the same way `VERB_LEXICON` does
    // below.
    const resolvedForRetained = resolve(token, plan.sentence);
    const retainedOkurigana = resolvedForRetained.beatsLexicon ? undefined : resolvedForRetained.retainedAdverbOkurigana;
    if (retainedOkurigana !== undefined) {
      pieces.push({ kind: "token", text: token.text + retainedOkurigana, caseParticle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    const resolved = resolve(token, plan.sentence);
    // A 形容動詞 tagged ADV reaches the page here, its 連用形 written by the
    // resolver rather than by the conjugation pipeline — 暴 in 忽覺咽中暴癢 is
    // 暴かに. That に is the ナリ活用 paradigm 連用形 the 連用形-て switch is
    // chiefly about, so it is spent here; off, it adds nothing. See
    // `adverbialRenyouTe`.
    const adverbialTe = adverbialRenyouTe(token, resolved, nextMeaningfulToken(plan, token.id));
    const text =
      (resolved.spellOutInProse
        ? (resolved.reading ?? "") + (resolved.okurigana ?? "")
        : token.text + (resolved.okurigana ?? "")) + // kanji retained; furigana-only reading is never shown in running prose
      adverbialTe;
    pieces.push(withRenyouTe({ kind: "token", text, caseParticle, tokenId: id }, adverbialTe));

    // A morph-driven auxiliary (potential/desiderative/passive/etc.) on
    // this token, or — only at the sentence root, and only when it has no
    // such morph — a synthesized なり copula for a bare nominal predicate
    // (Literary Chinese has no token realizing "is" for e.g. 君子). Shared
    // with the kundoku panel via conjugationContext.ts so a copula
    // inserted here out of nothing is still shown there. Skipped for an
    // override-sourced token (もって/おいて/等) — the override table's
    // entries are already complete, self-contained grammatical glosses, so
    // e.g. 以's own VerbForm=Conv morph must not *also* tack on a further
    // て (もってて) on top of もって, which already carries that sense.
    // `endingComplete` is the same exemption reached by a different route: a
    // reading that already carries all of its own ending (see its own doc).
    //
    // A multi-character token counts as a denominal compound here, the last
    // argument, because that is what the other panel calls it: KundokuView's
    // `compoundGroupCell` renders a fused span and a multi-character token
    // through one function and passes `true` for both, while this loop had no
    // branch for the second at all and reached this line with the default.
    // The two then disagreed about the same word — 輒半種黍；而家豪富 with
    // 豪富 read as one adjectival predicate showed 豪富ナリ in the 訓読文 and a
    // bare 豪富 in the prose. A whole-word reading has no okurigana of its own
    // to carry the ending (see `extraEndingFor`'s own note on the flag), and
    // that is as true of a token the tokenizer fused as of a span this app
    // did.
    if (!resolved.endingComplete) {
      const extraEnding = extraEndingFor(token, root, plan.sentence, [...token.text].length > 1);
      if (extraEnding) {
        const selected = selectedForm(extraEnding, plan, token.id);
        const endingTe = synthesizedRenyouTe(selected, nextMeaningfulToken(plan, token.id));
        pieces.push(withRenyouTe({ kind: "ending", text: selected.text + endingTe, tokenId: id }, endingTe));
      }
    }
    closeToken(pieces, id, plan);
  }

  return closeQuotesOutsideBrackets(pieces);
}

/** The same, flattened to a string — for callers that want the prose and
 * not the structure (the plain-text export, the tests). */
export function generateKakikudashi(plan: ReadingPlan, resolve: ReadingResolver): string {
  return generateKakikudashiPieces(plan, resolve)
    .map((p) => p.text + (p.caseParticle ?? ""))
    .join("");
}
/** The token whose mark closed `sentence`, ignoring any bracket standing
 * after it — 仁。」 is closed by the 。, not by the 」. Null where the parser
 * cut the sentence somewhere the source put no mark at all.
 *
 * The token and not just its text, because the mark is no longer always
 * written at the boundary it was read off: where the next sentence opens with
 * a closing bracket the mark is owed *after* that bracket, which is a piece in
 * the next sentence's list, and a piece answers to the character it came from
 * (see `deferredMark`). */
function closingPunct(sentence: Sentence): Token | null {
  for (const token of [...sentence.tokens].sort((a, b) => b.id - a.id)) {
    if (isBracket(token.text)) continue;
    if (FULL_STOPS.has(token.text) || COMMAS.has(token.text)) return token;
    return null;
  }
  return null;
}

function closingMark(sentence: Sentence): string | null {
  return closingPunct(sentence)?.text ?? null;
}

function firstToken(sentence: Sentence): Token | undefined {
  return [...sentence.tokens].sort((a, b) => a.id - b.id)[0];
}

function lastToken(sentence: Sentence): Token | undefined {
  return [...sentence.tokens].sort((a, b) => b.id - a.id)[0];
}

function sortedTokens(sentence: Sentence): Token[] {
  return [...sentence.tokens].sort((a, b) => a.id - b.id);
}

function isBracketOnly(sentence: Sentence): boolean {
  return sentence.tokens.every((t) => isBracket(t.text));
}

/** A mark a sentence is owed after it, with the source token it was read off
 * — null where the source wrote none and the 、 is this panel's own. */
interface OwedMark {
  text: string;
  token: Token | null;
}

/** The mark `sentences[i]` is owed after it, with no regard to *where* that
 * mark can be written. `sentenceSeparator` writes it at the boundary and
 * `deferredMark` writes it inside the next sentence; both ask this.
 *
 * The mark the source closed the sentence with decides it, as it decides
 * what the kundoku panel writes (see `japanesePunct`): a ， divides, so 、,
 * and a 。？！ closes, so 。. This used to be positional — 、 between every
 * pair and 。 only at the very end — on the reasoning that a ，-divided line
 * is one sentence in published kundoku, which is true and is what the 、
 * still expresses. What it missed is that the parser segments at *every*
 * mark, so the list it was counting along is a list of clauses and not of
 * sentences: 學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？ came back as four,
 * and running them together gave one sentence with three 、 in it where the
 * source had two full stops.
 *
 * Nothing at all where the next sentence begins a new line and this one
 * closed on no mark: the break is already the separator, and a 、 in front of
 * it would punctuate something the source never punctuated. Where the source
 * *did* close the sentence, the break is not standing in for anything and the
 * mark is still owed — this is what dropped the last 。 of a paragraph:
 * 體漸瘦、家亦日貧、後飲食至不能給。 ends the paragraph 異史氏曰 opens, and its
 * 。 — written in the source, sitting right there in the sentence's own last
 * token — was swallowed by the break, leaving 能はざるに至る with nothing after
 * it.
 *
 * A sentence of nothing but brackets punctuates nothing of its own, and the
 * parser leaves them stranded like that often: the 」 of 子曰：「…。」 comes back
 * alone, the 。 inside the quote having already ended the sentence before it.
 * What closed the clause is what closed the last sentence that had a clause in
 * it, so that is the mark to ask — otherwise a quotation ending a sentence was
 * followed by 、 rather than by 。. */
function markFor(sentences: readonly Sentence[], i: number): OwedMark | null {
  const current = sentences[i];
  const next = sentences[i + 1];
  if (!current || !next) return null;

  const first = firstToken(next);
  if (first && sourceLayoutOf(first)?.breakBefore && closingMark(current) === null) return null;

  let token: Token | null = null;
  for (let j = i; j >= 0 && token === null; j--) {
    token = closingPunct(sentences[j]);
    if (token === null && !isBracketOnly(sentences[j])) break;
  }
  return { text: token && FULL_STOPS.has(token.text) ? "。" : "、", token };
}

/** What goes between one sentence and the next, and after the last one —
 * `markFor`'s answer, wherever this boundary is where it can be written.
 *
 * It is not, in two cases, and both are about a bracket. Where the next
 * sentence opens with a closing bracket, that bracket closes the clause just
 * written and is part of it — this is what put 、 before 」, the mark the
 * reader noticed — so the mark is owed on the far side of it and
 * `deferredMark` is what writes it there. And where this sentence ends on an
 * opening bracket, for the mirror of that reason, nothing is owed at all. */
export function sentenceSeparator(sentences: readonly Sentence[], i: number): string {
  const current = sentences[i];
  const next = sentences[i + 1];
  if (!current || !next) return "。";

  const first = firstToken(next);
  if (first && isBracket(first.text) && !isOpeningBracket(first.text)) return "";

  const last = lastToken(current);
  if (last && isOpeningBracket(last.text)) return "";

  return markFor(sentences, i)?.text ?? "";
}

/** The mark `sentences[i]` is owed that has to be written *inside* the next
 * sentence, past the closing bracket that sentence opens with.
 *
 * The parser cuts at the 。 *inside* a quotation, so the bracket that shuts
 * the quotation is left heading the next sentence, and the mark is owed on the
 * far side of it. Where nothing follows that bracket — the 」 of 子曰：「…。」,
 * alone — the mark is written after the bracket-only sentence instead, by that
 * sentence's own `sentenceSeparator` walking back for it. Where the bracket is
 * followed by more text in its own sentence there is no such boundary to write
 * it at, and the mark was simply lost: 或言：『…成其術。』然歟否歟？ came out
 * …その術を成す』と然るや否むや, with the 。 the source wrote at 成其術 gone and
 * the closing と running straight into the question after it. That is the mark
 * the reader asked for.
 *
 * Null in every other case, the bracket-only one included, so that exactly one
 * of the two writes it. */
function deferredMark(sentences: readonly Sentence[], i: number): OwedMark | null {
  const next = sentences[i + 1];
  if (!next) return null;
  const first = firstToken(next);
  if (!first || !isBracket(first.text) || isOpeningBracket(first.text)) return null;
  if (isBracketOnly(next)) return null;
  return markFor(sentences, i);
}

/** How many opening brackets the source still has unclosed when each sentence
 * ends, counted across the whole tree.
 *
 * Across the tree and not within a sentence because a quotation's two hands
 * are hardly ever in the one sentence: the parser cuts at the 。 inside the
 * quote, so 「 and its 」 are routinely a sentence apart — and 異史氏曰：「… runs
 * four sentences, an inner 『…』 and all, before its own 」 arrives.
 *
 * Clamped at zero one bracket at a time, so an unbalanced 」 costs only itself
 * instead of throwing off every depth after it. */
function bracketDepths(tree: TokenTree): number[] {
  let depth = 0;
  return tree.sentences.map((sentence) => {
    for (const token of sortedTokens(sentence)) {
      if (!isBracket(token.text)) continue;
      if (isOpeningBracket(token.text)) depth++;
      else if (depth > 0) depth--;
    }
    return depth;
  });
}

/** Where the closing と left at the end of sentence `from` is to be written:
 * the bracket that shuts the quotation it closes, as a sentence index and a
 * token id.
 *
 * The quotation's own opening bracket is the innermost one open where the と
 * stands, so the bracket that shuts it is the next closing bracket to take the
 * depth *below* the depth that sentence ended at. Everything in between is
 * inside the quotation, however many sentences of it there are — which is what
 * the previous rule missed. It carried a trailing と only over brackets the
 * immediately next sentence opened with and gave up otherwise, so
 * 異史氏曰：「…豈飲啄固有數乎？ — whose 」 is three sentences away, with a whole
 * inner quotation in between — kept its と at the end of its own sentence,
 * 豈に飲啄固より數有るかと。, reporting nothing and closing a quotation that had
 * not ended, while the 」 that ends the passage got no と at all.
 *
 * Then any bracket shutting immediately after that one, because 「…『…』」 shuts
 * two quotations at once while `quoteEndIds` is a `Set`: the two arrive as one
 * id and are written with one と, which had better stand outside both rather
 * than in the middle of them.
 *
 * Null where the quotation was opened with no bracket at all, and where the
 * source never closes it. */
function quoteCloseSite(
  tree: TokenTree,
  depths: number[],
  from: number,
): { sentence: number; tokenId: number } | null {
  const start = depths[from];
  if (start === 0) return null;
  let depth = start;
  let found: { sentence: number; tokenId: number } | null = null;
  for (let j = from + 1; j < tree.sentences.length; j++) {
    for (const token of sortedTokens(tree.sentences[j])) {
      const bracket = isBracket(token.text);
      const closing = bracket && !isOpeningBracket(token.text);
      if (found && !closing) return found;
      if (!bracket) continue;
      if (!closing) {
        depth++;
        continue;
      }
      if (depth > 0) depth--;
      if (depth < start) found = { sentence: j, tokenId: token.id };
    }
  }
  return found;
}

/** Carries each quotation's closing と across the sentence boundary to the
 * bracket that shuts the quotation — `quoteCloseSite` says which bracket that
 * is, and `closeQuotesOutsideBrackets` makes the same move within a sentence,
 * which is where a quotation shut inside its own sentence is handled.
 *
 * Only a trailing と travels. One written anywhere else has text of its own
 * sentence after it, and that pass has already put it where it goes. */
function carryQuoteClosings(tree: TokenTree, bySentence: Piece[][]): void {
  const depths = bracketDepths(tree);
  // Every move decided before any is made, so that a と carried to the end of
  // a later sentence is not then mistaken for that sentence's own trailing と
  // and carried on again.
  const moves: { from: number; piece: Piece; sentence: number; tokenId: number }[] = [];
  for (let i = 0; i < bySentence.length - 1; i++) {
    const piece = bySentence[i][bySentence[i].length - 1];
    if (!piece || piece.kind !== "quote") continue;
    const site = quoteCloseSite(tree, depths, i);
    if (site) moves.push({ from: i, piece, ...site });
  }
  for (const move of moves) {
    const source = bySentence[move.from];
    const target = bySentence[move.sentence];
    const at = target.findLastIndex((p) => p.tokenId === move.tokenId && isClosingBracketPiece(p));
    const held = source.lastIndexOf(move.piece);
    if (at < 0 || held < 0) continue;
    source.splice(held, 1);
    target.splice(at + 1, 0, move.piece);
  }
}

/** Writes each `deferredMark` into the sentence carrying the bracket it is
 * owed after — past the whole run of brackets, and past the closing と that
 * `carryQuoteClosings` has just set among them. The と closes the quotation and
 * the mark closes the sentence that reported it, in that order: 『…成す』と。 */
function writeDeferredMarks(tree: TokenTree, bySentence: Piece[][]): void {
  for (let i = 0; i < bySentence.length - 1; i++) {
    const owed = deferredMark(tree.sentences, i);
    if (!owed) continue;
    const target = bySentence[i + 1];
    let at = 0;
    while (at < target.length && isClosingBracketPiece(target[at])) at++;
    while (at < target.length && target[at].kind === "quote") at++;
    // The mark answers to the character the source wrote it as, which is back
    // in the sentence this one is owed after — the same crossing the と it
    // follows already makes. Where the source wrote none, the 、 is this
    // panel's own and stands with the bracket it was written beside.
    const tokenId = owed.token?.id ?? target[0]?.tokenId ?? 0;
    target.splice(at, 0, { kind: "punct", text: owed.text, tokenId });
  }
}

/** Every sentence's pieces, with each quotation's closing と carried to the
 * bracket that shuts it and each sentence's own mark written after that
 * bracket where the boundary had nowhere to put it.
 *
 * Both are cross-sentence questions and both were being asked one sentence at
 * a time. The parser segments at every mark, and the mark inside a quotation
 * comes *before* its closing bracket — 劉答言：「無。」 is cut at the 。, so the 」
 * is left heading a sentence of its own, and 或言：『…。』然歟否歟？ leaves the 』
 * heading the sentence that carries on after it. Sentence by sentence there is
 * nothing after the と to move it past, and it stayed inside the bracket
 * (「無しと」); and the 。 standing in front of that bracket had nowhere to be
 * written at all. */
export function generateKakikudashiPiecesForTree(
  tree: TokenTree,
  planFor: (sentence: Sentence) => ReadingPlan,
  resolve: ReadingResolver,
): Piece[][] {
  const bySentence = tree.sentences.map((sentence) => generateKakikudashiPieces(planFor(sentence), resolve));
  carryQuoteClosings(tree, bySentence);
  writeDeferredMarks(tree, bySentence);
  return bySentence;
}

export function generateKakikudashiForTree(
  tree: TokenTree,
  planFor: (sentence: Sentence) => ReadingPlan,
  resolve: ReadingResolver,
): string {
  const bodies = generateKakikudashiPiecesForTree(tree, planFor, resolve).map((pieces) =>
    pieces.map((piece) => piece.text + (piece.caseParticle ?? "")).join(""),
  );
  return bodies.map((body, i) => body + sentenceSeparator(tree.sentences, i)).join("");
}
