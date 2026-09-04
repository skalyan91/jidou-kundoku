import { loadJsonIndex } from "./jsonIndex.ts";
import { fullSizeKana, historicalByReading, historicalSpelling, historicalSplitByReading, type HistoricalKanaIndex } from "./historicalKana.ts";
import {
  attestedClassicalParadigm,
  isAdjectiveLemma,
  isAdjectiveReading,
  isModernIchidanLemma,
  type JmdictIndex,
  lemmaTransitivity,
} from "./jmdictLookup.ts";
import {
  attestedHistoricalReading,
  classicalAdjectiveConjClass,
  classicalAdjectiveReading,
  classicalConjClass,
  hagyouShuushi,
  KANJI_RETAINED_ADVERBS,
  kunWordClass,
  lexicalKun,
  readingEndingSplitFor,
  retainedAdverbParts,
  splitKunWordClass,
} from "./classicalEnding.ts";
import { conjugate, type ConjClass } from "../kakikudashi/classicalConjugation.ts";
// `verbLexicon.ts` is a leaf (its own imports are `classicalConjugation.ts` and
// a JSON index), so this edge closes no cycle — the same reason
// `classicalEnding.ts` reaches it directly rather than through
// `conjugationContext.ts`. What it is here for is `nominalizedCandidates`,
// which needs the *sense-disambiguated* classical word for a character and not
// a second guess at it from KANJIDIC2's reading list.
// `LEXICON_SENSES` alongside it for `curatedCandidates`: the menu offers every
// classical sense of a character, not only the leading one `VERB_LEXICON`
// exposes, because the resolver's `beatsLexicon` machinery can land the page
// on any of them.
import { attestedSenseByModernSpelling, LEXICON_SENSES, VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
// Two more leaves, for the same reason and with the same absence of a cycle:
// `bungoConjugation.ts` imports only `classicalConjugation.ts`, and
// `overridesLookup.ts` only its own JSON. Both are tables the page reads a
// character's reading out of, and the menu has to offer what the page shows.
// `AUXILIARY_LEMMAS` is the second thing taken from the first of those, and it
// was moved there from `conjugationContext.ts` to be taken — see its own doc.
import {
  AUXILIARY_LEMMAS,
  CAUSATIVE,
  DESIDERATIVE,
  NECESSITY,
  POTENTIAL,
  sentenceFinalParticle,
  type ConjugatedForm,
} from "../kakikudashi/bungoConjugation.ts";
import { overrideReadings } from "./overridesLookup.ts";
import overrides from "./overrides.json";

export interface KanjidicEntry {
  on: string[];
  kun: string[];
  meanings: string[];
}
export type KanjidicIndex = Record<string, KanjidicEntry>;

let cached: Promise<KanjidicIndex> | null = null;

export function loadKanjidicIndex(url = "/data/kanjidic-index.json"): Promise<KanjidicIndex> {
  if (!cached) cached = loadJsonIndex<KanjidicIndex>(url);
  return cached;
}

/** Strips the kanjidic okurigana-dot notation ("あ.う" -> "あう") to get a
 * plain reading; the part after the dot is returned separately as
 * okurigana so callers can render it outside the furigana ruby. */
function splitOkurigana(kunReading: string): { reading: string; okurigana?: string } {
  const dot = kunReading.indexOf(".");
  if (dot === -1) return { reading: kunReading };
  return { reading: kunReading.slice(0, dot), okurigana: kunReading.slice(dot + 1) };
}

/** KANJIDIC2 stores on'yomi in katakana (its own source convention) — every
 * other reading this app shows is hiragana, so on'yomi needs converting
 * too. Duplicated from `render/kana.ts`'s `toKatakana` (inverse direction)
 * rather than imported: this module sits in the data layer, `render/`
 * shouldn't be a dependency of it. */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** A KANJIDIC2 kun'yomi in 歴史的仮名遣い: whatever Wiktionary attests for
 * this character and reading, and otherwise the reading in the historical
 * orthography's own full-size convention — see `fullSizeKana`. KANJIDIC2's
 * readings are modern dictionary readings verbatim (the same fact
 * `classicalAdjectiveReading` in classicalEnding.ts deals with for endings and
 * `toHiragana` above deals with for katakana), so one arriving from it is
 * written in the modern convention and has to be put into this app's before
 * it goes on the page.
 *
 * The fold is gated on the index being supplied at all, rather than run
 * unconditionally, so that the index argument means one thing throughout:
 * pass it and the reading comes back in this app's orthography, omit it and
 * it comes back as KANJIDIC2 wrote it. The compound path is the caller that
 * needs the second (`compoundFurigana`, and `onyomiCompound` through
 * `onyomiOf`): it compares a reading against JMdict's own spelling of the
 * compound, which is modern kana, and a reading half-converted to the
 * historical convention would not match a dictionary written in the other
 * one — so it corrects the spelling afterwards, on the pieces, rather than
 * before the comparison. */
function historicalKun(historicalKana: HistoricalKanaIndex | undefined, char: string, reading: string, entry?: KanjidicEntry): string {
  if (!historicalKana) return reading;
  // See `seriesAmbiguousReading`. Failing closed leaves the reading alone,
  // which the fold below then writes in this app's own convention.
  if (entry && seriesAmbiguousReading({ [char]: entry }, char, reading)) return fullSizeKana(reading);
  // Between the two: what is attested for *this* character, then what every
  // attestation of this *reading* agrees on (see `historicalByReading` — 輒's
  // すなわち is 乃's word), then the orthographic fold.
  //
  // …with the middle one withheld from an 音便 stem. See `onbinStemReading`.
  // The character's own attestation still answers first, so 以's もつ — which
  // the index carries directly — is untouched; what is withheld is only the
  // borrowing of another character's spelling.
  const byReading = onbinStemReading(entry, char, reading)
    ? undefined
    : historicalByReading(historicalKana, overrides, reading);
  // Folded over the attestation, not merely in its absence: 27 readings on 21
  // characters come back from the index already carrying a small kana (掛 か
  // -> くゎ), and those reached the page precisely *because* they were
  // attested. Written out rather than through `historicalSpelling` only
  // because of the transfer table standing between the two. See that helper's
  // own note for why the fold has the last word.
  return fullSizeKana(historicalKana[char]?.[reading] ?? byReading ?? reading);
}

/** True where KANJIDIC2's own boundary shows this reading to be the stem of an
 * **音便** form — an い/っ/ん standing in front of a て/た/で/だ okurigana.
 *
 * **Why a 音便 stem must not take the reading-keyed transfer**, which is the
 * whole of the rule. 歴史的仮名遣い writes a 音便 as it sounds: 書きて contracts
 * to 書いて and is spelled 書いて, never 書ひて. So an い produced by イ音便 is an
 * い in the historical orthography too — it is not a は行転呼 reflex of ひ, and
 * it is exactly a は行転呼 reflex that `historicalByReading` exists to restore.
 * The two are indistinguishable as bare kana and are told apart only by where
 * the い came from, which is what this test reads off the boundary.
 *
 * **The character this was written for is 於**, and it is the reader's own
 * question. 於 is read with the カ行四段 おく: 連用形 おき + て, イ音便, おいて.
 * KANJIDIC2 lists it as `おい.て`, so the stem handed to `historicalKun` is おい
 * — and the transfer table's unanimous answer for おい is **おひ**, contributed
 * by 生, 負 and 笈, every one of them a genuine ハ行 stem (生ひ立つ, 負ひ目). The
 * character's own index entry is `{"お": "を"}` and does not cover おい, so
 * nothing stood in front of the transfer and the furigana menu offered 於 an
 * **おひテ** — 追ひて's spelling on 於く's word. Picking it wrote おひ through
 * `chosenReadingParts`, which both panels consult ahead of `yuParts`, so the
 * prose read 於ひて. `yuParts` was never wrong; it simply was not the only
 * route to the page.
 *
 * **Measured before it was written, over the whole shipped KANJIDIC2 index**:
 * eight kun readings have this shape at all — 於 おい.て, 序 つい.で, 以 もっ.て,
 * 燦 さん.たる, 秀 ひい.でる, 出 い.でる / い.だす, 凍 い.てる — and exactly two of
 * them were taking a transfer, 於's おい→おひ and 序's つい→つひ. Both are wrong
 * for the same reason (序's ついで is 次ぐ's 連用形 次ぎ + て, イ音便 again; つひ
 * is 終/遂, a different word), and the other six were already falling through
 * to `fullSizeKana`, which is what they want. So the guard changes two answers
 * and both of them from wrong to right.
 *
 * Fails closed the way `seriesAmbiguousReading` does — a reading it cannot
 * place is left to the fold — and asks the entry rather than a lemma, so it
 * holds for a character reached through the menu, through `lookupKanji`, and
 * through the compound path alike. */
function onbinStemReading(entry: KanjidicEntry | undefined, char: string, reading: string): boolean {
  if (!entry || !/[いっん]$/u.test(reading)) return false;
  return kunReadings(entry, char).some((kun) => {
    const split = splitOkurigana(stripAffixHyphen(kun));
    return split.reading === reading && /^[てたでだ]/u.test(split.okurigana ?? "");
  });
}

/** KANJIDIC2 marks a reading that only occurs as a prefix or suffix with a
 * hyphen on the joining side ("こ-", "-ごと.に"). That is positional
 * notation, not part of the reading, and writing it into the ruby verbatim
 * puts a stray "-" on the page — 毎's only inflecting kun'yomi is the
 * suffix-marked "-ごと.に", and reading it unstripped gave a furigana of
 * "-ごと". Shared by both readers of the kun list below, rather than only
 * by `candidateReadings` (which is where the stripping lived, and so was
 * the only one of the two that did it). */
function stripAffixHyphen(kunReading: string): string {
  return kunReading.replace(/^-|-$/g, "");
}

/** Classical kun'yomi a character genuinely has in kanbun that KANJIDIC2's
 * modern entry does not list at all — supplementary to the index, never a
 * correction of it (nothing here may name a reading kanjidic already
 * carries).
 *
 * **The merge puts these ahead of kanjidic's own list, not after it.** They
 * are the *kanbun* readings of a character whose KANJIDIC2 entry is a modern
 * Japanese one, and where the two disagree about a character this app is
 * reading in a classical text, the classical answer is the one wanted first
 * — 首 is くび in modern Japanese and かうべ in kundoku. Ordering is the only
 * lever available for saying so: `overrides.json`, the other table that could
 * force a reading, marks every entry `spellOutInProse`, which prints the word
 * in kana in the 書き下し文 and moves its reading into the 訓読文's okurigana
 * slot. That is right for a function word and wrong for a content noun, whose
 * kanji must stay on the page under ordinary furigana — so a content word's
 * classical reading can only be made the default from here.
 *
 * Leading rather than appending changes nothing about the two entries that
 * predate it. 需's kanjidic kun list is empty, so the two orders are the same
 * list; 種's supplement is dotted and its kanjidic readings are not, and both
 * `pickKun` and `candidateReadings` split the list by that dot before they
 * look at order at all — a NOUN still takes the first bare kun (たね) and a
 * VERB the first dotted one (う.).
 *
 * Written in kanjidic's own okurigana-dot notation, so `pickKun` and
 * `candidateReadings` read these exactly as they read the index's own
 * entries and no third code path appears: the dot is what marks the
 * reading as an inflecting word, which is what makes it eligible for a
 * VERB and ineligible for a NOUN.
 *
 * 種: 植う ("to plant"), ワ行下二段. KANJIDIC2 gives 種 only the nominal
 * たね ("seed") and the suffix -ぐさ, so a 種 the parser tags VERB (種樹,
 * "to plant trees" — a real, live parse) had no inflecting reading to
 * fall back to and came out たね. The dot sits at the *end* because this
 * verb's 終止形 is the bare stem mora with nothing following the kanji
 * (種う would be two morae, not the one 植う has) — the same shape
 * `classicalConjugation.ts` gives ア行下二段 得, whose shuushikei okurigana
 * is likewise empty because the kanji's own reading already covers it.
 * 種 is overwhelmingly the noun in this corpus, and stays so: a NOUN takes
 * the first *bare* kun (たね) and only a VERB reaches the first *dotted*
 * one, whichever end of the list the supplement is spliced onto.
 *
 * 需: 貰ふ ("to receive, to be given"), asked for by name. KANJIDIC2's
 * entry for 需 in this app's shipped index carries **no kun'yomi at all**
 * (`{"on":["ジュ"],"kun":[]}` — not even the もと.める/まつ a fuller edition
 * lists), so the character had no native reading of any kind to fall back
 * to and every occurrence read the on'yomi じゆ. This is the one claim this
 * table makes about a *word* rather than about a paradigm: 需 is not
 * conventionally a 貰ふ-verb in the dictionaries, and the entry is here
 * because the reader wants it available, not because a source attests it.
 *
 * **ハ行四段, settled by the reader**: もらは / もらひ / もらふ / もらふ /
 * もらへ. It went in first as もらゑる, which is the modern 一段 もらえる
 * respelled and is a classical paradigm form of nothing — a ワ行下二段 verb
 * runs ゑ/ゑ/う/うる/うれ/ゑよ, whose 終止形 is もらう, and 貰ふ is ハ行四段;
 * neither spells itself もらゑる — so it carried no class and printed its
 * citation form wherever it stood. The reader has now chosen between the
 * two, and this is 貰ふ.
 *
 * Written ふ, historically rather than modernly, because that is this app's
 * orthography and nothing downstream would put the ふ there: a modern もら.う
 * would reach the page as もらう untouched, `classicalVerbEnding` leaving a
 * one-kana ending exactly as it finds it. (The ending is 四段 either way —
 * that is what `classicalConjClass` reads a bare う as — but the *class*
 * being classical does not make the *spelling* classical, and it is the
 * spelling that goes on the page.) `historicalKun` folds this entry like any
 * other and leaves it alone: ふ is full-size, and no index entry names もら.
 *
 * **The class lives in `RESIDUAL`, and it takes both tables.** They answer
 * different questions, and neither can answer the other's. This one supplies
 * a *reading* the character has nowhere else — KANJIDIC2's kun list is what
 * `lookupKanji` and `candidateReadings` both read, so without an entry here
 * 需 has no kun'yomi to be chosen and none to offer in the furigana menu.
 * `RESIDUAL` supplies the *paradigm*: a reading with no class conjugates
 * nowhere (the same wall 種's entry hit — 種樹 came out as the bare
 * character), and nothing derives a class for a supplementary kun by itself,
 * because `readingResolver.ts` attaches `conjClass` only to a reading the
 * *transitivity* check chose, and a character with a single inflecting
 * reading gives that check nothing to choose between. So the two go in
 * together, and this table still earns its half: じゆ stays first for every
 * nominal — 需 has no bare kun in either table, so the nominal filter empties
 * the list and the on'yomi is reached exactly as before — and it is what puts
 * もらフ in the furigana menu as an alternative the reader can pick.
 *
 * **It does not surface on this reader's own 問需何藥 (sent_id 17), and the
 * reason is a parser error rather than anything here.** That 需 is tagged
 * PROPN with `NameType=Giv` — the parser has read the character as a given
 * name — and PROPN is one of the two routes to the on'yomi series
 * (`lookupKanji`'s `eligible`), so no kun'yomi added to this table can
 * reach it; `candidateReadings`'s nominal filter drops a dotted reading
 * besides, so the furigana menu on that token offers じゆ alone. Reported
 * as the mis-tag it is rather than compensated for here — the same
 * judgement `lookupKanji` already documents for 輮/藍. The reading fires as
 * soon as the token is a VERB, which is what the tag ought to be.
 *
 * 首: かうべ ("head"), asked for by name. KANJIDIC2 lists only くび, the
 * modern word for the *neck*, and 去首半尺 (sent_id 20) is measuring from
 * the man's head, not his neck. Both are real readings of the character and
 * this table keeps both — くび stays in the furigana menu — but かうべ leads,
 * for the reason the table's own doc gives: kanbun before modern Japanese.
 * Undotted, because it is a bare noun and inflects for nothing, which is
 * also what makes it eligible for the NOUN this token is tagged.
 *
 * **Not `overrides.json`, though that is the only other table that can make
 * a reading the default.** Every entry there is returned with
 * `spellOutInProse`, and 首 is a content noun: the 書き下し文 must print the
 * character, not かうべ, and the 訓読文 must put the reading over it as
 * furigana rather than beside it in the okurigana slot. That table cannot
 * express a content word at all — see `ResolvedReading.spellOutInProse`,
 * which documents the same split from the other end.
 *
 * 縶: 縛る ("to tie up"), 四段ラ行. KANJIDIC2 gives 縶 only つな.ぐ, which is
 * the same act under a different verb, and the reader wants しばる — 縶手足
 * (sent_id 20) is binding the man's hands and feet. Its class lives in
 * `RESIDUAL` for exactly the reason 需's does: a supplementary kun derives
 * no paradigm by itself, and 縶 has to inflect (縶ぎて → 縶りて). The
 * `RESIDUAL` entry is what both panels actually read for this VERB-tagged
 * token; this one is what makes しばル a kun candidate at all, so the
 * furigana menu offers it beside kanjidic's つなグ instead of only the
 * latter.
 *
 * 但: ただ ("only, merely"), split た + だ. KANJIDIC2 lists ただ.し, the
 * *conjunction* ("however"), and 但 in kanbun is at least as often the
 * limiting adverb — 但令於日中俯臥 (sent_id 20) is "just have him lie face
 * down in the daytime", not "however". The dot goes after the first mora
 * because that is where the dictionary puts it for every retained adverb of
 * this shape — 甚 はなは.だ, 必 かなら.ず, 更 さら.に, kanji for all but the
 * final kana and okurigana for the last — and 但ダ is that convention applied
 * to ただ, written here as a dot because that is the notation this file is in.
 *
 * **This one joins ただし rather than replacing it, and cannot displace it
 * from here.** 但 has its own `overrides.json` entry reading ただし and its
 * own `KANJI_RETAINED_ADVERBS` line naming that word (whose し
 * `retainedAdverbOkurigana` then reads off KANJIDIC2's own ただ.し), and both
 * are consulted ahead of any kanjidic lookup — so the default stays 但シ and
 * this entry reaches the reader through the furigana menu, which is what "one
 * of its kun readings" asks for. Making 但ダ the default is a change to those
 * two tables, not to this one.
 *
 * 許: ばかり ("about, roughly" — 長三寸許, "some three inches long"),
 * undotted. **Moved here out of `overrides.json`, and the move is the whole
 * point of the entry.** That table returns every entry `spellOutInProse`,
 * which writes the reading in kana in the 書き下し文 *and* puts it in the
 * 訓読文's okurigana slot beside the character — 許[|バカリ]. The reader wants
 * ばかり over the character, which is the ordinary furigana treatment and the
 * one thing only this table can give: a supplementary kun is a reading of the
 * character like any other, so the kanji stays on the page in both panels and
 * the ruby goes above it. Undotted, because ばかり inflects for nothing, which
 * is also what makes it eligible for the NOUN both occurrences are tagged.
 *
 * The two costs the override entry documented are unchanged by the move, and
 * are restated rather than lost with it. The verb 許す is untouched: a VERB
 * takes the first *dotted* kun, which is still KANJIDIC2's own ゆる.す, and
 * `VERB_LEXICON` holds 許 as ゆる 四段サ行 ahead of any lookup here. The other
 * NOUN sense, もと (母の許, "at his mother's place"), is displaced — it is
 * KANJIDIC2's only other bare kun and this one now leads — and the parser
 * gives both senses the same tag with no dep to separate them. 酒蟲 has 許
 * twice and both are the approximative: 長三寸許 (sent_id 25), and the 許 the
 * parser opened sent_id 21 with, which it tagged a place name after the
 * source's comma cut 去首半尺許 in two.
 *
 * 暴: にはか ("sudden" — 忽覺咽中暴癢, "suddenly felt a violent itching in his
 * throat"), undotted. KANJIDIC2 gives 暴 only あば.く / あば.れる, the modern
 * "expose" and "rave" senses, and a 暴 the parser tags ADV with `Degree=Pos`
 * came out 暴ク — an adverb built out of "to expose". The kanbun word is the
 * ナリ活用形容動詞 にはかなり, and its stem is what this supplies. Undotted for
 * the reason 首's かうべ is: a 形容動詞 stem takes no okurigana of its own, its
 * ending coming from the paradigm — which lives in `RESIDUAL` (verbLexicon.ts)
 * for exactly the reason 需's and 縶's do, and which that entry documents.
 *
 * 熾: さか.ん ("blazing, in full spate" — 饞火上熾, "the fire of his craving
 * rose and blazed"), the stem of the ナリ活用形容動詞 さかんなり, with the
 * paradigm in `RESIDUAL` for the reason 需's and 縶's are there.
 *
 * **The reading is KANJIDIC2's own and what this supplies is the boundary.**
 * Its entry for 熾 reads おこ.る / おこ.す / さかん — the third undivided, and so
 * a bare noun by the dot's own POS convention, which is why a 熾 tagged VERB
 * never reached it: `pickKun` filters an inflecting token's readings down to
 * the dotted ones. KANJIDIC2 divides the identical word on 盛, as さか.ん, and
 * that is the only dotted ん in the whole index against 24 characters writing
 * さかん undivided (旺, 昌, 壯, 屬, 殷, 奭 and the rest). So this is one
 * character's boundary written out, not a rule about ん: an undotted kun ending
 * in ん is overwhelmingly an ordinary noun in this index — かばん, ずきん,
 * にしん, そろばん, だいこん — and transferring 盛's dot to every reading
 * KANJIDIC2 writes undivided elsewhere would put a dot in 1,220 of them, most
 * of them nouns (蝿 はえ, 臼 うす, 崖 がけ, 樫 かし). Measured, and rejected on
 * the measurement.
 *
 * Dotted, and the dot does the same work it does for 哇: it makes the reading
 * eligible for a VERB. What it does *not* do is settle a paradigm — ん is no
 * conjugation's ending — so the class comes from `RESIDUAL`, and reaching that
 * entry is why `pickKun` now holds a supplementary reading back from the
 * transitivity vote (see there; JMdict lists 熾る and 熾す and would otherwise
 * have chosen between them and stood the entry down).
 *
 * 哇: は.く ("to vomit" — 哇有物出, "he retched, and something came out").
 * KANJIDIC2 lists 哇 as かい / けい, two bare nouns glossed "fawning child's
 * voice", so a 哇 tagged VERB had no inflecting reading at all and read かひ.
 * The character is 吐く in this text. Dotted, and the dot is doing real work:
 * it is what makes the reading eligible for a VERB and what lets
 * `classicalConjClass` read 四段カ行 off the く unaided — so unlike 需 and 縶
 * this one needs no `RESIDUAL` line to carry a paradigm.
 *
 * **適 is deliberately absent, and the reason is worth keeping.** Its kanbun
 * verb reading is ゆく ("to go to, to proceed to"), which KANJIDIC2 does not
 * list — its only kun for the character is かな.う — so this table is where
 * such a reading would go, and it was put here and taken out again. Adding a
 * second *dotted* kun is not inert: `pickKun` puts a VERB through
 * `pickByTransitivity` the moment more than one dotted reading exists, and that
 * check, asked about a 適 with no object, answers かな.う and returns
 * `transitivitySelected` — which sets `beatsLexicon` and stands the very
 * `RESIDUAL` entry down that was supposed to supply ゆく. The character read
 * かなふ either way, by a longer route. Its reading and paradigm therefore live
 * in `RESIDUAL` alone (see `verbLexicon.ts`), and the cost is that the furigana
 * menu offers テキ and かなフ but not ゆク — the reading on the page is not one
 * of its own entries. That is the trade this table cannot avoid: a menu
 * candidate for an inflecting word is also an answer `pickKun` may choose. */
const SUPPLEMENTARY_KUN: Record<string, string[]> = {
  種: ["う."],
  需: ["もら.ふ"],
  首: ["かうべ"],
  縶: ["しば.る"],
  但: ["た.だ"],
  許: ["ばかり"],
  暴: ["にはか"],
  哇: ["は.く"],
  熾: ["さか.ん"],
};

/** A character's kun'yomi as the rest of this module reads them: anything
 * `SUPPLEMENTARY_KUN` adds for it first, then kanjidic's own list — see that
 * table's doc for why the supplement leads. */
function kunReadings(entry: KanjidicEntry, char: string): string[] {
  const extra = SUPPLEMENTARY_KUN[char];
  return extra ? [...extra, ...entry.kun] : entry.kun;
}

/** Whether the 歴史的仮名遣い index cannot be trusted about (`char`,
 * `reading`), because the character reads that same kana string in *both* of
 * its series and the index does not record which one its entry is for.
 *
 * The index is keyed by (kanji, modern reading) alone — see
 * `HistoricalKanaIndex` — and it is a merge of two sources: what Wiktionary
 * attests for a word, and what `derive-onyomi-kana.py` derives for an on'yomi
 * from the 廣韻's rime data. When one key names a reading of each kind, a
 * lookup asking about the kun'yomi gets whichever of the two happened to be
 * written there, with nothing on the entry to say it is the wrong one. 謂 is
 * the case: its on'yomi イ is 云母, historically ゐ, and its kun'yomi is い.ふ
 * — the same い as a key — so both the generic kanjidic path and
 * `KundokuView.ts`'s lexicon path were handed ゐ and printed ゐふ where 謂ふ
 * is いふ.
 *
 * **Both halves of the test are needed, and neither alone will do.** "The
 * reading is one of the character's on'yomi" is far too broad on its own:
 * ten of the sixteen `VERB_LEXICON` readings it catches are Sino-Japanese
 * サ変 verbs whose reading *is* the on'yomi (略 りゃく, 課 か, 香 こう), and
 * refusing the index for those would throw away exactly the derivation that
 * is right for them — 課 くわ, 香 かう, 評 ひやう. What makes a reading
 * genuinely ambiguous is that it is also one of the character's *kun* stems,
 * which is the other series the same key could be speaking for. Over the
 * shipped tables that pair holds for 謂 (ゐ, corrected here) and 嘱 (しよく,
 * which the fold below reproduces exactly), and for nothing else the lexicon
 * reaches.
 *
 * Compared against the kun *stem* — the part before KANJIDIC2's okurigana dot,
 * with any affix hyphen stripped — because that is the unit the index is keyed
 * by, and the unit both callers hold: い is the key for 謂's い.ふ. */
export function seriesAmbiguousReading(index: KanjidicIndex | null | undefined, char: string, reading: string): boolean {
  const entry = index?.[char];
  if (!entry) return false;
  if (!onyomiOf(index!, char).includes(reading)) return false;
  return kunReadings(entry, char).some((kun) => splitOkurigana(stripAffixHyphen(kun)).reading === reading);
}

/** Where one of `classicalEnding.ts`'s `KANJI_RETAINED_ADVERBS` divides: the
 * okurigana that goes beside the character, "" for a word that takes none, and
 * undefined for a character the table does not hold.
 *
 * **The division is the dictionary's, not this app's.** KANJIDIC2 writes the
 * okurigana boundary of a kun'yomi as a dot — 嘗 かつ.て, 必 かなら.ず, 悉
 * ことごと.く — and that dot is the same notation `splitOkurigana` above
 * already reads for every ordinary verb and adjective. What
 * `KANJI_RETAINED_ADVERBS` states is that these particular characters, read as
 * these particular words, keep their kanji in the 書き下し文 — two claims no
 * dictionary makes, since KANJIDIC2 lists 更 as さら, さらに, ふ.ける and ふ.かす
 * without saying which is the adverb. *Where* the named word divides is a plain
 * dictionary fact and is read from here instead. The table used to carry that
 * too, and the cost was exactly what a hand-copied split costs: 嘗's て went
 * missing on the way in and the character rendered カツテ with nothing over it
 * at all, which is the bug this function closes for good.
 *
 * **Per character, not per token.** The answer is a property of the word the
 * table names, so a token of that character whose reading is something else
 * entirely — 猶 tagged VERB reading ごとし, 嘗 tagged VERB — gets the same
 * answer, and the callers decide on their own evidence whether it applies to
 * the reading in front of them (`retainedAdverbParts` refuses a reading that
 * does not end in it; both panels stand the whole rule down on `beatsLexicon`).
 * That is the division of labour the table had before the derivation existed,
 * and moving any of it in here would change which tokens the rule fires on.
 *
 * **Here, and not beside the table it serves**, because the index is fetched at
 * runtime and handed in — there is no importable kanjidic to consult at module
 * load, and `classicalEnding.ts` is deliberately a leaf on the far side of the
 * `generator.ts` -> `readingResolver.ts` -> `kanjidicLookup.ts` edge (see the
 * table's own doc). This module is the one that already owns every piece the
 * derivation needs — `kunReadings` for the list, `stripAffixHyphen` and
 * `splitOkurigana` for the notation, `historicalKun` for the orthography — and
 * it imports `classicalEnding.ts` already, so asking the question here adds no
 * edge and closes no cycle. `readingResolver.ts` is the caller that puts the
 * answer where the two panels can see it (see `ResolvedReading`'s
 * `retainedAdverbOkurigana`); `candidateReadings` below asks it directly, per
 * menu candidate.
 *
 * **Matched after the historical-kana fold, not before it.** KANJIDIC2 is
 * modern kana and this app is 歴史的仮名遣い: 尚 and 猶 are filed as なお and
 * the table names なほ, so a comparison made on the raw dictionary string
 * recognises neither. `historicalKun` is the conversion the rest of this module
 * already applies to every kanjidic-sourced reading before it reaches the page,
 * and applying it here is what makes the two ends meet. It is asked of the
 * stem alone — the unit the historical index is keyed by, exactly as
 * `lookupKanji` asks it — with the dictionary's own okurigana appended after.
 *
 * **A character with more than one kun for the same word is settled by the
 * joined reading, then by the dot.** 更 is filed both さら and さら.に, and only
 * the second joins to the さらに the table names; 悉 has ことごと beside
 * ことごと.く the same way. Where both a dotted and an undotted entry join to
 * the word, the dotted one wins — it is the more specific statement about the
 * same reading, and an undotted entry is the dictionary declining to divide
 * rather than asserting that the word is indivisible.
 *
 * Undefined for a listed character means the index is absent (a resolver built
 * without one, as several tests are) or its entry has stopped spelling the
 * word. */
export function retainedAdverbOkurigana(
  index: KanjidicIndex | null | undefined,
  char: string,
  historicalKana?: HistoricalKanaIndex,
): string | undefined {
  // The residue first: a character the dictionary cannot answer for, or answers
  // about a different division, and whose okurigana the table therefore asserts
  // on its own. See `KANJI_RETAINED_ADVERBS` for the reason per entry.
  return KANJI_RETAINED_ADVERBS[char]?.okurigana ?? dictionaryRetainedAdverbOkurigana(index, char, historicalKana);
}

/** The dictionary's half of the answer above, on its own: the okurigana
 * KANJIDIC2's own dot puts on the word `KANJI_RETAINED_ADVERBS` names for
 * `char`, with the table's residue assertion not consulted at all.
 *
 * **Exported so that the residue can be checked rather than trusted.** Four of
 * the eighteen entries assert an okurigana because the dictionary cannot supply
 * it — but "cannot" is a claim about a data file that is periodically rebuilt,
 * and the function above answers identically whether the assertion is
 * load-bearing or merely shadowing a dictionary that has since learned the
 * word. Asking this one is the only way a test can tell the two apart, and so
 * the only way it can report that the residue has shrunk instead of silently
 * agreeing with itself. Nothing in `src/` calls it. */
export function dictionaryRetainedAdverbOkurigana(
  index: KanjidicIndex | null | undefined,
  char: string,
  historicalKana?: HistoricalKanaIndex,
): string | undefined {
  const listed = KANJI_RETAINED_ADVERBS[char];
  const entry = index?.[char];
  if (listed === undefined || !entry) return undefined;
  let undotted: string | undefined;
  for (const kun of kunReadings(entry, char)) {
    const split = splitOkurigana(stripAffixHyphen(kun));
    if (historicalKun(historicalKana, char, split.reading, entry) + (split.okurigana ?? "") !== listed.reading) continue;
    if (split.okurigana !== undefined) return split.okurigana;
    undotted = "";
  }
  return undotted;
}

export interface KanjidicLookupResult {
  reading: string;
  okurigana?: string;
  gloss?: string;
  /** Set when the `transitivity` argument actually moved the choice — the
   * character had both a transitive and an intransitive kun'yomi and the
   * sentence picked the one the entry's own ordering would not have. The
   * caller needs to know: this is the reading that has to survive
   * `VERB_LEXICON`'s single per-lemma entry (see `ResolvedReading`'s
   * `beatsLexicon`), and the one whose modern 一段 ending has to be put
   * back into classical 二段 shape. */
  transitivitySelected?: boolean;
}

/** What `lookupKanji` returns: a result that also says which of the
 * character's two series the reading came from.
 *
 * Declared here rather than on `KanjidicLookupResult` itself because
 * `ReadingCandidate` extends that interface and already carries the same
 * distinction under its own name (`kind`, which has a third value the
 * dictionary has no notion of).
 *
 * A caller cannot recover the series from the reading string. Comparing
 * against `onyomiOf` will not do it: the reading has already been put into
 * 歴史的仮名遣い by the time the caller sees it, and a kun'yomi that
 * coincides with one of the character's on'yomi (謂's い — the very case
 * `historicalKun` has its own guard for) would answer the wrong way.
 *
 * What turns on it is that a verb read on'yomi is read サ変 in kundoku —
 * 大破す, 佳醸す, never a bare on'yomi stem. `onyomiPairReading` and
 * `chosenOkurigana` already supply that す for the on'yomi they choose
 * themselves; this is how the third path that can produce one — a character
 * with no kun'yomi to choose at all, so `useKun` is false — says so too. */
export interface KanjidicReading extends KanjidicLookupResult {
  series: "kun" | "on";
}

/** A candidate for the furigana menu: a reading plus which series it comes
 * from, so the menu can group them the way a kanji dictionary does.
 *
 * `candidateReadings` below only ever produces the two dictionary series.
 * The third is the 再読文字 reading, which is not a dictionary entry at all
 * but the reading a construction gives the character — the menu builds that
 * one itself (see `readingCandidatesFor`), and it is a kind here so that it
 * can travel and be rendered as any other candidate is. */
export interface ReadingCandidate extends KanjidicLookupResult {
  kind: "kun" | "on" | "reread";
  /** The paradigm this candidate inflects by, where the ending it is
   * offered under can no longer say. Set on the two kinds of candidate
   * `candidateReadings` converts and on no others — the adjectives
   * `classicalAdjectiveKun` puts into their 終止形, where both ク活用 and
   * シク活用 end in し, and the もちゐる of `LEXICAL_KUN`, whose ワ行上一段 is
   * not a shape any ending states. Every other candidate is offered in the
   * modern ending kanjidic wrote, which `classicalConjClass` reads a class
   * off unaided. A reader who picks this candidate has the class stored with
   * it (see `setChosenReading`), which is what lets 易 inflect to 易き or
   * 易しき rather than standing at 易し. */
  conjClass?: ConjClass;
}

/** KANJIDIC2's own okurigana-dot notation is also a POS signal, not just an
 * okurigana boundary marker: a kun'yomi with a dot ("あた.る", "たか.い") is
 * an inflecting word — a verb or adjective — while one with no dot ("なか",
 * "うち") is a bare noun. A single character routinely carries both kinds
 * (中: なか/うち "middle/inside" vs あた.る "to hit"), listed in whatever
 * order KANJIDIC2 happens to enumerate them, which does not track how
 * *this* occurrence is tagged — always taking `kun[0]` regardless of `pos`
 * is exactly how a VERB-tagged 中 could end up read なかる instead of あたる.
 * Only overrides `kun[0]` for the two POS families where the dot/no-dot
 * distinction is unambiguous (VERB/ADJ want a dotted reading, NOUN/PRON
 * want a bare one — `pos === "PROPN"` never reaches here at all, see the
 * `useKun` guard at this function's one call site) and falls back to it
 * otherwise — a tag like PART covers plenty of genuinely non-inflecting
 * function words *and* words like 已 (comp:aux "to stop") that are really
 * verbs kanjidic already lists dot-first for, so guessing a preference for
 * that broader, mixed bucket would trade one mismatch for another rather
 * than fixing it. */
/** Which of a character's inflecting kun'yomi the sentence wants, when the
 * character has both a transitive and an intransitive one.
 *
 * KANJIDIC2 lists 立's readings as た.つ/た.てる and 破's as やぶ.る/やぶ.れる
 * in whatever order it enumerates them, with nothing recording which member
 * of the pair takes an object — so `pickKun`'s plain "first dotted reading"
 * rule reads 立太子 ("to install a crown prince", a real live parse with 子
 * as 立's `comp:obj`) as 立つ, the intransitive "to stand". The dictionary
 * knows: JMdict tags 立つ intransitive and 立てる transitive (see
 * `lemmaTransitivity`), and the headword to ask it about is simply the
 * character plus that reading's own okurigana — 立 + てる.
 *
 * `wantTransitive` comes from the dependency tree (the token has a
 * `comp:obj` child, or it does not), so this is the ranking condition the
 * syntax supplies and the character's entry cannot.
 *
 * "both" counts as a match either way, and that is the right answer rather
 * than a fudge: JMdict lists 開く (ひらく) as transitive *and* intransitive
 * because the classical verb genuinely is both, and 開 has no separate
 * partner reading to switch to — 門を開く and 門開く are the same word.
 *
 * Returns undefined when the evidence does not separate the candidates
 * (nothing in JMdict, or every candidate matches equally), leaving
 * `pickKun`'s existing order to decide — a character with only one
 * inflecting reading has no choice to make, and guessing between two
 * unattested ones would trade a defensible default for an undefensible
 * one.
 *
 * Only *free* readings are candidates. KANJIDIC2's affix hyphen (see
 * `stripAffixHyphen`) marks a reading that occurs solely as a prefix or
 * suffix, and a bound form is not a word the clause could be reading — so it
 * cannot be one side of a choice between two verbs. 死's kun list is し.ぬ
 * beside the 連用形 nominal し.に-, and counting that bound form as a
 * candidate manufactured a split where the character has only one verb: 死
 * with no object "matched" 死ぬ while し.に- (a noun in JMdict, so no
 * transitivity) supplied the opposing side, and the decision that reported
 * set `beatsLexicon`. Standing down `VERB_LEXICON` discarded its ナ変 死ぬ,
 * and `classicalConjClass` derives 四段 from a bare modern ぬ — so 死者 and
 * 死之時 printed 死ぬもの/死ぬの時 where ナ変's 連体形 gives 死ぬる.
 *
 * Excluding bound forms rather than every candidate whose transitivity
 * JMdict does not record, which was tried and is too broad: an entry that is
 * *listed* as something other than a transitive/intransitive verb is
 * evidence about that candidate, not silence. 悔's くや.しい and 親's した.しい
 * are both free adjectives JMdict knows, and they are exactly what separates
 * 悔いる from the lexicon's 悔し (giving 王過を悔ゆ) and した.しむ from
 * した.しい (giving あひ親しむ). Dropping them left both characters with one
 * usable answer and no decision, and both readings regressed. */
function pickByTransitivity(char: string, dotted: string[], wantTransitive: boolean, jmdict: JmdictIndex): string | undefined {
  const wanted = wantTransitive ? "transitive" : "intransitive";
  const matches = (t: string | undefined): boolean => t === wanted || t === "both";
  // The modern citation spelling is what JMdict is keyed by, and it is
  // exactly the character followed by kanjidic's own okurigana — no
  // conversion, since kanjidic's kun'yomi are modern dictionary readings
  // verbatim (see `classicalAdjectiveReading`'s doc in readingResolver).
  const graded = dotted
    .filter((kun) => kun === stripAffixHyphen(kun))
    .map((kun) => ({
      kun,
      transitivity: lemmaTransitivity(jmdict, char + (splitOkurigana(kun).okurigana ?? "")),
    }));

  // The question only counts as answered where it actually separates the
  // candidates: some reading the sentence wants, and some other reading it
  // does not. 去 lists さ.る beside the bound -さ.る, and with that bound form
  // out of the running there is a single candidate and nothing to separate —
  // reported as a decision, it outranked `VERB_LEXICON`'s sense-disambiguated
  // 去ぬ and printed 去る. A character with no transitive/intransitive split
  // has no transitivity question to answer, whatever its entry lists.
  if (!graded.some((g) => matches(g.transitivity)) || !graded.some((g) => !matches(g.transitivity))) return undefined;

  // An exact match ahead of a "both": JMdict lists 開く (ひらく) as transitive
  // *and* intransitive because the classical verb genuinely is both, so a
  // character that has a dedicated partner for the wanted sense should use
  // it and fall back on the ambiguous one only if none turns up.
  return graded.find((g) => g.transitivity === wanted)?.kun ?? graded.find((g) => g.transitivity === "both")?.kun;
}

/** Whether the character's entry offers an adjective among its kun'yomi — a
 * reading whose okurigana ends in い (深: ふか.い beside ふか.まる/ふか.める).
 *
 * This is what tells a `Degree=Pos` token that really is being used
 * adjectivally from one the parser has merely tagged that way. The feature
 * alone cannot: it sits on 深 in 竹林深し, where the adjective 深し is wanted,
 * and equally on 肥 in 馬肥 and on 現 in 其德現, where no adjective reading
 * exists to be wanted and the word is a plain intransitive verb. Asking the
 * dictionary whether there is an adjective to choose separates the two.
 *
 * `"i-final"` and not `"adjective"`, because that is as far as the shape goes
 * — see `kunWordClass`, which this and every other dot-reading rule in this
 * file now go through. The over-admission is the right way round here: this
 * is a *suppression* gate (it withholds the transitivity question in favour of
 * an adjective reading), so admitting 扱's あつか.い costs a verb reading the
 * character does not have, while missing 深's ふか.い would cost the adjective
 * reading it does. Where the answer has to be narrowed to a real adjective the
 * dictionary is asked — see `classicalAdjectiveKun`. */
export function hasAdjectiveKun(index: KanjidicIndex, char: string): boolean {
  return (index[char]?.kun ?? []).some((k) => kunWordClass(k) === "i-final");
}

/** Whether the character is an **adjective and nothing else** as far as its
 * kun'yomi go: at least one the dictionary vouches for as an い-adjective, and
 * no bare noun reading at all. 癢 is the case — KANJIDIC2 gives it かゆ.い and
 * that is its whole kun list.
 *
 * What turns on it is a token in a *nominal slot*, and the question it answers
 * is the premise `isVerbalNominal` in `readingResolver.ts` rests its object-slot
 * exclusion on: that a verbal character standing as an object is "routinely the
 * noun of the action", with "the nominal reading available". For 療 れう, 釀
 * じやう, 累 るゐ that is so, and the on'yomi is the noun. For a character like
 * this one there is no such noun to reach: `pickKun` drops the inflecting
 * readings for a nominal, finds no bare one, and the on'yomi it falls through to
 * is a stem no kundoku reading uses on its own — 咽中暴癢 came out 癢 ヨウ. The
 * word for what is being felt is かゆみ, which is what the character's own
 * adjective nominalises to.
 *
 * The dictionary's vouching is the whole of the narrowness, and it is why this
 * asks `classicalAdjectiveKun`'s question rather than `hasAdjectiveKun`'s: a
 * character whose only kun is a 連用形 nominal (這's は.い) already *is* a noun
 * and has nothing to nominalise. Over lzh-train/dev/test the two conditions
 * together select one token, and over the reader's own 酒蟲 they select the 癢
 * of sent_id 24 — this is a rule about a shape that is rare, not a rule that
 * does little. */
export function hasAttestedAdjectiveKunOnly(index: KanjidicIndex, jmdict: JmdictIndex, char: string): boolean {
  const kun = index[char]?.kun ?? [];
  if (kun.length === 0 || kun.some((k) => kunWordClass(k) === "nominal")) return false;
  return kun.some((k) => {
    const split = splitOkurigana(stripAffixHyphen(k));
    return classicalAdjectiveKun(jmdict, char, split, split).conjClass !== undefined;
  });
}

/** Whether this kun'yomi should be offered in its classical 終止形 rather
 * than in the modern shape KANJIDIC2 writes it in — 易's やす.い as 易し, not
 * 易い.
 *
 * The menu is the one place a *modern* ending was still reaching the page.
 * `readingResolver.ts` puts the reading it settles on through
 * `classicalAdjectiveReading` and the annotation comes out classical (易耳
 * renders 易[やさ|シキ]), but the furigana menu listed the same two readings
 * as やさシイ / やすイ — the app offering, in a classical text, readings in a
 * language it never prints. This is what closes that.
 *
 * **Positive dictionary evidence is required, and the resolver's own gate
 * would not do here.** That gate is the token's — `Degree=Pos`, or ADJ, or
 * `isTopicalizedAdjective` — and it is the right gate for *one* reading
 * chosen for *one* occurrence. It is the wrong one for a menu, twice over.
 * It says nothing per-candidate, while the menu lists every one of a
 * character's dotted kun'yomi at once: a 向 the parser marked Degree=Pos
 * would have had む.い and む.かい rewritten to 向し / 向かし beside the verb
 * readings, and those are 連用形 nominals ("facing") that take no ending at
 * all. And it is not even *satisfied* by the case that prompted this: 易 in
 * 易耳 arrives VERB with `FEATS=_` and `dep=root` (measured), so every clause
 * of the resolver's gate is false — the classical 易しき on the page comes
 * from the verb lexicon's own しく-adjective entry, not from that gate — and
 * a menu gated the same way would have gone on saying やすイ.
 *
 * So the question is put to JMdict about the candidate itself, through
 * `isAdjectiveLemma`, and the headword is built the same way
 * `pickByTransitivity` builds its own: the character plus KANJIDIC2's
 * okurigana, which is already a modern dictionary spelling (易 + い = 易い).
 * Silence is "leave it alone", never "probably an adjective" — an い ending is
 * not by itself a reason to believe a reading is an adjective, and a real
 * minority of these are nominals (圍's かこ.い "enclosure", 這's は.い) with
 * nothing in KANJIDIC2 to tell them apart from 峨's けわ.しい.
 *
 * **The headword question is asked first and the *reading* question second**,
 * and the second is what carries this rule into kanbun. Only 220 of the 1,134
 * い-final kun'yomi have a headword JMdict lists at all: the character a
 * classical text writes an adjective with is usually not the character a modern
 * dictionary files it under, and 癢い, 幽い, 趍しい and 侔しい are absent from it
 * exactly as 癢, 幽, 趍 and 侔 are absent from a modern newspaper. Their
 * *readings* are not absent — かゆい, ふかい, ひさしい, ひとしい are all ordinary
 * `adj-i` entries under 痒い, 深い, 久しい, 等しい — so `isAdjectiveReading` is
 * asked where the headword lookup came back silent, and it is the same demand
 * for positive evidence made of the one thing kanbun and modern Japanese
 * actually share. It refuses the 連用形 nominals cleanly, because their readings
 * are not adjective readings either (扱い あつかい, 使い つかい, 災い わざわい,
 * 賄い まいない, 互い たがい); see that function for the whole of what it admits
 * and refuses. Together the two routes vouch for 891 of the 1,134.
 *
 * The shape test is not redundant with the dictionary's answer: it is about
 * what `classicalAdjectiveReading` can convert *without dropping a stem
 * kana*. That function replaces the whole okurigana with し, which is right
 * where the okurigana is the whole ending (やす.い -> やすし) or ends in しい
 * (やさ.しい -> やさし), and wrong where a stem mora sits inside it — 危's
 * あぶ.ない would become 危し where the classical adjective is 危なし. Those
 * seventeen readings (あぶ.ない, おお.きい, つめ.たい, すさ.まじい and the rest)
 * are left in their modern shape rather than given a truncated classical one,
 * on the same principle as everything else here. None of them occurs in this
 * reader's corpus, measured.
 *
 * A reading whose kana boundary was transferred from another character's
 * attestation (see `historicalSplitByReading`) is not offered this at all:
 * its okurigana is not KANJIDIC2's own, so KANJIDIC2's dot notation says
 * nothing about it, and the headword the dictionary would be asked about is
 * not the one the boundary came from.
 *
 * The 終止形 it converts to is also where the ク/シク distinction stops being
 * legible — both classes end in し — so the class is read off the modern
 * ending here, while that ending is still in hand, and returned with the
 * converted reading. It is the one thing a reader who picks this candidate
 * could not otherwise be given: 易 offers both やさシ (シク活用) and やすシ
 * (ク活用), the two are stored identically, and without the class travelling
 * alongside neither could be inflected at all — 易し stood wherever it was
 * picked, where 易耳 wants the 連体形 (易しき / 易き respectively). See
 * `classicalAdjectiveConjClass`, and `chosenReading.ts` for where it is kept.
 *
 * `modern` is KANJIDIC2's reading as written, before the 歴史的仮名遣い fold,
 * because that spelling is what JMdict is keyed by; `candidate` is the folded
 * one this rewrites. */
function classicalAdjectiveKun(
  jmdict: JmdictIndex | null | undefined,
  char: string,
  modern: { reading: string; okurigana?: string },
  candidate: { reading: string; okurigana?: string },
): { reading: string; okurigana?: string; conjClass?: ConjClass } {
  if (!jmdict) return candidate;
  const { reading, okurigana } = modern;
  const wholeEnding = okurigana === undefined ? reading.endsWith("い") : okurigana === "い" || okurigana.endsWith("しい");
  if (!wholeEnding) return candidate;
  const modernWord = reading + (okurigana ?? "");
  if (!isAdjectiveLemma(jmdict, char + (okurigana ?? "い"), modernWord) && !isAdjectiveReading(jmdict, modernWord)) {
    return candidate;
  }
  // 終止形, never 連体形: the menu names the reading, and the citation form a
  // dictionary would list it under is what names it. Which form the
  // annotation then takes is the sentence's business — 易耳 shows シキ over
  // the character while the menu says やさシ, exactly as 直 shows the 連用形
  // なほシ against a menu entry なほス. `openReadingMenu` already compares on
  // the reading alone for that very reason, so the ending differing does not
  // stop the entry being marked as the current one.
  return {
    ...classicalAdjectiveReading(candidate.reading, candidate.okurigana),
    conjClass: classicalAdjectiveConjClass(reading, okurigana),
  };
}

/** **The classical form of an inflecting kun'yomi, and the paradigm it
 * inflects by** — `classicalAdjectiveKun`'s companion for the verbs, doing for
 * them exactly what that function has always done for the adjectives.
 *
 * KANJIDIC2's kun'yomi are modern dictionary readings verbatim, so the menu
 * was offering 覺 as おぼ**エル**, 出 as い**デル** and 覺's second word as
 * さ**メル** — 下一段 endings, which is not a shape this app ever prints and not
 * a form a reader annotating a classical text is choosing between. The page
 * beside the menu already read おぼゆ. A menu whose items are spelled in an
 * orthography and a grammar the page does not use cannot even mark which of
 * them is the current one, which is the objection `hagyouShuushi` (買フ, not
 * 買ウ) and the adjective conversion (易シ, not 易い) each answer for their own
 * corner; this answers it for the rest.
 *
 * **The ending is written from the paradigm, not converted from the string**,
 * and that is the whole of how おぼえる becomes おぼゆ. A mechanical conversion
 * cannot get there — `classicalVerbEnding` declines the あ row outright,
 * because a modern -eru with a bare え could descend from ア行, ヤ行 or ワ行下二段
 * and the surface form cannot tell them apart — so what is asked for instead is
 * the *class*, and once a class is named its own 終止形 is a table lookup
 * (`conjugate`). This is the same move `readingResolver.ts` already makes at
 * its `ending` branch, where a paradigm the ending could not state is written
 * out of the class rather than converted from the modern okurigana.
 *
 * **Three sources, asked in the order the resolver asks them**, so that the
 * menu and the page cannot name different paradigms for one character:
 *
 *  1. `attestedSenseByModernSpelling` — this project's own verb lexicon,
 *     matched on the exact modern spelling KANJIDIC2 wrote. It is what answers
 *     for 覺: `LEXICON_SENSES` holds おぼ as **下二段ヤ行**, whose 終止形 is
 *     おぼゆ. (`lexicalKun` is asked before this, earlier in the caller, and
 *     returns 用's ワ行上一段 もちゐる outright.)
 *  2. `classicalConjClass` — the shape tables, which answer for every regular
 *     二段: 出's い.でる is 下二段ダ行 いづ, 立's た.てる 下二段タ行 立つ, 起's
 *     お.きる 上二段カ行 起く, 破's やぶ.れる 下二段ラ行 破る.
 *  3. `attestedClassicalParadigm` — JMdict's own classical headwords, keyed by
 *     reading, which is the route written for exactly the row the shape tables
 *     decline: 應's こた.える comes back 下二段ハ行 こたふ.
 *
 * **It fires only where the ending actually changes**, and that bound is what
 * keeps it from making a new claim anywhere it has nothing to say. A one-kana
 * modern okurigana is already the classical 終止形 (惡's にく.む is 四段マ行 む
 * either way), and it is also where `classicalConjClass` says outright that its
 * 四段 answer is a *guess* — 墮's おち.る is such a case, and the guess is wrong
 * there (the word is 落つ, 上二段タ行, which KANJIDIC2's own dot position on the
 * shinjitai 堕 as お.ちる gets right and its kyūjitai one does not). Since the
 * derived ending equals the stored one, the candidate is returned untouched and
 * no paradigm is attached: the menu goes on offering おちル exactly as before,
 * and `chosenConjClass` goes on deriving the same 四段 from it at pick time if
 * the reader chooses it. Nothing is made worse, and nothing is asserted that
 * this function did not establish. The annotation to correct is KANJIDIC2's
 * division of 墮, not this rule.
 *
 * **The class travels with the converted ending**, and must: the conversion is
 * lossy in exactly the place the class turns on — た.てる and た.ちる both give
 * 立つ, and 下二段タ行 against 四段タ行 is the whole difference between 廟を立てて
 * and 廟立ちて — so `chosenConjClass` could not read the paradigm back off what
 * is now stored. That is the same argument `CONJ_CLASS_KEY` records for the
 * adjectives, whose 終止形 し erases ク against シク, and the same remedy: the
 * class is taken from the candidate that knew it while the modern ending was
 * still in hand. A stem prefix (肥's や, 果's た) needs no carrying — the stored
 * ending is the class's own 終止形 including it, which is the spelling
 * `attestedSense` matches a lexicon sense back on.
 *
 * `modern` is KANJIDIC2's reading as written, before the 歴史的仮名遣い fold,
 * because that spelling is what both dictionaries are keyed by; `candidate` is
 * the folded one this rewrites — the same division `classicalAdjectiveKun`
 * makes, and for the same reason. */
function classicalVerbKun(
  jmdict: JmdictIndex | null | undefined,
  char: string,
  modern: { reading: string; okurigana?: string },
  candidate: { reading: string; okurigana?: string },
): { reading: string; okurigana?: string; conjClass?: ConjClass } {
  const { reading, okurigana } = modern;
  // The shape has to say the word inflects at all. This refuses the nominals
  // (no dot), the 連用形 nominals and ナリ活用 stems and adverbs `kunWordClass`
  // calls `"unstated"` (飲.み, やす.らか, もっ.て), and the い-final readings,
  // which are the adjective conversion's business and are already spent by the
  // time this runs.
  if (okurigana === undefined || splitKunWordClass(okurigana) !== "verb") return candidate;
  // **The stem prefix comes from the lexicon sense or from nowhere**, and that
  // is a fact about the other two routes rather than a simplification: the
  // shape tables read a one- or two-kana ending that has no room for a prefix,
  // and `attestedClassicalParadigm` refuses outright any word that needs one
  // (its own doc gives 肥's こ.やす as the case). So a prefix exists only where
  // a sense supplied the class, and there it is the sense's own — which is
  // exactly what `conjugatedOkurigana` writes, and exactly the spelling
  // `attestedSense` matches a stored ending back against.
  const sense = attestedSenseByModernSpelling(char, reading, okurigana);
  const conjClass =
    sense?.conjClass ??
    classicalConjClass(okurigana, { lemma: char, reading }) ??
    attestedClassicalParadigm(jmdict, reading, okurigana);
  if (!conjClass) return candidate;
  // The one guard the resolver also carries, and for the identical reason: a
  // dictionary calling the modern word 一段 is calling a guessed 四段 wrong,
  // whatever the right answer turns out to be. See `isModernIchidanLemma`.
  if (okurigana.length === 1 && isModernIchidanLemma(jmdict, char + okurigana, reading + okurigana)) return candidate;
  const classical = (sense?.okuriganaPrefix ?? "") + conjugate(conjClass, "shuushi");
  // **Nothing is rewritten where the ending is already what it should be**, and
  // the candidate is then returned exactly as it arrived — without a class,
  // deliberately. A one-kana modern okurigana is its own classical 終止形 (惡's
  // にく.む is 四段マ行 む either way), and it is also the one place
  // `classicalConjClass` says outright that its 四段 answer is a *guess*. 墮 is
  // that case and the guess is wrong there: KANJIDIC2 divides the kyūjitai as
  // おち.る where it divides the shinjitai 堕 as お.ちる, and only the second
  // reaches 上二段タ行 落つ. Attaching the guessed 四段 here would have written
  // it into the menu as a paradigm this function had established, where today
  // it is merely what `chosenConjClass` re-derives from the same bare る if the
  // reader picks that candidate — the same answer either way, and better left
  // where it can be recognised for what it is. The annotation to correct is
  // KANJIDIC2's division of 墮, not this rule.
  if (classical === candidate.okurigana) return candidate;
  return { reading: candidate.reading, okurigana: classical, conjClass };
}

/** The classical adjective paradigm `char` takes when read with `okurigana` —
 * ク活用 or シク活用 — or undefined where the dictionary does not vouch for that
 * reading being an adjective at all.
 *
 * `classicalAdjectiveKun` above answers this for a *candidate the menu is
 * building*, which already has KANJIDIC2's own (unfolded) reading in hand. This
 * answers it for a reading `lookupKanji` has already chosen and folded, which
 * is the shape `readingResolver.ts` holds — so the character's kun list is read
 * a second time here to recover the modern spelling the dictionary is keyed by.
 * The two go through the one gate, deliberately: the menu and the annotation
 * disagreeing about whether a word is an adjective is precisely the drift this
 * module is written to prevent.
 *
 * **What the resolver needs it for is the tokens the *tree* does not call
 * adjectives.** That path converts an い-final kun to its 終止形 only for a token
 * carrying `Degree=Pos` (or topicalized, or a complement of becoming), which is
 * the right gate where the parser supplies the feature and no gate at all where
 * it does not: measured over lzh-train/dev/test, 109 characters reach the page
 * with a modern い okurigana, and for the 71 of them `VERB_LEXICON` is silent
 * about there is nothing else to correct it — 幽 printed ふかい, 趍 ひさしい, 侔
 * ひとしい, 癢 かゆい, every one of them tagged a plain VERB with no feature on
 * it. The dictionary's answer does not depend on the tag, so it can be asked
 * wherever the tag failed to say.
 *
 * **Both halves of the reading are matched, and the fold is applied to find the
 * match.** The caller holds a reading `lookupKanji` has already put into
 * 歴史的仮名遣い, so comparing it against KANJIDIC2's own modern spelling would
 * miss every kun the index touches — 麗's うるわ.しい is on the page as うるは —
 * while comparing on the okurigana alone would find *any* kun of the character
 * that happens to end the same way. Both failures were live: 沽 lists あた.い
 * ("price", a noun) and あら.い ("coarse") and would have taken the adjective
 * answer belonging to the second while reading the first, and 齊 read せい (its
 * on'yomi, no okurigana at all) would have matched the undotted はやい and been
 * trimmed to せし. So the fold is re-applied here to each candidate kun and the
 * whole reading has to agree.
 *
 * A reading whose boundary was *transferred* from another character's
 * attestation matches no kun here and gets no answer, which is the same silence
 * `classicalAdjectiveKun` gives it and for the same reason.
 *
 * The dictionary question is asked of KANJIDIC2's *unfolded* spelling, never of
 * the folded one, exactly as `candidateReadings` asks it: JMdict is keyed
 * modernly, and うるは matches no entry it holds. */
export function attestedAdjectiveClass(
  index: KanjidicIndex,
  jmdict: JmdictIndex | null | undefined,
  char: string,
  reading: string,
  okurigana: string | undefined,
  historicalKana?: HistoricalKanaIndex,
): ConjClass | undefined {
  const entry = index[char];
  if (!entry) return undefined;
  for (const kun of kunReadings(entry, char)) {
    const split = splitOkurigana(stripAffixHyphen(kun));
    if (split.okurigana !== okurigana) continue;
    if (historicalKun(historicalKana, char, split.reading, entry) !== reading) continue;
    const conjClass = classicalAdjectiveKun(jmdict, char, split, split).conjClass;
    if (conjClass) return conjClass;
  }
  return undefined;
}

/** The kana a classical paradigm nominalises with, after the stem — the
 * readings a **verb or adjective standing in a nominal slot** takes.
 *
 * Two shapes, and which of them applies is the class's own business:
 *
 *  - **A verb nominalises by its 連体形.** 出づ (下二段ダ行) is いづる, and
 *    有物出 — where 出 is the `subj` of 有 — is 物の出づる有り. Classical
 *    Japanese nominalises a predicate by putting it in the attributive and
 *    letting it stand headless, which is the same inference
 *    `isNominalizedPredicate` in conjugationContext.ts already makes for a
 *    predicate in an object slot; here it is the reading rather than the
 *    ending that has to carry it, because the token is not tagged a verb and
 *    so never reaches either panel's conjugation branch.
 *  - **An adjective nominalises by さ or み**, and offers its 連体形 and its
 *    citation 終止形 beside them. 長 is ながさ ("length" — 長三寸許 is
 *    長さ三寸ばかり), ながみ, ながき, ながし. シク活用 carries its own し into
 *    both suffixes (楽しさ, 楽しみ), which is why the ending is built from the
 *    paradigm's 連用形-less stem rather than by appending to a bare さ.
 *
 * **What this licenses and what it does not.** It licenses *offering* these
 * readings for a nominal — putting them in the furigana menu, and letting the
 * resolver reach one where the tree says the token is a predicate standing in
 * a nominal slot (see `lookupKanji`'s `nominalization` argument). It is **not**
 * a claim that the word is a noun: 出づる is the 連体形 of a verb wherever it
 * appears, and nothing here says 出 has a nominal sense, only that a verb
 * standing where a noun would is read in the form classical Japanese reads it
 * in. Nor does it license the *ending* being inflected further — a
 * nominalisation is the finished form, so no `conjClass` travels with these
 * candidates and a reader who picks one gets exactly the string offered.
 *
 * No さ/み for the 形容動詞 classes: 静かさ is a real word, but a ナリ/タリ stem
 * is Sino-Japanese far more often than not in this corpus and 蠕動さ is not,
 * so those classes get their 連体形 alone. */
function nominalizingEndings(conjClass: ConjClass): string[] {
  if (conjClass === "ku-keiyoushi" || conjClass === "shiku-keiyoushi") {
    const stem = conjClass === "shiku-keiyoushi" ? "し" : "";
    return [stem + "さ", stem + "み", conjugate(conjClass, "rentai"), conjugate(conjClass, "shuushi")];
  }
  return [conjugate(conjClass, "rentai")];
}

/** Every nominal reading `char` offers by nominalising one of its own
 * inflecting words — the candidates `nominalizingEndings` describes, built for
 * each classical word this app can name for the character.
 *
 * **Two sources, lexicon first.** `VERB_LEXICON` holds one *sense-disambiguated*
 * classical word per kanji — a reading and a paradigm read off Wiktionary's own
 * conjugation table, or off `RESIDUAL` where the reader has settled the sense —
 * and that is the word a nominalisation should be of. KANJIDIC2's kun list is
 * the fallback and is not a substitute for it: 出's list leads with で.る, whose
 * bare る `classicalConjClass` can only read as 四段ラ行, so a nominalisation
 * taken off it would be 出る where the word is 出づ. The lexicon says 下二段ダ行
 * い and the 連体形 comes out いづる. Every kun the list holds is then offered
 * too, so the menu shows the alternatives the lexicon's single entry hides.
 *
 * The kun-derived half goes through `classicalAdjectiveKun` — the same gate,
 * with the same dictionary, that `candidateReadings` already puts an い-final
 * reading through — so an adjective is nominalised only where JMdict vouches
 * for it being one, and a 連用形 nominal (扱's あつか.い) is left alone. A
 * dotted reading the shape calls a verb takes `classicalConjClass`, which
 * abstains on every ending it cannot name a paradigm for.
 *
 * De-duplicated by the caller, which folds these into one list with the
 * ordinary candidates and drops anything already offered. */
function nominalizedCandidates(
  index: KanjidicIndex,
  char: string,
  historicalKana: HistoricalKanaIndex | undefined,
  jmdict: JmdictIndex | null | undefined,
): ReadingCandidate[] {
  const entry = index[char];
  if (!entry) return [];
  const gloss = entry.meanings[0];
  const out: ReadingCandidate[] = [];
  const add = (reading: string, conjClass: ConjClass, prefix: string): void => {
    // A reading that **is** the paradigm's own 終止形 covers the ending rather
    // than a stem, and the ending written after it has to have that kana taken
    // off or the kana is written twice. 種 is the case: ワ行下二段 植う, whose
    // terminative is the bare row-kana う and whose kanji therefore carries the
    // whole of it (`SUPPLEMENTARY_KUN` writes the reading as "う." with the dot
    // last, for exactly this reason). Its 連体形 うる is 種 + る, and appending
    // the paradigm's うる unexamined gave 種ううる.
    //
    // Conditioned on the reading being that ending exactly, not on the two
    // merely overlapping: a stem that happens to start with its own row's kana
    // is an ordinary word (立つ's た against つ does not, but nothing here
    // should depend on that), and a prefix (来's た in 来たる) means the
    // boundary has already been placed by hand and must not be moved again.
    const shuushi = conjugate(conjClass, "shuushi");
    const readingCoversEnding = prefix === "" && reading === shuushi && shuushi !== "";
    for (const suffix of nominalizingEndings(conjClass)) {
      const whole = prefix + suffix;
      const okurigana = readingCoversEnding && whole.startsWith(shuushi) ? whole.slice(shuushi.length) : whole;
      // An ending that comes out empty is the citation form itself, which the
      // ordinary kun list already offers where it offers anything.
      if (okurigana) out.push({ reading, okurigana, gloss, kind: "kun" });
    }
  };

  const lex = VERB_LEXICON[char];
  // Folded, and by the same two steps `candidateReadings`' own lexicon branch
  // and `lexiconFurigana` in `KundokuView.ts` use — the index first, the
  // full-size fall-back after, and neither where the key is ambiguous between
  // the character's two series. This was the one lexicon reading that reached a
  // menu raw, and it is gated to a nominal POS, which is why it showed up as a
  // NOUN/PROPN-only leak: 39 of the lexicon's entries hold a modern reading by
  // design (the ones whose extraction found no classical table), so 戯 offered
  // じゃ, 喫 きっ and 仰 おっしゃ where the same characters at VERB were already
  // coming out じや, きつ and おつしや. The kun loop below has always folded its
  // half through `historicalKun`; this line had not.
  const lexReading =
    lex?.reading === undefined
      ? undefined
      : seriesAmbiguousReading(index, char, lex.reading)
        ? fullSizeKana(lex.reading)
        : historicalSpelling(historicalKana, char, lex.reading);
  if (lex?.conjClass && lexReading) add(lexReading, lex.conjClass, lex.okuriganaPrefix ?? "");

  for (const kun of kunReadings(entry, char)) {
    const split = splitOkurigana(stripAffixHyphen(kun));
    const folded = { reading: historicalKun(historicalKana, char, split.reading, entry), okurigana: split.okurigana };
    const adjective = classicalAdjectiveKun(jmdict, char, split, folded);
    if (adjective.conjClass) {
      add(folded.reading, adjective.conjClass, "");
      continue;
    }
    if (splitKunWordClass(split.okurigana) !== "verb") continue;
    const conjClass = classicalConjClass(split.okurigana, { lemma: char, reading: folded.reading });
    if (conjClass) add(folded.reading, conjClass, "");
  }
  return out;
}

/** The short of an `overrides.json` gloss, for a menu item's tooltip.
 *
 * Those glosses are written for whoever is reading the table, and several run
 * to a paragraph explaining why the entry is shaped the way it is (之's ADP
 * entry explains the empty `okurigana`; 非's explains which slot each half
 * goes in). All of them open with the word's actual meaning and then break
 * into that explanation at a full stop or an opening bracket, so the first
 * clause is the whole of what a reader hovering a menu item wants and the
 * rest is note-to-self. Cut rather than shown entire, and cut rather than a
 * second `gloss` field added to 208 entries by hand. */
function shortGloss(gloss: string | undefined): string | undefined {
  if (!gloss) return undefined;
  const cut = gloss.search(/\. |\(|。/);
  return (cut === -1 ? gloss : gloss.slice(0, cut)).trim() || undefined;
}

/** What each auxiliary in `AUXILIARY_LEMMAS` is, for a menu item's tooltip —
 * the four categories that table's own doc names.
 *
 * Keyed on the paradigm object rather than on its kana, so that べし's two
 * entries are told apart: 可/能 take it as `POTENTIAL` and 須/當/応/應 as
 * `NECESSITY`, which are the same string and different grammatical claims, and
 * a tooltip reading "potential" over a 當 would be simply wrong. A form the map
 * has no entry for still gets a tooltip — nothing here may be the reason a
 * reading is withheld, and a fifth category added to that table should show up
 * as a vague gloss rather than as a missing menu item. */
const AUXILIARY_GLOSSES: ReadonlyMap<ConjugatedForm, string> = new Map([
  [POTENTIAL, "potential auxiliary"],
  [NECESSITY, "necessity auxiliary"],
  [DESIDERATIVE, "desiderative auxiliary"],
  [CAUSATIVE, "causative auxiliary"],
]);

/** The curated readings of a character — everything the app can put over it
 * that KANJIDIC2 does not list, gathered so the furigana menu offers it.
 *
 * **The menu's list and the resolver's answer have to be drawn from the same
 * sources, and they were not.** `candidateReadings` read KANJIDIC2 (plus this
 * module's own supplements) and nothing else, while the reading that reaches
 * the page comes from five further tables — so wherever one of those spoke,
 * the menu offered a set of readings that did not include the one on screen.
 * Two things went wrong at once: the reader could not get back to the default
 * once they had picked something else, and `openReadingMenu` marked nothing as
 * current, because it marks by comparing its candidates against the `<rt>`.
 * 否 is the case that named the bug — it reads 否ム by `VERB_LEXICON` and its
 * menu offered ヒ alone — and it is one of 39 cells in the reader's own text.
 *
 * The five:
 *
 *  - **`overrides.json`**, the curated function-word table. 174 characters,
 *    208 entries, of which 126 (on 114 characters) name a reading no menu
 *    offered: 其's そ+の, 每's ごと+に, 不's ず, 使's しむ, 者's もの. Every
 *    entry for the character is taken, whatever role it names — see
 *    `overrideReadings`.
 *
 *  - **`LEXICON_SENSES`** (verbLexicon.ts), the classical verb/adjective
 *    senses. 138 single-character lemmas name a reading (163 in all) that no
 *    menu offered — 曰's い, 渴's かは-as-かわ, 墮's お, 瘦's や, 否's いな.
 *    This is the table `KundokuView.ts` draws its furigana from for any token
 *    the lexicon claims, so it is the *most* common source of a reading on
 *    the page and was the one entirely absent from the menu.
 *
 *  - **the sentence-final particles** (bungoConjugation.ts). Ten characters,
 *    of which four name a reading no menu offered: 夫's かな, 焉's り, 否's や,
 *    耳's のみ. 否 needs both this and the lexicon — it is a real verb *and* a
 *    question tag, and the menu should say so.
 *
 *  - **`AUXILIARY_LEMMAS`** (bungoConjugation.ts), the modal and causative
 *    auxiliaries. Eleven characters, of which three named a reading no menu
 *    offered — and all three were measured unmarkable on the page: 能 renders
 *    ベシ against a menu of なう/よク/あたフ/よく, 欲 renders マホシ against
 *    よく/ほつスル/ほシ/ほつす, and 遣 renders シム against a menu with no しむ
 *    on it at all. The other eight escaped only by accident: `overrides.json`
 *    happens to carry べし for 可 and しむ for 使/令/教 on its own account, and
 *    須/當/応/應 are 再読文字 that reach the page through `isRereadUse`, where
 *    `rereadCandidateFor` names them すべからく…ベシ. An accident is not a
 *    guarantee, and the three it did not cover are what this arm is for.
 *
 *  - **the two division tables** (`READING_ENDING_SPLITS` and
 *    `KANJI_RETAINED_ADVERBS`), which are not sources of readings but of
 *    *divisions*, and are handled in `candidateReadings` itself rather than
 *    here because they apply to KANJIDIC2's own これ and あに as much as to a
 *    curated reading. The adverb table used to be a known gap, and was
 *    unreachable from here for a structural reason: it lived in `generator.ts`,
 *    which imports `readingResolver.ts`, which imports this module, so the edge
 *    would have closed a cycle. It now lives in `classicalEnding.ts` beside the
 *    other one, which both sides can reach, and 豈's あ+ニ and 固's もと+ヨリ —
 *    the two divisions in the reader's own 酒蟲 that no menu could mark — are
 *    offered.
 *
 * A reading written *wholly in the okurigana slot* — an override stating no
 * `okurigana` of its own (不 is a bare 不 beside ズ), a postposed negation, a
 * particle read after its character, and every auxiliary above — used to be
 * offered here and yet unmarkable, because `openReadingMenu` marks by comparing
 * against the `<rt>` and these cells have no furigana in it to compare. That is
 * closed, and closed on the render side rather than here: `cellFor` records the
 * *citation* form of whatever stands in that slot as `data-kana-reading` — the
 * form each branch draws from its own paradigm, not the inflected kana on the
 * page, since one ず is written ズ, ザル, ザルニ or ズト and equals no citation —
 * and `openReadingMenu` compares a candidate's `reading` against that wherever
 * the furigana slot is empty. Which is why an arm here need only name the
 * citation: the machinery to match it is already waiting for one.
 *
 * What is **not** here, and is left out deliberately rather than half-covered:
 *
 *  - A `ConjugatedForm`'s `alt`. `DESIDERATIVE` records たし beside まほし as a
 *    documented later-register alternative, and `NEGATION` records ぬ and ざる
 *    beside ず — but `selectForm` chooses between `primary`, `mizen` and
 *    `renyou` only, and `cellFor` is handed `primary` in every case, so no
 *    `alt` is ever a reading this app puts on a page. The rule this whole
 *    function exists for is that the menu must offer what the page shows; an
 *    entry for a form the page cannot show is a different claim, and one for
 *    the tables that state readings (`overrides.json`) to make. */
function curatedCandidates(
  index: KanjidicIndex,
  char: string,
  pos: string | undefined,
  historicalKana: HistoricalKanaIndex | undefined,
  /** The readings the dictionary arms have already put on the list, which the
   * auxiliary and lexicon arms below defer to — see there. The arms that state
   * a reading *in place of* the character rather than as a reading of it (the
   * override table, the sentence-final particles) do not: an override is
   * curated precisely to say what the dictionary does not, and a particle read
   * over its character is a different word from a kun'yomi spelled alike. */
  alreadyOffered: ReadonlySet<string>,
): ReadingCandidate[] {
  const entry = index[char];
  // **Every candidate from here is a 訓読み**, and that is a statement about
  // the 音読み heading rather than about these readings: that group is the
  // *dictionary's* own on series, which `fromOn` in `candidateReadings` lists
  // in full and ahead of this, so a curated reading spelled like one of them
  // is folded into it by the de-duplication and never reaches the menu twice.
  // What survives to be grouped here is by construction a reading KANJIDIC2
  // does not carry — including the Sino-Japanese-looking ones, 令's and 使's
  // しむ, which are not on'yomi of those characters either.
  //
  // Curated readings *spelled* like their own character's on'yomi do exist, and
  // there are two dozen of them (謂's lexicon reading い, 仁's じん, 放's ほう) —
  // the claim is the narrower one that none **survives**, checked over the
  // shipped tables at every POS. Three things stand them down and it does not
  // matter which: the arms below that consult `alreadyOffered` never emit one,
  // the de-duplication in `candidateReadings` folds what the other arms do emit
  // into the `fromOn` entry listed ahead of it, and where the on'yomi has been
  // folded into 歴史的仮名遣い (謂's イ is listed ゐ) the collision is with the
  // character's own kun stem instead and `alreadyOffered` catches it there. The
  // auxiliaries are the least likely of the five sources to break this — the on
  // series of all eleven is か/こく/なう/す/しゆ/たう/おう/よう/よく/し/れい/
  // けう/けん and the readings offered are べし/まほし/しむ — but nothing here
  // rests on that; see `tests/candidateReadings.test.ts`, which re-derives the
  // whole claim over every table each run.
  const out: ReadingCandidate[] = [];
  for (const override of overrideReadings(char)) {
    out.push({
      reading: override.reading,
      ...(override.okurigana ? { okurigana: override.okurigana } : {}),
      gloss: shortGloss(override.gloss),
      kind: "kun",
    });
  }

  const particle = sentenceFinalParticle(char);
  if (particle) out.push({ reading: particle, gloss: "sentence-final particle", kind: "kun" });

  // **The auxiliary this character renders as**, where it is one of the eleven.
  //
  // Offered at *every* part of speech, unlike the lexicon arm below, and the
  // gate has to be the one the page itself uses: `AUXILIARY_LEMMAS` is keyed
  // on the lemma alone and `auxiliaryFormFor` adds only the 再読 test to it, so
  // there is no POS anywhere on the path that puts ベシ or シム on a cell. A
  // nominal-tagged 令 renders シム exactly as a verb-tagged one does — measured,
  // on a tree with 令/能/欲 hand-tagged NOUN, where all three still drew シム,
  // ベシ and マホシ — and a menu that withheld the reading from a nominal would
  // be withholding it from the one occurrence that could not do without it.
  // The `kun` filter's reason does not reach here in any case: it withholds a
  // *dictionary word* whose finite form a
  // noun cannot take, and offers the nominalisations of that word instead
  // (`nominalizedCandidates`). An auxiliary is not a dictionary word of the
  // character at all — it is a grammatical gloss standing in for it, with the
  // kanji dropped in the prose — so there is nothing to nominalise and nothing
  // the tag could rule out. `overrides.json`, which glosses the same eleven
  // characters the same way, is ungated for the same reason.
  //
  // **No `conjClass` travels with it, and none can.** Every other candidate
  // that carries one is a *stem* plus an ending — the lexicon's 曰 is い + フ,
  // and the class inflects the second half while the first stands still. An
  // auxiliary reading is a whole word in one piece, because that is the only
  // spelling the menu can mark it by: `cellFor` records the paradigm's own
  // citation as `data-kana-reading` (べし, まほし, しむ), the cell has no
  // furigana for the `<rt>` comparison to read, and `openReadingMenu` falls
  // back to comparing that citation against a candidate's `reading` entire.
  // A class named beside it would then be appended to a reading that already
  // contains its own tail — `conjugatedOkurigana` knows only how to add a
  // suffix — and a picked 能 would print 能[べし]シ, a picked 令 令[しむ]ム.
  // Naming none does *not* freeze the pick, which is what it used to do and
  // what the shape of this entry might suggest. A pick of one of these is
  // recognised by `chosenAuxiliary` (chosenReading.ts) and routed back into
  // the auxiliary machinery rather than through the hand-picked branch, so it
  // inflects on the ordinary path — `auxiliaryFormFor` → `selectForm` → the
  // 未然形 before a ず — and 可 and 使's identical `overrides.json` entries
  // inflect with it. The whole-word spelling is what makes that recognition
  // possible: the stored reading *is* the citation, so no second field has to
  // be stored to say which auxiliary was chosen.
  //
  // A dictionary entry that divides the same word is a different claim and
  // stays a different menu entry — 可 offers KANJIDIC2's べ.き and べ.し beside
  // the curated べし, a 可 read as an adjective in its own right. Those two do
  // *not* inflect: picking べシ on the 可 of 不可 leaves 可[べ]シ, because
  // `chosenConjClass` cannot derive ク活用 from a bare し. That is the general
  // adjective-pick gap `CONJ_CLASS_KEY` documents, not something this arm
  // decides — measured, not assumed, after an earlier version of this comment
  // asserted the opposite.
  const auxiliary = AUXILIARY_LEMMAS[char];
  // Only where the dictionary has not already offered it, the same rule the
  // lexicon arm below states at length. Vacuous over the shipped tables (no
  // kun'yomi of the eleven is spelled べし, まほし or しむ — 須's すべし is the
  // nearest miss) and kept all the same, because the table is meant to grow
  // and a second べし on 可's menu is exactly what the rule exists to prevent.
  // The collision with `overrides.json`'s own べし/しむ above is left to the
  // de-duplication in `candidateReadings`, which folds them by reading and
  // ending and keeps the override's fuller gloss — that arm ran first.
  if (auxiliary && !alreadyOffered.has(auxiliary.primary)) {
    out.push({ reading: auxiliary.primary, gloss: AUXILIARY_GLOSSES.get(auxiliary) ?? "auxiliary", kind: "kun" });
  }

  // A lexicon sense is a conjugating word, so it is offered under the same
  // rule the dictionary's own inflecting kun'yomi are: never to a nominal,
  // which cannot be read as a finite predicate (see the `kun` filter in
  // `candidateReadings`, and `nominalizedCandidates` for what a nominal is
  // offered instead — which is built from this very table).
  if (pos !== "NOUN" && pos !== "PRON" && pos !== "PROPN") {
    for (const sense of LEXICON_SENSES[char] ?? []) {
      if (!sense.reading) continue;
      // **Only where the dictionary has not already offered the reading.** The
      // menu names the reading that is on the page by comparing against the
      // `<rt>`, which holds the reading and not the ending, so a lexicon sense
      // whose reading is already listed is already findable and already
      // markable — and adding it again would put a second ending beside the
      // first for the same word. That second ending is where the doubt is: the
      // lexicon is derived data, and its 危 as あぶ + シク活用 would be offered
      // as あぶし, a word nobody says, beside kanjidic's own あぶない (the very
      // truncation `classicalAdjectiveKun` refuses). 用's three senses collapse
      // here too — もちゐる, もちひる and もちゆ are one reading もち, which
      // KANJIDIC2 lists.
      //
      // What is left is exactly the gap: a reading the dictionary does not have
      // at all. 否's いな for a VERB (kanjidic lists it, but as the *bare*
      // nominal reading the inflecting filter above drops), 曰's い, 渴's かわ
      // against the fold's かは, 墮's お, 瘦's や, 適's ゆ — the reading that is
      // on the page in each case.
      //
      // Asked of the folded reading below rather than of the raw one, since
      // that is the spelling the list is written in.
      // The same fold, by the same two steps and in the same order, that
      // `lexiconFurigana` in `KundokuView.ts` applies to this reading before
      // drawing it — the index first, the full-size fall-back after, and
      // neither where the key is ambiguous between the character's two series
      // (謂's い). It has to be that fold and not `historicalKun`'s: the two
      // disagree about 渴, whose lexicon reading reaches the page as かわ while
      // this module's cross-character transfer answers かは, and a menu written
      // in the other one's spelling recognises nothing.
      const reading = seriesAmbiguousReading(index, char, sense.reading)
        ? fullSizeKana(sense.reading)
        : historicalSpelling(historicalKana, char, sense.reading);
      if (alreadyOffered.has(reading)) continue;
      const prefix = sense.okuriganaPrefix ?? "";
      // Both endings where the sense has both, because both reach the page:
      // 曰 is 曰ハク wherever it introduces speech and 曰フ where it does not
      // (`isNamingUse` decides), and a menu offering one of them leaves the
      // other occurrence marking nothing.
      if (sense.fixedReading) out.push({ reading, okurigana: sense.fixedReading, gloss: entry?.meanings[0], kind: "kun" });
      if (sense.conjClass) {
        out.push({
          reading,
          okurigana: prefix + conjugate(sense.conjClass, "shuushi"),
          // The paradigm travels with the ending, as it does for the two other
          // candidate kinds that carry one: this ending is a 終止形 written out
          // of the class rather than KANJIDIC2's modern okurigana, so nothing
          // downstream could read the class back off it (`chosenConjClass`
          // sees a bare む and calls it 四段マ行, which is what 否 is, but sees
          // 曰's ふ and cannot know it is ハ行四段 rather than 下二段). Without
          // it a picked 否 would stand at 否む wherever it fell.
          conjClass: sense.conjClass,
          gloss: entry?.meanings[0],
          kind: "kun",
        });
      }
    }
  }
  return out;
}

/** The chosen kun'yomi, and whether the transitivity check is what chose it.
 *
 * The two are reported separately because they are different questions, and
 * conflating them was a bug: `transitivitySelected` used to mean "the answer
 * differs from the unconditioned default", which is not the same as "the
 * syntax answered it". 肥 with no object resolves to こ.える, which is also
 * kanjidic's own first dotted reading — so the flag stayed off, and with it
 * off `VERB_LEXICON`'s single entry (肥 as the transitive こ+やす) overruled
 * the resolver and 馬肥 read 馬肥やす. An answer the syntax gave outranks the
 * lexicon whether or not it happens to agree with the dictionary's ordering. */
function pickKun(
  kun: string[],
  pos: string | undefined,
  transitivity?: { char: string; wantTransitive: boolean; jmdict: JmdictIndex },
): { kun: string | undefined; transitivitySelected: boolean } {
  if (kun.length === 0) return { kun: undefined, transitivitySelected: false };
  if (pos === "VERB" || pos === "ADJ") {
    const dotted = kun.filter((k) => kunWordClass(k) !== "nominal");
    // **A hand-supplied reading is not put to the vote.** `SUPPLEMENTARY_KUN`
    // holds the readings a person has settled for a character KANJIDIC2 reads
    // some other way, and `kunReadings` puts them at the head of the list
    // precisely so they lead — but the transitivity check reorders the list on
    // the dictionary's evidence, and the dictionary has nothing to say about a
    // reading it does not hold, so the supplement lost every time. 適's entry in
    // `verbLexicon.ts` records the shape from the other side: a supplementary
    // ゆ.く beside KANJIDIC2's own かな.う sends the character through
    // `pickByTransitivity`, which answers かな.う, reports `transitivitySelected`
    // — and that flag then stands the `RESIDUAL` entry down as well, so the
    // character read かなふ by a longer route with both tables saying otherwise.
    // 熾 is the same: さか.ん against おこ.る/おこ.す, of which JMdict holds the
    // latter two and not the first.
    //
    // The two claims are of different kinds and that is why one yields. The
    // vote settles *which of the character's own listed words* the syntax
    // wants; a supplement says which word this character is in kanbun at all.
    // Nothing is lost where the supplement is not what leads — a character with
    // no supplementary reading reaches the vote exactly as before, and the
    // supplement's own alternatives stay in the list behind it for the furigana
    // menu to offer.
    const settled = dotted[0] !== undefined && (SUPPLEMENTARY_KUN[transitivity?.char ?? ""] ?? []).includes(dotted[0]);
    if (transitivity && dotted.length > 1 && !settled) {
      const byObject = pickByTransitivity(transitivity.char, dotted, transitivity.wantTransitive, transitivity.jmdict);
      if (byObject) return { kun: byObject, transitivitySelected: true };
    }
    return { kun: dotted[0] ?? kun[0], transitivitySelected: false };
  }
  // For a nominal, a dotted kun is not a worse answer but a wrong one: it
  // is an inflecting word, and a noun cannot be read as one. Where the
  // entry offers no bare kun at all, this returns undefined so the caller
  // can fall back to the on'yomi — 利 has only き.く ("to be effective"),
  // and as a noun it is り, not 利く.
  if (pos === "NOUN" || pos === "PRON") return { kun: kun.find((k) => kunWordClass(k) === "nominal"), transitivitySelected: false };
  return { kun: kun[0], transitivitySelected: false };
}

/** Every reading of `char` that is compatible with `pos`, best first — what
 * the furigana's own right-click menu offers as alternatives.
 *
 * "Compatible" is the same dot-as-POS-signal rule `pickKun` documents, read
 * as a filter rather than a preference: a dotted kun'yomi is an inflecting
 * word, so it cannot be the reading of a token tagged NOUN/PRON/PROPN, and
 * an undotted one is a bare noun, so it cannot be the reading of a
 * VERB/ADJ. On'yomi are offered throughout — they are uninflected stems,
 * and a verb read on'yomi (with す supplied) is ordinary in kundoku, so
 * excluding them would rule out real readings rather than wrong ones.
 *
 * The broader tags (PART, ADV, and the rest) get everything, deliberately:
 * `pickKun` declines to guess a preference for that mixed bucket, and a
 * menu that hid candidates on a guess this module has already judged
 * unsafe would be worse than one that shows them all.
 *
 * `historicalKana` puts each candidate into 歴史的仮名遣い, exactly as
 * `readingResolver.ts` does for the reading it settles on — the annotation
 * on the page is historical, so a menu listing modern spellings would be
 * offering readings in a different orthography from the one it is
 * replacing, and would never recognise the reading already displayed as
 * one of its own entries. Substituted before the de-duplication below, so
 * two modern readings that share a historical spelling collapse into one
 * entry rather than appearing twice identically.
 *
 * `jmdict` is what lets an adjective be offered in its classical 終止形 —
 * 易し, not 易い — and it is the dictionary rather than a flag because the
 * question is asked of each candidate separately; see `classicalAdjectiveKun`
 * for what is converted and what is left. Omit it, as the tests' direct
 * calls do, and every reading comes back in the modern shape KANJIDIC2 wrote
 * it in. */
export function candidateReadings(
  index: KanjidicIndex,
  char: string,
  pos?: string,
  historicalKana?: HistoricalKanaIndex,
  jmdict?: JmdictIndex | null,
): ReadingCandidate[] {
  // **An absent KANJIDIC2 entry stands in as an empty one rather than ending
  // the lookup**, because the dictionary is no longer the only source here.
  // 尔, 复 and 敎 are variant spellings the shipped index does not carry and
  // `overrides.json` does (なんぢ, また, しむ), and the resolver returns those
  // readings without consulting the dictionary at all — so returning nothing
  // gave the one reading such a character has no menu at all to appear in
  // (`openReadingMenuFor` opens none for an empty list). A character no table
  // speaks for still comes back empty, from the arms below rather than from
  // here.
  const entry: KanjidicEntry = index[char] ?? { on: [], kun: [], meanings: [] };

  // Keyed by kanji spelling *and* modern reading — see HistoricalKanaIndex.
  // Falling back to the full-size fold for the same reason `historicalKun`
  // does: an on'yomi the derivation abstained on still must not reach the page
  // with a modern small kana. The fold's own before-う guard is what makes this
  // safe on a series that is long vowels almost throughout — しゅく becomes
  // しゆく, while きょう and じゅう are left exactly as they were, because which
  // of けう/きやう/きよう a fused long vowel had is a lexical fact and not a
  // matter of glyph size.
  // No `historicalByReading` here: transferring a *reading's* spelling between
  // characters is sound within a series and not across one. 灰/蠅/入/這 all
  // attest はい -> はひ, every one a native word, and carrying that onto 沛 —
  // whose ハイ is an on'yomi, historically はい — printed はひ. On'yomi have
  // their own derivation from the 廣韻's rime data, which abstains where it
  // cannot answer; that abstention must not be filled in from the kun series.
  const historicalOn = (reading: string) =>
    historicalKana ? historicalSpelling(historicalKana, char, reading) : reading;

  const inflecting = pos === "VERB" || pos === "ADJ";
  const nominal = pos === "NOUN" || pos === "PRON" || pos === "PROPN";
  const all = kunReadings(entry, char);
  // The same dot-as-word-class rule `pickKun` applies, through the same
  // function — see `kunWordClass`.
  const kun = inflecting
    ? all.filter((k) => kunWordClass(k) !== "nominal")
    : nominal
      ? all.filter((k) => kunWordClass(k) === "nominal")
      : all;

  const gloss = entry.meanings[0];
  // The prefix/suffix hyphen (see `stripAffixHyphen`) is dropped here, and
  // the de-duplication below folds anything that collides with the bare
  // form already listed.
  const fromKun: ReadingCandidate[] = kun.map((k) => {
    const split = splitOkurigana(stripAffixHyphen(k));
    // Same transferred boundary the resolver takes — see `lookupKanji`.
    const moved = split.okurigana === undefined ? historicalSplitByReading(historicalKana, overrides, split.reading) : undefined;
    if (moved?.okurigana) return { reading: moved.reading, okurigana: moved.okurigana, gloss, kind: "kun" as const };
    const { reading } = split;
    // Only the reading is substituted, never the okurigana — the same
    // split `readingResolver.ts` makes, since the index is keyed by the
    // reading alone and the ending is inflected separately. The orthographic
    // fold is a different operation and does reach the ending; see
    // `lookupKanji`, which says why and lists the eight KANJIDIC entries that
    // need it.
    const okurigana = split.okurigana === undefined ? undefined : fullSizeKana(split.okurigana);
    // Then the verb lexicon, for the readings that index has nothing to say
    // about. `historicalKun` above is keyed by kanji + reading and falls back
    // to a transfer from another character attesting the same reading; where
    // both come up empty a modern spelling survives, and the menu then offers
    // a reading in an orthography this app never prints — the same objection
    // 買フ below answers for an ending. 貯 is the case: nothing attests たくわ
    // anywhere, and `VERB_LEXICON` holds the word as たくは all along.
    //
    // Asked of the *folded* reading rather than the raw one, which costs
    // nothing and states the order: a reading the index already corrected
    // matches its own sense on the first comparison
    // (`attestedSenseByModernSpelling` accepts either spelling), so this can
    // only fill a gap and never overturn an attestation.
    //
    // Here as well as in `chosenReading.ts` because these are two halves of
    // one thing. That module converts a choice on the way *out*, which is what
    // fixes a たくわ already stored in a saved text or a `.conllu` file; this
    // one stops the menu offering the modern spelling in the first place, so
    // the item the reader clicks is the reading that appears — and so the menu
    // can still mark it, which it does by comparing against the annotation on
    // screen (see `openReadingMenu`).
    const folded = {
      reading: attestedHistoricalReading(char, historicalKun(historicalKana, char, reading, entry), okurigana),
      okurigana,
    };
    // The one verb whose ending the fold cannot reach: the index above is
    // keyed by the *reading* alone, and もちいる's ゐ is inside the okurigana,
    // which nothing here substitutes. Offered as もちヰル rather than the
    // modern もちイル, and with the paradigm no ending of its own states —
    // neither いる nor ゐる is a row `classicalConjClass` derives ワ行上一段
    // from, and a picked 用 with no class stood at its citation form wherever
    // it fell (用いるず, これを用いるもの). The same treatment, and the same
    // reason, as the adjectives below. See `LEXICAL_KUN`.
    const lexical = lexicalKun(folded.reading, okurigana);
    if (lexical) return { ...folded, okurigana: lexical.okurigana, conjClass: lexical.conjClass, gloss, kind: "kun" as const };
    // A ハ行四段 verb is offered on its own 終止形 — 買フ, not 買ウ — because the
    // annotation this menu replaces is written in 歴史的仮名遣い, and a menu
    // listing 買う beside a page reading 買ふ is offering a reading in an
    // orthography the app never prints. `hagyouShuushi` is that conversion.
    //
    // **It used to be the *only* verb ending converted here, and that bound has
    // gone.** Its own doc gave the reason: the class was read back off whatever
    // the reader picked (`chosenConjClass`), and う -> ふ was the one conversion
    // that left that class legible, so 起's き.る could not be touched. What
    // lifts the bound is `classicalVerbKun` below carrying the class *with* the
    // converted ending — the arrangement the adjectives have had all along —
    // so a conversion may now be as lossy as it needs to be. The menu offers
    // 起ク and 出ヅ and 覺ユ, and the app never prints a 下一段 ending it is
    // offering the reader a choice of.
    //
    // Both are applied to what the adjective gate returns, not to `folded` —
    // the two never both fire (an adjective's converted ending is し, which
    // `splitKunWordClass` does not call a verb) and asking them of the result
    // is what keeps this from putting a verb's い back over an adjective's し.
    // `hagyouShuushi` stays in front of the verb conversion rather than being
    // folded into it: it is an *orthographic* rule about a kana, right for
    // every う-final ending whether or not any table names the word's paradigm,
    // where the conversion below is a grammatical claim that abstains wherever
    // the paradigm is not established.
    const adjectival = classicalAdjectiveKun(jmdict, char, split, folded);
    const hagyou = { ...adjectival, okurigana: hagyouShuushi(adjectival.okurigana) };
    const classical = adjectival.conjClass ? hagyou : classicalVerbKun(jmdict, char, split, hagyou);
    return { ...classical, gloss, kind: "kun" };
  });
  const fromOn: ReadingCandidate[] = entry.on.map((o) => ({ reading: historicalOn(toHiragana(o)), gloss, kind: "on" }));
  // A nominal is also offered every *nominalisation* of the character's own
  // inflecting words — 出's いづる, 長's ながさ/ながみ/ながき/ながし. The filter
  // above is what makes this an addition rather than a loosening: an inflecting
  // kun is still not offered to a noun in its finite shape (出る, 長い), because
  // a noun cannot be read as a finite predicate; what a noun *can* be read as
  // is that predicate nominalised, which is a different string and a different
  // claim. See `nominalizedCandidates`, and `lookupKanji`'s `nominalization`
  // argument for where the resolver may take one of these as the reading.
  //
  // Offered for every nominal POS rather than only where the tree says the
  // token is a predicate, because this is a menu: the resolver's own gate is
  // the treebank's xpos, which the menu is not given (its one caller has the
  // token's UPOS and nothing else), and hiding a real reading of a character
  // behind a tag the reader may be about to correct is the wrong way for a
  // menu to fail.
  const fromNominalization: ReadingCandidate[] = nominal ? nominalizedCandidates(index, char, historicalKana, jmdict) : [];
  // Everything the app can read this character as that KANJIDIC2 does not
  // list — the curated override table, the classical verb lexicon, the
  // sentence-final particles. See `curatedCandidates`, which is the whole of
  // why this menu can now name the reading that is on the page.
  const fromCurated: ReadingCandidate[] = curatedCandidates(
    index,
    char,
    pos,
    historicalKana,
    new Set([...fromOn, ...fromKun].map((c) => c.reading)),
  );
  // On'yomi first, throughout — the order a kanji dictionary lists a
  // character's readings in, and so the order the menu presents them in.
  // Purely presentational: which entry the menu marks as current is decided
  // by comparing against the reading actually on screen, not by position.
  const ordered: ReadingCandidate[] = [...fromOn, ...fromKun, ...fromCurated, ...fromNominalization];

  // Asked once for the character rather than once per candidate: the division
  // is a property of the word `KANJI_RETAINED_ADVERBS` names, not of whichever
  // reading the menu is listing at the moment.
  const retainedOkurigana = retainedAdverbOkurigana(index, char, historicalKana);
  const seen = new Set<string>();
  return ordered
    // A word this app writes with its ending beside the character is offered
    // in *both* divisions — これ and こレ — because both reach the page, and
    // the menu names the reading it is looking at by comparing against the
    // `<rt>`. Whichever division this occurrence took, one of the two equals
    // it, and only one: an occurrence written これヲ has こ in neither slot,
    // and one written こレ has これ in neither. See `READING_ENDING_SPLITS`
    // for what is divided and `readingEndingSplit` in `readingResolver.ts`
    // for what decides which division a token takes.
    //
    // The split form follows its whole form rather than replacing it, and
    // carries no `conjClass`: れ and り are not paradigms, they are the tail of
    // a pronoun and of a postposition.
    //
    // `KANJI_RETAINED_ADVERBS` is the second table that divides a reading this
    // way, and it is asked here for the same reason and answered the same way.
    // The two are different statements and neither subsumes the other — that
    // one is per *character* and says the kanji survives into the prose with
    // its ending written after it (豈 is あ+ニ and 固 もと+ヨリ, and
    // `KundokuView.ts` draws exactly that split), while
    // `READING_ENDING_SPLITS` is per *word* and holds however the word is
    // spelled — so the menu consults both and takes whichever speaks.
    //
    // The okurigana itself is KANJIDIC2's own dot, read back out of the index
    // by `retainedAdverbOkurigana` — this is the one caller with an index in
    // hand and no `ResolvedReading` to take the answer off, so it asks
    // directly. Per character, so every candidate is offered the same division
    // and `retainedAdverbParts` refuses the ones that do not end in it: 豈's
    // menu gains あ+ニ beside あに and its on'yomi ガイ is left alone.
    //
    // Only where the answer is a non-empty okurigana. 亦, 皆, 尚, 猶 and 益 are
    // in the table to say that the character is kept with *nothing* beside it,
    // so their "division" is the whole reading the list already carries, and
    // offering it a second time would put また on the menu twice.
    .flatMap((candidate) => {
      if (candidate.okurigana !== undefined) return [candidate];
      const retained = retainedAdverbParts(candidate.reading, retainedOkurigana);
      const split = readingEndingSplitFor(candidate.reading, pos) ?? (retained?.okurigana ? retained : undefined);
      return split ? [candidate, { ...candidate, ...split }] : [candidate];
    })
    // **The paradigm is part of what makes a candidate distinct**, and it had to
    // be added to this key the moment `classicalVerbKun` started converting
    // verb endings. Two of a character's modern kun'yomi routinely descend from
    // two classical words that share a 終止形: 立's た.つ and た.てる are 四段タ行
    // and 下二段タ行, both 立つ, and 破's やぶ.る and やぶ.れる are 四段ラ行 and
    // 下二段ラ行, both 破る. Before the conversion the two were different strings
    // and the reader could pick between them; converted and keyed on the string
    // alone, the second collapsed into the first and the 下二段 became
    // unreachable from the menu altogether — which is exactly the distinction
    // `CONJ_CLASS_KEY` in `chosenReading.ts` calls "the whole difference between
    // 廟を立てて and 廟立ちて". Keying on the class as well keeps both.
    //
    // It de-duplicates strictly less than it did, so nothing that used to be
    // hidden is now hidden: a candidate with no class keeps the old key exactly.
    // What it *does* leave is two entries spelled alike — the menu shows 立ツ
    // twice, distinguished only by a paradigm the list does not print. That is
    // a display question and not this function's to answer; the list's business
    // is not to lose a reading the reader can pick.
    .filter((r) => {
      const key = `${r.reading}|${r.okurigana ?? ""}|${r.conjClass ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Looks up a single character, preferring kun'yomi for ordinary content
 * words and on'yomi for proper nouns / technical-register nouns, per the
 * plan's reading-resolution order (kanjidic is step 2, after the curated
 * override table).
 *
 * A mistagged PROPN (輮/藍 both get PROPN in only *some* of their real-parse
 * occurrences, giving on'yomi there and kun'yomi elsewhere for the same
 * word) is a parser problem, not a reading-resolution one — fixing it here
 * by second-guessing the POS tag would just move the bug, not remove it,
 * and would incorrectly override a genuine proper noun that happens to have
 * an unrelated kun'yomi. The real fix belongs in the tagger itself.
 * `transitivity` — the syntactic fact that the token does or does not have
 * a `comp:obj` child, plus the JMdict index to check it against — is the
 * one piece of context this otherwise purely per-character lookup takes,
 * because it is the one thing a character's own entry cannot supply: see
 * `pickByTransitivity`. Omit it (every caller with no sentence in hand —
 * the compound-span path, the tests' direct lookups) and the ranking is
 * exactly what it was.
 *
 * `historicalKana` puts the chosen reading into 歴史的仮名遣い, exactly as
 * `candidateReadings` does for the whole list it offers — the two have to
 * agree, since the menu's job is to name the reading that is on the page and
 * offer the alternatives to it, and a menu written in a different orthography
 * from the annotation would never recognise its own current entry. Done here
 * rather than by the caller so that the substitution is keyed by kanjidic's
 * own *modern* reading unconditionally: `readingResolver.ts` used to do it
 * itself and had to document that it must run before its own adjective
 * stem-trimming or the trimmed stem would be looked up under a key the index
 * never used. Omit it — as the compound path does, comparing against
 * JMdict's modern spellings — and the reading comes back in kanjidic's own
 * modern kana.
 *
 * `nominalization` is passed only where the caller has already decided that
 * this token is a **predicate standing in a nominal slot** — a NOUN or PRON
 * whose xpos says 動詞 (see `isVerbalNominal` in readingResolver.ts, which is
 * the one caller and which holds the token this lookup does not). Given it,
 * the character's own nominalisations (`nominalizedCandidates`) are preferred
 * to its bare kun'yomi, which is exactly what that tag denies: 長's おさ
 * ("chief") is a noun sense of the character, and 長三寸許's 長 is not that
 * noun but the adjective ながし standing where a noun would, so it is ながさ.
 * Only the *reading* moves; the caller is handed a plain reading and okurigana
 * with no class attached, because a nominalisation is a finished form. Where
 * the character has no nominalisation to offer — no inflecting kun and no
 * lexicon sense, as with the kun-less 累 and 療 — this falls straight through
 * to the ordinary ranking and nothing changes.
 *
 * Returns null if the character isn't in the index. */
export function lookupKanji(
  index: KanjidicIndex,
  char: string,
  pos?: string,
  transitivity?: { wantTransitive: boolean; jmdict: JmdictIndex },
  historicalKana?: HistoricalKanaIndex,
  nominalization?: { jmdict: JmdictIndex | null },
): KanjidicReading | null {
  const entry = index[char];
  if (!entry) return null;

  if (nominalization) {
    const [best] = nominalizedCandidates(index, char, historicalKana, nominalization.jmdict);
    if (best) return { reading: best.reading, okurigana: best.okurigana, gloss: best.gloss, series: "kun" };
  }

  const allKun = kunReadings(entry, char);
  // **A character KANJIDIC2 gives no kun'yomi for is read on'yomi** — 封, 謁,
  // 療. Settled by the reader, in those words, as a rule of its own and not
  // as a consequence of anything else here: it had been standing on the
  // inference that `allKun.length === 0` leaves nothing else to return, which
  // is true of the code and was never a statement about kundoku. It is one
  // now. The rule holds whatever the token is — a kun-less NOUN takes the
  // on'yomi too (累 るゐ, 僧 そう, 寸 すん) and, being a nominal, takes no
  // ending with it; only a VERB adds the サ変 す, which is `readingResolver.ts`'s
  // business rather than this lookup's.
  const eligible = pos !== "PROPN" && allKun.length > 0;
  // What makes a reading "transitivity-selected" is that the object check
  // answered the question, which `pickKun` reports directly — not that the
  // answer differs from the default, which is a different fact and the wrong
  // one to key on (see `pickKun`).
  const picked = eligible
    ? pickKun(allKun, pos, transitivity ? { char, ...transitivity } : undefined)
    : { kun: undefined, transitivitySelected: false };
  const kunChoice = picked.kun;
  // A nominal with no bare kun falls through to the on'yomi rather than
  // being read as the verb it isn't — see `pickKun`.
  const useKun = kunChoice !== undefined;
  const primary = useKun ? kunChoice : entry.on[0] ?? allKun[0];
  if (primary === undefined) return null;

  const gloss = entry.meanings[0];
  if (!useKun) {
    // on'yomi readings have no okurigana-dot notation, but do need
    // converting from KANJIDIC2's own katakana to this app's hiragana
    // furigana convention.
    const on = toHiragana(primary);
    // Same fold, same reason, as `historicalOn` in `candidateReadings` below.
    // Same: the index for this character, then the fold — never a transfer
    // from another character's kun reading. See `historicalOn` below.
    return { reading: historicalKana ? historicalSpelling(historicalKana, char, on) : on, gloss, series: "on" };
  }
  const split = splitOkurigana(stripAffixHyphen(primary));
  // A reading KANJIDIC writes undivided can still have a known boundary, from
  // the same attestation that supplies its spelling — 輒's すなわち is 乃's
  // すなは + ち, and both halves of that come from the same place. Only where
  // KANJIDIC offers no dot of its own; where it does, its own boundary wins and
  // only the spelling is substituted.
  const transferred = split.okurigana === undefined ? historicalSplitByReading(historicalKana, overrides, split.reading) : undefined;
  const reading = transferred?.okurigana ? transferred.reading : historicalKun(historicalKana, char, split.reading, entry);
  // Only the reading is *substituted*, never the okurigana — the same split
  // `candidateReadings` makes, since the index is keyed by the reading alone
  // and the ending is a matter for the conjugation paradigm (see
  // `classicalVerbEnding` and `conjugatedOkurigana`), not for a kana
  // respelling.
  //
  // The **fold** is not that, and does apply to an ending. Substitution is a
  // claim about which word this is and the index cannot make one about a half
  // it is not keyed by; the fold only says how this app writes a syllable it
  // has already got, and an ending is written in the same orthography as
  // everything beside it. KANJIDIC divides eight kun'yomi with a 促音 on the
  // far side of the dot — 仍 よ.って, 曾 か.って, 却/卻 かえ.って, 押 お.っ-,
  // 仰 お.っしゃる, 些 ち.っと, 婀 あだ.っぽい — and three of those are
  // characters this app actually reads, so よつて and かつて were reaching the
  // page with a small っ beside a reading that had been folded.
  // Folded where there is one, and an *absent* ending stays absent: 種 has a
  // sense whose okurigana is the empty string, which is not the same claim as
  // having none, so the two must not be collapsed.
  const rawOkurigana = transferred?.okurigana ?? split.okurigana;
  const okurigana = rawOkurigana === undefined ? undefined : fullSizeKana(rawOkurigana);
  return {
    reading,
    okurigana,
    gloss,
    series: "kun",
    ...(picked.transitivitySelected ? { transitivitySelected: true } : {}),
  };
}

/** A character's on'yomi, in this app's hiragana convention — the raw list,
 * for the callers that need to *recognise* an on'yomi rather than choose
 * one. `readingResolver.ts`'s on'yomi-compound rule uses it to accept a
 * dictionary reading of a two-character pair only when every piece of the
 * split is one of these, which is what tells 大破 (たい+は, both on'yomi,
 * so genuinely read as one Sino-Japanese word) from 大喜 (おお+よろこび,
 * kun throughout, so 大いに喜ぶ — two words, not one). */
export function onyomiOf(index: KanjidicIndex, char: string): string[] {
  return (index[char]?.on ?? []).map(toHiragana);
}
