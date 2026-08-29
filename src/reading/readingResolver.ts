import type { Sentence, Token } from "../parse/types.ts";
import { chosenReading } from "./chosenReading.ts";
import type { ReadingResolver, ResolvedReading } from "./types.ts";
import { findOverride } from "./overridesLookup.ts";
import { type KanjidicIndex, lookupKanji, onyomiOf } from "./kanjidicLookup.ts";
import { type JmdictIndex, lookupLemma } from "./jmdictLookup.ts";
import { sequentialVoicing, splitCompoundReading } from "./compoundReading.ts";
import type { HistoricalKanaIndex } from "./historicalKana.ts";
import type { ConjClass } from "../kakikudashi/classicalConjugation.ts";
import { parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import { classicalAdjectiveRootReading, isNominalizedFaultNoun, isTopicalizedAdjective } from "../kakikudashi/conjugationContext.ts";

/** KANJIDIC2's kun'yomi are modern dictionary readings verbatim (e.g.
 * "たか.い", okurigana "い") — this project's whole scope is classical
 * (bungo), not modern, Japanese, and a modern い-adjective needs a real
 * classical ending instead: 終止形 (shuushikei) し (高い -> 高し, 楽しい ->
 * 楽し — both the く and しく katsuyō shuushikei end in し, never い), or
 * 連体形 (rentaikei) き/しき for a topicalized adjective (敦い -> 敦き — see
 * `isTopicalizedAdjective`). Only called once `isAdjective` (Degree=Pos on
 * the token itself, or `isTopicalizedAdjective`) has already confirmed this
 * word is being used adjectivally — that's what makes it safe to also
 * handle kanjidic entries that omit the usual okurigana dot for an
 * inflecting reading (敏's kun is bare "さとい", not "さと.い" the way 聰's
 * "さと.い" is): with no dot to trust, splitting off a trailing い is only
 * reliable because the morph feature, not the string shape, is what
 * identifies this as an adjective in the first place.
 *
 * Only converts the mechanically unambiguous cases — an "い"/no-dot okurigana
 * ending the reading, or one ending "しい" — and otherwise leaves the
 * reading/okurigana untouched: some modern い-adjectives (大きい, "big")
 * descend from a classical なり-adjective instead (大きなり, not a
 * く/しく-adjective 大きし at all), and the surface form alone can't tell
 * those apart, so guessing there would trade one wrong ending for another
 * rather than fix it. */
function classicalAdjectiveReading(
  reading: string,
  okurigana: string | undefined,
  form: "shuushi" | "rentai" = "shuushi",
): { reading: string; okurigana: string | undefined } {
  if (okurigana) {
    if (!okurigana.endsWith("い")) return { reading, okurigana };
    if (form === "rentai") return { reading, okurigana: okurigana.slice(0, -1) + "き" };
    return { reading, okurigana: okurigana.endsWith("しい") ? okurigana.slice(0, -1) : "し" };
  }
  if (!reading.endsWith("い") || reading.length < 2) return { reading, okurigana };
  const trimmed = reading.slice(0, -1); // drop the trailing い
  if (form === "rentai") {
    // Rentaikei always just tacks き on after the stem, whether しく-type
    // (あつ+き=あつき) or く-type (たのし+き=たのしき) — unlike shuushikei
    // below, no further care is needed here.
    return { reading: trimmed, okurigana: "き" };
  }
  // Shuushikei: a しく-type stem (たのし) already *is* the complete
  // shuushikei ending with nothing left to append; a く-type stem (あつ)
  // still needs its own し appended.
  return trimmed.endsWith("し") ? { reading: trimmed.slice(0, -1), okurigana: "し" } : { reading: trimmed, okurigana: "し" };
}

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

/** The 終止形 ending of the classical 二段 verb a modern 一段 one descends
 * from: 立てる -> 立つ, 破れる -> 破る, 起きる -> 起く.
 *
 * KANJIDIC2's kun'yomi are modern dictionary readings verbatim (the same
 * fact `classicalAdjectiveReading` above deals with for adjectives), and a
 * modern 下一段/上一段 verb descends from a classical 下二段/上二段 one whose
 * 終止形 ends in the u-sound of its own row. So the ending converts by
 * replacing the i-sound or e-sound before る with that row's u-sound and
 * dropping the る.
 *
 * The table lists only the rows where that is unambiguous, settled by
 * reading every two-kana -る okurigana KANJIDIC2 actually contains rather
 * than by enumerating the kana chart:
 *
 *  - included, and right throughout their entries: き/ぎ/ち/び/り (起きる,
 *    過ぎる, 落ちる, 綻びる, 足りる -> 起く, 過ぐ, 落つ, 綻ぶ, 足る) and the
 *    whole e-row (建てる, 出でる, 恐れる, 慰める, 述べる, 掛ける, 下げる,
 *    尋ねる, 見せる, 交ぜる);
 *  - excluded み, because the 一段 verbs written with it are the compounds
 *    of 見る (顧みる, 省みる, 試みる, 鑑みる), 上一段 in classical too and
 *    keeping their る;
 *  - excluded じ and ひ for the same reason in miniature: 恥じる is 恥づ, not
 *    *恥ず (modern じ from historical ぢ), 混じる is 四段, and 嚏る is another
 *    上一段;
 *  - excluded the あ row throughout, the same judgement
 *    `classicalAdjectiveReading` makes about 大きい: a modern -eru with a
 *    bare え could descend from ア行下二段 (得), ヤ行下二段 (見ゆ) or
 *    ワ行下二段 (植う), and the surface form cannot tell those apart — 見える
 *    is 見ゆ, not *見う — so guessing would trade one wrong ending for
 *    another.
 *
 * Anything unlisted keeps its modern ending rather than being given a wrong
 * classical one. A one-kana okurigana is left alone throughout: a bare る is
 * already what 上一段 見る takes in classical, and the a-row endings (集まる,
 * 加わる, 下がる) are 四段 and unchanged either way. */
const KAMI_NIDAN_SHUUSHI: Record<string, string> = {
  き: "く", ぎ: "ぐ", ち: "つ", び: "ぶ", り: "る",
};
const SHIMO_NIDAN_SHUUSHI: Record<string, string> = {
  け: "く", げ: "ぐ", せ: "す", ぜ: "ず", て: "つ", で: "づ", ね: "ぬ", へ: "ふ", べ: "ぶ", め: "む", れ: "る",
};
/** The two halves as one table, which is all `classicalVerbEnding` needs —
 * the 終止形 is the same u-sound either way, and only `classicalConjClass`
 * below cares which grade of 二段 the ending came from. Merged here rather
 * than the halves being spelled out again, so the row set has exactly one
 * definition. */
const NIDAN_SHUUSHI: Record<string, string> = { ...KAMI_NIDAN_SHUUSHI, ...SHIMO_NIDAN_SHUUSHI };

function classicalVerbEnding(okurigana: string | undefined): string | undefined {
  if (!okurigana || okurigana.length < 2 || !okurigana.endsWith("る")) return okurigana;
  const row = okurigana[okurigana.length - 2];
  const shuushi = NIDAN_SHUUSHI[row];
  return shuushi === undefined ? okurigana : okurigana.slice(0, -2) + shuushi;
}

/** The paradigm `classicalConjugation.ts` names for a verb of a given 行 in
 * each of the three regular classes, keyed by that 行's 終止形 ending — the
 * *output* side of the two tables above, so a row can only be added to them
 * by way of an ending listed here.
 *
 * A class is absent where classical grammar has no such paradigm rather than
 * where this file merely declines to guess: there is no ザ行/ダ行四段 (ず/づ
 * arise from voicing an already-inflected 下二段 row, never as a 四段
 * terminative), and 上二段 is a much smaller family than 下二段 — か/が/た/ば/
 * ま/ら and no others among these rows. An absent entry falls out as
 * `undefined`, which is the same safe outcome as an unrecognised ending. */
const CLASSES_BY_SHUUSHI: Record<string, { yodan?: ConjClass; kami?: ConjClass; shimo?: ConjClass }> = {
  く: { yodan: "yodan-ka", kami: "kami-nidan-ka", shimo: "shimo-nidan-ka" },
  ぐ: { yodan: "yodan-ga", kami: "kami-nidan-ga", shimo: "shimo-nidan-ga" },
  す: { yodan: "yodan-sa", shimo: "shimo-nidan-sa" },
  ず: { shimo: "shimo-nidan-za" },
  つ: { yodan: "yodan-ta", kami: "kami-nidan-ta", shimo: "shimo-nidan-ta" },
  づ: { shimo: "shimo-nidan-da" },
  ぬ: { yodan: "yodan-na", shimo: "shimo-nidan-na" },
  ふ: { yodan: "yodan-ha", shimo: "shimo-nidan-ha" },
  ぶ: { yodan: "yodan-ba", kami: "kami-nidan-ba", shimo: "shimo-nidan-ba" },
  む: { yodan: "yodan-ma", kami: "kami-nidan-ma", shimo: "shimo-nidan-ma" },
  る: { yodan: "yodan-ra", kami: "kami-nidan-ra", shimo: "shimo-nidan-ra" },
};

/** The conjugation class of the verb whose modern okurigana this is — the
 * companion to `classicalVerbEnding`, answering the *other* half of what the
 * two panels need.
 *
 * The ending alone is not enough, and that is the whole reason this exists:
 * transitive 立 (下二段タ行) and intransitive 立 (四段タ行) share the 終止形
 * 立つ and differ everywhere else — 廟を立てて against 廟立ちて. A reading the
 * syntax chose stands `VERB_LEXICON` down (see `beatsLexicon`), and with the
 * lexicon goes the class it was carrying, so the class has to travel
 * alongside the reading or the citation form is all that is left.
 *
 * Driven off the very same rows `classicalVerbEnding` converts, by
 * construction: the two-kana cases go through `KAMI_NIDAN_SHUUSHI` /
 * `SHIMO_NIDAN_SHUUSHI` themselves, so an okurigana shape this returns a
 * class for is exactly one that gets a classical ending, and the two cannot
 * come to disagree about which rows are in scope. Every exclusion documented
 * on those tables therefore applies here unchanged — most importantly the
 * whole あ row (a modern -eru with a bare え could be ア行/ヤ行/ワ行下二段 and
 * the surface form cannot tell which), and み/じ/ひ.
 *
 * The remaining case is a one-kana okurigana, which `classicalVerbEnding`
 * leaves alone because a 四段 ending is already classical as it stands: 四段
 * of that 行, with modern う read as its historical ふ (習う -> 習ふ, は行四段).
 * A one-kana る is 四段ラ行 here even though bare る is also what 上一段 見る
 * takes — that is a real residual risk, bounded by this only ever being
 * asked about a reading the object check actually *moved*, which for a 上一段
 * verb means moving onto it from some other reading of the same character.
 *
 * Everything else — a two-kana okurigana not ending る (起こす), a longer one
 * (命ずる), an adjective's い — returns undefined rather than a guess. An
 * undefined class simply leaves the pre-existing behaviour in place for that
 * word, which is the outcome to prefer over a confidently wrong paradigm. */
function classicalConjClass(okurigana: string | undefined): ConjClass | undefined {
  if (!okurigana) return undefined;
  if (okurigana.length === 1) {
    return CLASSES_BY_SHUUSHI[okurigana === "う" ? "ふ" : okurigana]?.yodan;
  }
  if (okurigana.length !== 2 || !okurigana.endsWith("る")) return undefined;
  const row = okurigana[0];
  const kami = KAMI_NIDAN_SHUUSHI[row];
  if (kami !== undefined) return CLASSES_BY_SHUUSHI[kami]?.kami;
  const shimo = SHIMO_NIDAN_SHUUSHI[row];
  if (shimo !== undefined) return CLASSES_BY_SHUUSHI[shimo]?.shimo;
  return undefined;
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
function modifierHeadPair(
  token: Token,
  sentence: { tokens: Token[] },
): { modifier: Token; head: Token; kind: "numeral" | "adverb" } | null {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const classify = (modifier: Token, head: Token): "numeral" | "adverb" | null => {
    if (modifier.dep !== "mod" || modifier.id + 1 !== head.id) return null;
    if (parseMorphFeatures(modifier.morph ?? "").Polarity === "Neg") return null;
    if (modifier.pos === "NUM" && (head.pos === "NOUN" || head.pos === "PROPN")) return "numeral";
    if (modifier.pos === "ADV" && head.pos === "VERB") return "adverb";
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
  const hit = lookupLemma(jmdict, chars.join(""));
  if (!hit) return null;
  const split = splitCompoundReading(chars, hit.reading, kanjidic);
  if (!split) return null;
  return split.every((piece, i) => onyomiOf(kanjidic, chars[i]).includes(piece)) ? split : null;
}

/** Each character's own first on'yomi — the fallback for a numeral+noun
 * pair no dictionary lists as a word (五十歩 is not a JMdict headword,
 * though 五十歩百歩 is). Only numerals get it: a numeral and the noun it
 * counts are read on'yomi in kanbun whether or not the pair is lexicalized
 * (三人 サンニン, 百歩 ヒャッポ), whereas an adverb and a verb are read as one
 * word only when they *are* one, which is what the dictionary check above
 * establishes. Returns null if any character has no on'yomi at all. */
function perCharacterOnyomi(chars: string[], kanjidic: KanjidicIndex): string[] | null {
  const readings = chars.map((ch) => onyomiOf(kanjidic, ch)[0]);
  return readings.every((r) => r !== undefined) ? (readings as string[]) : null;
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
  const chars = [...pair.modifier.text, ...pair.head.text];
  const readings = onyomiCompound(chars, kanjidic, jmdict) ?? (pair.kind === "numeral" ? perCharacterOnyomi(chars, kanjidic) : null);
  if (!readings) return null;

  const start = token.id === pair.modifier.id ? 0 : [...pair.modifier.text].length;
  const own = chars
    .slice(start, start + [...token.text].length)
    .map((ch, i) => historicalKana?.[ch]?.[readings[start + i]] ?? readings[start + i]);

  return {
    reading: own.join(""),
    // A verb read on'yomi is read サ変 in kundoku — 大破す, never a bare
    // stem. The same supplement `chosenReading.ts` makes for a hand-picked
    // on'yomi, for the same reason and on the same POS condition: a noun
    // read on'yomi takes no ending at all.
    okurigana: token.pos === "VERB" ? "す" : undefined,
    gloss: kanjidic[token.text]?.meanings[0],
    source: "kanjidic",
    beatsLexicon: true,
    // The modifier is half of one word, not a word of its own, so it takes no
    // ending whatever its own morph says. This parser tags the 大 of 大破
    // `VerbForm=Conv` — true of 大 read おほいに, and false of the たい that is
    // the first half of たいはす — and that morph put a converb て on it: 大破
    // 敵軍 came out 大て敵軍を破す. The ending belongs to the pair, and the
    // pair's head is already carrying it (the サ変 す above).
    ...(token.id === pair.modifier.id ? { endingComplete: true } : {}),
  };
}

/** 連濁 (sequential voicing) on the second element of an adjacent kun'yomi
 * noun+noun modification read as one word — 竹林 たけ+はやし -> たけばやし,
 * 野草 の+くさ -> のぐさ.
 *
 * Only this shape, and deliberately not the fused compound spans: those
 * already go through `compoundFurigana`, which resolves the whole span from
 * JMdict (where `splitCompoundReading` matches each member against its own
 * rendaku variant, so an attested voicing is already reproduced) or reads
 * every member on'yomi. What is left over is the noun+noun `mod` pair that
 * `findCompoundSpans` does not fuse — it fuses only VERB/ADJ modifiers —
 * and whose two members are therefore resolved one at a time, each in
 * isolation, with nothing to make the second one voice.
 *
 * The voicing itself, including Lyman's Law, is `sequentialVoicing`. What
 * this adds is the syntactic condition (an immediately preceding nominal
 * `mod`) and one dictionary check in front of it: where JMdict lists the
 * pair and reads it as the two kun'yomi *unvoiced*, that attestation wins
 * and nothing is voiced — 草木 is くさき, not *くさぎ, and no rule over the
 * two readings could know that. The mechanical rule then covers what the
 * dictionary is silent about, which is most of it (JMdict gives 竹林 only
 * its Sino-Japanese ちくりん and 野草 only やそう, so neither pair's kun'yomi
 * reading is attested there at all).
 *
 * Applied after the historical-kana substitution, never before: it is は
 * that voices to ば, and a modern わ would have nothing to become. */
function rendakuHeadReading(
  token: Token,
  sentence: { tokens: Token[] },
  headReading: string,
  kanjidic: KanjidicIndex,
  jmdict: JmdictIndex,
): string | null {
  if (token.pos !== "NOUN" && token.pos !== "PROPN") return null;
  const modifier = sentence.tokens.find(
    (t) =>
      t.head === token.id &&
      t.id !== token.id &&
      t.dep === "mod" &&
      t.id + 1 === token.id &&
      (t.pos === "NOUN" || t.pos === "PROPN"),
  );
  if (!modifier) return null;

  // Both members have to be read kun'yomi for this to be a kun compound at
  // all — an on'yomi pair is a jukugo, where any voicing is part of the
  // dictionary reading rather than something to derive.
  const modifierHit = lookupKanji(kanjidic, modifier.text, modifier.pos);
  if (!modifierHit || onyomiOf(kanjidic, modifier.text).includes(modifierHit.reading)) return null;
  if (onyomiOf(kanjidic, token.text).includes(headReading)) return null;

  const attested = lookupLemma(jmdict, modifier.text + token.text)?.reading;
  // The modern spelling is what JMdict is written in, so the comparison is
  // against kanjidic's own (modern) readings, not the historical ones on
  // the page.
  const modernHead = lookupKanji(kanjidic, token.text, token.pos)?.reading;
  if (attested && modernHead && attested === modifierHit.reading + modernHead) return null;

  return sequentialVoicing(headReading);
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
 * to be fixed. */
export function createReadingResolver(kanjidic: KanjidicIndex, jmdict: JmdictIndex, historicalKana?: HistoricalKanaIndex): ReadingResolver {
  return (token: Token, sentence: Sentence | { tokens: Token[] }): ResolvedReading => {
    // A reading the user picked from the furigana's own menu outranks every
    // rule below — it is a correction *of* those rules, so any of them
    // winning here would make the choice look like it hadn't registered.
    const chosen = chosenReading(token);
    if (chosen) return chosen;

    const zheTopic = zheTopicReading(token, sentence);
    if (zheTopic) {
      return { reading: zheTopic, gloss: "topic marker (following a noun/name)", source: "override" };
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

    const override = findOverride(token.text, token.pos, token.dep);
    if (override) {
      return {
        reading: override.reading,
        okurigana: override.okurigana,
        gloss: override.gloss,
        source: "override",
      };
    }

    // Before the plain per-character lookup below, and after the override
    // table: a modifier+head pair read as one Sino-Japanese word (大破
    // タイハす, 三人 サンニン) is a reading of the *pair*, which no lookup of
    // either character on its own can produce.
    const onyomiPair = onyomiPairReading(token, sentence, kanjidic, jmdict, historicalKana);
    if (onyomiPair) return onyomiPair;

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
    const wantTransitive = hasObject(token, sentence);
    const transitivity = token.pos === "VERB" && (!isAdjective || wantTransitive) ? { wantTransitive, jmdict } : undefined;
    const kanjidicHit = lookupKanji(kanjidic, token.text, token.pos, transitivity);
    if (kanjidicHit) {
      // historicalKana is keyed by kanjidic's own (modern) reading string,
      // so it's looked up *before* classicalAdjectiveReading's stem-trimming
      // below — not after — or an undotted adjective entry (the one case
      // that actually changes `reading`, not just `okurigana`) would look
      // itself up under a key the index never used.
      const baseReading = historicalKana?.[token.text]?.[kanjidicHit.reading] ?? kanjidicHit.reading;
      const { reading, okurigana } = isAdjective
        ? classicalAdjectiveReading(baseReading, kanjidicHit.okurigana, topicalized ? "rentai" : "shuushi")
        : { reading: baseReading, okurigana: kanjidicHit.okurigana };
      // 連濁 on the head of a kun'yomi noun+noun modification — see
      // `rendakuHeadReading`. Applied to the historical spelling, which is
      // why it sits here rather than inside the lookup.
      const voiced = isAdjective ? null : rendakuHeadReading(token, sentence, reading, kanjidic, jmdict);
      // KANJIDIC2's okurigana is modern throughout, so a verb's 一段 ending
      // is put back into classical 二段 shape here — see
      // `classicalVerbEnding`. Applied to every verb reading, not only to a
      // transitivity-selected one: 起 is 起く whether or not the object
      // check moved anything, kanjidic's きる being the modern 上一段 form of
      // the same word either way. Skipped where the adjective conversion
      // above has already rewritten the ending, which is finished (高し) and
      // must not be run through a second, contradictory rule.
      const ending = token.pos === "VERB" && okurigana === kanjidicHit.okurigana ? classicalVerbEnding(okurigana) : okurigana;
      // Only a transitivity-selected reading carries `beatsLexicon`: it is
      // the one answer here the syntax chose rather than the character's
      // own entry ordering, and so the only one with a claim to outrank the
      // lexicon's single per-lemma entry.
      //
      // `conjClass` travels with it and only with it, derived from the same
      // *modern* okurigana `classicalVerbEnding` just converted (not from
      // `ending`, which has already lost the i/e-grade distinction the class
      // turns on). Standing the lexicon down discards the class that entry
      // was carrying, and without a replacement the panels can only print the
      // citation form — 廟を立つて, where the 下二段 class gives 廟を立てて.
      // Nothing is attached where the lexicon still applies: that reading
      // goes on reaching its own entry's class exactly as before.
      const conjClass = kanjidicHit.transitivitySelected ? classicalConjClass(okurigana) : undefined;
      return {
        reading: voiced ?? reading,
        okurigana: ending,
        gloss: kanjidicHit.gloss,
        source: "kanjidic",
        ...(kanjidicHit.transitivitySelected ? { beatsLexicon: true } : {}),
        ...(conjClass ? { conjClass } : {}),
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
