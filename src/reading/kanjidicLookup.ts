import { loadJsonIndex } from "./jsonIndex.ts";
import { fullSizeKana, historicalByReading, historicalSplitByReading, type HistoricalKanaIndex } from "./historicalKana.ts";
import { isAdjectiveLemma, type JmdictIndex, lemmaTransitivity } from "./jmdictLookup.ts";
import {
  classicalAdjectiveConjClass,
  classicalAdjectiveReading,
  classicalConjClass,
  kunWordClass,
  lexicalKun,
  splitKunWordClass,
} from "./classicalEnding.ts";
import { conjugate, type ConjClass } from "../kakikudashi/classicalConjugation.ts";
// `verbLexicon.ts` is a leaf (its own imports are `classicalConjugation.ts` and
// a JSON index), so this edge closes no cycle — the same reason
// `classicalEnding.ts` reaches it directly rather than through
// `conjugationContext.ts`. What it is here for is `nominalizedCandidates`,
// which needs the *sense-disambiguated* classical word for a character and not
// a second guess at it from KANJIDIC2's reading list.
import { VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
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
  return historicalKana[char]?.[reading] ?? historicalByReading(historicalKana, overrides, reading) ?? fullSizeKana(reading);
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
 * because that is where this app puts it for every retained adverb of this
 * shape: `generator.ts`'s `KANJI_RETAINED_ADVERBS` writes 甚 はなは+だ,
 * 必 かなら+ず, 更 さら+に — kanji for all but the final kana, okurigana for
 * the last — and 但ダ is that convention applied to ただ.
 *
 * **This one joins ただし rather than replacing it, and cannot displace it
 * from here.** 但 has its own `overrides.json` entry reading ただし and its
 * own `KANJI_RETAINED_ADVERBS` line giving it し, and both are consulted
 * ahead of any kanjidic lookup — so the default stays 但シ and this entry
 * reaches the reader through the furigana menu, which is what "one of its
 * kun readings" asks for. Making 但ダ the default is a change to those two
 * tables, not to this one.
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
 * 哇: は.く ("to vomit" — 哇有物出, "he retched, and something came out").
 * KANJIDIC2 lists 哇 as かい / けい, two bare nouns glossed "fawning child's
 * voice", so a 哇 tagged VERB had no inflecting reading at all and read かひ.
 * The character is 吐く in this text. Dotted, and the dot is doing real work:
 * it is what makes the reading eligible for a VERB and what lets
 * `classicalConjClass` read 四段カ行 off the く unaided — so unlike 需 and 縶
 * this one needs no `RESIDUAL` line to carry a paradigm. */
const SUPPLEMENTARY_KUN: Record<string, string[]> = {
  種: ["う."],
  需: ["もら.ふ"],
  首: ["かうべ"],
  縶: ["しば.る"],
  但: ["た.だ"],
  許: ["ばかり"],
  暴: ["にはか"],
  哇: ["は.く"],
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
 * Silence is "leave it alone", never "probably an adjective" — 771 dotted
 * い-final readings are absent from JMdict altogether, most of them rare
 * kyūjitai for real adjectives (峨's けわ.しい) but a real minority of them
 * nominals (圍's かこ.い "enclosure", 這's は.い), and there is nothing in
 * KANJIDIC2 to tell those apart. The 227 readings this converts are the ones
 * a dictionary vouches for.
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
  if (!isAdjectiveLemma(jmdict, char + (okurigana ?? "い"), reading + (okurigana ?? ""))) return candidate;
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
  if (lex?.conjClass && lex.reading) add(lex.reading, lex.conjClass, lex.okuriganaPrefix ?? "");

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
    if (transitivity && dotted.length > 1) {
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
  const entry = index[char];
  if (!entry) return [];

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
    historicalKana ? historicalKana[char]?.[reading] ?? fullSizeKana(reading) : reading;

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
    const { reading, okurigana } = split;
    // Only the reading is substituted, never the okurigana — the same
    // split `readingResolver.ts` makes, since the index is keyed by the
    // reading alone and the ending is inflected separately.
    const folded = { reading: historicalKun(historicalKana, char, reading, entry), okurigana };
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
    // An adjective is offered in classical shape, on the dictionary's word
    // and after the fold — see `classicalAdjectiveKun`.
    return { ...classicalAdjectiveKun(jmdict, char, split, folded), gloss, kind: "kun" };
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
  // On'yomi first, throughout — the order a kanji dictionary lists a
  // character's readings in, and so the order the menu presents them in.
  // Purely presentational: which entry the menu marks as current is decided
  // by comparing against the reading actually on screen, not by position.
  const ordered: ReadingCandidate[] = [...fromOn, ...fromKun, ...fromNominalization];

  const seen = new Set<string>();
  return ordered.filter((r) => {
    const key = `${r.reading}|${r.okurigana ?? ""}`;
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
    return { reading: historicalKana ? historicalKana[char]?.[on] ?? fullSizeKana(on) : on, gloss, series: "on" };
  }
  const split = splitOkurigana(stripAffixHyphen(primary));
  // A reading KANJIDIC writes undivided can still have a known boundary, from
  // the same attestation that supplies its spelling — 輒's すなわち is 乃's
  // すなは + ち, and both halves of that come from the same place. Only where
  // KANJIDIC offers no dot of its own; where it does, its own boundary wins and
  // only the spelling is substituted.
  const transferred = split.okurigana === undefined ? historicalSplitByReading(historicalKana, overrides, split.reading) : undefined;
  const reading = transferred?.okurigana ? transferred.reading : historicalKun(historicalKana, char, split.reading, entry);
  const okurigana = transferred?.okurigana ?? split.okurigana;
  // Only the reading is substituted, never the okurigana — the same split
  // `candidateReadings` makes, since the index is keyed by the reading alone
  // and the ending is a matter for the conjugation paradigm (see
  // `classicalVerbEnding` and `conjugatedOkurigana`), not for a kana
  // respelling.
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
