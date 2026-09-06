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

/** The 歴史的仮名遣い spelling of a *reading* that arrived in modern kana,
 * where the verb lexicon attests one for this very word — 貯's たくわ is たくは,
 * because `VERB_LEXICON` holds 貯ふ (ハ行下二段) under the reading たくは and
 * `modernOkurigana` of that paradigm is `える` exactly.
 *
 * **Why this is not the general modern-to-historical map, which does not
 * exist.** `historicalKana.ts` says at length why: the correspondence is
 * one-to-many (a medial わ is は in 変はる and わ in 川), so it is gated on
 * *attestation* there and on *mediality*, and 別's word-initial わ is exactly
 * why a bare reading cannot be transferred by rule. `fullSizeKana` folds 促音
 * and 拗音 and touches neither わ nor は. Nothing mechanical can spell たくわ as
 * たくは.
 *
 * What can is the lexicon, and only because the *whole modern headword* is in
 * hand rather than a kana string: `attestedSenseByModernSpelling` identifies a
 * sense by reading **and** okurigana together, and returns nothing where more
 * than one sense survives. So this is not a respelling rule at all — it is a
 * dictionary lookup that happens to come back written historically, and the
 * substitution it licenses is purely orthographic by construction: the sense
 * is only taken when its own reading *modernises to the very string asked
 * about* (`modernReading` in verbLexicon.ts), so たくは comes back for たくわ
 * and no sense whose reading is a different word ever can.
 *
 * **What it declines to convert**, which is everything the lexicon does not
 * settle: a lemma with no entry, a reading no sense of that lemma spells, an
 * okurigana that is not the paradigm's own modern ending, and — the abstention
 * that matters most — a lemma where *two* senses match (用's もちいる is 用ゐる,
 * 用ひる and 用ゆ all three, so nothing is claimed). In every one of those the
 * reading is handed straight back exactly as it was written, which is the rule
 * this has to keep: a reader's own spelling stands wherever nothing attests
 * otherwise.
 *
 * Idempotent, as everything in this module must be (see `chosenOkurigana`): a
 * reading already in the lexicon's spelling matches that sense on the *first*
 * disjunct of the same comparison and comes back unchanged. */
export function attestedHistoricalReading(
  lemma: string | undefined,
  reading: string,
  okurigana: string | undefined,
): string {
  if (lemma === undefined) return reading;
  return attestedSenseByModernSpelling(lemma, reading, okurigana)?.reading ?? reading;
}

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

/** The words this app writes with an ending *beside* the character rather than
 * wholly over it — これ as こ+レ, より as よ+リ — and the ending each takes.
 *
 * **Keyed by the reading, not by the character.** 之れ is written the way 以 is
 * written 以て and 乃 乃ち: れ is an ending, not part of what the character
 * says, and that is a fact about the *word* これ, which is the same word
 * whichever of 之 / 此 / 是 spells it. Keying by character made each spelling a
 * separate claim to be rediscovered — the set held 之 and 此 and not 是, so
 * 蟲是劉之福 drew これ whole over 是 beside a 此れ four sentences earlier. Over
 * the shipped tables the reading is reached by 之, 此, 是 (KANJIDIC2 kun lists
 * これ for all three) and by 之's and 是's own `overrides.json` entries; any
 * further character read これ is caught for free.
 *
 * **それ is これ's own series, and joins it for the reason the keying already
 * gives.** こ/そ/か + れ is one paradigm, and れ is no more part of what 其 or
 * 夫 says than it is part of what 之 says: 其れ and 夫れ are written the way
 * 此れ and 是れ are. The reading is reached by two curated entries —
 * `overrides.json` gives 其 それ off its char-only entry and 夫 それ on
 * PART/SCONJ — and between them that is **1,303** non-`det` 其 and **1,427**
 * non-`det` 夫 over the recoded gold, so it is not a corner. 其's *other*
 * entry already divides its other word by hand (`det` 其 is そ + の, written
 * into that entry), which is what made the missing half visible: one character
 * split as そ+ノ where it modifies and drawn whole as それ where it stands
 * alone. The conditions below apply here as everywhere — 227 of the 夫 and 13
 * of the 其 stand on `comp:obj` and take を, so those keep the reading whole.
 *
 * より is the same statement about the postposition: 自 and 從 have curated ADP
 * entries reading より, 从 and 由 are given them here (see `overrides.json`),
 * and each is written よ+リ — 遠方ヨリ over four characters' worth of okurigana
 * slot was the whole reading standing beside a character with nothing above
 * it. **ADP only**, because that is the word this is about: 自 also reads より
 * outside an adposition slot in this table's char-only entry, and 由's own ADV
 * entry is なほ, a different word entirely.
 *
 * **Here rather than in `readingResolver.ts`, where it was written, because
 * the furigana menu has to divide a candidate exactly as the page divides the
 * annotation.** `openReadingMenu` finds the entry to mark by comparing against
 * the reading in the `<rt>`, and a page reading こ matches no candidate saying
 * これ — 此/是/之 each showed an unmarked menu on the very occurrences this
 * split produced. `candidateReadings` and the resolver now read one table, and
 * this module is where a rule both sides of the `readingResolver.ts` ->
 * `kanjidicLookup.ts` edge need already lives (see the file's own doc).
 *
 * The split itself is unconditional here and the *conditions* are not: the
 * ending slot holds one run, so where a case particle takes it the reading
 * stays whole (見之 is これヲ, not レヲ), and that is a fact about one token in
 * one sentence rather than about the word. `readingEndingSplit` in
 * `readingResolver.ts` is where those conditions are asked. The menu asks
 * none of them and offers *both* divisions, because both reach the page —
 * 一番僧見之 (これヲ) and 曰：「有之。」 (こレ) are four sentences apart in one
 * text, and a menu that offered only one of them would leave the other
 * occurrence marking nothing. */
export const READING_ENDING_SPLITS: readonly { reading: string; okurigana: string; pos?: string }[] = [
  { reading: "これ", okurigana: "れ" },
  { reading: "それ", okurigana: "れ" },
  { reading: "より", okurigana: "り", pos: "ADP" },
];

/** **者's two particle uses, named by the slot each puts its は in.** The
 * character reads は either way and the difference is where the kana goes,
 * which is the same division `READING_ENDING_SPLITS` above draws for これ and
 * より — so the two constants live beside that table rather than in the rule
 * that applies them.
 *
 *  - `ZHE_TOPIC_READING` — the bare topic marker after a noun or name, 黃帝者
 *    -> 黃帝は. Read *in place of* the character: it is a particle and nothing
 *    else, and the 書き下し文 spells it out in kana as it does every other
 *    particle it writes.
 *  - `ZHE_NOMINALIZER_OKURIGANA` — the nominalizer after a predicate, 不復挺者
 *    -> 復た挺かぬ者は. Here 者 is a *noun* ("the one who…"), so the character
 *    stays and only the は is written beside it, which is the reader's own
 *    statement of this rule. Its furigana slot is empty.
 *
 * **Here, and not in `readingResolver.ts` where the rule that applies them is,
 * because `conjugationContext.ts` has to read the same two facts and cannot
 * import that module.** `readingResolver.ts` imports `caseParticleFor` from
 * `conjugationContext.ts`, so the edge back is a cycle — the same one this
 * module was created to sit outside of (see the file doc). What
 * `conjugationContext.ts` needs them for is `isNominalizerAhead`: whether the
 * predicate before 者 is attributive turns on which of these two uses this 者
 * is, and that question used to be answered by comparing 者's reading against
 * もの, a string neither use returns any more.
 *
 * Which slot the は landed in is the whole of the distinction, and is readable
 * off the resolved reading with no further test: the topic marker fills
 * `reading` with the は and leaves `okurigana` unset, while the nominalizer
 * puts もの in `reading` and the は in `okurigana`.
 *
 * **The nominalizer's `reading` was empty and is now もの**, which is what the
 * 訓読文 draws over the character. Leaving it empty wrote the は beside a 者
 * with nothing above it — the reader's own report, "I'm not seeing the furigana
 * もの for 者". The word is ものは and the character is 者; もの is what is read
 * *of* the character and は is the ending, exactly the division 此れ takes as
 * こ+レ. Nothing downstream had to move for it: `isNominalizerAhead` already
 * accepts either shape, and it is the first of its two arms — the reading —
 * that now answers. */
export const ZHE_TOPIC_READING = "は";
export const ZHE_NOMINALIZER_READING = "もの";
export const ZHE_NOMINALIZER_OKURIGANA = "は";

/** How `reading` divides into furigana + okurigana, or null where this app
 * writes it whole. `pos` is the token's part of speech, for the entries that
 * name one; a caller with no POS in hand (the tests' direct lookups) reaches
 * only the unconditioned entries. */
export function readingEndingSplitFor(reading: string, pos?: string): { reading: string; okurigana: string } | null {
  const rule = READING_ENDING_SPLITS.find((r) => r.reading === reading && (r.pos === undefined || r.pos === pos));
  if (!rule) return null;
  return { reading: rule.reading.slice(0, -rule.okurigana.length), okurigana: rule.okurigana };
}

/** Common classical adverbs/conjunctions that keep their kanji in
 * kakikudashibun (unlike pronouns or case particles, which are spelled out
 * in kana via `reading/overrides.json`) — a bounded, hand-verified set in
 * the same spirit as `verbLexicon.ts`, not an attempt to classify every
 * override-table entry.
 *
 * **What this table says is which characters are in it, read as which words.**
 * Neither half is a dictionary fact. "This adverb keeps its kanji" is not one:
 * 悉 is filed `ことごと.く` in KANJIDIC2 exactly as every ordinary verb is filed
 * with a dotted kun, and nothing in that entry separates the adverb 悉く, which
 * survives into the prose as a kanji, from the verb こころ.みる, which does not.
 * Nor is "and the word it is, is this one": KANJIDIC2 lists 更 as さら, さらに,
 * ふ.ける and ふ.かす without saying which of the four is the retained adverb,
 * and 嘗 as かつ.て beside こころ.みる and な.める. Both claims are this app's,
 * about kanbun, and both stay hand-kept.
 *
 * **Where the kanji ends is a dictionary fact, and is no longer written here.**
 * KANJIDIC2 marks the okurigana boundary of a kun'yomi with a dot — 嘗 かつ.て,
 * 必 かなら.ず, 悉 ことごと.く — and `retainedAdverbOkurigana` in
 * `kanjidicLookup.ts` reads it off the entry that spells the `reading` named
 * here, through the same `splitOkurigana` the rest of the app already uses for
 * every other character. Naming the word is what makes that lookup answerable;
 * dividing it is the dictionary's job, and for fourteen of the eighteen it does
 * it. `okurigana` is stated only for the residue, where the dictionary cannot
 * be asked at all or answers about a different word, with the reason given per
 * entry below.
 *
 * The okurigana used to be hand-copied for all eighteen, and the cost of a
 * hand-copy is what it always is: 嘗's て went missing on the way in, and the
 * character rendered カツテ beside a bare 嘗 with no furigana at all, on a
 * reading KANJIDIC2 divides perfectly well. A hand-copied *division* that
 * disagrees with the dictionary about a character nobody re-checks is exactly
 * the failure this arrangement removes — and a hand-written *reading* cannot
 * fail the same way, because it is what the page prints and a wrong one is
 * visible on sight.
 *
 * **Here, and not in `generator.ts` where it was written, for the reason
 * `READING_ENDING_SPLITS` above is here**: a table that divides a reading
 * between the two annotation slots is read by the furigana menu as well as by
 * the two panels, and the menu is on the far side of an import edge from the
 * prose generator (`generator.ts` -> `readingResolver.ts` ->
 * `kanjidicLookup.ts`, so the reverse edge is a cycle). `candidateReadings`
 * could not see this table at all, and the cost was exactly what an unseen
 * split costs: 豈 is drawn あ over the character with ニ beside it, its menu
 * listed あに, and nothing matched, so nothing was marked as current. This
 * module is where a rule both sides of that edge need already lives (see the
 * file's own doc).
 *
 * That edge is also why the derivation cannot live beside the table: the
 * kanjidic index is fetched at runtime and handed to the resolver, so there is
 * nothing importable to consult at module load, and reaching for
 * `kanjidicLookup.ts` from here would close the very cycle this module was
 * moved out of `generator.ts` to avoid. The derivation therefore sits in
 * `kanjidicLookup.ts` and its answer travels to the two panels on the
 * resolver's `ResolvedReading` (`retainedAdverbOkurigana`), which is the one
 * thing every consumer of this table already holds. */
export interface RetainedAdverb {
  /** The word this character is when it keeps its kanji — the reading the page
   * prints over it, joined: 嘗 かつて, 必 かならず, 亦 また. It is not the
   * division (that is the dictionary's, read off this) but the thing divided,
   * and it is here because the dictionary cannot be asked *which* of a
   * character's kun'yomi the retained adverb is.
   *
   * The same string `overrides.json` states for sixteen of the eighteen, and
   * the two it does not (必, 更) are read straight from KANJIDIC2 by the
   * ordinary kanjidic path. Nothing reads the reading *from* here — it exists
   * to identify the dictionary entry — so a disagreement with either source
   * would show up as a missing division rather than as a wrong reading on the
   * page, which is what the test that walks this table is for. */
  reading: string;
  /** Where the character ends, for the residue alone: an entry KANJIDIC2 has
   * no reading of at all (固, 益), or has undotted where this app divides it
   * (豈, 曽). Absent — which is fourteen of the eighteen — means the dot in the
   * dictionary's own entry for `reading` is the answer. */
  okurigana?: string;
}

export const KANJI_RETAINED_ADVERBS: Record<string, RetainedAdverb> = {
  亦: { reading: "また" },
  皆: { reading: "みな" },
  尚: { reading: "なほ" },
  猶: { reading: "なほ" },
  且: { reading: "かつ" },
  甚: { reading: "はなはだ" },
  必: { reading: "かならず" },
  更: { reading: "さらに" },
  // 悉 read ことごとく — the same shape as 必ず and 更に, and added for the same
  // reason the others are here: it is an adverb with a dictionary reading of
  // its own, so it keeps its kanji. `overrides.json` already bounds the
  // adverbial use away from the verb 悉くす ("to exhaust in full") by requiring
  // ADV + `mod`, which is what that entry's own gloss records measuring.
  悉: { reading: "ことごとく" },
  但: { reading: "ただし" },
  獨: { reading: "ひとり" },
  独: { reading: "ひとり" },
  // The three the reader's 酒蟲 still had in the kana-only slot, each with the
  // right reading already and the kanji dropped in the prose. All three are
  // ordinary adverbs with a dictionary reading, which is what this table
  // claims, so they are annotated the way 必ず and 更に are. They are also all
  // three residue — for the two different reasons given below — which is a
  // coincidence of this text rather than a pattern.
  //
  // 豈 read あに — 豈飲啄固有數乎？ is あに飲啄もとより數有らんか. `caseParticleFor`
  // reads the same character from the other side (see
  // `RHETORICAL_QUESTION_ADVERB_LEMMAS`), where it is the 反語 marker that turns
  // a following 乎 from や into か; the two uses of the character are the same
  // word and this is where its own reading is divided.
  //
  // **Residue, and the first of the two kinds.** KANJIDIC2 does hold the
  // reading — it files 豈 as `あに` — but files it *undotted*, so the division
  // it states is あに whole with nothing beside the character, and あ + に is
  // not the dictionary's answer. The app writes 豈ニ because that is how a
  // kanbun text writes the 反語 marker, which is a claim about this app's
  // orthography and not about KANJIDIC2's, so it is asserted here.
  豈: { reading: "あに", okurigana: "に" },
  // 固 read もとより — 固 + もと/より, the same い-sound-stem shape as 悉く.
  //
  // **Residue of the second kind: the dictionary does not have the word.**
  // KANJIDIC2's 固 is the adjective/verb entry (かた.める, かた.まる, かた.まり,
  // かた.い) and lists もとより nowhere, so there is no dot to read. The reading
  // reaches the page from `overrides.json` alone, and the division with it.
  固: { reading: "もとより", okurigana: "より" },
  // 益 read ますます, with no okurigana at all — the whole reading goes over the
  // character, as 亦 and 皆 do. The reading is a reduplication (益益), which the
  // render layer now marks with a 〻 below-right; that mark is drawn from the
  // *reading*, so it composes with this rather than competing — this table only
  // decides that the character is kept and that nothing is written beside it.
  //
  // Residue for the same reason 固 is: KANJIDIC2's 益 is `ま.す`, the verb, and
  // ますます is not in it at all.
  益: { reading: "ますます", okurigana: "" },
  // かつて, the same case again and the last of the kana-only slot in the
  // reader's 酒蟲: 嘗 was drawn カツテ beside a bare character with no furigana
  // at all, where it wants かつ over the character and テ beside it.
  //
  // **The division is not a judgement here; it is written in the dictionary.**
  // KANJIDIC2 gives 嘗's kun as `かつ.て` and 曾's as `かつ.て`, and that dot is
  // the okurigana boundary — the same notation `splitOkurigana` in
  // `kanjidicLookup.ts` already reads for every other character. The reading
  // reaches these three from `overrides.json` instead, which states かつて
  // whole, so the boundary was lost on the way; `retainedAdverbOkurigana` puts
  // it back by asking the dictionary rather than by re-copying the dot.
  //
  // 嘗's entry in `overrides.json` is gated `contextPos: ["ADV"]`, which is
  // what keeps this off the verb な.める / こころ.みる — the same bounding 悉
  // relies on above, and for the same reason.
  嘗: { reading: "かつて" },
  曾: { reading: "かつて" },
  // 曽 is the odd one out in the data rather than in the language, and so the
  // fourth residue entry: KANJIDIC2 files it as `かつ` and `かつて` with no dot at
  // all, the simplified form having been indexed less carefully than the two
  // traditional ones. The tie-break in `retainedAdverbOkurigana` reaches the
  // undotted `かつて` — the only one of the two that joins to the reading — and
  // an undotted entry states no division, so the dictionary's answer for this
  // character is "" where its traditional twin's is て. Asserted identically to
  // 曾 above, because it is the same word; the shinjitai index is no way round
  // it either, since it maps 曾 -> 曽 and the reverse direction is many-to-one.
  曽: { reading: "かつて", okurigana: "て" },
  // 與/与 read ともに — the comitative adverb, 與(とも)に. 可與言 is 與に言ふべし;
  // 未可與適道 is いまだ與に道に適くべからず; 揖所與立 is 與に立つところに揖す.
  //
  // **The same kind of word as 獨 ひとり, three lines above**, and it was being
  // treated as the opposite kind. The reading reaches these tokens from
  // `overrides.json`, which marks every entry `spellOutInProse`, so the prose
  // wrote ともに and dropped the character and the 訓読文 drew トモニ beside a
  // bare 與 with no furigana at all — which is precisely the failure this table
  // exists to prevent, stated in its own doc about 亦 and マタ. Received kundoku
  // writes the character, and this app's practice is that where a curated table
  // speaks for a word, the kanji survives into the prose.
  //
  // **Residue of the first kind — 豈's case exactly.** KANJIDIC2 does hold the
  // reading, filing 與's kun as `ともに`, but files it *undotted*, so the division
  // it states is ともに whole with nothing beside the character. と'も + に is
  // this app's orthography for the word and is asserted here, as 豈ニ and 固ヨリ
  // are.
  //
  // **The character has four roles and only this one keeps its kanji this way**,
  // which is what made `retainedAdverbApplies` below necessary: 與 is ADP 1,406
  // times (と, 利與命 as 利と命と), a sentence-final particle 189 times (や), a
  // VERB 與ふ, and ADV **61** times — every one of the 61 comitative. The rule
  // reaches a token per *lemma*, so before that gate it fired on all of them and
  // printed 與に where と belongs, on 1,476 tokens.
  與: { reading: "ともに", okurigana: "に" },
  与: { reading: "ともに", okurigana: "に" },
};

/** **Whether this token is the word `KANJI_RETAINED_ADVERBS` names**, and so
 * whether the two panels may keep its kanji and write the table's okurigana
 * after it. The shared gate both of them now ask, in place of the two
 * conditions each was applying on its own.
 *
 * The table is keyed by character and `retainedAdverbOkurigana` attaches its
 * answer per *lemma* — deliberately, and see the resolver's note on why — so
 * what arrives at a panel is "this character is in the set", not "this token is
 * that adverb". For every member the table held until now the two came to the
 * same thing: 亦 is また wherever it stands, 必 is かならず. 與 is not, and its
 * arrival broke the assumption in the loudest possible way: the character is a
 * preposition 1,406 times against 61 adverbial uses, and the rule fired on all
 * of them, printing 利與に命 where 利と命と belongs.
 *
 * **So the test is the word and not the character.** The table names a word —
 * 猶 is なほ, 嘗 is かつて, 與 is ともに — and this asks whether that is what this
 * occurrence actually resolved to, furigana and okurigana together. Nothing
 * else in the two panels can ask it: the prose panel appends the okurigana
 * without looking at the reading at all (which is what 必 needs — its reading
 * arrives already divided into かなら + ず, so a test that the *reading* ends in
 * the okurigana would strip its ず), and the kundoku panel's
 * `retainedAdverbParts` makes that stricter test and falls through to the
 * ordinary furigana branch when it fails.
 *
 * **It corrects three characters besides 與**, each the same failure — a
 * character used as something other than the adverb the table names, and given
 * the adverb's ending anyway. Measured over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`,
 * against a baseline re-rendered immediately before: **122** of the 68,893
 * sentences change. **61** are 與's own (ともに -> 與に). **37** are 猶 standing as
 * a comparison rather than as なほ — 待猶君也 printed 君を**猶**, the bare
 * character with the empty okurigana this table gives なほ and the word nowhere
 * on the page, and now prints 君を**ごとし**, which is what this app already
 * writes for 如 and 若. **18** are 嘗 as the autumn sacrifice, not かつて: 秋曰嘗
 * and 天子嘗、禘、郊、社 printed 嘗**て**, "formerly", inside a list of the four
 * seasonal rites. **5** are 更 in the name 滕更 — 滕更之在門也 printed 滕の更**に**.
 *
 * **Two tokens are lost to it and are the price**: 滋益恭 and 弟子稍益進, where 益
 * resolves to something other than ますます and now prints 益**す** where it
 * printed a bare 益. One more, 黨與皆爲卿相, is 與 as the noun of 黨與 ("the
 * faction") reaching KANJIDIC2's own undotted ともに and printing 黨與**に** — the
 * gate cannot catch that one, the reading being the table's word by a route
 * that is not the adverb. */
export function retainedAdverbApplies(
  lemma: string,
  resolved: { reading?: string; okurigana?: string; beatsLexicon?: boolean; source?: string },
): boolean {
  const listed = KANJI_RETAINED_ADVERBS[lemma];
  if (!listed) return false;
  // The 獨酌 stand-down, unchanged in substance and narrowed by one clause. A
  // reading the *pair rule* chose is not this adverb's own word — 獨酌 is どく・
  // しやく, not 獨り酌 — and `beatsLexicon` is what marks it. A **curated** entry
  // carries the same flag for an entirely different reason: it says the table
  // outranks `VERB_LEXICON` for the role this token stands in, which is a
  // statement that this *is* the adverb, not that it is half of something else.
  // 與's ADV entry needs the flag (the parser tags the comitative ADV with
  // `VerbForm=Conv`, which `isConverbUse` admits to the lexicon, so 與ふ reached
  // all 61 and wrote 與へ on them), and without this clause the rule it needs
  // stood down on the very flag that got it here.
  if (resolved.beatsLexicon && resolved.source !== "override") return false;
  return (resolved.reading ?? "") + (resolved.okurigana ?? "") === listed.reading;
}

/** How one of those adverbs divides between the two annotation slots: the
 * reading that goes *over* the character, and the okurigana that goes beside
 * it. 必 read かならず is かなら + ず; 亦 read また is また over the character
 * with nothing beside it.
 *
 * **This exists because the two panels disagree about these words, and the
 * prose panel is the one that is right.** `KANJI_RETAINED_ADVERBS` above is
 * exactly the statement that these adverbs keep their kanji — that is what the
 * table is for, and `generateKakikudashiPieces` writes 亦 and 必ず accordingly.
 * The kundoku panel reaches them by a different route (the resolver answers for
 * them out of `overrides.json`, which marks them `spellOutInProse`), and that
 * route puts the *whole* reading in the okurigana slot as one katakana run with
 * no furigana at all, and tags the cell `kanaOnly` — a claim that the prose
 * drops the character, which for these words is false. So 亦 is drawn マタ
 * beside a bare 亦 where an adjective in the same position is drawn with its
 * reading over the character and its ending beside it.
 *
 * An adverb is a content word with a dictionary reading, exactly as an
 * adjective is; the reason a particle's gloss goes in the okurigana slot
 * entire (see `KundokuView.ts`'s note on the split) is that a particle has no
 * reading of the character to put over it, and these do.
 *
 * Written beside the table it names, so that the split the kundoku panel draws,
 * the okurigana the prose panel prints and the division the furigana menu
 * offers come from one place. `okurigana` is `retainedAdverbOkurigana`'s answer
 * for this character and this reading — the dictionary's dot where KANJIDIC2
 * states one, the table's assertion for the residue, and undefined for a
 * character the table does not hold. Taken as an argument rather than read off
 * the table here because it cannot be read off the table any more: the
 * dictionary is fetched at runtime and this module is a leaf (see
 * `KANJI_RETAINED_ADVERBS`), so the one caller that has neither — an editor
 * asking only whether the character is in the set — asks the set instead.
 *
 * The reading is the resolver's whole-word one; where it does not end in that
 * okurigana the word is not the one the table describes (a reading the syntax
 * chose, or a compound — see `beatsLexicon` at the call sites) and this
 * declines rather than cutting the string blindly. */
export function retainedAdverbParts(
  reading: string | undefined,
  okurigana: string | undefined,
): { reading: string; okurigana: string } | undefined {
  if (okurigana === undefined || !reading) return undefined;
  if (okurigana === "") return { reading, okurigana: "" };
  if (!reading.endsWith(okurigana) || reading.length <= okurigana.length) return undefined;
  return { reading: reading.slice(0, -okurigana.length), okurigana };
}

/** ハ行四段's 終止形, written as the ふ it is rather than as the う modern
 * spelling gave it — 買う -> 買ふ, 云う -> 云ふ, 適う -> 適ふ.
 *
 * The one modern okurigana that is a *single* kana and still not classical.
 * Every other one-kana ending is already what classical writes (a bare る is
 * 上一段 見る, the a-row endings 集まる/加わる are 四段), which is why
 * `classicalVerbEnding` leaves that length alone; う is the exception, because
 * ハ行転呼 unvoiced the ふ out of the terminative and modern orthography
 * followed it.
 *
 * **Exactly the bare う, and nothing longer.** KANJIDIC2 writes 577 kun'yomi
 * whose okurigana ends in う; 541 of them are that bare う and every one is a
 * ハ行四段 terminative. The other 36 are two and three kana (逆's さか.らう,
 * 行's おこ.なう, 恥's は.じらう) and all but one are ハ行 too — but the one is
 * 向's む.こう, the noun 向こう, whose こう is not an ending at all. Nothing in
 * the shape separates it from 行's なう, so the shape is not asked: the bare う
 * has no such counterexample and the longer endings are left as they stand.
 *
 * **Lossless, and that is why this was for a long time the only verb ending the
 * furigana menu converted.** A menu candidate is stored as the reader picked it,
 * and its paradigm used to be read back off that stored ending alone
 * (`chosenConjClass`), so a conversion that erased a distinction cost the class:
 * converting 起's き.る to 起く would leave a lone く, and 四段カ行 is what
 * `classicalConjClass` reads off that where the word is 上二段 起く. This
 * conversion erases nothing — `CLASSES_BY_SHUUSHI` gives う and ふ the same
 * 四段ハ行, by the same `okurigana === "う" ? "ふ"` step below — so 買フ could be
 * offered and still get 四段ハ行 back if it were picked.
 *
 * **The menu now converts the rest of them too**, through `classicalVerbKun` in
 * `kanjidicLookup.ts`, and what makes that safe is not losslessness but the
 * class travelling *with* the converted ending — the arrangement the adjectives
 * have had all along (see `CONJ_CLASS_KEY` in `chosenReading.ts`). This
 * function keeps its place in front of that one all the same, and the division
 * between them is worth stating: this is an *orthographic* rule about a kana,
 * right for every う-final ending whether or not any table names the word's
 * paradigm, where that one is a grammatical claim and abstains wherever the
 * paradigm is not established. See `candidateReadings`, which applies both. */
export function hagyouShuushi(okurigana: string | undefined): string | undefined {
  return okurigana === "う" ? "ふ" : okurigana;
}

/** `reading` is the stem the ending belongs to, and is only consulted for
 * `LEXICAL_KUN` — omit it and the mechanical conversion below runs exactly as
 * it always has. Callers that have the reading in hand should pass it; the
 * ending alone cannot tell 用いる from 老いる. */
export function classicalVerbEnding(okurigana: string | undefined, reading?: string): string | undefined {
  const lexical = lexicalKun(reading, okurigana);
  if (lexical) return lexical.okurigana;
  // Ahead of the length test below, which would otherwise hand a one-kana
  // ending straight back. Idempotent, as every conversion in this module must
  // be (see `chosenOkurigana`, which re-runs them over a choice restored from a
  // saved text): ふ is not う, so a second pass leaves it alone.
  if (okurigana === "う") return hagyouShuushi(okurigana);
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
 * `isTopicalizedAdjective`), or 連用形 (renyoukei) く/しく for an adjective that
 * hands the clause on instead of closing it (貧い -> 貧しく — see
 * `isBecomingComplement`, the predicative complement of a verb of becoming).
 * Only called once the caller has already
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
  form: "shuushi" | "rentai" | "renyou" = "shuushi",
): { reading: string; okurigana: string | undefined } {
  // 連用形 and 連体形 are one case, and the ending is the only difference
  // between them: both simply tack their kana onto the stem, whether the
  // paradigm is ク活用 (あつ+く / あつ+き) or シク活用 (たのし+く / たのし+き).
  // Only the 終止形 needs the further care below, because し is where the two
  // classes' endings collide.
  const suffix = form === "rentai" ? "き" : "く";
  if (okurigana) {
    if (!okurigana.endsWith("い")) return { reading, okurigana };
    if (form !== "shuushi") return { reading, okurigana: okurigana.slice(0, -1) + suffix };
    return { reading, okurigana: okurigana.endsWith("しい") ? okurigana.slice(0, -1) : "し" };
  }
  if (!reading.endsWith("い") || reading.length < 2) return { reading, okurigana };
  const trimmed = reading.slice(0, -1); // drop the trailing い
  if (form !== "shuushi") {
    return { reading: trimmed, okurigana: suffix };
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
