import { type Sentence, type Token, isContentPredicatePos } from "../parse/types.ts";
import { chosenReading, isBareChosenReading } from "./chosenReading.ts";
import type { ReadingResolver, ResolvedReading } from "./types.ts";
import { findOverride } from "./overridesLookup.ts";
import { attestedAdjectiveClass, hasAdjectiveKun, hasAttestedAdjectiveKunOnly, type KanjidicIndex, lookupKanji, onyomiOf, retainedAdverbOkurigana } from "./kanjidicLookup.ts";
import {
  classicalAdjectiveReading,
  classicalConjClass,
  classicalVerbEnding,
  readingEndingSplitFor,
  splitKunWordClass,
} from "./classicalEnding.ts";
import {
  attestedClassicalParadigm,
  findCompoundSpans,
  isModernIchidanLemma,
  type JmdictIndex,
  lookupLemma,
  lookupModernisedLemma,
} from "./jmdictLookup.ts";
import { attestedSenseByModernSpelling, VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
import { splitCompoundReading } from "./compoundReading.ts";
import { compoundFurigana } from "./compoundFurigana.ts";
import { historicalSpelling, type HistoricalKanaIndex } from "./historicalKana.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ConjClass } from "../kakikudashi/classicalConjugation.ts";
import { isDescriptiveToken, parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import {
  caseParticleFor,
  classicalAdjectiveRootReading,
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  // Moved there from this file, and read from there now that a second rule asks
  // it — see `hasObject`'s own doc, and `pinnedKeiyoudoushi`, which refuses a
  // 形容動詞 paradigm to a descriptive that governs an object on exactly the
  // evidence the transitivity check below runs on.
  hasObject,
  isBecomingComplement,
  // "This span is a reduplicated descriptive", read from there rather than
  // written here so that `redupTariReading` below and the として guard in
  // `precedingFormSuppliesShite` cannot come apart about which spans take a
  // タリ活用 paradigm. Its own doc carries the three conditions; the evidence for
  // them is at `redupTariReading`.
  descriptiveRedupSpan,
  isNominalizedFaultNoun,
  isTopicalizedAdjective,
  nextMeaningfulToken,
  syntheticLexiconEntry,
  tariSuffixGroup,
} from "../kakikudashi/conjugationContext.ts";
import { conjugate } from "../kakikudashi/classicalConjugation.ts";
import { rereadGovernedForm } from "../kakikudashi/rereadCharacters.ts";

/** Relations marking a token as part of a multi-character fused span (see
 * `findCompoundSpans` in jmdictLookup.ts for full span detection). This
 * per-token resolver only attempts a jmdict lookup on the token's own
 * (possibly already multi-character) lemma when it carries one of these
 * relations — resolving a whole span as a single fused reading/furigana
 * unit spanning several *tokens* is the render layer's job, done by calling
 * `findCompoundSpans` + `lookupLemma(index, span.text)` directly, not
 * through this per-token resolver. */
const SPAN_DEPS = new Set(["compound", "compound@redup", "flat", "flat@vv", "flat@foreign"]);

/** Tokens resolved to nothing, keyed by "text:pos:dep", with an occurrence
 * count — a running "gaps" report for prioritizing future override-table
 * additions. Exported directly rather than via a callback since callers
 * (dev tooling, a console warning list) just want to inspect it after a
 * batch of resolutions. */
export const unresolvedLog = new Map<string, number>();

function logUnresolved(token: Token): void {
  const key = `${token.text}:${token.pos}:${token.dep}`;
  unresolvedLog.set(key, (unresolvedLog.get(key) ?? 0) + 1);
}

/** 者 reads は (topic marker) when it follows — is modified (`mod`) by — a
 * bare noun or name (孔子者 -> 孔子は, "as for Confucius..."), but もの
 * (nominalizer, "the one who...") when modified by a verb (知者 -> 知る者,
 * "one who knows"; 仁者 -> 仁なる者, since this parser tags a stative
 * predicate like 仁/賢 not NOUN but — up to 0.3.1 — VERB with `Degree=Pos`,
 * and from 0.3.2 ADJ, when it's used predicatively like this. Either tag
 * falls past the nominal test below and reaches もの, which is why the
 * recoding changed nothing here). 者's own (pos, dep) can't distinguish these —
 * it's always tagged PART/subj or PART/comp:obj either way — so this reads
 * its *modifier's* POS instead, the one token in the sentence with
 * `head === token.id && dep === "mod"`. Returns undefined (falls through to
 * the catch-all もの override) for anything else modifying 者, or for 者
 * with no modifier at all (bare 者 as a stand-alone pronoun-like "someone"). */
function zheTopicReading(token: Token, sentence: Sentence | { tokens: Token[] }): "は" | undefined {
  if (token.text !== "者") return undefined;
  const modifier = sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && t.dep === "mod");
  if (modifier && (modifier.pos === "NOUN" || modifier.pos === "PROPN")) return "は";
  return undefined;
}

/** The adjacent modifier+head pair `token` belongs to, if it belongs to one
 * this module reads as a single Sino-Japanese word — a numeral modifying a
 * noun (三人 サンニン, 五十歩 ゴジッポ) or an adverb modifying a verb (大破
 * タイハす). Returns the pair from either end, since the resolver is asked
 * about one token at a time and both members need the same answer.
 *
 * Adjacency is a condition in its own right, on top of the relation: an
 * adverb reads as half of a compound only when it stands directly before
 * the verb, and a `mod` edge reaching across intervening tokens is a
 * clause-level modification of some looser kind. Checked on token ids in
 * source order (`modifier.id + 1 === head.id`), the same way
 * `findCompoundSpans` tests adjacency, not on the dependency alone.
 *
 * A negation is excluded outright. 不/未 are tagged ADV and attach to their
 * verb by `mod` exactly as 大 does, and 不知 is even listed in JMdict (ふち,
 * "being unknown") — but they are read as postposed ず, by their own branch
 * in both panels, and letting this rule claim them would put a second,
 * competing reading on the character. */
/** Which of the two modifier+head shapes a pair is: a numeral counting a
 * noun, or any other modifier standing directly on a verb or a noun. The
 * distinction is exactly the one thing that differs between them — whether a
 * dictionary has to attest the pair before it is read as one word. See
 * `onyomiPairReading`. */
type PairKind = "numeral" | "modifier";

export function modifierHeadPair(
  token: Token,
  sentence: { tokens: Token[] },
): { modifier: Token; head: Token; kind: PairKind } | null {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const classify = (modifier: Token, head: Token): PairKind | null => {
    if (modifier.dep !== "mod" || modifier.id + 1 !== head.id) return null;
    if (parseMorphFeatures(modifier.morph ?? "").Polarity === "Neg") return null;
    if (modifier.pos === "NUM" && (head.pos === "NOUN" || head.pos === "PROPN")) return "numeral";
    // A **classifier** counted by a quantifier that is not a numeral is the
    // same word-formation under a different first half, and the treebank says
    // so in the head's own morphology rather than in the relation: 厚半寸 has
    // 半 (VERB, `v,動詞,描写,量`) standing `mod` on 寸, and 寸 carries
    // `NounType=Clf`. Read as an ordinary `modifier` pair it needed a
    // dictionary that has no 半寸, so 半 fell through to its kun'yomi and came
    // out as a *predicate* — なかば, with its own okurigana — splitting the
    // measure phrase in two. Under `numeral` it is はんすん, one word.
    //
    // **Why the feature is enough here when it is not enough on its own.**
    // `NounType=Clf` is on 1,296 gold tokens and is *not* the `clf` relation's
    // twin — 640 of them stand on `mod`, 536 on `clf`, and 1,472 `clf` tokens
    // carry it only 506 times. What makes it decisive is the company it keeps:
    // of the tokens standing `mod` immediately before a `NounType=Clf` head,
    // **508 are NUM** — already claimed by the line above — and only **13** are
    // anything else. Restricting the new admission to a quantifier-like
    // modifier (VERB or ADV, the two classes this treebank tags 半 with: 74
    // VERB and 14 ADV of its 96 tokens, and NUM never) takes 3 of those 13 and
    // leaves the other 10, which are nouns and proper nouns standing in a
    // genitive rather than counting anything — 城方八里 is 城の方, 周尺 is 周の尺.
    //
    // The 3 are 厚半寸 (半寸 はんすん), 以治郡高第 (高第 かうだい) and 逐牛行幾里
    // (幾里). The last is the one measured counter-example and is recorded
    // rather than excluded: 幾 is the interrogative "how many", which kundoku
    // reads いくばく里 rather than the きり this gives it. One token in 433,169,
    // against a rule that is right on the other two and on every numeral.
    //
    // **The tags in that survey are 0.3.1's and the class has moved.** 半 is a
    // `v,動詞,描写,量` stative, and parser 0.3.2 recodes that whole class off
    // VERB: over the recoded gold (`…rulemerged.adjfix`) 半 is ADJ 75 / ADV 14
    // / NOUN 7 and VERB **0**, and the three admitted counter-examples above
    // are now 厚半寸 (半 **ADJ**), 以治郡高第 (高 **ADJ**) and 逐牛行幾里 (幾 ADV).
    // Re-measured on that data the `mod` modifiers before a `NounType=Clf`
    // head are NUM 507, NOUN 7, PROPN 2, **ADJ 2**, SCONJ 2, ADV 1 — so a
    // VERB/ADV gate now takes 1 of the 14 where it used to take 3, and the two
    // it drops are the two the rule was written for. VERB is kept beside ADJ
    // rather than replaced by it: it costs nothing (0 gold tokens) and a live
    // tree, or a hand-corrected one, can still say VERB.
    if (
      (isContentPredicatePos(modifier.pos) || modifier.pos === "ADV") &&
      head.pos === "NOUN" &&
      parseMorphFeatures(head.morph ?? "").NounType === "Clf"
    ) {
      return "numeral";
    }
    // An adverb over a verb *or* a noun, and gated the same way in both. The
    // noun case was briefly ungated, on the argument that Japanese has no
    // reading of 獨酌 in which ひとり modifies a noun 酌, so the pair could
    // only ever be a Sino-Japanese compound. The argument has a
    // counter-example: 金就礪則利 puts 則 (ADV) directly before 利 (NOUN), and
    // 則 there is すなはち, a clause connective joining two clauses — not half
    // of a word — so the ungated per-character fallback read it そく. What
    // the argument missed is that an adverb precedes whatever follows it
    // whether or not the two are related, and adjacency alone cannot tell a
    // compound from a connective that happens to sit next to a noun.
    //
    // The gate was never the wrong idea; it was failing on orthography. 獨酌
    // and 大亂 are absent from JMdict while 独酌 and 大乱 are in it, so the
    // check was refusing real compounds for being spelled in 旧字体 — which
    // `shinjitaiSpelling` now fixes at the lookup itself, for every caller.
    //
    // The modifier's own POS is not a condition. It was ADV alone, from the
    // narrower rule this generalises — but nothing in the argument above
    // turns on the modifier being an adverb: what makes a pair one word is
    // that the dictionary says so, and that check is put to the pair
    // whatever the parser calls its first half. This treebank tags a
    // descriptive modifier VERB (佳 in 佳釀, 良 in 良醞, 半 in 半種 — all
    // `mod`, all Degree=Pos), and 佳醸 かじょう is a JMdict headword read
    // on'yomi throughout while 良醞 and 半種 are not words at all: the gate
    // separates them, exactly as it separates 大破 from 大喜.
    // ADJ joins VERB in the head position for the reason the modifier arm
    // above gives: 佳/良/半 are the modifiers this doc names, and the *heads*
    // move with them — over the recoded gold **3,362** adjacent `mod` edges
    // now have an ADJ head where under 0.3.1 every one of them was a VERB.
    // Nothing about the argument turns on the head being a verb: what makes a
    // pair one word is that JMdict says so, and `onyomiCompound` is still the
    // gate that decides it.
    //
    // **An adjective before a noun was measured as a candidate for exclusion
    // here and is deliberately left in.** The reading it produces is a jukugo
    // — 高山 かうざん — where attributive modification would want 高き山, so the
    // question is real; what settles it is which of the two this construction
    // mostly *is*. Over the recoded gold a descriptive standing `mod`
    // immediately before a nominal head is **6,552** edges, and the commonest
    // of them are lexicalised outright: 大夫 514, 太子 354, 寡人 324, 大王 233,
    // 皇帝 162, 太后 142, 大臣 67, 太祖 52, 皇后 29, 太守 28. Every one of those
    // is read on'yomi in kundoku and none is a live adjective phrase, so a
    // blanket refusal would misread the commonest shape in the corpus to
    // correct a rarer one. Nothing in the tree separates the two: only 165 of
    // the 6,552 have a head carrying `NameType` or tagged PROPN, and the
    // dictionary holds 高山 and 良馬 as readily as it holds 太子. See the report
    // accompanying this note — the line has to be drawn by a curated list or
    // by the reader, not by a feature.
    if (isContentPredicatePos(head.pos) || head.pos === "NOUN" || head.pos === "PROPN") return "modifier";
    return null;
  };

  const head = byId.get(token.head);
  if (head && head.id !== token.id) {
    const kind = classify(token, head);
    if (kind) return { modifier: token, head, kind };
  }
  const modifier = sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && classify(t, token) !== null);
  if (modifier) return { modifier, head: token, kind: classify(modifier, token)! };
  return classifierPair(token, sentence);
}

/** The **`clf` pair** `token` belongs to — a classifier and the quantity it
 * counts, returned in reading order with the quantity first.
 *
 * Held apart from `classify` above because the tree runs the other way. Every
 * pair that function reads is *modifier -> head*, the first token depending on
 * the second; a `clf` edge is the reverse — 行千里 comes back with 千 as the
 * root and 里 hanging off it — so neither of that function's two searches ever
 * presents the two in the order it tests. That is the whole of why 千里 was
 * read ちさと, two kun'yomi standing side by side, where 三年 (which this parser
 * labels `mod`, not `clf`) was already さんねん: one relation reached the rule
 * and the other could not.
 *
 * **The relation is the claim, so no POS condition is put on the quantity.**
 * Counted over `lzh_kyoto-sud-{train,dev,test}` (86,239 sentences), `clf` is
 * **1,472** tokens: the classifier is a NOUN in 1,471 of them, and its head is
 * NUM 1,392, NOUN 73, VERB 5, ADV 2. Admitting only the NUM heads would be
 * 94.6% of the relation and would drop exactly the pairs a reader would notice
 * — 數仞 すうじん, 餘歲 よさい, 元年 ぐわんねん, 正月 しやうぐわつ — each as much a
 * Sino-Japanese word as 千里 is. What the label says is "this noun is a
 * classifier and that is what it is counting", and nothing else it can be said
 * of makes the pair two words.
 *
 * Adjacency in *reading* order is required, and it is what the relation almost
 * always has: the classifier stands immediately after its head **1,439** times,
 * one before it 21, and further off 12. A pair the reader will not see as
 * contiguous kanji is not one to fuse a reading across, the same condition
 * `classify` puts on a `mod` pair and `findCompoundSpans` on a span.
 *
 * Returned as `numeral` so `onyomiPairReading` reaches `perCharacterOnyomi`
 * where no dictionary lists the pair — 千里 せんり is in JMdict, but 六年 and
 * 百畝 are not, and a classifier phrase is read on'yomi whether or not it has
 * been lexicalized, for the reason that rule already gives about numerals. */
function classifierPair(
  token: Token,
  sentence: { tokens: Token[] },
): { modifier: Token; head: Token; kind: PairKind } | null {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const asClassifier = (clf: Token): { modifier: Token; head: Token; kind: PairKind } | null => {
    if (clf.dep !== "clf" || clf.pos !== "NOUN") return null;
    const counted = byId.get(clf.head);
    if (!counted || counted.id + 1 !== clf.id) return null;
    return { modifier: counted, head: clf, kind: "numeral" };
  };
  // Asked from either end, exactly as `modifierHeadPair` is: the resolver
  // hands this one token at a time and both members owe the same answer.
  return asClassifier(token) ?? (sentence.tokens.filter((t) => t.head === token.id).map(asClassifier).find((p) => p !== null) ?? null);
}

/** Every character of a pair read on'yomi throughout, or null.
 *
 * Preferring the dictionary's own reading of the whole word to two
 * independently chosen on'yomi is what gets 大破 right: 大's *first*
 * on'yomi is ダイ, and only 大破's own JMdict entry (たいは) says this word
 * takes タイ. `splitCompoundReading` is what divides that reading back into
 * one piece per character, exactly as the compound-span path already does.
 *
 * Every piece then has to *be* one of its character's on'yomi, and that
 * check is what makes this rule safe to apply to any adverb+verb pair the
 * dictionary happens to list rather than to a hand-picked set: 大喜 is in
 * JMdict too, as おおよろこび, which splits into kun'yomi and so is
 * correctly refused — 大喜 is 大いに喜ぶ, two words, not a Sino-Japanese
 * compound. Of the adverb+verb pairs in the live parses this was checked
 * against (必問, 皆知, 復見, 遂去, 相見, 又問, 深思, 大破, 大亂), only 大破 and
 * 大亂 — the two that really are single words — pass it. */
function onyomiCompound(chars: string[], kanjidic: KanjidicIndex, jmdict: JmdictIndex): string[] | null {
  // The one lookup in this file that modernises the spelling before giving
  // up — kanbun is written in 旧字体 and JMdict is keyed on 新字体, so 獨酌
  // and 大亂 were missing a dictionary that holds 独酌 and 大乱. The gate
  // below was refusing real compounds for their orthography, which is what
  // made an ungated adverb+noun case look necessary in the first place.
  const hit = lookupModernisedLemma(jmdict, chars.join(""));
  if (!hit) return null;
  const split = splitCompoundReading(chars, hit.reading, kanjidic);
  if (!split) return null;
  return split.every((piece, i) => onyomiOf(kanjidic, chars[i]).includes(piece)) ? split : null;
}

/** Each character's own first on'yomi — the fallback for a numeral+noun
 * pair no dictionary lists as a word (五十歩 is not a JMdict headword,
 * though 五十歩百歩 is). Only numerals get it, and that is the whole of the
 * difference between the two `PairKind`s: a numeral and the noun it counts
 * are read on'yomi in kanbun whether or not the pair is lexicalized (三人
 * サンニン, 百歩 ヒャッポ), because a numeral standing before its noun is
 * counting it and can be doing nothing else. An adverb has no such
 * guarantee — it is read as half of one word only when it *is* one, which is
 * what the dictionary check above establishes and what keeps 則利 out.
 * Returns null if any character has no on'yomi at all.
 *
 * `countedFrom` is where the counted noun's own characters begin, so the
 * classifier can be given `CLASSIFIER_ONYOMI` in place of the first entry in
 * KANJIDIC2's list. Everything before it is the quantity and takes the first
 * on'yomi as it always did. */
function perCharacterOnyomi(chars: string[], kanjidic: KanjidicIndex, countedFrom: number): string[] | null {
  const readings = chars.map((ch, i) =>
    i >= countedFrom ? CLASSIFIER_ONYOMI[ch] ?? onyomiOf(kanjidic, ch)[0] : onyomiOf(kanjidic, ch)[0],
  );
  return readings.every((r) => r !== undefined) ? (readings as string[]) : null;
}

/** **Which on'yomi a character takes when it is the thing being counted**,
 * where that is not KANJIDIC2's first.
 *
 * The fallback above takes `onyomiOf(...)[0]`, and for most classifiers there
 * is nothing to choose: of the 1,472 `clf` tokens in
 * `lzh_kyoto-sud-{train,dev,test}`, **915** have a classifier with exactly one
 * on'yomi (里 リ, 年 ネン, 寸 スン, 乘 ジョウ), 44 have one KANJIDIC2 does not
 * list at all (歲 40, 戶 4 — 旧字体 the modern index is keyed away from, a gap
 * of its own and not this table's business), and 513 spread over 38 characters
 * have more than one. For most of those 38 the first is also the counter — 月
 * ゲツ, 日 ニチ, 尺 シャク, 世 セイ, 步 ホ, 斗 ト, 家 カ — and they are absent
 * here for that reason rather than by oversight.
 *
 * The three below are the ones where it is not, listed with what the corpus
 * spends on each:
 *
 *  - **人 → ニン** (194 `clf` tokens, 13% of the whole relation, and the single
 *    largest ambiguous classifier). KANJIDIC2 orders 人 ジン before ニン, and
 *    ジン is the reading of 人 as "person" in the abstract (詩人, 人生); ニン is
 *    the counter (三人 さんにん, 何人 なんにん). Without this the app
 *    **contradicted itself about one word**: 三人 is a JMdict headword read
 *    さんにん and came out right through `onyomiCompound`, while 一人 — whose
 *    JMdict entry is the kun ひとり and so is correctly refused by that gate —
 *    fell to this fallback and printed いち**じん**. Two spellings of the same
 *    counter, decided by whether a dictionary happened to list the numeral.
 *  - **畝 → ホ** (27). ボウ heads the list; the Chinese area measure is ホ,
 *    which is what 百畝 ひゃっぽ is built on.
 *  - **石 → コク** (5). セキ is the stone; コク is the volume measure, 一石
 *    いっこく.
 *
 * 分 (8 tokens, ブン first where the measure is ブ) is deliberately left out:
 * unlike the three above it is a measure in only some of its uses, and 十分
 * じゅうぶん is the commoner word. Kept as a list rather than derived because
 * KANJIDIC2 records no counter/non-counter distinction among a character's
 * on'yomi — the same reason `INTENTION_VERB_LEMMAS` in conjugationContext.ts is
 * hand-listed, and checked the same way, against what the corpus actually
 * spends. Consulted only for the counted half of a pair this module has already
 * decided is one Sino-Japanese word, so a 人 anywhere else is untouched.
 *
 * Written in hiragana because `onyomiOf` is: KANJIDIC2 stores on'yomi in
 * katakana and that function folds them, and these strings have to compare and
 * substitute against its output and then be keyed into the historical-kana
 * index, which is hiragana throughout. */
const CLASSIFIER_ONYOMI: Readonly<Record<string, string>> = { 人: "にん", 畝: "ほ", 石: "こく" };

/** Whether the parse says this token is a **predicate standing in a nominal
 * slot** — tagged NOUN or PRON in the UPOS column while the treebank's own
 * finer tag calls it a verb.
 *
 * The two columns disagree often enough to be evidence, and here they
 * disagree in the direction that matters: 出 in 有物出 (sent_id 24) is `NOUN`
 * with the xpos `v,動詞,行為,移動`, and 長 in 長三寸許 (sent_id 25) is `NOUN`
 * with `v,動詞,描写,量`. Neither is a noun. Each is a verb or an adjective
 * filling a nominal slot, which classical Japanese reads by nominalising it —
 * 物の出づる有り, 長さ三寸ばかり — and that is what the reading has to carry,
 * since a token not tagged VERB never reaches either panel's conjugation
 * branch (`usesLexiconEntry`) and so cannot be inflected there.
 *
 * The same tie-break `isVerbalXpos` in conjugationContext.ts makes for the
 * opposite question, and made the other way round on purpose: that one asks
 * whether a token *tagged* VERB really is one and trusts the UPOS where the
 * xpos is missing, because a tree written by hand should behave as it did
 * before. This one asks whether a token tagged NOUN is secretly a verb, so an
 * absent xpos has to answer *no* — trusting the UPOS there would fire on every
 * noun in a tree that carries no xpos at all.
 *
 * PROPN is deliberately not admitted. It never reaches a kun'yomi at all
 * (`lookupKanji`'s `eligible`), and a proper noun the parser has mis-tagged is
 * the case that file already declines to second-guess. 縛 in 解縛視之 is
 * `PROPN`/`NameType=Giv` with a verbal xpos — the parser reading "Bound" as a
 * given name — and it stays ばく here, reported rather than compensated for.
 *
 * **The subject slot, and only it.** The rule read "a nominal slot" and took
 * every one — and an object slot is a nominal slot too, which is how 嗜飲 came
 * out **飲むを嗜む**. The reader's answer is 飲を嗜む: 飲 there is the ordinary
 * Sino-Japanese noun "drink", exactly the 飲 this same text reads as one two
 * sentences later (不以飲爲累 -> 飲をもつて累と爲せざるなり) and again in 飲食.
 *
 * The two slots are not alike, and the difference is what the disagreement
 * between the columns can be made to settle:
 *
 *  - **In the subject slot the UPOS cannot be believed.** A NOUN reading of 出
 *    in 哇有物出 gives 物出有り and of 長 in 赤肉長三寸許 gives 肉長三寸, neither of
 *    which is a reading at all. Something has to give, and it is the coarse tag —
 *    which is the argument this rule was written on, and both of the sentences it
 *    was written for are `subj`.
 *  - **In an object slot it can.** A verbal character standing as an object is
 *    routinely the noun of the action: 求醫療, 成佳釀, 惡酒如仇, 覺癢, 解縛. The
 *    nominal reading is available, it is what the UPOS says, and nothing in the
 *    sentence forces a verb. Where the parse really does mean a *predicate* in an
 *    object slot it says so in the column that decides — it tags it VERB — and
 *    `isNominalizedObjectPredicate` in conjugationContext.ts is the rule that
 *    then reads it 連体形 + を. That rule requires `pos === "VERB"` precisely so
 *    that the two halves of the question do not both answer.
 *
 * So the gate is the relation, written as `isNominalizedSubjectPredicate` writes
 * it (`subj` and its subtypes) so the subject-slot rule on the reading side and
 * the subject-slot rule on the conjugation side name the same slot.
 *
 * **What it costs, over the reader's own tree** (`酒蟲`, 39 sentences): 13 tokens
 * pass the POS/xpos test and **4 of them are `subj`** — 出 in 哇有物出, 長 in
 * 赤肉長三寸許, and the two 飲 heading 飲食 (sent_id 34) and 飲啄 (35). The other
 * nine are `comp:obj` (飲 in 嗜飲, 療, 癢, 縛, 釀, 仇), `comp:pred` (累),
 * `comp:obl` (何), `compound` (饞), `parataxis` (熾) and `conj:coord` (啄), and
 * the only one of the nine whose printed reading changes is the 飲 this is about.
 * Both sentences the rule was written for are among the four kept. */
function isVerbalNominal(token: Token): boolean {
  if (token.dep !== "subj" && !token.dep.startsWith("subj@")) return false;
  return isNominalTaggedVerbally(token);
}

/** The one object-slot case the rule above holds out and should not — a verbal
 * nominal whose character offers **no nominal reading to take instead**.
 *
 * `isVerbalNominal`'s exclusion of the object slot rests on a premise, stated in
 * its own doc: that a verbal character standing as an object is routinely the
 * noun of the action, and that "the nominal reading is available". It is, for
 * every character that argument was measured on — 療 is れう, 釀 じやう, 累 るゐ,
 * 仇 あた. It is not available for a character whose kun'yomi are all inflecting
 * ones, because `pickKun` drops every one of them for a nominal and the on'yomi
 * it then falls through to is a bare Sino-Japanese stem: 忽覺咽中暴癢's 癢 came
 * out ヨウ, which is not a reading of anything. So the premise is written out as
 * the condition it always was, and where it fails the character nominalises its
 * own adjective instead — 癢 as かゆさ, the noun of the quality being felt.
 *
 * `hasAttestedAdjectiveKunOnly` is the test and the dictionary is what makes it
 * safe; see it for what it selects, and for the measurement (one token across
 * lzh-train/dev/test, and this 癢 in the reader's own tree).
 *
 * The object slot alone, and not every slot the rule above refuses. `subj` is
 * already admitted; a `ROOT` or a `comp:pred` is a *predicate* rather than a
 * nominal slot, and a nominalisation there would answer a question nobody asked
 * — 良 tagged NOUN and heading its own clause wants the 終止形 よし, which is what
 * a predicate wants, not the noun よさ. */
function isQualityNounInObjectSlot(token: Token, kanjidic: KanjidicIndex, jmdict: JmdictIndex): boolean {
  if (token.dep !== "comp:obj" && !token.dep.startsWith("comp:obj@")) return false;
  return isNominalTaggedVerbally(token) && hasAttestedAdjectiveKunOnly(kanjidic, jmdict, token.text);
}

/** A NOUN or PRON this treebank's own xpos calls a verb — the shape both rules
 * above are about, written once so they cannot come to disagree about it. */
function isNominalTaggedVerbally(token: Token): boolean {
  return (token.pos === "NOUN" || token.pos === "PRON") && (token.xpos ?? "").startsWith("v,");
}

/** Whether *this* occurrence of a word `READING_ENDING_SPLITS` divides — これ
 * as こ+レ, より as よ+リ — actually takes that division, and what it is.
 *
 * The table and the division itself live in `classicalEnding.ts`, because the
 * furigana menu needs the same answer and sits on the far side of this file's
 * import edge; see `READING_ENDING_SPLITS` there for which words are divided
 * and why the rule is keyed by the reading rather than by the character. What
 * is left here is the pair of conditions that are facts about a token in a
 * sentence rather than about the word.
 *
 * The ending slot holds one run, and a case particle is written in it too:
 * 見之 is これヲ, and splitting the reading as well would put レヲ beside a
 * character reading こ, breaking the word in half to write a two-kana ending.
 * Where the particle takes the slot the reading stays whole; where nothing
 * does, the ending is written as the okurigana it is. Both occur in one text —
 * 一番僧見之 (これヲ) and 曰：「有之。」 (こレ) are four sentences apart.
 *
 * `caseParticleFor` is what decides that, and it is the same call both panels
 * make about this very token — `withCaseParticle` in KundokuView.ts and the
 * `caseParticle` field on generator.ts's own piece — so the condition here
 * cannot come apart from the particle it is conditioned on. Asked in the
 * resolver rather than in either panel for that reason: the split has to be
 * one answer, and this is the one place both panels read the reading from.
 *
 * The characters reach this from different branches, which is why the function
 * takes the reading rather than reading it off a table: 之's これ is an
 * `overrides.json` entry (so the 書き下し文 prints これ in kana), while 此's and
 * 是's come from KANJIDIC2's own kun list (so the prose keeps the kanji and
 * prints 此れ). The split is the same either way; what differs is only what the
 * prose does with a reading, which is `spellOutInProse`'s business and not this
 * one's — and an override-sourced split still prints its two halves run
 * together there (see `generateKakikudashiPieces`, which writes reading +
 * okurigana), so 藍より取る is unaffected by より being divided here. */
function readingEndingSplit(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
  resolved: { reading: string; okurigana?: string },
): { reading: string; okurigana: string } | null {
  const split = readingEndingSplitFor(resolved.reading, token.pos);
  // Asked first, and the two conditions below only of a reading it divides —
  // `caseParticleFor` walks the sentence, and every reading this app settles
  // on would otherwise pay for a rule that speaks about two words.
  if (!split) return null;
  // An ending of its own already claims the slot, exactly as a case particle
  // does. Nothing reaches here with one today; the condition is the same
  // statement as the particle test below and is written beside it.
  if (resolved.okurigana) return null;
  if (caseParticleFor(token, sentence)) return null;
  return split;
}

/** Whether the curated table states a reading for `token` *in the role it
 * actually occupies* — an entry naming a `contextPos` or a `contextDep`, and
 * whose named context this token matches (`findOverride` returns the most
 * specific matching entry, so a character holding both kinds answers with the
 * conditioned one wherever its condition is met).
 *
 * This is the one thing that stands the pair rule below down, and the
 * distinction it draws is the whole of why the pair rule can sit ahead of
 * `findOverride` at all. The two kinds of entry make different claims:
 *
 *  - A char-only entry is the character's reading *standing on its own* —
 *    獨 is ひとり. It says nothing about the character as half of a word, so
 *    the pair rule, which knows it is not standing on its own, outranks it.
 *    This is exactly the case the ordering was introduced for: 獨酌 read
 *    ひとり酌 while 独酌 sat in JMdict as どくしゃく, and it goes on reading
 *    ドクシャク.
 *
 *  - A conditioned entry names the syntactic role, and so speaks about this
 *    token as it actually stands. A predicative 然 is しかり — and in 果然 the
 *    然 the pair rule is claiming *is* that predicate. (Both this 然 and the
 *    果 before it are tagged ADJ from parser 0.3.2, where they were VERB
 *    before; the two `overrides.json` entries name both tags.) A hand-verified statement
 *    about the character in this very role outranks the dictionary's word
 *    list, which knows only that the two characters appear together as a
 *    modern headword and nothing about how kanbun reads them.
 *
 * Asked of both members, because being one word is a property of the pair:
 * 果然 is read はたして然り in kundoku, not かぜんす, and it takes only one end
 * of it to be spoken for. Two pairs in the live text turn on this, and both
 * are conventionally read kun throughout — 果然 (JMdict かぜん, "as was
 * expected") and 固有 (JMdict こゆう, "inherent") in 豈飲啄固有數乎, where 有
 * is the ordinary あり. There is no enumeration of such pairs on offer here:
 * JMdict holds tens of thousands of two-character headwords and no list says
 * which of them a kanbun reader takes as one Sino-Japanese word, so this
 * catches only those a curated entry already speaks for, and other pairs of
 * the same kind certainly remain. */
function curatedInRole(token: Token): boolean {
  const entry = findOverride(token.text, token.pos, token.dep);
  return entry !== null && (entry.contextPos !== undefined || entry.contextDep !== undefined);
}

/** The on'yomi reading of `token` as one half of a modifier+head pair read
 * as a single Sino-Japanese word, or null if it is not in one.
 *
 * `historicalKana` is applied per character, to that character's own modern
 * on'yomi, exactly as the ordinary kanjidic path applies it — on'yomi in
 * this app is written in 歴史的仮名遣い, so a reading arriving here from
 * JMdict (modern) has to go through the same index or 三十 would print
 * さんじゅう next to a さんじふ produced anywhere else. */
function onyomiPairReading(
  token: Token,
  sentence: { tokens: Token[] },
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
  historicalKana: HistoricalKanaIndex | undefined,
): ResolvedReading | null {
  const pair = modifierHeadPair(token, sentence);
  if (!pair) return null;
  // See `curatedInRole`. A conditioned curated entry for either member is a
  // statement about that character in the role it is standing in here, and
  // outranks the dictionary's claim that the two of them are one word.
  if (curatedInRole(pair.modifier) || curatedInRole(pair.head)) return null;
  const chars = [...pair.modifier.text, ...pair.head.text];
  const readings =
    onyomiCompound(chars, kanjidic, jmdict) ??
    (pair.kind === "numeral" ? perCharacterOnyomi(chars, kanjidic, [...pair.modifier.text].length) : null);
  if (!readings) return null;

  const start = token.id === pair.modifier.id ? 0 : [...pair.modifier.text].length;
  const own = chars
    .slice(start, start + [...token.text].length)
    .map((ch, i) => historicalSpelling(historicalKana, ch, readings[start + i]));

  // The head of the pair carries the whole word's ending; the modifier is
  // half of one word and takes none (see `endingComplete` below). Asked of
  // the *head's* POS and not the token's own, because the ending belongs to
  // the pair: when the modifier was required to be an adverb this came to the
  // same thing, since an ADV is not a VERB and so was never given one — and
  // the moment any modifier could qualify, 佳釀 printed 佳す釀す, the サ変
  // ending written twice over one word.
  //
  // **VERB and not ADJ, and under parser 0.3.2 that exclusion is real for the
  // first time.** Up to 0.3.1 a stative head was tagged VERB like any other
  // predicate, so this test could not tell 大破 from a descriptive pair and
  // gave both the サ変 す. It can now: the head of a pair the dictionary reads
  // as one on'yomi word is either a verb (破, 破す) or a descriptive, and a
  // descriptive jukugo is a noun or a 形容動詞 — 高大 is かうだい and never
  // 高大す. Left as VERB, the ADJ-headed pair simply takes no ending here and
  // the copula machinery decides on its own evidence, which is what the two
  // exclusions this comment already names were always for.
  const isHead = token.id === pair.head.id;
  const onyomiVerb = isHead && pair.head.pos === "VERB";

  return {
    reading: own.join(""),
    // A verb read on'yomi is read サ変 in kundoku — 大破す, never a bare
    // stem. The same supplement `chosenReading.ts` makes for a hand-picked
    // on'yomi, for the same reason and on the same POS condition: a noun
    // read on'yomi takes no ending at all.
    okurigana: onyomiVerb ? "す" : undefined,
    // …and サ変 is a paradigm, not the fixed string す. The okurigana above is
    // only its 終止形; naming the class lets the ordinary conjugation pipeline
    // inflect it from context, which is what every other verb reading gets.
    // Without it 大破 was frozen at す everywhere: 大破すの時 for the 連体形
    // (する), 大破すもの before 者, 破すごとに before 毎, and 大破すず for the
    // 未然形, where サ変's mizen is せ.
    ...(onyomiVerb ? { conjClass: "sa-hen" as ConjClass } : {}),
    gloss: kanjidic[token.text]?.meanings[0],
    source: "kanjidic",
    beatsLexicon: true,
    // The modifier is half of one word, not a word of its own, so it takes no
    // ending whatever its own morph says. This parser tags the 大 of 大破
    // `VerbForm=Conv` — true of 大 read おほいに, and false of the たい that is
    // the first half of たいはす — and that morph put a converb て on it: 大破
    // 敵軍 came out 大て敵軍を破す. The ending belongs to the pair, and the
    // pair's head is already carrying it (the サ変 す above).
    ...(isHead ? {} : { endingComplete: true }),
  };
}


/** Either character of a タリ活用形容動詞 binom — 愕然, 突如, 莞爾 — read
 * on'yomi throughout, with the suffix carrying the group's たり, or null where
 * `token` is not in one. See `tariSuffixGroup` for what a group is and why it
 * is found by source adjacency rather than by the dependency edge.
 *
 * **On'yomi is licensed by the shape, not by a dictionary.** This is the one
 * way it differs from `onyomiPairReading` above, and the difference is
 * deliberate: that rule reads a modifier+head pair as one word only when
 * JMdict lists the pair, because an adverb standing before a verb is very
 * often just an adverb standing before a verb (則利 is すなはち利, not ソクリ).
 * A タリ suffix makes no such ambiguous shape — the parser has tagged the
 * character a bound suffix, which is already the claim that these two are one
 * word, and a bound Sino-Japanese suffix is read on'yomi and so is what it
 * binds to. Gating on attestation would have passed here and quietly failed
 * elsewhere: 愕然 is in JMdict, and of the 40-odd distinct 然-binoms in the
 * corpus (喟然, 憮然, 蹴然, 悖然, 浡然, 艴然…) many are not.
 *
 * The dictionary is still *consulted*, one step ahead of the fallback, and
 * what it buys is which on'yomi where a character has more than one — 大破's
 * たいは rather than the ダイ that heads 大's list, the same thing
 * `onyomiCompound` buys the pair rule. Where it has nothing to say, each
 * character's own first on'yomi stands, which is what makes the rule reach a
 * binom no dictionary lists. Both routes then produce one reading per
 * character (`splitCompoundReading` divides the dictionary's, which is one
 * run across both), so the 訓読文 draws がく over 愕 and ぜん over 然 rather
 * than smearing がくぜん across the pair — and it can, because this treebank
 * tokenises one character per token, so a binom is always exactly two tokens
 * and never one.
 *
 * The whole rule declines where either character has no on'yomi at all. That
 * is the honest answer rather than a fallback: "read on'yomi throughout" is
 * the rule, and a group half of which cannot be is not one this can render.
 *
 * `endingComplete` on the stem, for the reason `onyomiPairReading`'s modifier
 * takes it: the ending belongs to the binom and the suffix is already writing
 * it, so the stem's own morph must not add a converb's て on top (the parser
 * tags 愕 `ExtPos=VERB` in the reader's text, and other stems arrive
 * `VerbForm=Conv`). The class rides along on the suffix for the reason every
 * other synthesized class in this file does — たり is only the 終止形, and
 * naming the paradigm is what lets 愕然たる and 愕然と come out of the ordinary
 * conjugation pipeline instead of the one frozen string. */
function tariSuffixReading(
  token: Token,
  sentence: { tokens: Token[] },
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
  historicalKana: HistoricalKanaIndex | undefined,
): ResolvedReading | null {
  const group = tariSuffixGroup(token, sentence);
  if (!group) return null;
  const chars = [...group.stem.text, ...group.suffix.text];
  // `chars.length` as the counted offset: nothing here is a classifier, so
  // `CLASSIFIER_ONYOMI` is out of reach and every character takes its first
  // on'yomi as it always did. 愕然 is a descriptive stem and its suffix, not a
  // quantity and the thing it counts.
  const readings = onyomiCompound(chars, kanjidic, jmdict) ?? perCharacterOnyomi(chars, kanjidic, chars.length);
  if (!readings) return null;

  const start = token.id === group.stem.id ? 0 : [...group.stem.text].length;
  const own = chars
    .slice(start, start + [...token.text].length)
    .map((ch, i) => historicalSpelling(historicalKana, ch, readings[start + i]));

  const isSuffix = token.id === group.suffix.id;
  return {
    reading: own.join(""),
    ...(isSuffix
      ? { okurigana: conjugate("tari-keiyoudoushi", "shuushi"), conjClass: "tari-keiyoudoushi" as ConjClass }
      : { endingComplete: true }),
    gloss: lookupModernisedLemma(jmdict, chars.join(""))?.gloss ?? kanjidic[token.text]?.meanings[0],
    source: "kanjidic",
    beatsLexicon: true,
  };
}

/** Whether the reading a span is drawn with is **on'yomi throughout** —
 * every piece of it one of that character's own attested on'yomi.
 *
 * The same test `onyomiCompound` puts to a modifier+head pair, asked here of
 * the reading `compoundFurigana` produces rather than of a lookup of this
 * module's own: that function is what both panels draw over these characters,
 * so this answers about the word as it actually reaches the page and not
 * about some other analysis of the same two characters. Both of its routes
 * are covered by the one call — a JMdict reading of the whole word, split
 * back across the members, and the per-character on'yomi fallback it takes
 * when the dictionary has nothing.
 *
 * **The historical-kana index is deliberately withheld.** `onyomiOf` answers
 * in KANJIDIC2's own modern kana, and 臥's ぐわ against が is an orthography
 * this app applies to a reading it has already chosen, not a different
 * reading. Checking after the substitution would have failed every on'yomi
 * the index touches.
 *
 * A member `compoundFurigana` cannot read at all fails the test, which is the
 * answer to prefer: a span this app cannot read is not one it can vouch for
 * as Sino-Japanese. So does a character KANJIDIC2 gives no on'yomi for — the
 * fallback hands back its kun'yomi there, and a kun reading is exactly what
 * this is looking for the absence of. */
function isOnyomiSpan(chars: string[], text: string, jmdict: JmdictIndex, kanjidic: KanjidicIndex): boolean {
  const modern = compoundFurigana(chars, text, jmdict, kanjidic, null, () => undefined);
  return modern.every((piece, i) => piece !== undefined && onyomiOf(kanjidic, chars[i]).includes(piece));
}

/** The reading `token` takes as the carrier of a **reduplicated descriptive**
 * — 蕭蕭, 冥冥, 皇皇, 穆穆 — read on'yomi throughout and taking タリ活用, or null
 * where the span it is in is not one.
 *
 * **This is the other タリ shape**, and it is deliberately spelled the way
 * `tariSuffixReading` spells the first: on'yomi throughout, the class named
 * rather than the one frozen string (たり is only the 終止形, and 蕭蕭たる and
 * 蕭蕭として have to come out of the ordinary conjugation pipeline), and the
 * ending belonging to the *group*. Classical grammar draws the タリ class round
 * exactly these two shapes — the stem+然/如/爾/乎/焉 binom and the reduplicated
 * descriptive — so a second dialect of the same claim would be two answers to
 * one question.
 *
 * **Where the ending is written is the whole difficulty.** A reduplication is
 * one of `SPAN_FUSING_DEPS`, so both panels draw the pair through their
 * fused-span branch, which emits a single group ending after the last member.
 * A rule that handed *one member* its own たり would print 木蕭たり蕭たり. So
 * nothing here writes an ending at all: this answers only for the **carrier**
 * (`carrierOf` — the member holding the span onto the sentence), exactly as
 * `spanSuruReading` below does and for its reason, and `compoundSuruOkurigana`
 * spends the answer once, at `lastMemberId`. Both panels take that one string.
 *
 * ── What makes a span a reduplicated descriptive ────────────────────────────
 * `descriptiveRedupSpan` is the test, and it is written next to
 * `pinnedKeiyoudoushi` so the two タリ rules cannot drift; the evidence for its
 * three conditions is here.
 *
 * **Every member the same character, and at least one `compound@redup` edge.**
 * The relation alone is not enough to key on: a span is whatever
 * `findCompoundSpans` unioned together, and its edges need not all be redup
 * ones. Over the gold treebank's `lzh_kyoto-sud-{train,dev,test}` (86,239
 * sentences, 433,169 tokens) all **634** `compound@redup` tokens land in a span
 * — 632 of size two and one span of size four, 陶陶遂遂, where a `flat@vv` joins
 * two different reduplicated pairs into one run. That span is not a
 * reduplication of anything, and the same-character test is what declines it;
 * it goes on reading as it did.
 *
 * **`isDescriptiveToken` on every member**, which is the same test
 * `pinnedKeiyoudoushi` puts to a single pinned character. Descriptive is what
 * separates the タリ reduplication from the other 252: 人人, 世世, 處處 (NOUN
 * throughout), 往往 and 遲遲 (`v,動詞,行為,*`), 濟濟 in its "cross over" sense.
 * Those are nominal or adverbial reduplications, and たり is not what any of
 * them takes — nothing here reaches them, and they read exactly as they did.
 * In gold **382** of the 634 have `Degree=Pos` on both members, and it is the
 * very same 382 that have `v,動詞,描写,*` on both, so the feature and the
 * tagset's own descriptive class agree to the token here. Asking *every*
 * member rather than the carrier alone is what those two figures buy: 390 have
 * it on the head only and 388 on the dependent only, so 14 reduplications carry
 * the feature on one half of a character and not on the other — the same
 * character, twice, annotated two ways. A disagreement there is the treebank
 * being unsure, not a fact about the word, and the conservative reading of it is
 * to decline. 濟濟, 洋洋, 遲遲 and 忽忽 each occur in the corpus both ways, so
 * this is decided per occurrence and not per word, which is right: 濟濟 really
 * is two words.
 *
 * **An object stands the rule down**, because a 形容動詞 governs none — the same
 * guard `pinnedKeiyoudoushi` makes on the same evidence, and the same one
 * `adjectivalSense` below is overruled by. Two gold reduplications have one and
 * both keep the サ変 they read with today: 故壘蕭蕭蘆荻秋 (蘆荻秋 as 蕭's
 * `comp:obj`) and 雙鯉迢迢一紙筆. Whether those parses are right is not this
 * rule's question; what it says is that a descriptive taking an object is being
 * used as a transitive verb, and 蘆荻秋を蕭蕭たり is not a reading.
 *
 * The on'yomi test and the reading both come from `compoundFurigana`, for the
 * two reasons `spanSuruReading` gives at `isOnyomiSpan`: that function is what
 * the panels actually draw over these characters, and a span this app cannot
 * read on'yomi throughout is not one it can vouch for as Sino-Japanese. 蕭蕭 is
 * せう + せう, one reading per character — which is also why no 踊り字 is drawn
 * under either half (`odoriji.ts` asks about a *reading* being a doubled word,
 * and せう is not one), and nothing here changes that. */
function redupTariReading(
  token: Token,
  sentence: { tokens: Token[] },
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
  historicalKana: HistoricalKanaIndex | undefined,
): ResolvedReading | null {
  const span = descriptiveRedupSpan(token, sentence);
  if (!span) return null;
  if (carrierOf(span, sentence).id !== token.id) return null;

  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const members = span.tokenIds.map((id) => byId.get(id)!);
  const chars = members.map((t) => t.text);
  if (!isOnyomiSpan(chars, span.text, jmdict, kanjidic)) return null;
  const readings = compoundFurigana(chars, span.text, jmdict, kanjidic, historicalKana ?? null, () => undefined);
  const own = readings[span.tokenIds.indexOf(token.id)];
  if (!own) return null;
  const listed = lookupLemma(jmdict, span.text);

  // **The two タリ shapes can be the same word**, and where they are, only one
  // of them may write the ending. 綽綽然, 循循然, 巍巍乎, 空空如 are a
  // reduplicated stem carrying a タリ *suffix*: `tariSuffixGroup` claims the
  // last member and the 然/乎/如 beside it (its own doc gives the corpus for
  // reading the stem backwards from the suffix rather than off the head edge,
  // and names these very reduplications as the shape that made it necessary),
  // and `tariSuffixReading` has already put the group's たり on the suffix. A
  // second ending after the span writes it twice — 巍巍たり乎たり, and 巍巍す
  // 乎たり before this rule existed at all.
  //
  // So the span takes none, which is exactly the `endingComplete` that rule
  // marks its own stem with, made here about a stem two characters long: the
  // ending belongs to the word and the suffix is already writing it.
  //
  // That flag is what keeps *this* answer honest — the reading of a stem
  // carries no ending, and the token inspector shows what the resolver claims.
  // What stops the panels writing one anyway is `compoundSuruOkurigana`'s own
  // タリ-suffix branch, which returns `""` for the same 79 spans; the span
  // branch of both panels never consults `endingComplete`, so a reading that
  // only said so would still have taken the converb's て out of
  // `extraEndingFor` (蕩蕩**て**乎たり). Two facts, said in the two places that
  // can act on them.
  const last = members[members.length - 1];
  const suffixGroup = tariSuffixGroup(last, sentence);
  if (suffixGroup && suffixGroup.stem.id === last.id) {
    return { reading: own, endingComplete: true, gloss: listed?.gloss, source: listed ? "jmdict" : "kanjidic", beatsLexicon: true };
  }

  return {
    reading: own,
    // たり is only タリ活用's 終止形. Naming the class is what lets 滔滔**たる**
    // もの before a nominalizer, 蕭蕭**として** handing on to the next clause and
    // 昭昭**たら**しむ under a causative come out of `decideConjForm` rather than
    // being one frozen string — the same supplement, for the same reason, that
    // `tariSuffixReading` and `spanSuruReading` both document. All three are
    // gold sentences, and the sweep reaches every slot of the paradigm except
    // the 已然形: `isConditionalTemporalClause` refuses a `v,動詞,描写,*` token
    // outright ("a manner or degree adverb rather than a clause"), and a
    // descriptive is what this rule is entirely made of, so 蕭蕭たれば is a
    // reading nothing here can produce. That exclusion is that rule's own and
    // is left standing.
    okurigana: conjugate("tari-keiyoudoushi", "shuushi"),
    conjClass: "tari-keiyoudoushi" as ConjClass,
    beatsLexicon: true,
    // The class is the **span's**, not this character's — see the field's own
    // doc. It is what `compoundSuruOkurigana` gates on, and so what makes the
    // ending appear once, after the last member, instead of once per character.
    suruCompound: true,
    // Both from the same entry or from neither, exactly as in `spanSuruReading`:
    // `compoundFurigana` takes the whole word's reading from JMdict where JMdict
    // holds it and falls back to each character's own on'yomi where it does not,
    // and calling the fallback a JMdict reading would name an entry that does
    // not exist.
    gloss: listed?.gloss,
    source: listed ? "jmdict" : "kanjidic",
  };
}

/** The reading `token` takes as the carrier of a fused span read on'yomi and
 * standing as a verb, or null where it is not that.
 *
 * A span read on'yomi reached the page with no ending at all: 蠕動 — JMdict's
 * ぜんどう — printed as two bare characters, where 獨酌 (a modifier+head
 * *pair*, taken by `onyomiPairReading`) already read 獨酌する and 封 (a
 * kun-less verb, taken by the kanjidic branch below) already read 封して.
 * Three routes to a Sino-Japanese word, and the only one with no サ変 ending
 * on it was the one the parser had fused.
 *
 * **What this keys on is the reading being on'yomi and the carrier being a
 * verb.** The reader's standing rule is that a verb read on'yomi ends in a
 * form of す, and those two conditions are that rule written out: 俯臥 is
 * ふ+ぐわ over a VERB carrier and reads 俯臥す, exactly as 大破 and 封 do. It
 * keyed on JMdict's `vs` tag instead ("noun or participle which takes the
 * aux. verb suru"), which is a narrower thing — 蠕動 is listed and 俯臥, 飲啄
 * and 異疾 are not, so three spans of the same shape and the same register
 * came out bare because a modern dictionary happens not to list them as
 * する-nouns. Attestation is the wrong question here for the reason
 * `tariSuffixReading` gives about its own binoms: the corpus is full of
 * two-character Sino-Japanese words no modern dictionary holds, and gating on
 * one would pass for the handful it does hold and quietly fail everywhere
 * else.
 *
 * **Being a span is still not evidence of being a verb**, and with `vs` gone
 * the carrier's POS carries that weight alone. It can carry it, because a
 * span's carrier is the member holding the whole span onto the sentence (see
 * `carrierOf`), so its tag is the parser's statement about what the *word* is
 * doing: 游魚 ("fish swimming about in water") is read ゆう+ぎょ and would pass
 * the on'yomi test, and what keeps it bare is that its carrier is the NOUN 魚.
 * 異疾 is the same shape and stays bare for the same reason (carrier 疾,
 * NOUN). What this does let through, and what `vs` was incidentally
 * excluding, is a span the parser has *mis*-tagged VERB: this treebank tags a
 * noun VERB often enough to have needed `isVerbalXpos` elsewhere in the app,
 * and a mis-tagged nominal span will now take a す it should not have. That is
 * the same exposure `onyomiPairReading`'s own `pair.head.pos === "VERB"` and
 * the kanjidic branch's `token.pos === "VERB"` already carry, and it is the
 * price of the reader's rule holding for the words no dictionary lists.
 *
 * The carrier is asked and no one else, so exactly one member of a span can
 * answer this and the two panels cannot pick different members.
 *
 * The reading comes from `compoundFurigana` itself rather than from a second
 * lookup of the same word: that function is what the 訓読文 draws over these
 * characters, and a resolver that agreed with JMdict but not with the panel
 * would put one reading on the page and another in the token inspector. Where
 * it cannot produce one for this member (no kanjidic index would do it — the
 * fallback is never reached here), nothing is claimed. */
function spanSuruReading(
  token: Token,
  sentence: { tokens: Token[] },
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
  historicalKana: HistoricalKanaIndex | undefined,
): ResolvedReading | null {
  const span = findCompoundSpans(sentence).find((s) => s.tokenIds.includes(token.id));
  if (!span) return null;
  const carrier = carrierOf(span, sentence);
  // **VERB, or an ADJ whose xpos is verbal — and the second half is what
  // parser 0.3.2 made necessary.** A fused predicate span read on'yomi
  // throughout takes サ変 (燥渴す, 陶陶遂遂す), and its carrier used to be a
  // VERB whether the word was an action or a state: 燥 is `v,動詞,描写,形質`,
  // which 0.3.1 tagged VERB and 0.3.2 tags ADJ. Left as VERB-only the span
  // lost its ending altogether — nothing else writes one for a
  // non-reduplicated on'yomi span — so the tag alone would have silently
  // deleted a す that was right.
  //
  // **The xpos is what keeps 豪富 out, and it has to be asked.** The other
  // kind of ADJ carrier is the Sino-Japanese *denominal* — 酒蟲's 豪 and 富,
  // ADJ over the **nominal** xpos `n,名詞,描写,態度` — and that word is 豪富
  // なり, not 豪富す. It was excluded before only because it was already ADJ
  // when nothing else was, so widening the tag test without the xpos test
  // would have taken the なり away and put す in its place. The two are told
  // apart exactly as `conjugationContext.ts`'s `isVerbalXpos` tells them
  // apart, and the reduplicated タリ case is held out ahead of this rule by
  // `redupTariReading` as it always was.
  const verbalCarrier = carrier.pos === "VERB" || (carrier.pos === "ADJ" && carrier.xpos.startsWith("v,"));
  if (carrier.id !== token.id || !verbalCarrier) return null;

  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const chars = span.tokenIds.map((id) => byId.get(id)!.text);
  if (!isOnyomiSpan(chars, span.text, jmdict, kanjidic)) return null;
  const readings = compoundFurigana(chars, span.text, jmdict, kanjidic, historicalKana ?? null, () => undefined);
  const own = readings[span.tokenIds.indexOf(token.id)];
  if (!own) return null;
  const listed = lookupLemma(jmdict, span.text);

  return {
    reading: own,
    // す is only サ変's 終止形, and the class is what lets the ordinary
    // conjugation pipeline inflect it for where the span stands — the same
    // supplement, for the same reason, that `onyomiPairReading` and the
    // kanjidic branch below both document. `beatsLexicon` is what carries the
    // class through `syntheticLexiconEntry` to the panels at all.
    okurigana: "す",
    conjClass: "sa-hen" as ConjClass,
    beatsLexicon: true,
    // What tells the panels this class is the *span's* and not this one
    // character's — see the field's own doc, and the two spans that were
    // conjugated on a member's own verb class before it existed.
    suruCompound: true,
    // Both from the same entry or from neither: `compoundFurigana` takes the
    // whole word's reading from JMdict where JMdict holds it and falls back to
    // each character's own on'yomi where it does not, and the gloss and the
    // source both have to say which of those two happened. 蠕動 is ぜんどう with
    // "vermiculation" beside it; 俯臥 is ふ + ぐわ with nothing, and calling that
    // a JMdict reading would name a dictionary entry that does not exist.
    gloss: listed?.gloss,
    source: listed ? "jmdict" : "kanjidic",
  };
}

/** The okurigana a fused span takes as one word, conjugated for where the span
 * stands — `""` for a span whose ending is written elsewhere, or undefined
 * where this has nothing to say and the panels' own `extraEndingFor` decides.
 * The two are different answers and both panels read them as such: see the
 * タリ-suffix branch below for the one that says `""`.
 *
 * **Two paradigms reach it, not one**: サ変 for a span read on'yomi and standing
 * as a verb (`spanSuruReading` — 蠕動す, 俯臥せしむ) and タリ活用 for a
 * reduplicated descriptive (`redupTariReading` — 蕭蕭たり, 冥冥たる). Nothing
 * here has to know which: the class arrives on the resolved reading and the
 * ordinary pipeline below inflects it. The name is the older of the two claims.
 *
 * **Called by both panels, and by nothing else.** The 訓読文 hangs it off the
 * last member of the group and the 書き下し文 emits it as a piece after the
 * whole span, but the string itself is decided once, here. Two panels quietly
 * disagreeing about one word is the failure this project guards hardest
 * against, and a span is where it would be least visible: the group ending is
 * drawn in one place and printed in another.
 *
 * The split between the two tokens it is handed mirrors what the panels
 * already do with `extraEndingFor`/`selectForm`: the **carrier** carries the
 * span's syntactic relation, so it decides the *form*; the **last member** is
 * where the ending is written, so what follows *it* in reading order is what
 * "what comes next" means (a following negation wants 未然形 from the end of
 * the group, not from the carrier's own neighbour).
 *
 * **This still returns only the string, where `pickedEnding` next door now
 * reports the form and the class it conjugated with as well** — so the
 * 連用形の「て」 switch goes on re-deriving those for a span and checking the
 * re-derivation against this string before it acts (see `compoundSuruRenyouTe`).
 * The debt is real and the body of the change is three lines. What holds it up
 * is the **return type**: both panels concatenate this answer straight into a
 * string, so widening it to an object is a change that has to land in the same
 * breath as both call sites — a panel left one edit behind prints
 * `[object Object]` rather than degrading to a missing て, which is what every
 * other call site of this switch degrades to. Paid together with those two
 * lines, not before them. */
export function compoundSuruOkurigana(
  carrier: Token,
  lastMemberId: number,
  plan: ReadingPlan,
  resolve: ReadingResolver,
): string | undefined {
  // **A span standing as the stem of a タリ suffix takes no ending of its own**,
  // and this is the one place that can say so to both panels at once. 踧踖如,
  // 驩虞如 and the 77 reduplicated 綽綽然/巍巍乎/空空如 of the gold treebank are
  // one word ending in 然/如/爾/乎/焉, and `tariSuffixReading` has already put
  // the group's たり on that suffix (its `tariSuffixGroup` reads the stem
  // backwards from the suffix precisely so a two-token stem is reachable — see
  // that function's own corpus note). Anything written after the span writes the
  // ending twice: 巍巍す乎たり from the サ変 rule, and 蕩蕩て乎たり from the
  // carrier's own `VerbForm=Conv` by way of `extraEndingFor`.
  //
  // **`""` and not `undefined`**, and the difference is the whole of the fix:
  // both panels branch on `!== undefined` and take `extraEndingFor` where this
  // declines, so "no ending" has to be *said* rather than left unsaid. The empty
  // string is the span's ending, decided here, and it stands in place of the
  // morph ending exactly as a conjugated one would. All 79 are two-character
  // stems, so nothing but a genuine タリ binom reaches this.
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  const last = byId.get(lastMemberId);
  const suffixGroup = last ? tariSuffixGroup(last, plan.sentence) : null;
  if (suffixGroup && suffixGroup.stem.id === lastMemberId) return "";

  const resolved = resolve(carrier, plan.sentence);
  // `suruCompound`, not `beatsLexicon` — a span member very often carries the
  // latter for a reading of its own single character (俯 in 俯臥 is ふ+す, 四段
  // サ行), and writing that verb's ending after the whole word gave 俯臥す and
  // 暴癢る for two words no dictionary lists at all. Only a class belonging to
  // the *span* may be written after the span.
  if (!resolved.suruCompound) return undefined;
  const lex = syntheticLexiconEntry(resolved, carrier.lemma);
  if (!lex?.conjClass) return undefined;
  const next = nextMeaningfulToken(plan, lastMemberId);
  // A governing 再読文字 dictates the form outright, ahead of the ordinary
  // context rules — the same order both panels' per-token branches use.
  const form = rereadGovernedForm(lastMemberId, plan) ?? decideConjForm(carrier, next, plan.sentence, lex.conjClass, resolve);
  // The span's own class — サ変, the one the ending above was conjugated with
  // — rather than a lexicon lookup on the carrier's lemma, which would answer
  // about the single character's verb sense (俯 as ふ+す) and not about the
  // word actually on the page.
  return conjugatedOkurigana(lex, form) + converbSuffix(carrier, next, lex.conjClass, form);
}

/** The ending a 形容動詞 takes where the parser has tagged it an **adverb** —
 * the 連用形, に for ナリ活用 and として for タリ活用.
 *
 * 暴 in 忽覺咽中暴癢 is `ADV` with `Degree=Pos`, and the word is にはかなり: a
 * ナリ活用形容動詞 whose stem `SUPPLEMENTARY_KUN` supplies and whose paradigm
 * `RESIDUAL` holds. With no ending at all it printed as the bare stem, 暴にはか
 * standing where 暴かに belongs.
 *
 * **The tag is the whole of the context this needs, which is why it can be
 * answered here rather than by the conjugation pipeline.** Both panels inflect
 * a word by asking `decideConjForm` what the sentence wants of it, and they
 * reach that only through `lexiconEntryFor`, whose gate (`usesLexiconEntry`)
 * admits VERB, AUX and a converb and not an adverb. But an adverb has no form
 * question to ask: a word tagged ADV is modifying a predicate, and a
 * 形容動詞 modifying a predicate is in its 連用形, whatever the predicate turns
 * out to be. So the one form an adverbial 形容動詞 can take is written directly,
 * and nothing is being decided here that the pipeline would decide differently.
 *
 * The class travels with it anyway, and with `beatsLexicon` so it can be
 * reached: it changes nothing today (an ADV takes no lexicon entry, so the
 * ending above is what both panels print) and is what makes 暴 inflect through
 * the ordinary pipeline the moment `usesLexiconEntry` admits a Degree=Pos
 * adverb — にはかなり in a predicate slot, にはかなる before a noun. Written as
 * the class rather than left implicit so that day needs no second edit here.
 *
 * Conditioned on the lexicon's own reading matching the one resolved, not on
 * the lemma alone: `LEXICON_SENSES` keeps a character's other words behind its
 * leading one (暴 is also 四段カ行 あばく), and an ending belongs to the word it
 * was derived for. Conditioned on there being no okurigana too — a 形容動詞
 * stem has none, and a reading that arrived with one is not this. */
function adverbialCopulaEnding(
  token: Token,
  reading: string,
  okurigana: string | undefined,
): { okurigana: string; conjClass: ConjClass } | null {
  if (token.pos !== "ADV" || okurigana !== undefined) return null;
  const lex = VERB_LEXICON[token.lemma];
  if (!lex?.conjClass || lex.reading !== reading) return null;
  if (lex.conjClass !== "nari-keiyoudoushi" && lex.conjClass !== "tari-keiyoudoushi") return null;
  return { okurigana: (lex.okuriganaPrefix ?? "") + conjugate(lex.conjClass, "renyou"), conjClass: lex.conjClass };
}

/** Builds a `ReadingResolver` (see `./types.ts`) implementing the plan's
 * resolution order: curated overrides -> KANJIDIC2 (+ historical-kana
 * substitution) -> JMdict -> unresolved.
 *
 * `historicalKana` (optional — omit for a resolver that leaves every
 * kanjidic reading at its modern spelling) is the general, data-driven
 * index built by `scripts/build-historical-kana-index.mjs` from Wiktionary
 * data, keyed by *kanji spelling* (`token.text`) rather than by whatever
 * reading kanjidic happens to produce: two unrelated words can share one
 * modern kun'yomi while having different (or no) attested historical
 * spellings, so looking this up by the resolved kana string instead of by
 * the actual character would risk "correcting" a homonym's reading using a
 * different word's historical spelling entirely. Deliberately the *only*
 * mechanism for this — no small hand-curated table sits in front of it (one
 * existed briefly and was removed): a per-word correction table is exactly
 * the word-by-word patching this index exists to replace, and letting it
 * win case-by-case would silently mask whatever the general index actually
 * produces instead of surfacing it for the index (or the extraction script)
 * to be fixed. The one thing that acts on a reading the index does not cover
 * is `fullSizeKana` in kanjidicLookup.ts, and it is not a table either: it
 * writes 促音 and 拗音 at full size, which is how the orthography writes them
 * and not a claim about any particular word. */
export function createReadingResolver(kanjidic: KanjidicIndex, jmdict: JmdictIndex, historicalKana?: HistoricalKanaIndex): ReadingResolver {
  const resolve = (token: Token, sentence: Sentence | { tokens: Token[] }): ResolvedReading => {
    // A reading the user picked from the furigana's own menu outranks every
    // rule below — it is a correction *of* those rules, so any of them
    // winning here would make the choice look like it hadn't registered.
    const chosen = chosenReading(token);
    if (chosen) {
      // **A pick corrects the reading, not the grammar** — the claim
      // `pinnedKeiyoudoushi` already makes for a single pinned character, made
      // here for a fused span. A span's ending belongs to the span and is
      // written once after its last member, and `compoundSuruOkurigana` will
      // only write one for a reading carrying `suruCompound`; a pick carries
      // none, so pinning the carrier of a span deleted the group ending
      // outright. 木蕭蕭 came out 木蕭蕭たり unpinned and a bare 木蕭蕭 the
      // moment a reading was pinned on the first 蕭, and 蠕動 lost its す the
      // same way.
      //
      // So the span rules are asked, and what is taken from them is the ending,
      // the paradigm and the flag saying both are the *span's* — never the
      // reading, which stays the reader's. A pin on a non-carrier member never
      // reaches this, because both rules answer for the carrier alone; that
      // member's own furigana still changes, which is what was asked for, and
      // no second ending appears inside the word.
      //
      // `isBareChosenReading` is the gate for the reason it gates
      // `pinnedKeiyoudoushi`: a bare `Reading=` with no `Okurigana=` and no
      // `ConjClass=` is what the menu's on'yomi arm writes, and a pick that
      // brought an ending of its own is a different claim about the word.
      const spanClass = isBareChosenReading(token)
        ? redupTariReading(token, sentence, kanjidic, jmdict, historicalKana) ??
          spanSuruReading(token, sentence, kanjidic, jmdict, historicalKana)
        : null;
      return spanClass
        ? { ...chosen, okurigana: spanClass.okurigana, conjClass: spanClass.conjClass, beatsLexicon: true, suruCompound: true }
        : chosen;
    }

    const zheTopic = zheTopicReading(token, sentence);
    if (zheTopic) {
      return { reading: zheTopic, gloss: "topic marker (following a noun/name)", source: "override", spellOutInProse: true, endingComplete: true };
    }

    // Both checked before kanjidic/override lookup, and tagged source
    // "kanjidic" (not "override") — these are content words that keep
    // their kanji in kakikudashi (see cellFor's kanaOnly doc), unlike the
    // override table's function-word glosses, which are shown as bare kana.
    if (isNominalizedFaultNoun(token)) {
      return { reading: "あやま", okurigana: "ち", gloss: "fault, error", source: "kanjidic" };
    }
    const adjectiveRoot = classicalAdjectiveRootReading(token);
    if (adjectiveRoot) {
      return { reading: adjectiveRoot.reading, okurigana: adjectiveRoot.okurigana, gloss: "sharp, advantageous", source: "kanjidic" };
    }

    // Ahead of the override table, not after it. A modifier+head pair read as
    // one Sino-Japanese word (獨酌 ドクシャク, 大破 タイハす, 三人 サンニン) is a
    // reading of the *pair*, which no lookup of either character on its own
    // can produce — and the override table is exactly such a lookup. 獨 has an
    // entry there reading ひとり, correct for the adverb standing on its own
    // (獨立) and wrong for the half of 獨酌, and being consulted first it won:
    // 獨酌 came out ひとり酌. What the pair rule knows is more specific than
    // what either table holds, so it is asked first; where it declines, every
    // rule below is reached exactly as before.
    // Ahead of the pair rule for the same reason the pair rule is ahead of the
    // override table: it is the more specific claim about the same characters.
    // A タリ binom's stem can also be the modifier half of an adjacent `mod`
    // pair, and a suffix character has a curated entry of its own — 然 tagged
    // VERB is しかり, 如 is ごとし — which speaks about that character standing
    // as a word. The suffix tag is the parser saying it is not standing as
    // one. Neither of those entries is *role-qualified for this role*
    // (`curatedInRole`: 然's two entries name VERB and SCONJ/CCONJ, 爾's names
    // PRON, and 如's ごとし is char-only), so nothing here is being overruled
    // that speaks about a PART-tagged suffix — but 如's char-only ごとし would
    // have won on order alone had this branch sat below `findOverride`, and
    // 突如 would have read 突ごとし.
    const tariSuffix = tariSuffixReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (tariSuffix) return tariSuffix;

    const onyomiPair = onyomiPairReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (onyomiPair) return onyomiPair;

    const override = findOverride(token.text, token.pos, token.dep);
    if (override) {
      // 之 read これ is written 之れ, and an ADP read より is written 自より,
      // where nothing else claims the ending slot — see `readingEndingSplit`,
      // which is where the condition lives so that both panels read one answer
      // rather than each deciding for itself.
      const parts = readingEndingSplit(token, sentence, override) ?? override;
      return {
        reading: parts.reading,
        okurigana: parts.okurigana,
        gloss: override.gloss,
        source: "override",
        // Every entry in the table is a function word written out in kana,
        // which is what the table is for; `spellOutInProse` says so as a fact
        // about the word rather than leaving it to be inferred from where the
        // reading came from. `endingComplete` likewise: these glosses are
        // self-contained, so 以's own VerbForm=Conv must not tack a second て
        // onto もって. Both were previously read off `source` at four separate
        // call sites, each re-deciding what an "override" implies.
        spellOutInProse: true,
        endingComplete: true,
        // An entry that says so stands `VERB_LEXICON` down — see
        // `OverrideEntry.beatsLexicon`. Only where the entry asks for it: the
        // lexicon is right about every ordinary verb use of a character this
        // table also holds a function-word reading for, and standing it down
        // wholesale would read 遂其業 as つひに rather than 遂ぐ.
        ...(override.beatsLexicon ? { beatsLexicon: true } : {}),
      };
    }

    // Behind the override table, unlike the pair rule above, and the two are
    // ordered on the same principle: a rule is asked before the table only
    // where the table cannot express what it knows. `onyomiPairReading` is —
    // it reads a pair as one word, and every entry in the table is a reading
    // of a single character standing on its own. This rule needs no such
    // precedence, because it does not choose the span's reading at all
    // (`compoundFurigana` already did, in both panels): it only says the span
    // takes a サ変 ending, and a character the table speaks for is one this
    // app has been told outright how to read.
    // Ahead of the サ変 rule, because it is the more specific claim about the
    // same span: a reduplicated descriptive passes `spanSuruReading`'s two
    // conditions wherever its carrier is tagged VERB (it is on'yomi throughout
    // by construction), and that rule would make it サ変 — 木蕭蕭す, where the
    // class of a Sino-Japanese descriptive compound is タリ活用 and the word is
    // 木蕭蕭たり. Behind the override table for the reason the サ変 rule is:
    // neither chooses the span's reading, so neither has anything to say that a
    // curated entry for one of these characters does not already outrank.
    const redupTari = redupTariReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (redupTari) return redupTari;

    const spanSuru = spanSuruReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (spanSuru) return spanSuru;

    // **Parser 0.3.2 tags a stative predicate ADJ** — 深/太/大 all arrive that
    // way now, where up to 0.3.1 they arrived VERB with `Degree=Pos` and the
    // feature was the only signal there was. `isDescriptiveToken` is what
    // reads the two together, and reading them through it rather than here is
    // what keeps this gate, `chosenOkurigana`'s and `pinnedKeiyoudoushi`'s on
    // one answer; see it for why a legacy VERB still carrying the feature is
    // now refused. Decided ahead of the lookup because it governs the lookup
    // as well as the ending below.
    const topicalized = isTopicalizedAdjective(token, sentence);
    // …and the same arrangement for the one form that is neither the 終止形 nor
    // the 連体形: a predicative complement of a verb of **becoming** is in
    // 連用形, so 適以益貧 is 貧**しく**適き and not the 終止形 貧し closing a
    // sentence the rest of the clause carries on from. Asked of
    // `conjugationContext.ts`'s own predicate for exactly the reason
    // `isTopicalizedAdjective` is — one function decides the form here and in
    // `decideConjForm`, so a reading this path writes and a form that file
    // chooses cannot come apart. See `isBecomingComplement` for which governors
    // count as verbs of becoming, and for the corpus reach.
    //
    // This path and not `decideConjForm` alone, because an adjective read here
    // never reaches a paradigm: the resolver writes the classical ending out
    // directly (see `classicalAdjectiveReading`) and carries no `conjClass`, so
    // the form `decideConjForm` chooses has nothing to inflect. That is what
    // made 連用形 unreachable for an adjective however the tree was shaped.
    const becomingComplement = isBecomingComplement(token, sentence);
    const isAdjective = topicalized || isDescriptiveToken(token);

    // The transitive/intransitive split, from the dependency tree — see
    // `hasObject` and `pickByTransitivity`. Asked only of a genuine verb:
    // transitivity is a property verbs have and adjectives do not, and
    // putting the question to an adjectival token picks a verb reading for
    // a word being used as neither — 竹林深し's 深 (VERB, Degree=Pos, no
    // object) was answering it with 深まる, the intransitive verb "to
    // deepen", instead of the adjective 深し.
    //
    // An object overrides that suppression, because it is evidence about
    // the same thing: an adjective governs no object, so a Degree=Pos token
    // that has one is being used as a transitive verb whatever the feature
    // says. The parser puts Degree=Pos on 現 in both 君子現其德 and 其德現,
    // and only the object tells the two apart (現す vs 現る).
    //
    // And the suppression itself only holds where there is an adjective to
    // suppress in favour of. `Degree=Pos` on 肥 in 馬肥 does not make 肥 an
    // adjective — its entry has no adjective reading at all (こ.える, こ.やす,
    // こ.やし, ふと.る) — so suppressing the question there answered it by
    // default, and the default is the transitive: 馬肥 read 馬肥やす, with no
    // object anywhere in the sentence. Worse, a suppressed question sets no
    // `beatsLexicon`, so `VERB_LEXICON`'s single entry (肥 as こ+やす) stood
    // and the resolver was never consulted at all. See `hasAdjectiveKun`.
    //
    // **ADJ joins VERB as the tag that may be asked**, and it has to: the whole
    // argument above is about `Degree=Pos` tokens, and under parser 0.3.2 every
    // one of them is tagged ADJ rather than VERB. 現 in 君子現其德 and 肥 in 馬肥
    // — the two worked examples — are ADJ 1 and ADJ 34 over the recoded gold,
    // with no VERB use left between them. Asked of a VERB-only gate the object
    // evidence would simply have been dropped: 馬肥 went back to reading
    // 馬肥やす, with no object anywhere, which is the exact regression the 肥
    // paragraph above records fixing.
    const wantTransitive = hasObject(token, sentence);
    const adjectivalSense = isAdjective && hasAdjectiveKun(kanjidic, token.text);
    const transitivity =
      isContentPredicatePos(token.pos) && (!adjectivalSense || wantTransitive) ? { wantTransitive, jmdict } : undefined;
    // The 歴史的仮名遣い substitution happens inside the lookup now, not here:
    // it is keyed by kanjidic's own (modern) reading string, so it has to run
    // before classicalAdjectiveReading's stem-trimming below — not after — or
    // an undotted adjective entry (the one case that actually changes
    // `reading`, not just `okurigana`) would look itself up under a key the
    // index never used. Making that the lookup's own business is what puts
    // this path and the furigana menu's `candidateReadings` on one rule
    // rather than two that have to be kept in step by hand.
    // A NOUN/PRON the treebank's own xpos calls a verb is a predicate in a
    // nominal slot, and is read by nominalising it — see `isVerbalNominal` and
    // `nominalizedCandidates`. Handed to the lookup rather than decided there,
    // because the xpos lives on the token and that function is per-character.
    const kanjidicHit = lookupKanji(
      kanjidic,
      token.text,
      token.pos,
      transitivity,
      historicalKana,
      isVerbalNominal(token) || isQualityNounInObjectSlot(token, kanjidic, jmdict) ? { jmdict } : undefined,
    );
    if (kanjidicHit) {
      // **The dictionary answers where the tag did not.** `isAdjective` is a
      // fact about the *token* — `Degree=Pos`, or a topicalization, or a
      // complement of becoming — and it is the whole of what decided, until
      // now, whether an い-final kun'yomi reached the page in its classical
      // 終止形 or in KANJIDIC2's modern shape. That gate is right where the
      // parser supplies the feature and silent where it does not, and it is
      // silent a great deal: measured over lzh-train/dev/test, 109 characters
      // reach the page with a modern い okurigana, and for the 71 of them
      // `VERB_LEXICON` holds no entry to correct it with, the modern ending is
      // what the reader sees — 幽 as ふかい, 趍 as ひさしい, 侔 as ひとしい, 癢 as
      // かゆい, every one tagged a plain VERB with no feature on it at all. The
      // reader's own 忽覺咽中暴癢 is one of those tokens.
      //
      // Whether a word is an adjective is not a fact about this occurrence of
      // it, so it can be settled by the dictionary rather than by the tree —
      // which is what `attestedAdjectiveClass` asks, through the very gate the
      // furigana menu already puts the same reading through. Positive evidence
      // only: the ambiguity `kunWordClass` documents is real (KANJIDIC2 writes
      // 連用形 nominals with a final い too — 扱's あつか.い, 使's つか.い), and a
      // shape-only rule here would have made 扱し of one. Where the dictionary
      // is silent the reading keeps the modern ending it has always had.
      //
      // The *form* stays the token's business. The tag not saying "adjective"
      // says nothing about which form the sentence wants, and the two rules
      // below that choose one (`topicalized`, `becomingComplement`) are asked
      // unchanged; a token neither of them fires on takes the 終止形, exactly as
      // a `Degree=Pos` one in the same position does.
      //
      // Asked of a kun'yomi only. An on'yomi is a bare Sino-Japanese stem with
      // no okurigana to convert and no adjective paradigm to be in, and the
      // conversion applied to one would eat its last mora: 齊 read せい would
      // have come out せし.
      const attestedAdjective =
        kanjidicHit.series === "kun"
          ? attestedAdjectiveClass(kanjidic, jmdict, token.text, kanjidicHit.reading, kanjidicHit.okurigana, historicalKana)
          : undefined;
      const { reading, okurigana } = isAdjective || attestedAdjective
        ? classicalAdjectiveReading(
            kanjidicHit.reading,
            kanjidicHit.okurigana,
            // 連体形 first: a topicalized adjective is what the source says
            // this word *modifies*, which binds tighter than what it is a
            // complement of — the same order `decideConjForm` puts its own
            // 連体形 rules above its 連用形 ones in.
            topicalized ? "rentai" : becomingComplement ? "renyou" : "shuushi",
          )
        : { reading: kanjidicHit.reading, okurigana: kanjidicHit.okurigana };
      // KANJIDIC2's okurigana is modern throughout, so a verb's 一段 ending
      // is put back into classical 二段 shape here — see
      // `classicalVerbEnding`. Applied to every verb reading, not only to a
      // transitivity-selected one: 起 is 起く whether or not the object
      // check moved anything, kanjidic's きる being the modern 上一段 form of
      // the same word either way. Skipped where the adjective conversion
      // above has already rewritten the ending, which is finished (高し) and
      // must not be run through a second, contradictory rule.
      //
      // The reading travels with the ending for the one word whose classical
      // ending is a lexical fact rather than a derivable one (もちいる ->
      // もちゐる; see `LEXICAL_KUN`), the same reason it already travels to
      // `classicalConjClass` below.
      //
      // Where the ending states no paradigm at all, the dictionary is asked
      // for one — see `attestedClassicalParadigm`, and `ending` below for what
      // is then written. Asked only of a reading whose *shape* says it is a
      // verb (`kunWordClass`): 扱's あつか.い is a 連用形 nominal and 安's
      // やす.らか a 形容動詞 stem, and neither is a word that has a paradigm to
      // find.
      //
      // `kanjidicHit.reading` has already been put into 歴史的仮名遣い by
      // `lookupKanji`, while JMdict is written modernly — so a stem the fold
      // rewrites (謂's い -> ゐ) is looked up under a key that dictionary never
      // uses. That fails closed, never wrong: a historical stem matches no
      // modern entry at all, so the answer is silence and the reading keeps
      // what it had. The kun stems the fold touches are a handful.
      //
      // **ADJ is admitted with VERB in all three of the tests below**, and the
      // reason is 肥. Its kun'yomi are verbs throughout (こ.える, こ.やす) and its
      // classical ending is 下二段ヤ行 肥ゆ, which only `classicalVerbEnding`
      // writes — but 0.3.2 tags it ADJ, so a VERB-only gate left kanjidic's
      // *modern* える standing and the panels printed 馬肥える. The adjective
      // conversion above is what keeps this safe on a word that really is one:
      // it rewrites the ending (たか.い -> し), and both `verbKun` and `ending`
      // require the ending to be **unchanged** before they touch it, so a
      // converted adjective falls straight past. `classicalConjClass` needs no
      // such guard — it answers undefined for every adjective ending by
      // construction (see its companion `attestedAdjectiveClass` for why).
      const shapeClass = isContentPredicatePos(token.pos)
        ? classicalConjClass(kanjidicHit.okurigana, { lemma: token.lemma, reading })
        : undefined;
      const verbKun =
        isContentPredicatePos(token.pos) &&
        okurigana === kanjidicHit.okurigana &&
        splitKunWordClass(kanjidicHit.okurigana) === "verb";
      const attestedClass =
        shapeClass ?? (verbKun ? attestedClassicalParadigm(jmdict, kanjidicHit.reading, kanjidicHit.okurigana) : undefined);
      // The one derivation above that is a *guess*: `classicalConjClass` reads
      // a one-kana modern ending as 四段 of that 行, and defends it with the
      // verb lexicon wherever the lexicon holds the word. Where it does not,
      // JMdict is asked to contradict it instead — 視's み.る is 上一段 見る and
      // never 四段, and a guessed class carried to the panels would inflect it
      // (視り for 視て) where a missing one leaves the citation form standing.
      // See `isModernIchidanLemma`, which only ever rules a 四段 out. Asked
      // only where the lexicon said nothing, so 見's own 上一段 — which comes
      // *from* the lexicon, through `attestedSenseByModernSpelling` — is not
      // second-guessed by a dictionary that would call 見る 一段 too.
      const guessedYodan =
        attestedClass !== undefined &&
        kanjidicHit.okurigana?.length === 1 &&
        attestedSenseByModernSpelling(token.lemma, reading, kanjidicHit.okurigana) === undefined;
      const contradicted =
        guessedYodan &&
        isModernIchidanLemma(jmdict, token.text + kanjidicHit.okurigana, kanjidicHit.reading + kanjidicHit.okurigana);
      // A paradigm the ending could not state is also an ending the reading
      // could not have: 応's こた.える has no classical form until the class
      // says 下二段ハ行, and then it has exactly one — that class's own 終止形,
      // 応ふ. Written from the class rather than converted from the modern
      // ending, because there was nothing in the modern ending to convert.
      const ending =
        !shapeClass && attestedClass && verbKun
          ? conjugate(attestedClass, "shuushi")
          : isContentPredicatePos(token.pos) && okurigana === kanjidicHit.okurigana
            ? classicalVerbEnding(okurigana, reading)
            : okurigana;
      // Only a transitivity-selected reading *outranks* the lexicon: it is
      // the one answer here the syntax chose rather than the character's
      // own entry ordering, and so the only one with a claim to be preferred
      // to the lexicon's single per-lemma entry.
      //
      // **A character the lexicon has no entry for is the other case, and it
      // is not the same claim.** There is nothing there to outrank — and
      // without the flag there is also no way to hand the panels a class at
      // all, since both of them read a resolver-supplied one only through
      // `syntheticLexiconEntry`, which `lexiconEntryFor` reaches only on
      // `beatsLexicon`. So a class derived for a lemma `VERB_LEXICON` is
      // silent about is carried too, and the alternative was never the
      // lexicon's answer but no answer: 不應 printed 應るず — 應's own
      // kun'yomi あた.る, whose 四段ラ行 the ending states plainly, standing
      // uninflected because nothing carried the class the two characters
      // apart. It now reads 應らず, and 不応 — whose こた.える states no
      // paradigm and gets one from `attestedClassicalParadigm` — reads
      // 応へず.
      //
      // `conjClass` travels with it and only with it, derived from the same
      // *modern* okurigana `classicalVerbEnding` just converted (not from
      // `ending`, which has already lost the i/e-grade distinction the class
      // turns on). Standing the lexicon down discards the class that entry
      // was carrying, and without a replacement the panels can only print the
      // citation form — 廟を立つて, where the 下二段 class gives 廟を立てて.
      // Nothing is attached where the lexicon still applies: that reading
      // goes on reaching its own entry's class exactly as before.
      //
      // The lemma and reading travel with the ending so that the derivation
      // can defer to an attested class where the ending alone would only be
      // guessed at — 見 with an object is 上一段 見る, not the 四段ラ行 a bare
      // る would otherwise give (見り for 見て). See `classicalConjClass`.
      const lexiconIsSilent = VERB_LEXICON[token.lemma] === undefined;
      // The contradiction is asked of the new arm only. The other one is a
      // decision this file already took and documents — 射's derived 四段ラ行
      // stands where two attested senses tie and the lexicon abstains — and
      // narrowing it is a separate question from filling a gap.
      const conjClass = kanjidicHit.transitivitySelected || (lexiconIsSilent && !contradicted) ? attestedClass : undefined;
      // A verb read on'yomi is read サ変 in kundoku — 佳醸す, never the bare
      // stem 佳 — and this is the third path that can produce one, beside
      // `onyomiPairReading` above and `chosenOkurigana`, which both supply
      // the same す for the same reason. It is reached where the character
      // has no kun'yomi for a verb to take (`useKun` false in `lookupKanji`),
      // and until now such a verb reached the page with no ending at all: 佳
      // in 佳釀 printed as the bare character.
      //
      // す is only サ変's 終止形, so the class is named alongside it rather
      // than the ending being left as a fixed string — the same supplement,
      // for the same reason, that `onyomiPairReading` documents: without it
      // 大破 was frozen at す everywhere, giving 大破すの時 for the 連体形.
      //
      // VERB only, and only where the token is not being used adjectivally.
      // A nominal read on'yomi takes no ending at all, and an adjectival one
      // wants なり rather than す — which the copula machinery decides on its
      // own evidence. The same two exclusions `chosenOkurigana` makes, and
      // they are not idle: 佳 in 佳釀 is a kun-less character the parser tags
      // `Degree=Pos`, and 佳す is not a word.
      //
      // Under parser 0.3.2 the two exclusions have become one: 佳 is now ADJ
      // (19 of its 21 gold tokens), so it fails `pos === "VERB"` before
      // `!isAdjective` is ever reached. The feature test is kept all the same
      // — it is what answers for a tree written by hand, and for the ADV a
      // `Degree=Pos` still lands on — and this is deliberately *not* widened
      // to ADJ, unlike the three verb-ending tests above: those write a verb's
      // ending onto a verb's reading, and this writes サ変 onto a word that is
      // not a verb at all.
      //
      // `beatsLexicon` rides along for the same reason `onyomiPairReading`
      // sets it: standing the lexicon down is what lets the class reach the
      // panels at all (they read a resolver-supplied class only through
      // `syntheticLexiconEntry`, and only on this flag), and without it 王封之
      // 而去 printed 王これを封すて去ぬ — サ変's 終止形 with 而's て glued on,
      // where the 連用形 gives 封して. There is no reading of these characters
      // for the lexicon to be holding.
      //
      // What makes `series === "on"` the right condition on a VERB is a rule
      // the reader has settled outright: **a character KANJIDIC2 gives no
      // kun'yomi for is read on'yomi** (封, 謁, 療 — see `lookupKanji`). For a
      // token tagged VERB that is the only way `lookupKanji` returns the on
      // series at all — PROPN is the other, and a verb is not a proper noun —
      // so this branch is exactly the kun-less verbs and nothing else. It is
      // written as the rule rather than left to be re-derived from that
      // coincidence, which is how it stood before and which said nothing
      // about how kanbun is read. The rule reaches non-verbs too, and they
      // need no branch here: a kun-less nominal (累 るゐ, 僧 そう) is read
      // on'yomi and takes no ending, which is what falling past this
      // condition already gives it.
      const onyomiVerb = kanjidicHit.series === "on" && token.pos === "VERB" && !isAdjective;
      // 此 and 是 read これ are written 此れ / 是れ, the same division 之 takes
      // in the override branch above and through the same function, so no
      // character comes to be split by a rule of its own. Asked of the ending
      // this branch has already settled, so a reading that grew one is left
      // alone.
      const split = readingEndingSplit(token, sentence, { reading, okurigana: ending });
      if (split) {
        return { reading: split.reading, okurigana: split.okurigana, gloss: kanjidicHit.gloss, source: "kanjidic" };
      }
      // A 形容動詞 the parser tagged ADV — 暴 as にはかに. See
      // `adverbialCopulaEnding` for why the 連用形 can be written outright here
      // when every other ending is decided by the panels' conjugation pipeline.
      const adverbialCopula = adverbialCopulaEnding(token, reading, kanjidicHit.okurigana);
      if (adverbialCopula) {
        return {
          reading,
          okurigana: adverbialCopula.okurigana,
          gloss: kanjidicHit.gloss,
          source: "kanjidic",
          beatsLexicon: true,
          conjClass: adverbialCopula.conjClass,
        };
      }
      return {
        reading,
        okurigana: onyomiVerb ? "す" : ending,
        gloss: kanjidicHit.gloss,
        source: "kanjidic",
        // `conjClass` alone is inert — the panels reach a resolver-supplied
        // class only through `syntheticLexiconEntry`, and `lexiconEntryFor`
        // reaches that only on this flag — so the two travel together
        // wherever a class was derived for a lemma the lexicon is silent
        // about. See `conjClass` above for why that is not the same claim as
        // outranking an entry that exists.
        ...(kanjidicHit.transitivitySelected || onyomiVerb || conjClass ? { beatsLexicon: true } : {}),
        ...(conjClass ? { conjClass } : onyomiVerb ? { conjClass: "sa-hen" as ConjClass } : {}),
      };
    }

    if (SPAN_DEPS.has(token.dep)) {
      const jmdictHit = lookupLemma(jmdict, token.lemma);
      if (jmdictHit) {
        return { reading: jmdictHit.reading, gloss: jmdictHit.gloss, source: "jmdict" };
      }
    }

    logUnresolved(token);
    return { reading: "", source: "unresolved", gloss: token.lemma };
  };

  // **Where a kanji-retained adverb's okurigana is settled, for both panels.**
  // `KANJI_RETAINED_ADVERBS` in `classicalEnding.ts` states *which* adverbs
  // keep their kanji in the 書き下し文; where the kanji ends is KANJIDIC2's own
  // okurigana dot, and `retainedAdverbOkurigana` reads it out of the index.
  // That index is fetched at runtime and handed in here, so the question can
  // only be asked somewhere it has been — and of the two panels that need the
  // answer, `generateKakikudashiPieces` has never been given one (it takes a
  // plan and a resolver). This is the single point that holds the index, the
  // orthography index and the token's own resolved reading all at once, so it
  // is asked here and the answer rides out on `ResolvedReading` (see that
  // field's own doc for why there rather than through the generator's
  // signature).
  //
  // **Per lemma, and deliberately not per reading.** The answer is a property
  // of the word the table names, so it is attached to every token of a listed
  // character whatever this occurrence resolved to — which is exactly what the
  // table itself did when both panels read it directly, and so what keeps the
  // set of tokens the rule fires on unchanged. Narrowing it here instead would
  // move that decision out of the two places that make it on their own
  // evidence: `retainedAdverbParts` refuses a reading that does not end in the
  // okurigana, and both panels stand the rule down entirely on `beatsLexicon`.
  //
  // Wrapping rather than answering inside: the resolver returns from some
  // twenty places, this is a fact about the token's *lemma* and not about which
  // of them answered, and nothing already on the object is touched — the field
  // is added only for a character the table holds.
  return (token: Token, sentence: Sentence | { tokens: Token[] }): ResolvedReading => {
    const resolved = resolve(token, sentence);
    const okurigana = retainedAdverbOkurigana(kanjidic, token.lemma, historicalKana);
    return okurigana === undefined ? resolved : { ...resolved, retainedAdverbOkurigana: okurigana };
  };
}
