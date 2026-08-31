import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { compoundSuruOkurigana } from "../reading/readingResolver.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import { sentenceFinalParticle } from "./bungoConjugation.ts";
import {
  AUXILIARY_LEMMAS,
  passiveComplement,
  passiveForm,
  caseParticleFor,
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  extraEndingFor,
  fixedExpressionPart,
  findRoot,
  isNamingUse,
  isNegationUse,
  isSentenceFinalParticleUse,
  negationForm,
  nextMeaningfulToken,
  pickedEnding,
  repeatsPredicateCopula,
  selectForm,
  conjugationSubject,
  lexiconEntryFor,
  teOrShite,
  yuReading,
} from "./conjugationContext.ts";
import { COMMAS, FULL_STOPS, isBracket, isOpeningBracket, isSentenceFinalPunct, medialPunctuation } from "../parse/punctuation.ts";
import { sourceLayoutOf } from "../parse/sourceLayout.ts";
import { isRereadUse, rereadCharacter, rereadGovernedForm } from "./rereadCharacters.ts";
import { chosenReadingParts } from "../reading/chosenReading.ts";

/** Common classical adverbs/conjunctions that keep their kanji in
 * kakikudashibun (unlike pronouns or case particles, which are spelled out
 * in kana via `reading/overrides.json`) — a bounded, hand-verified set in
 * the same spirit as `verbLexicon.ts`, not an attempt to classify every
 * override-table entry. Value is the (already historically-correct, where
 * relevant) okurigana that follows the kanji; empty string for adverbs
 * with no okurigana at all (they're read as a single invariant word). */
export const KANJI_RETAINED_ADVERBS: Record<string, string> = {
  亦: "",
  皆: "",
  尚: "",
  猶: "",
  且: "つ",
  甚: "だ",
  必: "ず",
  更: "に",
  但: "し",
  獨: "り",
  独: "り",
};

type PieceKind = "token" | "discourse" | "ending" | "negation" | "punct" | "layout";

export interface Piece {
  kind: PieceKind;
  text: string;
  /** Appended after `text` at output time (see `caseParticleFor`). */
  caseParticle?: string;
  /** The source token this came from, so a panel can tie the two together
   * — clicking a character in the kundoku panel highlights what it became
   * here. Several pieces can share one id (a word and its ending), and one
   * token can be answerable for a piece that is not itself (a negation is
   * emitted from the 不 that causes it). */
  tokenId: number;
}

/** Trailing と on the token/piece that ends a quoted/reported-speech
 * complement of a speech verb — see `ReadingPlan.quoteEndIds` and
 * `depClassification.ts`'s `isSpeechQuoteComplement`. Appended directly
 * onto the most-recently-pushed piece's own text (mirroring the kundoku
 * panel's `withQuoteEnd`, which appends to that token's own okurigana) —
 * called right before every `continue`/loop-end below, since the quote can
 * end on any kind of token. */
function markQuoteEnd(pieces: Piece[], tokenId: number, plan: ReadingPlan): void {
  if (plan.quoteEndIds.has(tokenId) && pieces.length > 0) {
    pieces[pieces.length - 1].text += "と";
  }
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
        pieces.push({ kind: "ending", text: suruOkurigana, caseParticle, tokenId: lastMemberId });
        closeToken(pieces, lastMemberId, plan);
        continue;
      }
      const extraEnding = extraEndingFor(carrier, root, plan.sentence, true);
      if (extraEnding) {
        pieces.push({ kind: "ending", text: selectForm(extraEnding, plan, lastMemberId), caseParticle, tokenId: lastMemberId });
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
      pieces.push({
        kind: "token",
        text: token.text + picked.okurigana,
        caseParticle: caseParticleFor(token, plan.sentence),
        tokenId: id,
      });
      if (picked.extra) pieces.push({ kind: "ending", text: picked.extra, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // A lexicalised formula — 答曰 and its three siblings, read 答へて曰はく —
    // is remembered whole and so has to be spent before any branch that would
    // work the reading out: the lexicon below, the resolver at the end of this
    // loop, and 曰's own `fixedReading`, which is right for a quote frame
    // standing alone and is the wrong half of this expression. Behind the
    // hand-picked reading above it, like everything else: the reader naming a
    // reading for one of these characters is overruling this app, and this is
    // one of the guesses being overruled. See `fixedExpressionPart`.
    const formula = fixedExpressionPart(token, plan.sentence);
    if (formula) {
      // The reading goes over the character in the 訓読文 and *into the prose*
      // here — the same split 曰 already takes (い over, はく beside), written
      // out as one word because that is what running prose shows.
      pieces.push({ kind: "token", text: token.text + formula.okurigana, tokenId: id });
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
      const particle = repeatsPredicateCopula(token, plan.sentence) ? "" : sentenceFinalParticle(token.lemma);
      pieces.push({ kind: "discourse", text: particle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // Handled as a dedicated piece kind here (not run through
    // resolve()/endingForMorph) because these tokens also carry
    // `Polarity=Neg` in their own morph features, and doing both would
    // double the negation text (亦説ばしからずずや instead of …ずや).
    if (isNegationUse(token)) {
      pieces.push({ kind: "negation", text: negationForm(nextMeaningfulToken(plan, id), rereadGovernedForm(id, plan)), tokenId: id });
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
    const aux = passive ? passiveForm(passive) : AUXILIARY_LEMMAS[token.lemma];
    if (aux) {
      pieces.push({ kind: "token", text: selectForm(aux, plan, token.id), tokenId: id });
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
    // of comparison — see `yuReading`). Checked here, ahead of the generic
    // override fallback below (which would otherwise render it via
    // overrides.json's own context-independent entry instead of going
    // through the okurigana slot the way every other special-cased
    // function word above does).
    const yu = yuReading(token, plan.sentence);
    if (yu) {
      pieces.push({ kind: "token", text: yu, tokenId: id });
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
    const lex = lexiconEntryFor(token, resolvedForLex);
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
      pieces.push({
        kind: "token",
        // The class handed to `converbSuffix` is `lex`'s — the very one the
        // okurigana just before it was conjugated with — and not one looked up
        // afresh: whether a て may be written turns on the shape of *that*
        // 連用形. Where the syntax stood the lexicon down (`beatsLexicon`),
        // the two differ, and a lookup wrote 見えて — 見ゆ's stem with 見る's て.
        text: token.text + conjugatedOkurigana(lex, form) + converbSuffix(token, next, lex.conjClass),
        caseParticle,
        tokenId: id,
      });
      closeToken(pieces, id, plan);
      continue;
    }

    // Not for an adverb the resolver has read as half of a Sino-Japanese
    // compound. This table gives an adverb the okurigana of its *own* reading
    // — 獨 standing alone is 獨り — which is the wrong word when the adverb is
    // half of one: 獨酌 is どくしやく, and the table put 獨り酌 in the prose
    // beside a panel already showing どく・しやく. `beatsLexicon` marks a
    // reading the syntax chose (see `ResolvedReading`), which is exactly the
    // condition under which this per-lemma table should stand down, the same
    // way `VERB_LEXICON` does below.
    const retainedOkurigana = resolve(token, plan.sentence).beatsLexicon ? undefined : KANJI_RETAINED_ADVERBS[token.lemma];
    if (retainedOkurigana !== undefined) {
      pieces.push({ kind: "token", text: token.text + retainedOkurigana, caseParticle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    const resolved = resolve(token, plan.sentence);
    const text =
      resolved.spellOutInProse
        ? (resolved.reading ?? "") + (resolved.okurigana ?? "")
        : token.text + (resolved.okurigana ?? ""); // kanji retained; furigana-only reading is never shown in running prose
    pieces.push({ kind: "token", text, caseParticle, tokenId: id });

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
        pieces.push({ kind: "ending", text: selectForm(extraEnding, plan, token.id), tokenId: id });
      }
    }
    closeToken(pieces, id, plan);
  }

  return pieces;
}

/** The same, flattened to a string — for callers that want the prose and
 * not the structure (the plain-text export, the tests). */
export function generateKakikudashi(plan: ReadingPlan, resolve: ReadingResolver): string {
  return generateKakikudashiPieces(plan, resolve)
    .map((p) => p.text + (p.caseParticle ?? ""))
    .join("");
}

/** The mark that closed `sentence`, ignoring any bracket standing after it —
 * 仁。」 is closed by the 。, not by the 」. Null where the parser cut the
 * sentence somewhere the source put no mark at all. */
function closingMark(sentence: Sentence): string | null {
  for (const token of [...sentence.tokens].sort((a, b) => b.id - a.id)) {
    if (isBracket(token.text)) continue;
    if (FULL_STOPS.has(token.text) || COMMAS.has(token.text)) return token.text;
    return null;
  }
  return null;
}

function firstToken(sentence: Sentence): Token | undefined {
  return [...sentence.tokens].sort((a, b) => a.id - b.id)[0];
}

function lastToken(sentence: Sentence): Token | undefined {
  return [...sentence.tokens].sort((a, b) => b.id - a.id)[0];
}

/** What goes between one sentence and the next, and after the last one.
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
 * Nothing at all in three cases. Where the next sentence begins a new line,
 * the break is already the separator and a 、 in front of it would punctuate
 * something the source never punctuated. Where the next sentence opens with
 * a closing bracket, that bracket closes the clause just written and is part
 * of it — this is what put 、 before 」, the mark the reader noticed. And
 * where this sentence ends on an opening bracket, for the mirror of that
 * reason. */
export function sentenceSeparator(sentences: readonly Sentence[], i: number): string {
  const current = sentences[i];
  const next = sentences[i + 1];
  if (!current || !next) return "。";

  const first = firstToken(next);
  if (first && sourceLayoutOf(first)?.breakBefore) return "";
  if (first && isBracket(first.text) && !isOpeningBracket(first.text)) return "";

  const last = lastToken(current);
  if (last && isOpeningBracket(last.text)) return "";

  // A sentence of nothing but brackets punctuates nothing of its own, and
  // the parser leaves them stranded like that often: the 」 of 子曰：「…。」
  // comes back alone, the 。 inside the quote having already ended the
  // sentence before it. What closed the clause is what closed the last
  // sentence that had a clause in it, so that is the mark to ask — otherwise
  // a quotation ending a sentence was followed by 、 rather than by 。.
  let mark: string | null = null;
  for (let j = i; j >= 0 && mark === null; j--) {
    mark = closingMark(sentences[j]);
    if (mark === null && !isBracketOnly(sentences[j])) break;
  }
  return mark && FULL_STOPS.has(mark) ? "。" : "、";
}

function isBracketOnly(sentence: Sentence): boolean {
  return sentence.tokens.every((t) => isBracket(t.text));
}

export function generateKakikudashiForTree(
  tree: TokenTree,
  planFor: (sentence: Sentence) => ReadingPlan,
  resolve: ReadingResolver,
): string {
  const bodies = tree.sentences.map((sentence) => generateKakikudashi(planFor(sentence), resolve));
  return bodies.map((body, i) => body + sentenceSeparator(tree.sentences, i)).join("");
}
