import type { Sentence, TokenTree } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
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
  findRoot,
  isConverbUse,
  isMistaggedLocativeVerb,
  isNamingUse,
  isNominalizedFaultNoun,
  isNominalizedVerbClause,
  negationForm,
  NEGATION_LEMMAS,
  nextMeaningfulToken,
  selectForm,
  teOrShite,
  yuReading,
} from "./conjugationContext.ts";
import { VERB_LEXICON } from "./verbLexicon.ts";
import { isSentenceFinalPunct, medialPunctuation } from "../parse/punctuation.ts";
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
 * wants (see `rereadGovernedForm`), so this only has to append.
 *
 * Innermost first: `rereadCloseIds` lists them in the order their clauses
 * were closed, so a nested pair comes out ...んとせず rather than ...ずんとす. */
function markRereadClose(pieces: Piece[], tokenId: number, plan: ReadingPlan): void {
  const closing = plan.rereadCloseIds.get(tokenId);
  if (!closing || pieces.length === 0) return;
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  for (const rereadId of closing) {
    const entry = rereadCharacter(byId.get(rereadId)?.text ?? "");
    if (entry) pieces[pieces.length - 1].text += entry.second;
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

    if (token.dep === "discourse" || token.dep === "discourse@sp") {
      pieces.push({ kind: "discourse", text: sentenceFinalParticle(token.lemma), tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    // Handled as a dedicated piece kind here (not run through
    // resolve()/endingForMorph) because these tokens also carry
    // `Polarity=Neg` in their own morph features, and doing both would
    // double the negation text (亦説ばしからずずや instead of …ずや).
    if (NEGATION_LEMMAS.has(token.lemma) && token.dep === "mod") {
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
      pieces.push({ kind: "token", text: teOrShite(plan, token.id), tokenId: id });
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

    // Gated on pos === "VERB"/"AUX" — a lexicon entry represents that
    // lemma's verb/adjective/copula sense specifically, not every use of
    // the character (青/寒 are also plain NOUNs elsewhere — the color/
    // condition itself as a substance — where conjugating them would be
    // wrong). AUX joins VERB for 爲/為's copula-like "becomes X" use
    // (comp:pred child, VerbType=Cop morph), which this parser tags AUX —
    // still a real sa-hen conjugation, not a morph-synthesized ending.
    // isConverbUse joins them too for a lexicon word tagged ADV when used
    // adverbially before a further verb (博/參 in 博學而日參省乎己) — see its
    // own doc.
    const lex =
      (token.pos === "VERB" ||
        token.pos === "AUX" ||
        isMistaggedLocativeVerb(token) ||
        isNominalizedVerbClause(token) ||
        isConverbUse(token)) &&
      !isNominalizedFaultNoun(token)
        ? VERB_LEXICON[token.lemma]
        : undefined;
    // Ahead of the lexicon branches below, which conjugate from their own
    // reading — see the matching short-circuit in `KundokuView.ts`. The
    // kanji is retained and only the ending written out, the same
    // convention the `resolve()` fallback at the end of this loop uses for
    // any other kanjidic-sourced reading.
    const picked = chosenReadingParts(token);
    if (picked) {
      pieces.push({ kind: "token", text: token.text + (picked.okurigana ?? ""), caseParticle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }
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
      const form = rereadGovernedForm(id, plan) ?? decideConjForm(token, next, plan.sentence, lex.conjClass);
      pieces.push({
        kind: "token",
        text: token.text + conjugatedOkurigana(lex, form) + converbSuffix(token, next),
        caseParticle,
        tokenId: id,
      });
      closeToken(pieces, id, plan);
      continue;
    }

    const retainedOkurigana = KANJI_RETAINED_ADVERBS[token.lemma];
    if (retainedOkurigana !== undefined) {
      pieces.push({ kind: "token", text: token.text + retainedOkurigana, caseParticle, tokenId: id });
      closeToken(pieces, id, plan);
      continue;
    }

    const resolved = resolve(token, plan.sentence);
    const text =
      resolved.source === "override"
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
    if (resolved.source !== "override") {
      const extraEnding = extraEndingFor(token, root, plan.sentence);
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

/** Generates kakikudashibun for a whole parsed text: joins each sentence's
 * output with 、 and terminates the tree with 。
 *
 * Positional, deliberately, and not from the source's own punctuation. ，
 * *is* sentence-final — the parser segments on it, and `punctuation.ts`
 * says so for the two places that need to know — but published kundoku of
 * a ，-divided line writes 、 between the clauses and closes the whole with
 * 。, running them together as one sentence. The output follows that
 * convention rather than the source's mark.
 *
 * Real source-final punctuation (？/！) is normalized to 。 for the same
 * kind of reason: question and exclamatory force is already carried by the
 * sentence-final particle rendering (乎 → や), not by the closing mark. */
/** What goes between one sentence and the next: 、 ordinarily, but nothing
 * at all when the next one begins a new line.
 *
 * Sentences are split at line breaks as well as at punctuation (see
 * `splitIntoSentences`), and where the boundary *is* a line break the break
 * is already the separator — a 、 in front of it would be punctuating
 * something the source never punctuated. */
export function sentenceSeparator(next: Sentence | undefined): string {
  if (!next) return "";
  const first = [...next.tokens].sort((a, b) => a.id - b.id)[0];
  return first && sourceLayoutOf(first)?.breakBefore ? "" : "、";
}

export function generateKakikudashiForTree(
  tree: TokenTree,
  planFor: (sentence: Sentence) => ReadingPlan,
  resolve: ReadingResolver,
): string {
  const bodies = tree.sentences.map((sentence) => generateKakikudashi(planFor(sentence), resolve));
  return bodies.map((body, i) => body + (i === bodies.length - 1 ? "。" : sentenceSeparator(tree.sentences[i + 1]))).join("");
}
