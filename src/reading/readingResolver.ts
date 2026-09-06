import { type Sentence, type Token, isContentPredicatePos } from "../parse/types.ts";
import { chosenReading, isBareChosenReading } from "./chosenReading.ts";
import type { ReadingResolver, ResolvedReading } from "./types.ts";
import { findOverride, type OverrideEntry } from "./overridesLookup.ts";
import { ADVERBIAL_NUMERAL_KUN, attestedAdjectiveClass, hasAdjectiveKun, hasAttestedAdjectiveKunOnly, type KanjidicIndex, lookupKanji, onyomiOf, retainedAdverbOkurigana } from "./kanjidicLookup.ts";
import {
  classicalAdjectiveReading,
  classicalConjClass,
  classicalVerbEnding,
  readingEndingSplitFor,
  splitKunWordClass,
  ZHE_NOMINALIZER_OKURIGANA,
  ZHE_TOPIC_READING,
  ZHE_NOMINALIZER_READING,} from "./classicalEnding.ts";
import {
  attestedClassicalParadigm,
  findCompoundSpans,
  isModernIchidanLemma,
  type JmdictIndex,
  lookupLemma,
  lookupModernisedLemma,
} from "./jmdictLookup.ts";
import { attestedSenseByModernSpelling, VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
import { sandhiVariants, splitCompoundReading } from "./compoundReading.ts";
import { compoundFurigana } from "./compoundFurigana.ts";
import { historicalSpelling, type HistoricalKanaIndex } from "./historicalKana.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ConjClass, ConjForm } from "../kakikudashi/classicalConjugation.ts";
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

/** 者's two particle uses, told apart by what modifies it — 者's own (pos,
 * dep) cannot do it, since it is tagged PART/`p,助詞,提示,*` in **4,786** of
 * 4,786 tokens over the recoded gold
 * (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`),
 * whichever use it is, and stands on `subj`/`comp:obj`/ROOT either way. So this
 * reads its *modifier's* POS instead, the one token in the sentence with
 * `head === token.id && dep === "mod"`.
 *
 *  - **A bare noun or name modifies it — 孔子者 -> 孔子は, "as for Confucius".**
 *    The topic marker, read は *in place of the character*: the 書き下し文 writes
 *    黃帝は and not 黃帝者は, because 者 here is a particle and nothing else,
 *    and a particle is spelled out in kana like every other one this app writes.
 *    **770 NOUN + 106 PROPN** modifiers in the gold.
 *  - **A predicate modifies it, and 者 itself stands in a topic slot —
 *    不復挺者 -> 復た挺かぬ者は, 知者勝 -> 知る者は勝つ.** The nominalizer, "the
 *    one who…", which is *a noun*: the character stays in the prose and は is
 *    written beside it as okurigana. **2,744 VERB + 610 ADJ + 260 AUX**
 *    modifiers in the gold, which is 4× the topic use. (A stative predicate
 *    like 仁/賢 is tagged VERB with `Degree=Pos` up to parser 0.3.1 and ADJ from
 *    0.3.2; `isContentPredicatePos` names both, so the recoding changes nothing
 *    here.)
 *
 * **The division of the second is what the reader asked for**: 者 was reading
 * もの off `overrides.json`'s catch-all entry and printing that kana *in place
 * of* the character (復た挺かぬもの), where kundoku keeps the kanji and writes
 * only the は. Returning the reading and its ending divided is the same shape
 * `readingEndingSplit` gives 之れ and 自より — an empty furigana slot rather
 * than a one-kana one being the only difference, and it says the same thing
 * those do: the kana beside the character is an ending, and what is above it is
 * what the character itself is read as.
 *
 * **The は is bounded to a topic slot, and the rule applied literally would be
 * wrong without that bound.** は marks a topic; a nominalizing 者 standing as an
 * *object* takes を, not は — 見知者 is 知る者を見る. Of the **3,562** 者 with a
 * predicate `mod` modifier in the gold, **2,245 stand on `subj`, 237 on ROOT
 * and 27 on `dislocated`/`subj@pass`** — the slots a は belongs in, and 70% of
 * the total — while **928 stand on `comp:obj`** and the remaining 125 on `mod`,
 * `conj:coord`, `udep` and a tail. Those are left exactly as they were, on the
 * もの entry: `caseParticleFor` declines to put a case particle on a PART at
 * all, so this branch could give them the character back but not the を that
 * should follow it, and a は written there would assert a topic the sentence
 * does not have. What they need is a を from `caseParticleFor` in
 * `conjugationContext.ts`, which is a change in that file and not in this one.
 *
 * **`conjugationContext.ts` has to be told about the topic ones, and is not
 * yet.** `isNominalizerAhead` decides whether the predicate before 者 is
 * attributive (大破するもの勝つ, 挺かぬ者) by asking this module what 者 was read
 * as and comparing it against もの, which the branch below no longer returns for
 * a 者 in a topic slot. The use stays perfectly recognisable in the answer, by
 * which slot the は landed in — the topic *marker* fills `reading` and leaves
 * `okurigana` unset, the nominalizer the other way round — and
 * `ZHE_TOPIC_READING` / `ZHE_NOMINALIZER_OKURIGANA` in `classicalEnding.ts` are
 * those two facts written once for both files, that module being the one both
 * can import (see its own note there).
 *
 * Returns undefined — falling through to the catch-all もの override — for
 * anything else modifying 者 (ADV 106, NUM 105, and a tail), and for 者 with no
 * modifier at all (12 in the gold: bare 者 as a stand-alone pronoun-like
 * "someone"). */
function zheParticleReading(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): { reading: string; okurigana?: string; gloss: string; spellOutInProse: boolean } | undefined {
  if (token.text !== "者") return undefined;
  const modifier = sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && t.dep === "mod");
  if (!modifier) return undefined;
  // **What 者 nominalizes is the whole chain, not just the link that carries
  // the relation.** 孝弟而好犯上者 hangs 孝弟 off 者 by `mod` and coordinates 好
  // onto *that* — the head of the chain is a noun and a later link is the
  // predicate — so a test reading the modifier alone called it a topic marker
  // and wrote a bare は where the word is ものは: 上を犯すを好みて**は**, with
  // the character gone. The reader's own reparse is what exposed it.
  //
  // Rare, and uniform where it occurs: over the recoded gold a nominal
  // modifier of 者 heads a chain with a predicate link **7** times against 833
  // that head no chain at all, and every one of the 7 is a nominalizer —
  // 惡勇而無禮者 (禮無き者), 死三日而后斂者, 一人身而牽留萬乘者, 十人而從一人者.
  // The 833 keep the topic marker they had, which is what 黃帝者 needs.
  //
  // Direct conjuncts only. Every one of the 7 is one edge deep, and a walk
  // that chained further would be claiming a reach nothing here has measured;
  // `predicateCoordinationChain` in `conjugationContext.ts` is where the
  // transitive question is asked, and this file cannot import it (that module
  // imports this one).
  const coordinated = sentence.tokens.filter(
    (t) => t.head === modifier.id && t.id !== modifier.id && ZHE_CHAIN_DEPS.has(t.dep),
  );
  // **也者 is a frame, and its 也 is the copula.** 孝弟也者、其為仁之本與 hangs a
  // PART 也 off 者 by `mod`, and a PART is neither a content predicate nor an
  // AUX, so the test below called this 者 nothing at all and it fell through to
  // the catch-all もの with no は — 孝弟也者 where the reading is 孝弟なるものは.
  // The 也 there is 断定の助動詞 なり (which is why the reader pins `Reading=なり`
  // on it: its own override reading at `mod` is や), so what 者 holds is a
  // predicate exactly as in every other nominalizing use.
  //
  // Measured over
  // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
  // a 者 whose `mod` is a PART occurs **11** times, **8** of them a 也 — 友也者、
  // 魄也者、敬讓也者、夫達也者、夫聞也者、孝弟也者 — and every one of the 8 is the
  // frame, read 〜なる者は. All 11 stand in a `subj` slot, so `isTopicSlot` below
  // admits them without further widening. The other two lemmas (所, 者) are left
  // alone: 所以者何 is a different construction and three tokens is not a rule.
  const nominalizes =
    isContentPredicatePos(modifier.pos) ||
    modifier.pos === "AUX" ||
    modifier.lemma === "也" ||
    coordinated.some((t) => isContentPredicatePos(t.pos) || t.pos === "AUX");
  if (!nominalizes && (modifier.pos === "NOUN" || modifier.pos === "PROPN")) {
    return { reading: ZHE_TOPIC_READING, gloss: "topic marker (following a noun/name)", spellOutInProse: true };
  }
  if (nominalizes && isTopicSlot(token.dep)) {
    return {
      reading: ZHE_NOMINALIZER_READING,
      okurigana: ZHE_NOMINALIZER_OKURIGANA,
      gloss: "the one who… (nominalizer), marked as topic",
      spellOutInProse: false,
    };
  }
  return undefined;
}

/** The relations that string a further predicate onto the phrase 者 marks —
 * the same three `COORDINATION_DEPS` names in `conjugationContext.ts`, written
 * out here because that module imports this one and the edge cannot be closed.
 * See `zheParticleReading` for the seven gold tokens this is for. */
const ZHE_CHAIN_DEPS: ReadonlySet<string> = new Set(["conj:coord", "conj:coord@emb", "parataxis"]);

/** The relations a nominalizing 者 can carry a は on — see `zheParticleReading`
 * for the counts and for what the other relations need instead.
 *
 * `subj` and its `@pass` subtype, the sentence's own ROOT (a 者 clause standing
 * as the whole utterance, which is what 不復挺者 is), and `dislocated` (a topic
 * set off in front of the clause, which is the construction itself). ROOT is
 * matched in both spellings because `conlluParser.ts` normalises the column's
 * `root` to `ROOT` while a hand-written tree may say either. */
function isTopicSlot(dep: string): boolean {
  return dep === "subj" || dep.startsWith("subj@") || dep === "ROOT" || dep === "root" || dep === "dislocated";
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
 * competing reading on the character. **以 and 而 are excluded on the same
 * argument** and on the line below it — see `NEVER_HALF_OF_A_WORD` for the two
 * characters, the 126 pairs they were forming, and why the exclusion is
 * blanket. */
/** The two function words that are **never half of a word**, whatever JMdict
 * holds — 以 and 而, excluded from the pair rule outright.
 *
 * This is the negation exclusion one line above it, made for the second time
 * and for the same reason. 不/未 are tagged ADV and attach to their verb by
 * `mod` exactly as 大 does, JMdict even lists 不知 — and they are read as
 * postposed ず by their own branch in both panels, so letting the pair rule
 * claim them would put a second, competing reading on the character. 以 and 而
 * are that case exactly: the instrumental/purposive coverb read もつて and the
 * clausal conjunction read しかして, both read out of `overrides.json` by a
 * branch of their own, and neither with any lexical content to contribute to a
 * Sino-Japanese compound. They are the two workhorse particles of Literary
 * Chinese — 7,290 以 and 7,794 而 over the recoded gold — and a pair rule that
 * claims them is not reading kanbun.
 *
 * **What it was costing.** Over `lzh_kyoto-sud-{train,dev,test}.…adjfix`,
 * `oneLexicalWordPair` formed **126** pairs with one of the two standing first
 * — **93** 以 (以來 46, 以降 13, 以下 8, 以遠 6, 以東 5, 以上 4, 以前 4, 以往 4,
 * 以深 3) and **33** 而 (而立 25, 而來 4, 而後 3, 而今 1) — in 125 sentences.
 * The head of the pair is tagged **VERB in 112** of them and ADJ in 9, and
 * `onyomiPairReading` gives a VERB-headed pair the サ変 す, so every one of
 * those 121 printed a *coined verb* made of a particle and the verb it was
 * standing in front of:
 *
 *  - 脩其祝、嘏，以降上神與其先祖 came out …上の神とその先の祖を**以降す**, where
 *    降 is the verb and the reading is 其の祝・嘏を脩め、以て上の神と其の先の祖と
 *    を**降す**. The bogus いこう the reader saw is this pair's furigana.
 *  - 賞諫者以來之 came out これを**以來す** for 諫むる者を賞して以て之を**來す**.
 *  - 三十而立 came out 三十**而立す** for 三十**にして立つ**. じりつ is a Japanese
 *    word *derived from* that line of 論語, and reading the line with it is
 *    circular.
 *  - 恭以遠恥 came out 恭しく恥を**以遠** for 恭にして以て恥を**遠ざく**, and
 *    其器廉以深 came out その器**廉以深** for 其の器は廉**にして深し** — the ADJ
 *    arm, where the coordinating 以 joins two statives and the pair swallows
 *    the second.
 *
 * **The postposition is not a population to be saved, and that is the finding
 * that settles the width.** 自X以來 ("since X") is a real lexicalised item, and
 * 43 of the 46 以來 are it — so the obvious worry is that a blanket exclusion
 * costs them. It does not: they were never printing the postposition. 自唐以來。
 * came out 唐より**以來す**, 自懿宗以來。 out 懿宗より**以來す**, 混元以降。 out
 * 混元**以降す** — the same coined サ変 verb, because the treebank tags 來 VERB
 * and ROOT (28 of the 46) whether it is the verb 來る or the second half of the
 * postposition. Nothing was lost by excluding what was already wrong, and
 * 唐より以て來る is at least compositional where 唐より以來す is not a word.
 *
 * **No tag and no relation divides the two senses**, which is why this is a
 * list of characters and not a rule. 以來 is `以 ADV/mod` on `來 VERB/ROOT` in
 * 脩文德以來之 ("cultivate culture and virtue so as to *make them come*") and in
 * 自唐以來 alike; 以降's 13 tokens are 12 of the verb 降る (斬寵以降 is 寵を斬りて
 * 以て降る) against 1 postposition (混元以降), on one annotation. The annotation
 * is not the fault and there is nothing to name back to the treebank: 以 really
 * is an adverbial `mod` on the predicate that follows it, which is the
 * compositional analysis and the right one. The fault was this app's, for
 * letting a list of modern Japanese headwords decide what a Literary Chinese
 * particle is half of.
 *
 * **Nor could `curatedInRole` carry it.** Both characters do hold a curated
 * entry — 以 もつ+て, 而 て — but each is char-only, and that function requires a
 * *conditioned* entry for the reason its own doc gives at length: a char-only
 * entry is the character's reading standing on its own and says nothing about
 * it as half of a word, which is exactly what keeps 獨酌 reading ドクシャク
 * rather than ひとり酌. Widening it would take 獨 with 以.
 *
 * **The price is one token, measured.** Three of the 126 were printing
 * something a reader would keep, all noun-headed — 及所部軍使**以上**七十餘人,
 * 累世**以前**，坐此者多矣, and 今三世**以前** — and two of the three cost
 * nothing, because they are held by a *different* branch: `findCompoundSpans`
 * fuses an adjacent VERB/ADJ `mod` onto a nominal head on its own account, so
 * both 以前 keep their span and go on reading 以前 with this rule out of the
 * way. Only 軍使以上七十餘人 loses, to 軍使**もつて上**七十餘人. That branch is
 * left exactly as it stands: it is producing the right answer on the one shape
 * where 以 really does close a nominal, and widening this exclusion into it
 * would break the two it is currently getting right.
 *
 * A `head.pos === "NOUN"` carve-out here would rescue that one token and would
 * also keep 而今 and 而後, the other two noun-headed members, both of which are
 * wrong — 而今而後吾知免夫 is 今よりして後、吾れ免るるを知るかな and never
 * じこんじご. One saved against two kept wrong, on a tag that is doing the work
 * of a sense distinction it cannot make (三世以前's 前 is NOUN and 有以前之's is
 * VERB, one word in either), is not a rule.
 *
 * Keyed on `text` and on `lemma` both. The treebank writes and lemmatises each
 * character one way only — all 7,290 以 and all 7,794 而 have text equal to
 * lemma — so the second test catches nothing here and is for a hand-corrected
 * tree, on the same terms the 與 entry keeps CCONJ beside ADP.
 *
 * **Rendered both ways against a baseline re-rendered immediately before**, over
 * all 68,893 gold sentences: **123** change, and every one of them is among the
 * 125 that carry such a pair — nothing outside the population moves, which is
 * the exclusion being exactly as wide as it claims. By the coined verb each one
 * loses: 以來 46, 而立 25, 以降 13, 以下 8, 以遠 6, 以東 5, 而來 4, 以上 4,
 * 以往 4, 而後 3, 以深 3, 以前 2, 而今 1 (124 over 123 sentences — 而今而後吾知
 * 免夫 loses two). 三十而立 is 三十**て立つ**, 由孔子而來 is 孔子より**て來る**,
 * 混元以降 is 混元**もつて降る**, and 脩其祝、嘏，以降上神與其先祖 is
 * …**もつて**上の神とその先の祖を**降ろす**. Which of て / しかして the 而 takes
 * is `conjugationContext.ts`'s branch and not this one's; what changes here is
 * only that there is a 而 and a verb to read at all. */
const NEVER_HALF_OF_A_WORD: ReadonlySet<string> = new Set(["以", "而"]);

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
    if (NEVER_HALF_OF_A_WORD.has(modifier.text) || NEVER_HALF_OF_A_WORD.has(modifier.lemma)) return null;
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
/** **Whether every share of a divided compound is its own character's
 * on'yomi**, counting a share the compound's own phonology has altered — 出奔
 * しゅっ|ぽん is on'yomi throughout, ぽん being 奔's ホン read after a sokuon.
 *
 * The one recogniser, shared by `onyomiCompound` just below and by
 * `isOnyomiSpan` further down, which put the same question to two different
 * pieces of code and would now have to be taught the same answer twice. What
 * it is taught is `sandhiVariants` — the same enumeration `splitCompoundReading`
 * divides by — so a gate can never refuse a share the splitter has itself
 * produced. Before it did: the moment the splitter could divide しゅっぽん,
 * 衞獻公出奔 read 出奔 with no ending at all, because ぽん is not in KANJIDIC2's
 * list for 奔 and the gate that writes the サ変 す looked no further. Measured
 * over the gold treebank, 96 sentences lost an ending that way and every one
 * of them is a word of exactly this shape (出奔, 尊卑 そんぴ, 吉凶 きっきょう,
 * 掩蔽 えんぺい, 紛紛 ふんぷん).
 *
 * 連濁 is deliberately not admitted: a voiced share is evidence of a *native*
 * compound, which is the thing these gates exist to refuse (大喜 おお|よろこび).
 * The 連声 and 促音便 forms are the opposite kind of evidence — they arise only
 * in Sino-Japanese phonology — so admitting them narrows nothing. */
function onyomiThroughout(kanjidic: KanjidicIndex, chars: string[], shares: (string | undefined)[]): boolean {
  return shares.every((share, i) => {
    if (share === undefined) return false;
    const attested = onyomiOf(kanjidic, chars[i]);
    if (attested.includes(share)) return true;
    // The neighbours are the *shares*, not the characters' own readings: what
    // licenses a sandhi form is the sound actually standing beside it in this
    // division of this word.
    const position = {
      precededBy: i > 0 ? shares[i - 1]?.slice(-1) : undefined,
      followedBy: i < shares.length - 1 ? shares[i + 1]?.[0] : undefined,
    };
    return attested.some((on) => sandhiVariants(on, position).includes(share));
  });
}

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
  return onyomiThroughout(kanjidic, chars, split) ? split : null;
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

/** **A pronoun standing as the complement of a prepositional 為 is a genitive,
 * and reads the genitive reading this table already states for it** — 為我 is
 * 我(わ)が爲に, never 我(われ)が爲に.
 *
 * The reader's ruling, and not a new one: *"われ should become わが by default
 * when modifying something"* is what puts わ + が on `det` in `overrides.json`,
 * and 我 in 我が爲に is modifying something in exactly that sense. What separates
 * the two is only the edge the parse hangs it on. A determiner arrives on `det`,
 * where the table can name the role outright; the complement of a preposition
 * arrives on `comp:obj`, which is *also* the relation an ordinary object stands
 * in (我を愛す, 401 first-person pronouns over the gold), so the table cannot
 * widen the entry to reach this slot without claiming every one of them. The
 * fact that decides it is the **governor** — 為 read ため — and no key on
 * (text, POS, deprel) can carry a fact about another token. Hence a rule here,
 * asked ahead of `findOverride` for the same reason the pair rule above it is:
 * where the table cannot express what a rule knows, the rule goes first.
 *
 * **The が is not written here, and that is the whole of how the doubling is
 * avoided.** `caseParticleFor`'s purposive arm already marks this slot が
 * (`PURPOSIVE_GENITIVE` — a pronoun takes が where a common or proper noun takes
 * の), so the page is one わ short of the reading and not one が short of the
 * particle. This supplies the わ and leaves the particle where it lives, and the
 * 訓読文 draws 我(わ)ガ爲(ため)ニ exactly as it draws a `det` 吾(わ)ガ身 — the
 * furigana from here, the okurigana from `withCaseParticle`. Returning the det
 * entry's `okurigana` as well would put the が on the page twice, and standing
 * the particle down instead would be the same answer written in two modules.
 *
 * **Four conditions, each of which excludes a real population.**
 *
 * 1. **A PRON on `comp:obj`** — the slot itself. 210 of the ADP 為/爲's 1,045
 *    `comp:obj` dependents are pronouns; the other 835 are nominals (NOUN 430,
 *    PROPN 217) taking の, predicates taking が on a 連体形 (VERB 132, ADJ 23 —
 *    `isPurposiveWeiComplement`), and a tail.
 * 2. **The governor is read ため** — `findOverride` asked of the 為 itself, which
 *    is the same question `caseParticleFor`'s own arm asks and for the reason
 *    stated there: `overrides.json` gives 為/爲 ために on `contextPos: ["ADP"]`
 *    and on nothing else, so the ADP tag *is* the condition under which ために is
 *    on the page. A 為 read たり or なす governs no genitive.
 * 3. **The が is actually written** — `caseParticleFor` returning it, rather than
 *    this rule assuming it from the shape. The two halves of one reading then
 *    cannot come apart: a slot whose particle is withheld (the negation branch
 *    withholds it for a predicate complement, and any future arm might for a
 *    pronoun) keeps われ, where a bare 我(わ)爲に would be a fragment. Over the
 *    gold `caseParticleFor` writes が **362** times and every one is this
 *    construction — PRON 210, VERB 131, ADJ 21, all on `comp:obj`.
 * 4. **The table states a `det` genitive for this character whose particle is
 *    が.** This is what picks the five first-person pronouns out of the seventeen
 *    that reach the slot, and it picks them by asking the table rather than by
 *    holding a list: 吾/我/予/余/朕 have a `det` entry reading わ + が, so わ is
 *    what each of them reads here (**29** gold tokens in 29 sentences — 我 19,
 *    余 7, 吾 2, 朕 1; 予 does not occur in this slot). **何 is excluded by the
 *    particle, not overlooked**: its `det` entry is なに + の, the determiner of
 *    何の藥 "what kind of medicine", which is a different construction from the
 *    one the が marks — and なにがために is right as it stands, 何が故に being the
 *    ordinary kundoku of exactly this frame. 之 (92), 誰 (3) and the rest hold no
 *    `det` entry at all and are likewise already right: これがために, たれがために.
 *    A sixth character given a わ + が determiner tomorrow is covered by that
 *    entry alone, with nothing to add here.
 *
 * The gloss comes from the same entry, because it is the same claim about the
 * same word — see that entry, which names this slot. */
function purposiveGenitivePronounReading(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): OverrideEntry | null {
  if (token.pos !== "PRON" || token.dep !== "comp:obj") return null;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return null;
  if (findOverride(governor.text, governor.pos, governor.dep)?.reading !== PREPOSITIONAL_WEI_READING) return null;
  if (caseParticleFor(token, sentence) !== PURPOSIVE_GENITIVE_PARTICLE) return null;
  const genitive = findOverride(token.text, token.pos, GENITIVE_DETERMINER_DEP);
  if (!genitive?.contextDep?.includes(GENITIVE_DETERMINER_DEP)) return null;
  return genitive.okurigana === PURPOSIVE_GENITIVE_PARTICLE ? genitive : null;
}

/** The reading `overrides.json` gives 為/爲 tagged ADP, which is the one
 * condition under which the character is on the page as a preposition — see
 * `purposiveGenitivePronounReading`, condition 2. */
const PREPOSITIONAL_WEI_READING = "ため";

/** The particle `caseParticleFor` marks a purposive 為's complement with (its
 * own `PURPOSIVE_GENITIVE`, named here rather than exported across the edge for
 * the sake of one string). Both the slot's particle and the determiner entry's
 * okurigana are tested against it. */
const PURPOSIVE_GENITIVE_PARTICLE = "が";

/** The relation a genitive determiner stands in, and so the key under which the
 * table holds a character's genitive reading. `conlluParser.ts` normalises only
 * `root` -> `ROOT`, and leaves every other DEPREL as the treebank spells it. */
const GENITIVE_DETERMINER_DEP = "det";

/** **Lexicalized numeral-initial compounds** — a numeral and the character
 * after it that are one Sino-Japanese word, keyed on the pair and read on'yomi
 * throughout: 一切 いっさい, 一片 いっぺん, 三分 さんぶん. One share per character,
 * in modern kana; `historicalSpelling` writes each share the way this app
 * spells an on'yomi, so the page gets いつさい and いつぺん (一 is イツ) exactly as
 * 三十 gets さんじふ. Every reading here is JMdict's own for the whole word,
 * divided by hand — `readsAsItsJmdictHeadword` in `readingCorrections.test.ts`
 * checks the shares still concatenate to it, so the division is answerable to
 * the dictionary rather than asserted here.
 *
 * **Why the pair and not the head's POS.** This treebank tags a great many
 * nominal-ish words VERB or ADJ, so a numeral standing *attributive* to one of
 * them wears the same three features as a numeral counting occasions of a
 * predicate — NUM, `mod`, a VERB/ADJ head — and `adverbialNumeralReading`
 * below cannot tell them apart by category. **This is not a mis-annotation to
 * name.** 切 in 一切眾生 really is a descriptive predicate character, 分 in
 * 三分天下 really is a verb that takes 天下 as its object, and the gold's tags
 * are right about both; what makes each pair one word is a fact about the
 * Japanese lexicon, and only a lexical statement can carry it. So the key is
 * the numeral's own text plus its head's, adjacent — the two things the
 * reading is a fact about.
 *
 * **一切 (36 gold tokens, and the largest single miss the numeral rule had.)**
 * It was reading 一たび切る — "cut once" — where the word is いっさい, "all, the
 * whole of", overwhelmingly Buddhist here: 一切眾生 is 一切の眾生, 一切諸佛 is
 * 一切の諸佛, 一切法皆是佛法 is 一切法は皆是れ佛法なり, 一切世間天、人、阿修羅 is
 * 一切の世間の天・人・阿修羅. The two non-Buddhist tokens are the adverb, and it
 * is the same word and the same reading — 請一切逐之 is 請ふ一切之を逐へ, 豈容一切
 * 輕徇 is 豈に一切輕く徇ふを容れんや. 36 for 36, with nothing to separate. Its head
 * is ADJ 32 times and VERB 4, and all 36 are contiguous; the other 3 一切 in the
 * gold have an ADV-tagged 切 and never reached the rule at all. **It was wrong
 * before that rule existed too** — 一 fell to the ordinary numeral and 切 to its
 * kun'yomi, giving 一切る — so 一切 has never been right here, and reverting it
 * to that is not a fix. This reads it.
 *
 * **三分 (10), on the reader's ruling.** 三分天下 is 天下を三分す, not みたび分く:
 * the pair is a transitive compound verb "divide in three" and the object is
 * the *whole*, not a share of it. All 13 三 standing `mod` on 分 in the gold are
 * contiguous, and the 10 whose 分 is VERB are unanimous — 三分天下 ×3, 三分其地
 * ×4, 三分關中, 三分去一 (三分して一を去る), 功蓋三分國. Not one of them counts
 * occasions. The other 3 have a NOUN 分 and never reached the numeral rule:
 * 今天下三分, 三分割據, 是我王果處三分之一也 — the last is 三分の一, where a
 * サ変 ending would be plainly wrong, which is why `suru` below is asked of the
 * head's own tag as well as of this table.
 *
 * **三分 reads correctly and does not yet *print* correctly, and that is a gap
 * in the reorder engine rather than in this table.** 三分 is the only entry
 * here whose head governs an object, so it is the only one the reading order
 * pulls apart: 分 is the verb and moves behind 天下, stranding 三 where it
 * stood, and 三分天下 comes out 三天下を分す where the reader's own convention is
 * 天下を三分す. 9 of the 10 gold tokens do this (功蓋三分國 is the tenth and stays
 * whole, since its 分 governs nothing that moves); both panels do it
 * identically, so nothing disagrees on the page. **The defect is not new and is
 * not 三分's**: `onyomiPairReading` has always had it for exactly the same
 * reason, and the shipped 大破敵軍 comes out 大敵軍を破す today. A word of two
 * tokens is kept contiguous only when `findCompoundSpans` calls it a span, and
 * that function is driven solely by the parser's own `compound`/`flat`
 * relations — deliberately, and 一切's own 眾生 is why (a dictionary-guessed
 * span once broke negation). Fixing it means teaching `computeReadingOrder`
 * that a resolver-fused pair travels together, which is that engine's ruling to
 * take, not this table's. Recorded here so the next reader of 三天下を分す knows
 * where to look.
 *
 * **一片 (3).** 一片降旛出石頭 · 一片冰心在玉壺 · 一片孤城萬仞山 — in all three 片 is
 * ADJ standing `mod` on the noun after it, so the whole 一片 is attributive:
 * 一片の降旛, 一片の冰心, 一片の孤城. 片 governs nothing in any of them and
 * "cut/split once" is not available as a reading.
 *
 * **The shares are divided by hand, and no longer because the splitter cannot
 * divide them.** It could not when this table was written: `splitCompoundReading`
 * matched each character against KANJIDIC2's own readings, and 一's on'yomi are
 * イチ and イツ — neither is the いっ a geminate compound puts there — so いっさい
 * and いっぺん both came back null. The splitter now has the 促音便 and 連声 it
 * needed (see `sandhiVariants`), and divides both into exactly the shares stated
 * here: いっ|さい off 一's イツ before さ, and いっ|ぺん off that same geminate with
 * 片's ヘン read ぺん after it. The shares stay written out because this entry is
 * doing more than dividing — it names the word, its gloss, and the POS gate that
 * keeps 一切 out of 一切る — and because all three entries should be one kind of
 * thing (さんぶん always divided perfectly well). Where the two now agree, the
 * agreement is asserted rather than assumed: see `tests/compoundReading.test.ts`.
 *
 * **The admission test is "one word in every gold instance", and it is what
 * keeps this a list of three.** Roughly 100 of the numeral rule's 390 firings
 * are a numeral over a predicate-tagged nominal, and most of the bigrams in
 * that tail fail the test outright — the same two characters are one word in
 * some sentences and a counted predicate in others, which no key on the pair
 * can divide:
 *
 *  - **一合 (6)** is 一合相 five times, the いちごう of the 金剛經's "one composite
 *    thing" (是一合相 · 則非一合相 · 是名一合相), and 齊、趙之交，一合一離 once —
 *    where it is precisely the adverbial numeral, ひとたび合しひとたび離る, in a
 *    line built out of the contrast. Excluding the pair would break that one.
 *  - **一舉/一擧 (21 + 3)** is nominal in at least ten — 是秦之一舉也 is 是れ秦の
 *    一舉なり, 在此一擧 is 此の一擧に在り — and verbal in at least three, where 舉
 *    takes an object in the tree: 一舉事 (事 `comp:obj`), 一舉眾而注地於楚 (眾
 *    `comp:obj`). It is the biggest thing left and it is genuinely two
 *    constructions under one bigram.
 *  - **三重 (7)** is "threefold" in six (諸侯之席三重 · 葛帶三重 · 夫祭有三重焉),
 *    and in 大饗，君三重席而酢焉 the 重 governs 席 as `comp:obj` — the ruler
 *    layers the mats three times over, which is the counted predicate.
 *  - **三變 (2)** is 君子有三變 (nominal) against 三變爲覇道 (三たび變じて), one
 *    each.
 *
 * The 有-enumerations left over — 三戒, 三畏, 三友, 一言, one or two tokens each
 * — are all nominal, but what they have in common is a *construction* (有 +
 * numeral + a predicate-tagged noun) and not a lexicon entry, and 三變 shows
 * that the same construction can hold a bigram whose other instance is
 * adverbial. A rule for them belongs in the syntax, not in this table. 一不孝 /
 * 三不孝 are not reachable from here at all: 不 stands between the numeral and
 * its head, and this key is adjacent. */
export const LEXICALIZED_NUMERAL_COMPOUND: Record<
  string,
  { shares: string[]; gloss: string; suru?: boolean }
> = {
  一切: { shares: ["いっ", "さい"], gloss: "all, the whole of" },
  一片: { shares: ["いっ", "ぺん"], gloss: "a single piece of" },
  三分: { shares: ["さん", "ぶん"], gloss: "to divide in three", suru: true },
};

/** The entry in `LEXICALIZED_NUMERAL_COMPOUND` that `token` is a character of,
 * or null.
 *
 * **Asked from either end**, exactly as `modifierHeadPair` is and for the same
 * reason: the resolver hands this one token at a time, both characters of the
 * word owe an answer, and a numeral answered without its head is how 三省吾身
 * came out 三たび省す. The numeral's own relation is the whole of the search —
 * NUM on `mod`, attached to the character immediately after it — so a pair the
 * tree does not join is never found, however the two characters happen to sit
 * on the page. Single-character members only, because the shares are one per
 * character.
 *
 * **The head's POS is deliberately not asked here**, though
 * `adverbialNumeralReading` below asks it: this table is a claim about two
 * characters standing in that relation and it holds whatever the head is
 * tagged. That is what reads 是我王果處三分之一也 — 分 NOUN there, so the numeral
 * rule never saw it — as 三分の一 off the same entry that reads 三分天下. */
function lexicalizedNumeralCompound(
  token: Token,
  sentence: { tokens: Token[] },
): { modifier: Token; head: Token; entry: { shares: string[]; gloss: string; suru?: boolean } } | null {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const asPair = (modifier: Token | undefined, head: Token | undefined) => {
    if (!modifier || !head) return null;
    if (modifier.pos !== "NUM" || modifier.dep !== "mod") return null;
    if (modifier.id + 1 !== head.id || modifier.head !== head.id) return null;
    if ([...modifier.text].length !== 1 || [...head.text].length !== 1) return null;
    const entry = LEXICALIZED_NUMERAL_COMPOUND[modifier.text + head.text];
    return entry ? { modifier, head, entry } : null;
  };
  return asPair(token, byId.get(token.head)) ?? asPair(byId.get(token.id - 1), token);
}

/** This token's share of a lexicalized numeral compound's on'yomi, or null.
 *
 * **`beatsLexicon`, and it is load-bearing on 4 of the 36 一切 and on all 10
 * 三分**: both panels consult `VERB_LEXICON` ahead of the resolver for anything
 * tagged VERB, and that table holds 切 as き (四段ラ, きる) and 分 as わ (わかる)
 * — the right words for a 切 that is cutting and a 分 that is dividing
 * something, and the wrong halves of いっさい and さんぶん.
 *
 * **The サ変 ending is asked of the entry *and* of the head's own tag**, and it
 * takes both. The entry, because a Sino-Japanese compound is a verb only if the
 * dictionary says so — 三分 is JMdict's "noun or participle which takes the aux.
 * verb suru" and 一切 is a plain noun, so 三分天下 is 天下を三分す while 一切す is
 * not a word at all, and no property of the *parse* separates those two (both
 * heads are tagged VERB). The head's tag, because the same entry also covers
 * the pair standing as a bare noun: 三分之一 is 三分の一 and 今天下三分 leaves 分
 * NOUN, and a す written there would be the ending of a verb nothing in the
 * sentence is using. It is `onyomiPairReading`'s own `pair.head.pos === "VERB"`
 * test, asked of a pair that rule cannot see. Naming `conjClass` beside the
 * okurigana rather than freezing the string is likewise that rule's ruling: す
 * is only サ変's 終止形, and 功蓋三分國 wants the 連体形 — 功は三分する國を蓋ふ.
 *
 * `endingComplete` everywhere the ending is *not* supplied, on **both**
 * characters, where `onyomiPairReading` exempts only its modifier: there the
 * head is always carrying the pair's ending, and here — 一切, 一片, and a 三分
 * whose head is NOUN — there is no ending to carry, so neither the head's own
 * `VerbForm` nor anything downstream may put one after it.
 *
 * Source `"kanjidic"` rather than `"override"`, so the characters are kept and
 * the 書き下し文 writes 一切 with いつさい over it rather than spelling the word
 * out in kana — the ruling `adverbialNumeralReading` already records for 一たび,
 * applied to words that are if anything more securely written in kanji. The
 * furigana menu needs nothing: every share is the character's own on'yomi
 * (一 イツ, 切 サイ, 三 サン, 分 ブン), so what is on the page is already one of
 * the menu's entries and a reader who wants ひとたび or みたび back is one click
 * away. 片 is the single exception and it is a spelling one — いっぺん reads ヘン
 * as ぺん, which is 連声 and not 連濁 (the voicing would be べん): a は行 onset
 * after a sokuon is read ぱ行. `compoundMemberCandidates` offers that form to
 * the menu as well as to the splitter, given the environment the page's own
 * shares supply — the share before it ends in っ — so the reader is offered
 * へん and べん beside the ぺん on the page rather than the ぺん appearing in a
 * list that does not contain it. */
function lexicalizedNumeralCompoundReading(
  token: Token,
  sentence: { tokens: Token[] },
  historicalKana: HistoricalKanaIndex | undefined,
): ResolvedReading | null {
  const pair = lexicalizedNumeralCompound(token, sentence);
  if (!pair) return null;
  const isHead = token.id === pair.head.id;
  const suru = isHead && pair.entry.suru === true && pair.head.pos === "VERB";
  return {
    reading: historicalSpelling(historicalKana, token.text, pair.entry.shares[isHead ? 1 : 0]),
    ...(suru ? { okurigana: "す", conjClass: "sa-hen" as ConjClass } : { endingComplete: true }),
    gloss: pair.entry.gloss,
    source: "kanjidic",
    beatsLexicon: true,
  };
}

/** A numeral counting **occasions of a predicate** — 一 as ひと + たび, 三 as
 * み + たび — or null where it is counting things instead.
 *
 * 三省吾身 is 三たび吾が身を省みる and 齊一變 is 齊ひとたび變ず; 三年, 十乘 and
 * 百物 are the ordinary numeral and must not move. The two are one relation
 * apart in nothing: both are `mod`, both are NUM. **What tells them apart is
 * the head's category**, which is why this is a rule here and not an entry in
 * `overrides.json` — that table is keyed on the token's own POS and dep and has
 * no way to ask what the numeral is standing on. Over the gold
 * (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
 * a NUM on `mod` has a VERB/ADJ head **640** times and a NOUN/PROPN/NUM head
 * **4,457**, and the second is the majority this must leave alone. (Counting by
 * *character* instead — the single-digit numerals 一…十 plus 再, whatever POS
 * each token wears — the same split is 698 / 3,368, which is the reader's own
 * measurement and the one the ruling was made on.)
 *
 * Which characters take the reading at all is `ADVERBIAL_NUMERAL_KUN`'s
 * question, and it answers 一 and 三 — see there for the attestation, for why
 * ふたたび is 再's business rather than 二's, and for why the table cannot live in
 * either of the two tables that would otherwise hold a per-character reading.
 * Restricted to those two, the rule fires on **390** gold tokens — 一 218 and 三
 * 172, counted through `parseConllu` and this very function. The 219th 一 in that
 * slot is tagged ADV rather than NUM and is declined; see below.
 *
 * **Ahead of `onyomiPairReading`, deliberately**, where every other rule that
 * reads a pair sits behind it. 三省 (JMdict さんせい), 三思 (さんし) and 三分
 * (さんぶん) are all headwords whose reading splits into two genuine on'yomi, so
 * that rule claims them and 三省吾身 was coming out 三省す — the reader's own
 * headline example, read as a modern Sino-Japanese noun. The dictionary's word
 * list knows that the two characters occur together as a modern headword and
 * nothing whatever about how kanbun reads them; a numeral standing over a
 * predicate is a fact about *this sentence*, and it is the more specific claim.
 * The one cost that ordering had is now paid rather than merely named: 三分天下
 * is 天下を三分す and read みたび for a day, and it is one of the three entries in
 * `LEXICALIZED_NUMERAL_COMPOUND`, which this rule stands down for outright.
 * That is where the dictionary's claim is admitted — for a named pair and on
 * the reader's ruling, not for every headword spelled like one.
 *
 * `pos === "NUM"` and not merely the character, because 一 is also the adverb
 * "wholly, uniformly" — 一遵何約束 is 一に何の約束に遵ふ, not 一たび — and the
 * parser tags that one ADV. The head must not be the token itself, which is the
 * ROOT self-loop this app writes.
 *
 * **No adjacency condition**, unlike the pair rules above: those fuse two
 * characters into one word and a reader who cannot see the pair as contiguous
 * kanji must not be given a fused reading, while this reads one character on its
 * own and the relation is the whole claim. 27 of the 390 have something between
 * the numeral and its verb, and they are the same construction — 三以天下讓 is
 * みたび天下を以て讓る, 比年一小聘 is 比年にひとたび小聘す.
 *
 * **Source `"kanjidic"`, not `"override"`**, on the same reasoning
 * `isNominalizedFaultNoun` and `classicalAdjectiveRootReading` above are: this
 * is a content word that keeps its kanji, so the 書き下し文 must write 一たび and
 * 三たび and not ひとたび and みたび. It is what 再 already does, from KANJIDIC2's
 * own ふたた.び dot through the ordinary lookup — 再拜而送之 is 再び拜して之を送る
 * — and the two must not come out differently spelled on one page.
 *
 * **The measured miss, and the three of it that are now excluded.** The head's
 * POS is the signal the reader named and it is noisy in one direction: this
 * treebank tags a great many nominal-ish words VERB or ADJ, so a numeral
 * attributive to one of them reaches this rule. Of the 390, a hand-check of the
 * head bigrams puts roughly 100 in that class, and one item was a third of them
 * — 一切 (36), いっさい, where 切 is ADJ and the pair is a fixed word.
 * `LEXICALIZED_NUMERAL_COMPOUND` above now takes that one, 三分 (10) and 一片
 * (3), keyed on the pair rather than on the head's POS because the POS is
 * exactly what is unreliable here; the rule fires on **341** gold tokens with
 * those three declined, counted through `parseConllu` and this function.
 *
 * The rest of the shape is left, and left deliberately: 一舉 / 一擧 (24), 三重
 * (7), 一合 (6), 三友 (2), 三變 (2), 三戒, 三畏, 一言, and the 一不孝 / 三不孝
 * enumerations — see that table for what each of them is and why a key on the
 * pair cannot take it. **None of them is a mis-annotation to be named**: the
 * heads really are tagged VERB/ADJ in the gold, and separating "a predicate
 * being counted" from "a predicate-tagged noun being enumerated" needs a
 * curated list or the reader, not a feature. The reader has the escape hatch
 * either way — the furigana menu offers 一's own いち and ひと beside ひとたび. */
function adverbialNumeralReading(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): ResolvedReading | null {
  const parts = ADVERBIAL_NUMERAL_KUN[token.text];
  if (!parts) return null;
  if (token.pos !== "NUM" || token.dep !== "mod") return null;
  const head = sentence.tokens.find((t) => t.id === token.head);
  if (!head || head.id === token.id) return null;
  if (!isContentPredicatePos(head.pos)) return null;
  // **A lexicalized pair is not a predicate being counted**, and it is asked
  // here rather than in the head's POS because the POS is exactly what cannot
  // answer it — see `LEXICALIZED_NUMERAL_COMPOUND`.
  if (lexicalizedNumeralCompound(token, sentence)) return null;
  return { ...parts, gloss: "counting occasions of the predicate", source: "kanjidic" };
}

/** A pair of adjacent tokens that are **one lexical word**, and the reading
 * each of their characters takes as half of it — `oneLexicalWordPair`'s answer.
 *
 * **The two are contiguous and `modifier` stands first**, which is a guarantee
 * of every path that builds one: `modifierHeadPair`'s own `classify` admits a
 * pair only where `modifier.id + 1 === head.id`, `classifierPair` returns the
 * counted quantity before its classifier, and `lexicalizedNumeralCompound`
 * demands the same adjacency. A caller may therefore treat the pair as a span
 * running from `modifier` to `head` without re-deriving the order. */
export interface OneLexicalWordPair {
  /** The half that stands first in the source — the adverb of 大破, the numeral
   * of 三人, the quantity of a classifier phrase. */
  modifier: Token;
  /** The half that stands second, and the one that carries the whole word's
   * ending where it has one (see `onyomiPairReading`'s サ変). */
  head: Token;
  /** One reading per character of `modifier.text` followed by `head.text`, in
   * that order — the word's reading divided into its characters' shares, as
   * `splitCompoundReading` divides it or as a curated entry states it.
   * **Modern kana**: `historicalSpelling` is applied by whoever writes the
   * reading onto the page, not here. */
  readings: string[];
  kind: PairKind;
}

/** **Whether `token` is half of a word rather than a word** — and if it is,
 * which two tokens the word is and how its reading divides between them.
 *
 * One decision with two consumers, which is why it is exported and why
 * `onyomiPairReading` below calls it rather than keeping the gate to itself.
 * The reading layer asks it to decide what the *character* is read as; the
 * span/reorder side asks it to decide whether the two tokens may be pulled
 * apart, because **a word that is one word must travel as one**: 大破敵軍
 * prints 大敵軍を破す today and 三分天下 prints 三天下を分す, the verb moving
 * behind its object and stranding the first half of its own word.
 *
 * **The seam cannot be drawn syntactically, which is the whole reason this has
 * to be the same call.** 大破敵軍 and 深知其意 are the same tree — an adverbial
 * modifier over a transitive verb — and what separates them is that the
 * dictionary reads 大破 as たいは and reads nothing for 深知, so 大 is half of a
 * word and 深 is a word. A rule on POS and relation would fuse both; only the
 * decision the *reading* already made can tell them apart, and a second copy of
 * it would be free to drift from this one.
 *
 * **Two paths, asked in the order the resolver asks them.**
 *
 *  - A **lexicalized numeral compound** — 一切 いっさい, 三分 さんぶん, 一片
 *    いっぺん — whose shares are stated by hand in `LEXICALIZED_NUMERAL_COMPOUND`
 *    because no dictionary division produces them. Asked first, exactly as
 *    `lexicalizedNumeralCompoundReading` is asked before `onyomiPairReading` at
 *    the call site.
 *  - An **on'yomi pair** — the dictionary's own reading of the two characters
 *    together, divided back into one piece per character and checked against
 *    each character's on'yomi list (`onyomiCompound`), or, for a numeral or
 *    classifier pair no dictionary lists, each character's own on'yomi
 *    (`perCharacterOnyomi`). That gate is `onyomiWordPair`, and it carries the
 *    two stand-downs a curated reading and an adverbial numeral impose on it.
 *
 * A caller wanting only the yes/no takes the truth of the result; the pair is
 * returned because knowing *which* two tokens is the half of the question a
 * boolean cannot answer — 一切法 has a 切 that is the second half of one word
 * and a 法 that is no part of it, and a predicate asked of 切 alone cannot say
 * which of its neighbours it belongs to. */
export function oneLexicalWordPair(
  token: Token,
  sentence: { tokens: Token[] },
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
): OneLexicalWordPair | null {
  const lexicalized = lexicalizedNumeralCompound(token, sentence);
  if (lexicalized) {
    // Both members are single characters (`lexicalizedNumeralCompound` demands
    // it), so the entry's two shares are already one per character.
    return { modifier: lexicalized.modifier, head: lexicalized.head, readings: lexicalized.entry.shares, kind: "numeral" };
  }
  return onyomiWordPair(token, sentence, kanjidic, jmdict);
}

/** `onyomiPairReading`'s gate, lifted out of it unchanged so that the rule and
 * `oneLexicalWordPair` above cannot come to disagree about what one word is.
 * Everything the reading needs from the decision is in the result. */
function onyomiWordPair(
  token: Token,
  sentence: { tokens: Token[] },
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
): OneLexicalWordPair | null {
  const pair = modifierHeadPair(token, sentence);
  if (!pair) return null;
  // See `curatedInRole`. A conditioned curated entry for either member is a
  // statement about that character in the role it is standing in here, and
  // outranks the dictionary's claim that the two of them are one word.
  if (curatedInRole(pair.modifier) || curatedInRole(pair.head)) return null;
  // **And an adverbial numeral stands the pair down from either end**, for the
  // same reason and asked the same way. That rule already outranks this one at
  // the call site, so the *modifier* was answered before reaching here — but the
  // *head* was not, and 三省吾身 came out 三たび省す: 三 reading みたび off the
  // syntax while 省 went on taking its half of JMdict's さんせい. Being one word
  // is a property of the pair, so it takes only one end of it to be spoken for
  // (`curatedInRole`'s own argument, and the two 果然/固有 cases it names).
  if (adverbialNumeralReading(pair.modifier, sentence)) return null;
  const chars = [...pair.modifier.text, ...pair.head.text];
  const countedFrom = [...pair.modifier.text].length;
  // **And a counting on'yomi stands the dictionary down**, which is the third
  // stand-down and the same argument as the two above it: `CLASSIFIER_ONYOMI`
  // is a statement about a character *in the role it is standing in here* —
  // 石 as the thing being counted is こく — so it outranks JMdict's claim that
  // these two characters are a modern headword. 一石 is the case: JMdict lists
  // it as いっせき ("one stone"), which divides into 一's イツ geminated and 石's
  // セキ and is on'yomi throughout, so the pair rule took it and the 一石 the
  // reader pinned as いちこく came out いつせき. The classifier table already
  // held the answer and was only being asked on the branch below.
  //
  // Nothing is refused where the two agree, which is most of them: 三人 さんにん
  // is a JMdict headword whose 人 divides to にん, exactly what the table says,
  // and it goes on being read through the dictionary as `CLASSIFIER_ONYOMI`'s
  // own note describes. This declines only a contradiction.
  const dictionary = onyomiCompound(chars, kanjidic, jmdict);
  const contradicted =
    dictionary !== null &&
    pair.kind === "numeral" &&
    chars.some((ch, i) => i >= countedFrom && CLASSIFIER_ONYOMI[ch] !== undefined && CLASSIFIER_ONYOMI[ch] !== dictionary[i]);
  const readings =
    (contradicted ? null : dictionary) ??
    (pair.kind === "numeral" ? perCharacterOnyomi(chars, kanjidic, countedFrom) : null);
  return readings ? { ...pair, readings } : null;
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
  const pair = onyomiWordPair(token, sentence, kanjidic, jmdict);
  if (!pair) return null;
  const chars = [...pair.modifier.text, ...pair.head.text];
  const readings = pair.readings;

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
    //
    // **`suruCompound` beside the class, because the sentence above it is
    // exactly what that field records.** "The head of the pair carries the
    // whole word's ending" is this rule's own claim, made in the comment and
    // in `endingComplete` on the modifier, and `suruCompound` is the field
    // both panels read that claim out of — it is what `compoundSuruOkurigana`
    // gates on, so that a span's ending is written once, after the last
    // member, instead of once per character. The object was making the claim
    // everywhere except in the field that carries it.
    //
    // **What it cost while it was unsaid.** `findCompoundSpans` now takes the
    // lexicon and so recognises a pair like 大破 as one span; both panels then
    // drop each member's own okurigana and ask `compoundSuruOkurigana` for the
    // group's — which declined, for want of this flag, and the ending vanished.
    // 大破秦兵鉅鹿下 printed 秦の兵に鉅鹿の下を大破, the word repaired and the
    // verb gone. `spanSuruReading` below sets the flag and would have answered,
    // but it is never asked: this rule returns first, and the proof is on the
    // page — 大 comes out **たい**, which only this rule produces (the plain
    // kanjidic arm gives だい and the span rule おほ). Reordering the two would
    // therefore change the reading, not just the ending, which is why the flag
    // is set here rather than the rules swapped.
    //
    // **Inert off-span**, which is what makes this safe to say unconditionally:
    // `suruCompound` is read in exactly two places — `compoundSuruOkurigana`
    // just below and `compoundSuruRenyouTe` in `kakikudashi/renyouTe.ts` — and
    // both are reached only from the two panels' fused-span branches
    // (generator.ts and KundokuView.ts). A pair that is not a span never asks.
    //
    // **Measured** over
    // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
    // 1,119 of the 68,893 sentences change, every one of them a サ変 ending
    // restored to a span that had lost it, and the class earns its keep by
    // inflecting rather than freezing — 三分天下 三分**す**, 博學而無所成名
    // 博學**して**, 篤信好學 篤信**し**, 大葬 大葬**する**. 大破秦兵鉅鹿下 is
    // 秦の兵を鉅鹿の下に大破**す**.
    ...(onyomiVerb ? { conjClass: "sa-hen" as ConjClass, suruCompound: true } : {}),
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
 * Literally the same test `onyomiCompound` puts to a modifier+head pair — both
 * call `onyomiThroughout` — asked here of the reading `compoundFurigana`
 * produces rather than of a lookup of this module's own: that function is what both panels draw over these characters,
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
  return onyomiThroughout(kanjidic, chars, modern);
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
  const span = findCompoundSpans(sentence, { kanjidic, jmdict }).find((s) => s.tokenIds.includes(token.id));
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
 * stem has none, and a reading that arrived with one is not this.
 *
 * **The form is reported alongside the ending, and has to be.** Everything
 * downstream of a resolver reading treats its okurigana as a *seed* in the
 * 終止形 — `attestedSense` matches a `LEXICON_SENSES` entry by comparing
 * `conjugatedOkurigana(sense, "shuushi")` against it — and this is the one
 * rule that answers with an inflected form instead, so the seed and the
 * comparison were in different forms and the match could never succeed. For a
 * sense with no `okuriganaPrefix` that cost nothing (the synthesized entry
 * `syntheticLexiconEntry` falls back on states the same class and the same
 * reading), and for one with a prefix it cost the prefix: 大 is おほ + い, and
 * the failed match printed 大(おほ)に across all 399 adverbial tokens where
 * 大いに is the received kundoku. `okuriganaForm` is what closes it — see that
 * field in `./types.ts`. */
function adverbialCopulaEnding(
  token: Token,
  reading: string,
  okurigana: string | undefined,
): { okurigana: string; okuriganaForm: ConjForm; conjClass: ConjClass } | null {
  if (token.pos !== "ADV" || okurigana !== undefined) return null;
  const lex = VERB_LEXICON[token.lemma];
  if (!lex?.conjClass || lex.reading !== reading) return null;
  if (lex.conjClass !== "nari-keiyoudoushi" && lex.conjClass !== "tari-keiyoudoushi") return null;
  return {
    okurigana: (lex.okuriganaPrefix ?? "") + conjugate(lex.conjClass, "renyou"),
    okuriganaForm: "renyou",
    conjClass: lex.conjClass,
  };
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
      if (spanClass) {
        return { ...chosen, okurigana: spanClass.okurigana, conjClass: spanClass.conjClass, beatsLexicon: true, suruCompound: true };
      }
      // **The same split for a pinned nominalizer**, and for the same reason: a
      // pick corrects the reading, not the grammar. `zheParticleReading` decides
      // both what 者 reads *and* the は a nominalizing one carries in a topic
      // slot (`ZHE_NOMINALIZER_OKURIGANA`), and a pin took the whole answer away
      // — 孝弟也者 with `Reading=もの` on the 者 printed もの with no は, where
      // the identical 者 unpinned would have carried one. The reading stays the
      // reader's; the particle is the sentence's.
      //
      // Only where the pick states no ending of its own, on `isBareChosenReading`'s
      // own reasoning above: a pin that brought an `Okurigana=` is a different
      // claim about the word and this must not overwrite it.
      const pinnedZhe = chosen.okurigana === undefined ? zheParticleReading(token, sentence) : undefined;
      if (pinnedZhe?.okurigana !== undefined) return { ...chosen, okurigana: pinnedZhe.okurigana };
      return chosen;
    }

    const zhe = zheParticleReading(token, sentence);
    if (zhe) {
      return { ...zhe, source: "override", endingComplete: true };
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

    // Ahead of the adverbial numeral, which is itself ahead of the pair rule
    // and the override table. Each step of that order is the more specific
    // claim about the same characters: 一切 and 三分 are *these two characters
    // in this relation*, the adverbial numeral is *a numeral over a
    // predicate*, and the pair rule is *whatever the dictionary lists*. The
    // numeral rule declines these pairs on its own account as well (it asks
    // `lexicalizedNumeralCompound` directly), so the two do not depend on this
    // ordering to disagree correctly — but the head half of 一切 and 三分 is
    // reached only here.
    const lexicalizedNumeral = lexicalizedNumeralCompoundReading(token, sentence, historicalKana);
    if (lexicalizedNumeral) return lexicalizedNumeral;

    // Ahead of the pair rule, which is itself ahead of the override table — see
    // `adverbialNumeralReading` for why a numeral counting occasions outranks a
    // JMdict headword spelled like it (三省, 三思).
    const adverbialNumeral = adverbialNumeralReading(token, sentence);
    if (adverbialNumeral) return adverbialNumeral;

    const onyomiPair = onyomiPairReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (onyomiPair) return onyomiPair;

    // Ahead of the table's own lookup, and about one of its own entries: a
    // pronoun under a prepositional 為 is a genitive, and the `det` reading the
    // table holds for it is what it reads — 為我 is 我(わ)が爲に. The lookup
    // below cannot reach that entry, because the fact that makes this slot a
    // genitive is the governor and not the deprel: keyed on `comp:obj` alone the
    // entry would claim every ordinary object pronoun as well. See
    // `purposiveGenitivePronounReading`, which also says why no が is written
    // here.
    const purposiveGenitive = purposiveGenitivePronounReading(token, sentence);
    if (purposiveGenitive) {
      return {
        reading: purposiveGenitive.reading,
        gloss: purposiveGenitive.gloss,
        source: "override",
        // The character is kept, as it is for the table entry this branch is
        // standing in for — 我(わ)が爲に, and the received text keeps 吾 on 108
        // of the 108 occurrences in its 白文 across the gold passages and 我 on
        // 51 of 51. Written here rather than left to default because this
        // branch does not go through `findOverride` and so cannot take the
        // entry's own flag; see `OverrideEntry.spellOutInProse` for the line
        // both of them are drawing.
        spellOutInProse: false,
        endingComplete: true,
      };
    }

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
        // Whether the word is written out in kana in place of its character
        // is a fact about the word, and the table now states it per entry —
        // see `OverrideEntry.spellOutInProse`, which carries the line and what
        // it was measured against. Defaulted true, which is what this said
        // unconditionally when every entry here was taken for a particle.
        //
        // The line the measurement drew, over the 624 gold passages, counting
        // each character in the 白文 against its survivals into the received
        // 書き下し文: 以 217/217, 其 282/282, 則 119/119 keep their character
        // every time, against 也 0/480, 矣 0/156, 乎 3/133 which drop it.
        // **A particle is a morpheme the Japanese sentence supplies and its
        // character has no place in the prose; a word the character names
        // keeps its character, with only the ending beside it.** 之 is 333/560
        // and is the whole case in one character — the pronoun これ keeps it
        // (之れ 18, 之を 239, 之に 53) and the genitive の does not — which is
        // why this is per entry and not per character. `chosenReading.ts`'s
        // `chosenSpellsOutInProse` already states the same line for the pick.
        //
        // `endingComplete` is still every entry's: these glosses are
        // self-contained, so 以's own VerbForm=Conv must not tack a second て
        // onto もつて. Both were previously read off `source` at four separate
        // call sites, each re-deciding what an "override" implies.
        spellOutInProse: override.spellOutInProse ?? true,
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
          okuriganaForm: adverbialCopula.okuriganaForm,
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
