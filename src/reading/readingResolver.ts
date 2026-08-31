import type { Sentence, Token } from "../parse/types.ts";
import { chosenReading } from "./chosenReading.ts";
import type { ReadingResolver, ResolvedReading } from "./types.ts";
import { findOverride } from "./overridesLookup.ts";
import { hasAdjectiveKun, type KanjidicIndex, lookupKanji, onyomiOf } from "./kanjidicLookup.ts";
import { classicalAdjectiveReading, classicalConjClass, classicalVerbEnding, splitKunWordClass } from "./classicalEnding.ts";
import {
  attestedClassicalParadigm,
  findCompoundSpans,
  isModernIchidanLemma,
  isSuruVerb,
  type JmdictIndex,
  lookupLemma,
  lookupModernisedLemma,
} from "./jmdictLookup.ts";
import { attestedSenseByModernSpelling, VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
import { splitCompoundReading } from "./compoundReading.ts";
import { compoundFurigana } from "./compoundFurigana.ts";
import type { HistoricalKanaIndex } from "./historicalKana.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ConjClass } from "../kakikudashi/classicalConjugation.ts";
import { parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import {
  caseParticleFor,
  classicalAdjectiveRootReading,
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  isNominalizedFaultNoun,
  isTopicalizedAdjective,
  nextMeaningfulToken,
  syntheticLexiconEntry,
  tariSuffixGroup,
} from "../kakikudashi/conjugationContext.ts";
import { conjugate } from "../kakikudashi/classicalConjugation.ts";
import { rereadGovernedForm } from "../kakikudashi/rereadCharacters.ts";

/** Whether the token governs a direct object — the syntactic fact that
 * decides between a character's transitive and intransitive kun'yomi (立太子
 * "install a crown prince" has 子 as 立's `comp:obj` and reads 立てる; 三十而立
 * "at thirty I stood on my own" has none and reads 立つ).
 *
 * Read off the tree rather than off the token's own features, because that
 * is where it lives: SUD marks the *dependent* as the object, so a verb has
 * no feature of its own saying it took one. `comp:obj@` subtypes are
 * included — the relation is still an object relation whatever the parser
 * qualifies it with — and a preposed object counts exactly as a postposed
 * one does (何如's 何 is `comp:obj` of 如 despite standing before it), since
 * the question here is whether the verb has an object at all, not where in
 * the line it sits. */
function hasObject(token: Token, sentence: { tokens: Token[] }): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && (t.dep === "comp:obj" || t.dep.startsWith("comp:obj@")),
  );
}

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
 * predicate like 仁/賢 VERB with Degree=Pos, not NOUN, when it's used
 * predicatively like this). 者's own (pos, dep) can't distinguish these —
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
    if (head.pos === "VERB" || head.pos === "NOUN" || head.pos === "PROPN") return "modifier";
    return null;
  };

  const head = byId.get(token.head);
  if (head && head.id !== token.id) {
    const kind = classify(token, head);
    if (kind) return { modifier: token, head, kind };
  }
  const modifier = sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && classify(t, token) !== null);
  if (modifier) return { modifier, head: token, kind: classify(modifier, token)! };
  return null;
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
 * Returns null if any character has no on'yomi at all. */
function perCharacterOnyomi(chars: string[], kanjidic: KanjidicIndex): string[] | null {
  const readings = chars.map((ch) => onyomiOf(kanjidic, ch)[0]);
  return readings.every((r) => r !== undefined) ? (readings as string[]) : null;
}

/** How 之 read これ divides between the character and the ending beside it:
 * こ over 之 with レ as okurigana, or these unsplit when a case particle
 * follows.
 *
 * The pronoun is written 之れ, the way 以 is written 以て and 乃 乃ち — れ is an
 * ending, not part of what the character says. But the ending slot holds one
 * run, and a case particle is written in it too: 見之 is これヲ, and splitting
 * the reading as well would put レヲ beside a character reading こ, breaking
 * the word in half to write a two-kana ending. Where the particle takes the
 * slot the reading stays whole; where nothing does, the れ is written as the
 * okurigana it is. Both occur in one text — 一番僧見之 (これヲ) and 曰：「有之。」
 * (こレ) are four sentences apart.
 *
 * `caseParticleFor` is what decides it, and it is the same call both panels
 * make about this very token — `withCaseParticle` in KundokuView.ts and the
 * `caseParticle` field on generator.ts's own piece — so the condition here
 * cannot come apart from the particle it is conditioned on. Asked in the
 * resolver rather than in either panel for that reason: the split has to be
 * one answer, and this is the one place both panels read the reading from.
 *
 * 之 alone. 是 and 此 also read これ in this text, and each is a separate claim
 * about how that character is written rather than a consequence of this one. */
function zhiPronounSplit(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
  override: { reading: string; okurigana?: string },
): { reading: string; okurigana?: string } | null {
  if (token.text !== "之" || override.reading !== "これ") return null;
  if (caseParticleFor(token, sentence)) return null;
  return { reading: "こ", okurigana: "れ" };
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
 *    token as it actually stands. 然 tagged VERB is しかり — and in 果然 the
 *    然 the pair rule is claiming *is* that VERB. A hand-verified statement
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
    onyomiCompound(chars, kanjidic, jmdict) ?? (pair.kind === "numeral" ? perCharacterOnyomi(chars, kanjidic) : null);
  if (!readings) return null;

  const start = token.id === pair.modifier.id ? 0 : [...pair.modifier.text].length;
  const own = chars
    .slice(start, start + [...token.text].length)
    .map((ch, i) => historicalKana?.[ch]?.[readings[start + i]] ?? readings[start + i]);

  // The head of the pair carries the whole word's ending; the modifier is
  // half of one word and takes none (see `endingComplete` below). Asked of
  // the *head's* POS and not the token's own, because the ending belongs to
  // the pair: when the modifier was required to be an adverb this came to the
  // same thing, since an ADV is not a VERB and so was never given one — and
  // the moment any modifier could qualify, 佳釀 printed 佳す釀す, the サ変
  // ending written twice over one word.
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
  const readings = onyomiCompound(chars, kanjidic, jmdict) ?? perCharacterOnyomi(chars, kanjidic);
  if (!readings) return null;

  const start = token.id === group.stem.id ? 0 : [...group.stem.text].length;
  const own = chars
    .slice(start, start + [...token.text].length)
    .map((ch, i) => historicalKana?.[ch]?.[readings[start + i]] ?? readings[start + i]);

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

/** The reading `token` takes as the carrier of a fused span JMdict lists as
 * a する-verb, or null where it is not that.
 *
 * A span read on'yomi reached the page with no ending at all: 蠕動 — JMdict's
 * ぜんどう, "noun or participle which takes the aux. verb する" — printed as
 * two bare characters, where 獨酌 (a modifier+head *pair*, taken by
 * `onyomiPairReading`) already read 獨酌する and 封 (a kun-less verb, taken by
 * the kanjidic branch below) already read 封して. Three routes to a
 * Sino-Japanese word, and the only one with no サ変 ending on it was the one
 * the parser had fused.
 *
 * **What this keys on is JMdict's part of speech, not the fact of being a
 * span.** Being written as two adjacent characters the parser tied together
 * is not evidence of anything: 蠕動 and 游魚 ("fish swimming about in water")
 * arrive as identical two-token spans, and 游魚 is a plain noun that takes no
 * ending and must not be given one. `isSuruVerb` is the whole of the test.
 *
 * The carrier's own POS is the second condition, and it is the same one the
 * other two routes make — `pair.head.pos === "VERB"` there, `token.pos ===
 * "VERB"` in the kanjidic branch. A する-noun is a noun before it is a verb
 * (學問 is "learning" far more often than it is 學問す), and the carrier is
 * the member holding the span onto the sentence, so its tag is what says
 * whether this span is predicating. Asked of the carrier and no one else, so
 * exactly one member of a span can answer this and the two panels cannot pick
 * different members.
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
  if (carrier.id !== token.id || carrier.pos !== "VERB") return null;
  if (!isSuruVerb(jmdict, span.text)) return null;

  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const chars = span.tokenIds.map((id) => byId.get(id)!.text);
  const readings = compoundFurigana(chars, span.text, jmdict, kanjidic, historicalKana ?? null, () => undefined);
  const own = readings[span.tokenIds.indexOf(token.id)];
  if (!own) return null;

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
    gloss: lookupLemma(jmdict, span.text)?.gloss,
    source: "jmdict",
  };
}

/** The okurigana a fused span takes as one word — サ変, conjugated for where
 * the span stands — or undefined for a span that takes none.
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
 * the group, not from the carrier's own neighbour). */
export function compoundSuruOkurigana(
  carrier: Token,
  lastMemberId: number,
  plan: ReadingPlan,
  resolve: ReadingResolver,
): string | undefined {
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
  return conjugatedOkurigana(lex, form) + converbSuffix(carrier, next, lex.conjClass);
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
  return (token: Token, sentence: Sentence | { tokens: Token[] }): ResolvedReading => {
    // A reading the user picked from the furigana's own menu outranks every
    // rule below — it is a correction *of* those rules, so any of them
    // winning here would make the choice look like it hadn't registered.
    const chosen = chosenReading(token);
    if (chosen) return chosen;

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
      // 之 read これ is written 之れ where nothing else claims the ending slot
      // — see `zhiPronounSplit`, which is where the condition lives so that
      // both panels read one answer rather than each deciding for itself.
      const parts = zhiPronounSplit(token, sentence, override) ?? override;
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
    const spanSuru = spanSuruReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (spanSuru) return spanSuru;

    // This treebank tags a stative predicate VERB with Degree=Pos rather
    // than ADJ (深/太/大 all arrive that way), so what makes a token
    // adjectival here is the feature, not the POS — decided ahead of the
    // lookup because it governs the lookup as well as the ending below.
    const topicalized = isTopicalizedAdjective(token, sentence);
    const isAdjective = topicalized || parseMorphFeatures(token.morph ?? "").Degree === "Pos";

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
    const wantTransitive = hasObject(token, sentence);
    const adjectivalSense = isAdjective && hasAdjectiveKun(kanjidic, token.text);
    const transitivity = token.pos === "VERB" && (!adjectivalSense || wantTransitive) ? { wantTransitive, jmdict } : undefined;
    // The 歴史的仮名遣い substitution happens inside the lookup now, not here:
    // it is keyed by kanjidic's own (modern) reading string, so it has to run
    // before classicalAdjectiveReading's stem-trimming below — not after — or
    // an undotted adjective entry (the one case that actually changes
    // `reading`, not just `okurigana`) would look itself up under a key the
    // index never used. Making that the lookup's own business is what puts
    // this path and the furigana menu's `candidateReadings` on one rule
    // rather than two that have to be kept in step by hand.
    const kanjidicHit = lookupKanji(kanjidic, token.text, token.pos, transitivity, historicalKana);
    if (kanjidicHit) {
      const { reading, okurigana } = isAdjective
        ? classicalAdjectiveReading(kanjidicHit.reading, kanjidicHit.okurigana, topicalized ? "rentai" : "shuushi")
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
      const shapeClass = token.pos === "VERB" ? classicalConjClass(kanjidicHit.okurigana, { lemma: token.lemma, reading }) : undefined;
      const verbKun =
        token.pos === "VERB" && okurigana === kanjidicHit.okurigana && splitKunWordClass(kanjidicHit.okurigana) === "verb";
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
          : token.pos === "VERB" && okurigana === kanjidicHit.okurigana
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
}
