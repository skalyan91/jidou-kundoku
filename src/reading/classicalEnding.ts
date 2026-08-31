/** KANJIDIC2's okurigana is a *modern* dictionary ending throughout, and
 * this project's whole scope is classical — so an ending taken off a
 * kanjidic entry has to be read twice before it can go on the page: once for
 * the classical ending it becomes, and once for the conjugation class it
 * came from. The three rules that do that live here, in a module whose only
 * import is a type, because their callers sit on opposite sides of an
 * existing import edge: `readingResolver.ts` applies them to every reading it
 * settles on, and `chosenReading.ts` — which the resolver imports — applies
 * them to the ending that arrives with a reading the reader picked off the
 * furigana menu. Either module hosting them would have made the other reach
 * back through a cycle (`chosenReading` -> `kanjidicLookup` -> `jmdictLookup`
 * -> `rereadCharacters` -> `chosenReading` is the one that appeared when they
 * were tried in `kanjidicLookup.ts`).
 *
 * The order the two are asked in matters, and is the one trap here:
 * `classicalConjClass` must be given the *modern* ending, never the classical
 * one `classicalVerbEnding` produces. The conversion is lossy in exactly the
 * place the class turns on — 立てる and 立ちる both become 立つ, and 四段タ行
 * against 下二段タ行 is precisely the distinction 廟を立てて needs — which is
 * why `CLASSES_BY_SHUUSHI` is keyed by 終止形 with the three grades kept
 * apart underneath it. Both callers therefore derive the class from the
 * untouched ending and convert afterwards.
 *
 * The one value this module imports is `attestedSenseByModernSpelling`, and
 * it is imported from `verbLexicon.ts` rather than from
 * `conjugationContext.ts` — where the same question is already asked, of the
 * same data — because that file is on the far side of the very cycle above:
 * it imports `chosenReadingText` from `chosenReading.ts`, which imports this
 * module. `verbLexicon.ts` is a leaf (its own imports are
 * `classicalConjugation.ts` and a JSON index), so the edge to it closes
 * nothing, and the helper was moved there so both sides could reach it. */
import type { ConjClass } from "../kakikudashi/classicalConjugation.ts";
import { attestedSenseByModernSpelling } from "../kakikudashi/verbLexicon.ts";

/** The word class KANJIDIC2's own kun'yomi notation states, read off the
 * shape of the reading and nothing else — the general form of a question this
 * file and `kanjidicLookup.ts` had been answering one case at a time.
 *
 *  - **`"nominal"`** — no okurigana dot. A bare kun'yomi is an uninflecting
 *    word: a noun (中's なか/うち) or an adverb (応's まさに). It takes no
 *    ending in any position.
 *  - **`"verb"`** — a dotted ending whose last kana is a 終止形 u-sound
 *    (`SHUUSHI_KANA`): あた.る, ま.つ, もと.める, こた.える.
 *  - **`"i-final"`** — a dotted ending in い, which is **not** the same thing
 *    as an adjective and is the one trap here. KANJIDIC2 writes a 連用形
 *    nominal with a final い too — 扱's あつか.い ("handling"), 向's む.かい
 *    ("facing"), 使's つか.い, 勢's いきお.い — and those are nouns that take no
 *    ending at all, never 扱し / 向かし. Over the shipped index the shape is
 *    い-final 1,134 times; JMdict vouches for 220 of those as adjectives and
 *    for 38 as ordinary nouns, with 874 absent from it altogether. So this
 *    answer names the ambiguity rather than resolving it, and a caller that
 *    needs it resolved has to put the word to a dictionary — which is what
 *    `classicalAdjectiveKun` in `kanjidicLookup.ts` does.
 *  - **`"unstated"`** — a dotted ending the shape says nothing about: 連用形
 *    nominals (飲.み, 開.き, 割.り), adverbs (もっ.て, まこと.に, あたか.も),
 *    ナリ活用 stems (やす.らか, たし.か, おだ.やか), and the classical
 *    adjectives and auxiliaries KANJIDIC2 spells out in full (悪's あ.し, 可's
 *    べ.し). 768 of the 16,036 kun'yomi in the shipped index. Undecidable
 *    here, and left so.
 *
 * **What the answer licenses, and what it does not.** `"verb"` licenses
 * treating the word as inflecting — taking it for a VERB-tagged token,
 * refusing it for a NOUN, expecting an okurigana that conjugates. It does
 * **not** license a paradigm: the ending names the 行 only where the tables
 * below say it does, and 老いる/悔いる/報いる (ヤ行上二段 老ゆ/悔ゆ/報ゆ),
 * 用いる (ワ行上一段 用ゐる) and 強いる (ハ行上二段 強ふ) share one ending and
 * have three different answers. `"i-final"` licenses nothing on its own —
 * see above. `"nominal"` licenses withholding every ending.
 *
 * Measured against JMdict over the whole shipped index: of the 6,447 readings
 * this calls `"verb"`, 2,168 are vouched for as verbs, 4,259 are absent from
 * JMdict (overwhelmingly rare kyūjitai for words it holds under their
 * shinjitai), and 20 disagree — the numerals 一つ/二つ/…/九つ, whose つ is a
 * 終止形 kana by coincidence; the 連体詞 或る/明くる/来たる/眇たる; 曰く and
 * 現つ, both nouns; and the frozen 非ず. Every one of those is a word this app
 * reaches by another route (曰 has its own `VERB_LEXICON` entry, a numeral is
 * never tagged VERB), so none of them is a live misreading — but the rule is
 * a rule about a *shape*, and these are what the shape cannot see. */
export type KunWordClass = "nominal" | "verb" | "i-final" | "unstated";

/** The 終止形 kana a classical verb's dictionary form can end in — the whole
 * う row, which is also every ending `CLASSES_BY_SHUUSHI` below has a paradigm
 * for, plus the modern う that stands for は行's ふ. Written as the row rather
 * than derived from that table so the two say different things: this one says
 * "this word inflects", and that one says "this is the paradigm it inflects
 * by". A shape can state the first and not the second, which is the whole
 * subject of this module. */
const SHUUSHI_KANA: ReadonlySet<string> = new Set(["う", "く", "ぐ", "す", "ず", "つ", "づ", "ぬ", "ふ", "ぶ", "む", "る"]);

export function kunWordClass(kun: string): KunWordClass {
  // KANJIDIC2's affix hyphen ("こ-", "-ごと.に") is positional notation, not
  // part of the reading — see `stripAffixHyphen` in `kanjidicLookup.ts`. A
  // bound form is still a word of some class, and it is the dot that says
  // which.
  const bare = kun.replace(/^-|-$/g, "");
  const dot = bare.indexOf(".");
  return dot === -1 ? "nominal" : splitKunWordClass(bare.slice(dot + 1));
}

/** The same answer for a kun'yomi already split into its reading and its
 * okurigana — the shape every caller downstream of `splitOkurigana` holds,
 * where the dot has been spent and only its *absence* (an undefined
 * okurigana) is left to record it. Undefined is `"nominal"` for that reason,
 * and not "no answer": an undotted kun'yomi is a bare noun, which is the one
 * thing this rule is certain of. */
export function splitKunWordClass(okurigana: string | undefined): KunWordClass {
  if (okurigana === undefined) return "nominal";
  // 種's supplementary う. puts the dot last: the 終止形 is the bare stem mora
  // with nothing after the kanji (see `SUPPLEMENTARY_KUN`). The dot is there
  // precisely to say the word inflects, which is this answer.
  if (okurigana === "") return "verb";
  if (okurigana.endsWith("い")) return "i-final";
  return SHUUSHI_KANA.has(okurigana[okurigana.length - 1]) ? "verb" : "unstated";
}

/** The 終止形 ending of the classical 二段 verb a modern 一段 one descends
 * from: 立てる -> 立つ, 破れる -> 破る, 起きる -> 起く.
 *
 * KANJIDIC2's kun'yomi are modern dictionary readings verbatim (the same
 * fact `classicalAdjectiveReading` below deals with for adjectives), and a
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
export const KAMI_NIDAN_SHUUSHI: Record<string, string> = {
  き: "く", ぎ: "ぐ", ち: "つ", び: "ぶ", り: "る",
};
export const SHIMO_NIDAN_SHUUSHI: Record<string, string> = {
  け: "く", げ: "ぐ", せ: "す", ぜ: "ず", て: "つ", で: "づ", ね: "ぬ", へ: "ふ", べ: "ぶ", め: "む", れ: "る",
};
/** The two halves as one table, which is all `classicalVerbEnding` needs —
 * the 終止形 is the same u-sound either way, and only `classicalConjClass`
 * cares which grade of 二段 the ending came from. Merged here rather than the
 * halves being spelled out again, so the row set has exactly one
 * definition. */
const NIDAN_SHUUSHI: Record<string, string> = { ...KAMI_NIDAN_SHUUSHI, ...SHIMO_NIDAN_SHUUSHI };

/** The words whose classical ending is a fact about the word rather than
 * about the shape of its modern one — keyed by the whole modern kun'yomi,
 * reading and okurigana together, which is the same identity
 * `attestedSenseByModernSpelling` uses and for the same reason: a reading is
 * a stem, an okurigana is an ending, and only the two together name a
 * dictionary headword.
 *
 * **The one entry is もちいる**, 用ゐる — ワ行上一段, whose whole paradigm is
 * the ゐ this table restores (未然 ゐ / 連用 ゐ / 終止 ゐる / 連体 ゐる / 已然
 * ゐれ / 命令 ゐよ). Modern spelling merged ゐ into い (see
 * `MEDIAL_KANA_MERGERS` in verbLexicon.ts), so KANJIDIC2 writes it もち.いる
 * and there is no ゐ left in the ending for anything above to find.
 *
 * It is a table and not a row on `KAMI_NIDAN_SHUUSHI`, because the い row is
 * exactly where the ending shape stops being evidence and a blanket rule
 * would corrupt the neighbours: 老いる, 悔いる and 報いる are ヤ行上二段
 * classically — 老ゆ, 悔ゆ, 報ゆ, a 終止形 in ゆ that keeps no ゐ at all and no
 * る either — which is why that table omits い outright. 強いる is a third
 * answer again (ハ行上二段 強ふ). Nothing about もちいる's surface separates it
 * from those; only the word does.
 *
 * `VERB_LEXICON` already holds 用's three senses (用ゐる, 用ひる, 用ゆ), and
 * the character resolves through it correctly today — this table is for the
 * paths that never reach the lexicon at all: the furigana menu, which offers
 * a kanjidic kun'yomi as written, and a reading picked off it, which outranks
 * the lexicon by construction. Every one of those three senses spells itself
 * もちいる today, so `attestedSenseByModernSpelling` abstains on 用 (three
 * matches, not one) and cannot be what answers this. ゐる is the reader's
 * answer among the three, not a derivation.
 *
 * Listed under **both** spellings of its own ending, so that a word already
 * converted still finds its paradigm. The menu now stores ゐる outright, and
 * `chosenConjClass` would otherwise have only a ゐ row to read a class off —
 * which no table here has, exactly as none has い. The modern key is what
 * converts; the classical one is what keeps the conversion idempotent, which
 * is the property every caller here relies on (see `chosenOkurigana`). */
const MOCHIWIRU = { okurigana: "ゐる", conjClass: "kami-ichidan" } as const;
const LEXICAL_KUN: Record<string, { okurigana: string; conjClass: ConjClass }> = {
  もちいる: MOCHIWIRU,
  もちゐる: MOCHIWIRU,
};

/** The classical ending and paradigm for `reading` + `okurigana` where that
 * pair names a word in `LEXICAL_KUN`, and undefined everywhere else — which
 * is everywhere but one word, so every caller falls straight through to the
 * mechanical rules below it. Both halves are required: a bare もち is 持 and
 * 望 as readily as 用. */
export function lexicalKun(
  reading: string | undefined,
  okurigana: string | undefined,
): { okurigana: string; conjClass: ConjClass } | undefined {
  return reading && okurigana ? LEXICAL_KUN[reading + okurigana] : undefined;
}

/** `reading` is the stem the ending belongs to, and is only consulted for
 * `LEXICAL_KUN` — omit it and the mechanical conversion below runs exactly as
 * it always has. Callers that have the reading in hand should pass it; the
 * ending alone cannot tell 用いる from 老いる. */
export function classicalVerbEnding(okurigana: string | undefined, reading?: string): string | undefined {
  const lexical = lexicalKun(reading, okurigana);
  if (lexical) return lexical.okurigana;
  if (!okurigana || okurigana.length < 2 || !okurigana.endsWith("る")) return okurigana;
  const row = okurigana[okurigana.length - 2];
  const shuushi = NIDAN_SHUUSHI[row];
  return shuushi === undefined ? okurigana : okurigana.slice(0, -2) + shuushi;
}

/** KANJIDIC2's kun'yomi are modern dictionary readings (e.g. "たか.い",
 * okurigana "い") — this project's whole scope is classical (bungo), not
 * modern, Japanese, and a modern い-adjective needs a real classical ending
 * instead: 終止形 (shuushikei) し (高い -> 高し, 楽しい -> 楽し — both the く
 * and しく katsuyō shuushikei end in し, never い), or 連体形 (rentaikei)
 * き/しき for a topicalized adjective (敦い -> 敦き — see
 * `isTopicalizedAdjective`). Only called once the caller has already
 * confirmed this word is being used adjectivally (Degree=Pos on the token
 * itself, or `isTopicalizedAdjective`) — that's what makes it safe to also
 * handle kanjidic entries that omit the usual okurigana dot for an
 * inflecting reading (敏's kun is bare "さとい", not "さと.い" the way 聰's
 * "さと.い" is): with no dot to trust, splitting off a trailing い is only
 * reliable because the morph feature, not the string shape, is what
 * identifies this as an adjective in the first place. The gate is not
 * optional even for a *dotted* ending: kanjidic writes a 連用形 nominal with
 * the same final い (扱's あつか.い "handling", 向's む.かい "facing"), and
 * those are nouns that take no ending at all, never 扱し/向かし.
 *
 * Only converts the mechanically unambiguous cases — an "い"/no-dot okurigana
 * ending the reading, or one ending "しい" — and otherwise leaves the
 * reading/okurigana untouched: some modern い-adjectives (大きい, "big")
 * descend from a classical なり-adjective instead (大きなり, not a
 * く/しく-adjective 大きし at all), and the surface form alone can't tell
 * those apart, so guessing there would trade one wrong ending for another
 * rather than fix it. */
export function classicalAdjectiveReading(
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

/** Which of the two adjective paradigms a modern い-adjective belongs to,
 * read off the *modern* ending — ク活用 for やす.い (易し, 連体形 易き), シク活用
 * for やさ.しい (易し, 連体形 易しき).
 *
 * The companion to `classicalAdjectiveReading` and the reason it needs one:
 * that conversion erases exactly this distinction. Both classes take し in
 * the 終止形, so やす + し and やさ + し are the same stored shape, and a class
 * derived from a *classical* ending — which is all `classicalConjClass` has
 * to work with, and which is why it answers undefined for every adjective —
 * cannot come back out of it. The modern ending still carries it, in the
 * しい that only シク活用 writes, so this has to be asked before the
 * conversion and the answer carried alongside the reading. That is the
 * whole of why a hand-picked adjective needs a class stored explicitly where
 * a hand-picked verb does not (see `chosenReading.ts`'s third MISC key).
 *
 * Asked of the same value `classicalAdjectiveReading` converts and under the
 * same conditions: an okurigana where kanjidic's dot supplies one, the whole
 * reading where it does not (敏's bare さとい). Callers gate this on the word
 * really being an adjective exactly as they gate that conversion — nothing in
 * a trailing い says so by itself.
 *
 * Deliberately not asked of an ending with a stem mora inside it (危's
 * あぶ.ない, whose classical form is 危なし and not 危し): those are the endings
 * `classicalAdjectiveReading` refuses to convert, and a class without the
 * matching conversion would inflect a stem the reading never grew. */
export function classicalAdjectiveConjClass(reading: string, okurigana: string | undefined): ConjClass {
  return (okurigana ?? reading).endsWith("しい") ? "shiku-keiyoushi" : "ku-keiyoushi";
}

/** The paradigm `classicalConjugation.ts` names for a verb of a given 行 in
 * each of the three regular classes, keyed by that 行's 終止形 ending — the
 * *output* side of the two 二段 tables above, so a row can only be added to
 * them by way of an ending listed here.
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
 * That is a guess and nothing more — a one-kana modern ending is *usually* a
 * 四段 terminative and is not always one, and the ways it is not are not
 * near-misses but whole other paradigms: 見る/着る/煮る/干る are 上一段, 有り/
 * 居り/侍り ラ変, 死ぬ ナ変, 得 ア行下二段. The bug this cost was 見り for 見て.
 *
 * So the guess yields to the lexicon wherever the lexicon has an attested
 * answer, `word` naming the word to ask about — the lemma and the reading
 * already chosen for it. `attestedSenseByModernSpelling` is asked, so the
 * lexicon's own classical class is accepted only where the *modern* spelling
 * that class surfaces as is the very okurigana in hand (見 read み is 見る,
 * 見す and 見ゆ in the lexicon, and only 見る spells itself みる today).
 *
 * The modern spelling, and not the classical 終止形, is what identifies the
 * word, and the difference is the whole of why this is sound: 下二段カ行 空く
 * and 四段カ行 空く share the 終止形 く exactly as 立つ does, so a 終止形 match
 * would have made a one-kana あく mean 下二段 空ける — the same collision the
 * two-kana branch below exists to resolve, reintroduced. The 二段 families
 * gained a る in the modern language and so cannot match a one-kana ending at
 * all, which is precisely the property that keeps this off 立.
 *
 * Only this branch consults the lexicon. The two-kana branch below has real
 * evidence of its own — the i/e grade modern spelling preserves — and it is
 * the branch 廟を立てて depends on; 立's attested senses are both 四段, so
 * letting them speak there would undo the transitivity distinction rather
 * than refine it.
 *
 * Everything else — a two-kana okurigana not ending る (起こす), a longer one
 * (命ずる), an adjective's い — returns undefined rather than a guess. An
 * undefined class simply leaves the pre-existing behaviour in place for that
 * word, which is the outcome to prefer over a confidently wrong paradigm. */
export function classicalConjClass(
  okurigana: string | undefined,
  word?: { lemma: string; reading: string | undefined },
): ConjClass | undefined {
  if (!okurigana) return undefined;
  // Ahead of both branches, and of the lexicon the one-kana branch consults:
  // 用's three senses all spell themselves もちいる, so the lexicon abstains on
  // exactly the word this answers. See `LEXICAL_KUN`.
  const lexical = lexicalKun(word?.reading, okurigana);
  if (lexical) return lexical.conjClass;
  if (okurigana.length === 1) {
    const attested = word && attestedSenseByModernSpelling(word.lemma, word.reading, okurigana)?.conjClass;
    return attested ?? CLASSES_BY_SHUUSHI[okurigana === "う" ? "ふ" : okurigana]?.yodan;
  }
  if (okurigana.length !== 2 || !okurigana.endsWith("る")) return undefined;
  const row = okurigana[0];
  const kami = KAMI_NIDAN_SHUUSHI[row];
  if (kami !== undefined) return CLASSES_BY_SHUUSHI[kami]?.kami;
  const shimo = SHIMO_NIDAN_SHUUSHI[row];
  if (shimo !== undefined) return CLASSES_BY_SHUUSHI[shimo]?.shimo;
  return undefined;
}
