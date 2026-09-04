import { loadJsonIndex } from "./jsonIndex.ts";
import shinjitaiData from "./shinjitai-index.json";
import { isRereadUse } from "../kakikudashi/rereadCharacters.ts";
import { parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import { isDistributivePostpose } from "../kundoku/depClassification.ts";
import { chosenReadingText } from "../reading/chosenReading.ts";
import { type ConjClass, isConjClass } from "../kakikudashi/classicalConjugation.ts";
import { modernisedCitation, modernOkurigana } from "../kakikudashi/verbLexicon.ts";
// Consumed from inside a function body only, like the `depClassification.ts`
// import above it, so the module cycle this closes resolves the way the
// existing ones between these pure-function modules do.
import type { Sentence, Token } from "../parse/types.ts";

export interface JmdictEntry {
  reading: string;
  gloss: string[];
  pos: string[];
  common: boolean;
}
export type JmdictIndex = Record<string, JmdictEntry>;

let cached: Promise<JmdictIndex> | null = null;

export function loadJmdictIndex(url = "/data/jmdict-index.json"): Promise<JmdictIndex> {
  if (!cached) cached = loadJsonIndex<JmdictIndex>(url);
  return cached;
}

export interface JmdictLookupResult {
  reading: string;
  gloss?: string;
}

/** `spelling` with every 旧字体 character replaced by its 新字体 — 獨酌 to
 * 独酌, 大亂 to 大乱 — or the spelling unchanged when it has none.
 *
 * Kanbun is written in 旧字体 and JMdict is keyed on modern spellings, so
 * without this the two never meet: every lookup here was quietly failing on
 * the orthography rather than on the word. 獨酌 is absent from JMdict and
 * 独酌 is in it (どくしゃく); so are 大乱, 独立 and hundreds more. The gap was
 * invisible because a miss and a genuine "not a word" are the same `null`.
 *
 * The map is `scripts/build-verb-lexicon.mjs`'s own, read off Wiktionary's
 * `pos: "character"` entries — the same derivation that already gives 學 the
 * conjugation it builds for 学 — rather than a hand-kept variant list. 500
 * characters, so it is imported directly rather than fetched: `lookupLemma`
 * is synchronous at every one of its call sites, and threading another
 * async-loaded index through all of them to carry 6KB would be the wrong
 * trade (the same call `verbLexicon.ts` makes about its own index).
 *
 * One-way and lossy on purpose. Several kyūjitai can share a shinjitai
 * (藝/芸), so this direction is many-to-one and safe, while the reverse is
 * not, and nothing here ever runs it backwards. */
export function shinjitaiSpelling(spelling: string): string {
  let normalised = "";
  let changed = false;
  for (const char of spelling) {
    const modern = SHINJITAI_OF[char];
    if (modern) changed = true;
    normalised += modern ?? char;
  }
  return changed ? normalised : spelling;
}

const SHINJITAI_OF = shinjitaiData as Record<string, string>;

/** Looks up a multi-character (or single-character) lemma. Returns null if
 * the lemma isn't in the index.
 *
 * Deliberately *not* 新字体-normalising: see `lookupModernisedLemma`, and the
 * measurement recorded there for why the normalisation is scoped to one
 * caller rather than applied to every lookup here. */
export function lookupLemma(index: JmdictIndex, lemma: string): JmdictLookupResult | null {
  const entry = index[lemma];
  if (!entry) return null;
  return { reading: entry.reading, gloss: entry.gloss[0] };
}

/** `lookupLemma`, retrying under the modern spelling when the spelling as
 * written misses — 獨酌 answered by 独酌's own entry (どくしゃく).
 *
 * The spelling as written is tried first, so a headword JMdict genuinely
 * lists under its old spelling still answers for itself; normalising up
 * front would throw that away for no gain.
 *
 * Scoped to `onyomiCompound` in readingResolver.ts, and it took a
 * measurement to decide that. Applying it inside `lookupLemma` and
 * `lemmaTransitivity` instead — so that every caller benefited — was tried
 * and reverted: enumerated over every kanji KANJIDIC2 holds, it moved 139
 * transitivity answers and 135 per-token resolutions, and made 182 single
 * kyūjitai characters resolve in JMdict where they had not. Much of that is
 * the transitivity machinery finally working for characters it could never
 * answer for (亂 with an object becomes みだす, 傳 つたえる, 殘 のこす, 變
 * かえる — all right). But it is not uniformly right, and the wrong ones are
 * not near-misses: 發 with an object became あばく ("to expose") where kanbun
 * wants はっす/たつ, 墮 became くずす where it means "to fall", 讚 moved from
 * たたえる to ほむ, 將 — normally a 再読文字 — became ひきいる, and 榮 acquired
 * the mahjong term ロン as a single-character reading available to the
 * compound-span path. 66,077 JMdict headwords become reachable in total once
 * every kyūjitai spelling is enumerated, which is far more surface than the
 * three words this change is for.
 *
 * The pair rule is where the normalisation is *needed* and where it is also
 * safe, because two independent checks stand behind it: the split reading
 * has to divide cleanly across the characters, and every piece has to be one
 * of its own character's attested on'yomi. A wrong dictionary hit does not
 * survive both. Widening it further is a decision about hundreds of
 * individual words and wants a person, not a lookup. */
export function lookupModernisedLemma(index: JmdictIndex, lemma: string): JmdictLookupResult | null {
  return lookupLemma(index, lemma) ?? lookupLemma(index, shinjitaiSpelling(lemma));
}

/** JMdict's own label for an い-adjective (the `adj-i` entity, expanded by
 * the distribution the same way `vt`/`vi` are above). */
const ADJECTIVE_POS = "adjective (keiyoushi)";

/** Whether JMdict says `headword` — a kanji spelling with its modern
 * okurigana, 易い / 扱い — is an い-adjective read `reading`.
 *
 * This is the evidence `kanjidicLookup.ts` needs to tell a character's
 * *adjective* kun'yomi from a 連用形 nominal that KANJIDIC2 writes with the
 * same final い, which is the one distinction the reading's own shape cannot
 * make: 易's やす.い and 扱's あつか.い are the same string shape, and only the
 * dictionary knows that 易い is an adjective while 扱い is a noun ("handling").
 * Nothing else separates them — the dot is KANJIDIC2's inflecting-word marker
 * and both carry it, and both characters list a partner reading besides.
 *
 * Answered as a single "yes", not as a three-way listed/not-listed/unknown
 * the way `lemmaTransitivity` is, because the caller wants *positive*
 * evidence and nothing else will do: an い ending is not by itself a reason
 * to believe a reading is an adjective, so silence has to mean "leave the
 * reading alone" rather than "probably yes".
 *
 * 新字体-normalised on the retry, and the caution `lookupModernisedLemma`
 * records about doing that does not carry over, because a second independent
 * check stands behind this one exactly as it does behind the pair rule: the
 * reading JMdict holds for the entry has to be the very reading KANJIDIC2
 * gives the character. A wrong modern entry does not survive both. Measured
 * over the whole shipped index, the retry is what reaches 20 readings —
 * 嚴しい by 厳しい, 淺い by 浅い, 輕い by 軽い, 險しい by 険しい, 齊しい by
 * 斉しい — every one of them a kyūjitai spelling of the same adjective, with
 * no wrong hit among them. The reading is passed in KANJIDIC2's own modern
 * kana for that reason: it is what the dictionary is keyed by, so the check
 * has to run before any 歴史的仮名遣い substitution, not after. */
export function isAdjectiveLemma(index: JmdictIndex, headword: string, reading: string): boolean {
  const listed = (spelling: string): boolean => {
    const entry = index[spelling];
    return entry !== undefined && entry.pos.includes(ADJECTIVE_POS) && entry.reading === reading;
  };
  return listed(headword) || listed(shinjitaiSpelling(headword));
}

/** Every kana reading some い-adjective in the index is spelled with, built
 * once on first use. 1,963 readings, out of 3,669 `adj-i` entries.
 *
 * The index is keyed by *spelling* and holds one entry per spelling, which is
 * what makes this a different question from `isAdjectiveLemma`'s and not a
 * looser version of it. That function asks whether **this character with this
 * okurigana** is a listed adjective, and it is the right question for a
 * character JMdict has heard of. Kanbun is mostly written in characters it has
 * not: of the 1,134 い-final kun'yomi in KANJIDIC2 only 220 have a headword the
 * dictionary lists, and the 914 that do not are overwhelmingly rare or kyūjitai
 * spellings of adjectives it holds perfectly well under another character —
 * 癢's かゆ.い against 痒い, 幽's ふか.い against 深い, 趍's ひさ.しい against
 * 久しい, 侔's ひと.しい against 等しい. Asked by spelling, every one of those is
 * silence; asked by reading, every one of them is answered.
 *
 * **The reading is doing real work and is not a rubber stamp**, which is the
 * whole reason this is worth having: the population it has to separate out is
 * the 連用形 nominals KANJIDIC2 writes with the same final い, and their
 * readings are *not* adjective readings. 扱い あつかい, 囲い かこい, 使い つかい,
 * 習い ならい, 匂い におい, 狙い ねらい, 勢い いきおい, 災い わざわい, 幸い
 * さいわい, 商い あきない, 賄い まいない, 類い たぐい, 値 あたい, 互い たがい —
 * 170 of the 1,134 are refused, and reading them off this list is how one
 * checks the rule rather than the code. What it lets through that a person
 * might not: 巾's おお.い is admitted because 多い is おおい, not because 巾い is
 * a word — and a 巾 already reading おおい is not made worse by being written
 * おほし.
 *
 * Failing closed is still the rule and this does not change it: a reading no
 * adjective in the dictionary shares is left exactly as KANJIDIC2 wrote it.
 * The misses are the ones the index's one-entry-per-spelling shape causes —
 * 辛い is held under からい alone, so 辛's つら.い is not found — and a miss
 * costs the modern ending, which is what it cost before.
 *
 * Built lazily and cached on the index object itself rather than in a module
 * variable, so two indices (the app's and a test's) cannot answer for each
 * other, and so a caller that never asks never pays the 228,774-entry pass. */
const ADJECTIVE_READINGS = new WeakMap<JmdictIndex, Set<string>>();

export function isAdjectiveReading(index: JmdictIndex, reading: string): boolean {
  let readings = ADJECTIVE_READINGS.get(index);
  if (!readings) {
    readings = new Set<string>();
    for (const entry of Object.values(index)) {
      if (entry.pos.includes(ADJECTIVE_POS)) readings.add(entry.reading);
    }
    ADJECTIVE_READINGS.set(index, readings);
  }
  return readings.has(reading);
}

/** The classical paradigm JMdict's own part-of-speech label names, or
 * undefined for a label that names none.
 *
 * **JMdict distinguishes every classical paradigm this app has a table for,
 * and says so in the entry itself.** The distribution's expanded labels spell
 * out the grade and the 行 together — "Nidan verb (lower class) with 'hu/fu'
 * ending (archaic)" is 下二段ハ行 and nothing else — so a word the dictionary
 * holds under its *classical* headword arrives with its paradigm attached and
 * needs no derivation at all. That is what makes this a route to the answer
 * rather than a second guess at it: the ambiguity the whole of
 * `classicalEnding.ts` is organised around (a modern -eru could be ア行, ヤ行,
 * ワ行 or — through ハ行転呼 — ハ行 下二段, and the surface form cannot say
 * which) is a fact about the *modern* spelling, and these entries are not
 * written in it.
 *
 * Parsed rather than tabulated, because the label is compositional and the
 * table would be a transcription of the same grammar twice: the grade is
 * "upper"/"lower" and the row is the quoted romanised 終止形 ending. The one
 * label that does not fit that shape is ワ行下二段's, which JMdict writes as a
 * 'u' ending "and 'we' conjugation" — the ゑ that is the row's whole identity
 * — and it is picked off first for that reason. A bare "Nidan verb with 'u'
 * ending" with no grade is ア行下二段, the one-word family of 得.
 *
 * Everything unrecognised is undefined, which includes every *modern* class
 * label: an "Ichidan verb" is 一段 today and was 二段 or 一段 classically with
 * nothing in the label to say which, so JMdict's modern entries are silent on
 * exactly the question this answers and are not read here. */
const NIDAN_LABEL = /^Nidan verb(?: \((upper|lower) class\))? with '([^']+)' ending/;
const YODAN_LABEL = /^Yodan verb with '([^']+)' ending \(archaic\)$/;
const ROW_OF_ENDING: Record<string, string> = {
  u: "a", ku: "ka", gu: "ga", su: "sa", zu: "za", tsu: "ta", dzu: "da",
  nu: "na", "hu/fu": "ha", bu: "ba", mu: "ma", yu: "ya", ru: "ra",
};
function classicalParadigmOfPos(pos: string): ConjClass | undefined {
  if (pos === "Nidan verb (lower class) with 'u' ending and 'we' conjugation (archaic)") return "shimo-nidan-wa";
  const nidan = NIDAN_LABEL.exec(pos);
  if (nidan) {
    const row = ROW_OF_ENDING[nidan[2]];
    if (!row) return undefined;
    if (!nidan[1]) return row === "a" ? "shimo-nidan-a" : undefined;
    const name = `${nidan[1] === "upper" ? "kami" : "shimo"}-nidan-${row}`;
    return isConjClass(name) ? name : undefined;
  }
  const yodan = YODAN_LABEL.exec(pos);
  if (yodan) {
    const name = `yodan-${ROW_OF_ENDING[yodan[1]] ?? ""}`;
    return isConjClass(name) ? name : undefined;
  }
  if (pos === "'ku' adjective (archaic)") return "ku-keiyoushi";
  if (pos === "'shiku' adjective (archaic)") return "shiku-keiyoushi";
  if (pos === "irregular ru verb, plain form ends with -ri") return "ra-hen";
  if (pos === "su verb - precursor to the modern suru") return "sa-hen";
  return undefined;
}

/** Every classical paradigm JMdict attests for a word, keyed by the *modern*
 * reading that word's own dictionary form would have — built once per index
 * and cached against it.
 *
 * The key is what makes this usable at all. JMdict holds a classical word
 * under its classical reading (答ふ is こたう) and KANJIDIC2 holds the same
 * word under its modern one (答's こた.える); a caller has the second and needs
 * the first, and the conversion that joins them only runs one way — see
 * `modernisedCitation`, which does it. So the index is built in the direction
 * that is safe and read in the direction the caller has: こたう + 下二段ハ行
 * goes in as こたえる.
 *
 * A `Set` per key, because the collision is real and is the whole reason the
 * lookup below abstains rather than picking: 老ゆ (ヤ行上二段, おゆ) and 生ふ
 * (ハ行上二段, おう) both surface as おいる today, which is precisely the
 * three-way -iru ambiguity `LEXICAL_KUN` documents, arriving here from the
 * other side. The shipped index carries 289 entries with a classical paradigm
 * on them, under 192 distinct classical readings.
 *
 * `WeakMap` so a test that builds its own small index gets its own, and so
 * nothing is built for a caller that never asks. The one pass is over the
 * whole of JMdict, which is why it is done once rather than per lookup. */
const paradigmsByModernReading = new WeakMap<JmdictIndex, Map<string, Set<ConjClass>>>();
function classicalParadigmIndex(index: JmdictIndex): Map<string, Set<ConjClass>> {
  const existing = paradigmsByModernReading.get(index);
  if (existing) return existing;
  const built = new Map<string, Set<ConjClass>>();
  for (const entry of Object.values(index)) {
    for (const pos of entry.pos) {
      const conjClass = classicalParadigmOfPos(pos);
      if (!conjClass) continue;
      const modern = modernisedCitation(conjClass, entry.reading);
      if (modern === undefined) continue;
      const at = built.get(modern) ?? new Set<ConjClass>();
      at.add(conjClass);
      built.set(modern, at);
    }
  }
  paradigmsByModernReading.set(index, built);
  return built;
}

/** The classical paradigm JMdict attests for the word a KANJIDIC2 kun'yomi
 * names — `reading` and `okurigana` being that entry's own two halves, which
 * together are the modern dictionary headword's reading (答's こた + える).
 *
 * **This is what closes the gap where a modern ending states no paradigm.**
 * `classicalConjClass` reads the 行 off the ending wherever the ending states
 * it, and abstains — on purpose, and documented at length in
 * `classicalEnding.ts` — wherever it does not: the あ row above all, where a
 * bare え could be ア行, ヤ行, ワ行 or (by ハ行転呼) ハ行 下二段. A word in that
 * position had no classical form at all and reached the page in its modern
 * one, uninflecting: 不応 read 応えるず. This answers for it from the
 * dictionary the app already ships, where 答ふ is listed as 下二段ハ行 outright.
 *
 * Keyed by the *reading*, not by the character, and that is deliberate rather
 * than a shortcut. The classical word is one word however many characters
 * write it — こたふ is 答ふ, 対ふ, 應ふ and 堪ふ — and JMdict lists the
 * classical headword under whichever spellings it happens to hold, which for
 * this word is 答ふ alone. A spelling-keyed lookup would answer for 答 and not
 * for 応, which is the character that needs it. What keeps that from becoming
 * a licence to read any homophone's paradigm onto any character is that the
 * reading in hand is not a guess: KANJIDIC2 says こた is how this character is
 * read, and the question asked is only what paradigm a word read that way,
 * with that ending, inflects by.
 *
 * Undefined where the dictionary holds no such word, and where it holds more
 * than one paradigm for it — the おいる collision above. Silence leaves the
 * caller exactly where it was, which for an unstated paradigm means the
 * modern ending it already had.
 *
 * **The paradigm has to account for the whole okurigana and no more**, which
 * is the last check and not a formality: the index is keyed by the two halves
 * *joined*, so a match says the two sources spell the same word and not that
 * they divide it in the same place. 肥's こ.やす is the case. JMdict holds
 * 肥やす as 四段サ行, whose own ending is す — the や belongs to the stem the
 * kanji covers, an `okuriganaPrefix` in `LexiconEntry`'s terms — so こ + やす
 * and こや + す meet here as one string with the boundary in two places, and a
 * class returned on that evidence would have written 肥す. A prefix is a fact
 * about the word that this answer has no room to carry, so a word that needs
 * one is one this declines; 肥 has a `VERB_LEXICON` entry that carries it
 * properly and is reached exactly as before.
 *
 * Over the shipped indexes this answers for 57 (character, kun'yomi) pairs
 * that nothing else in the app resolves: 応/應/答/對/対/荅/譍/堪's こた.える as
 * 下二段ハ行, 憂/愁 and their fifteen rare variants' うれ.える the same, 消/熄's
 * き.える and 癒/瘉/瘥/瘳's い.える as 下二段ヤ行, 報/酬/讐's むく.いる as
 * 上二段ヤ行, and 餓/饑/饉/藝/芸/蒔's う.える as 下二段ワ行. It is asked only
 * where the shape has already declined, so the 5,196 readings the tables do
 * state a paradigm for are untouched by it — as are the 168 the project's own
 * `verb-lexicon-index.json` answers for through `attestedSenseByModernSpelling`,
 * which is asked first and is the app's own best evidence. 1,026 verb kun'yomi
 * are left over, and they keep the modern ending they always had. */
export function attestedClassicalParadigm(
  index: JmdictIndex | null | undefined,
  reading: string | undefined,
  okurigana: string | undefined,
): ConjClass | undefined {
  if (!index || !reading || !okurigana) return undefined;
  const attested = classicalParadigmIndex(index).get(reading + okurigana);
  if (attested?.size !== 1) return undefined;
  const conjClass = [...attested][0];
  return modernOkurigana({ conjClass }) === okurigana ? conjClass : undefined;
}

/** Whether JMdict lists this modern headword as an 一段 verb — the one thing
 * a *modern* entry says that bears on a classical paradigm, and it says it by
 * ruling one out rather than by naming one.
 *
 * `classicalConjClass` reads a one-kana modern okurigana as 四段 of that 行,
 * and says outright that this is a guess: 見る/着る/煮る/干る are 上一段, 有り/
 * 居り ラ変, 死ぬ ナ変, 得 ア行下二段. Its own defence is the verb lexicon,
 * which corrects the guess for every word it holds — and a word it does not
 * hold had nothing to correct it. That is where this comes in. **No 四段 verb
 * became 一段**; the modern 一段 class is what 上一段 stayed and what 二段
 * became, so a dictionary calling the word 一段 today is calling the guess
 * wrong whatever the right answer turns out to be.
 *
 * Ten characters in the shipped indexes are in that position, and all ten are
 * genuinely not 四段: 看る/観る/視る/診る/覧る (all みる, 上一段 見る), 烹る
 * (煮る), 嚏る (ひる), 寐る (寝, 下二段ナ行), 瘠る (痩す) and 黴る (黴ぶ). The
 * answer here is only "not that", never "this instead" — the right paradigm is
 * a further question this cannot answer, and a word left with no class reads
 * as it did before, which is the outcome to prefer.
 *
 * The reading is checked as well as the spelling, exactly as `isAdjectiveLemma`
 * checks it and for the same reason: 看る is みる and JMdict's entry has to be
 * the entry for *that* word, not for some homograph. */
export function isModernIchidanLemma(index: JmdictIndex | null | undefined, headword: string, reading: string): boolean {
  const entry = index?.[headword];
  return entry !== undefined && entry.reading === reading && entry.pos.some((p) => p.startsWith("Ichidan verb"));
}

/* `isSuruVerb` stood here — JMdict's `vs` tag ("noun or participle which
 * takes the aux. verb suru"), asked of a fused span to decide whether it
 * takes a サ変 ending. It is gone, and the removal is the point rather than a
 * tidy-up: attestation was the wrong evidence for that question. The reader's
 * rule is that a verb read on'yomi ends in a form of す, and `vs` is narrower
 * than the rule — 蠕動 is listed while 俯臥, 飲啄 and 異疾, spans of the same
 * shape and the same register, are not, so three words came out bare because
 * a modern dictionary happens not to hold them as する-nouns. `spanSuruReading`
 * in readingResolver.ts now keys on the span's reading being on'yomi
 * throughout and its carrier being tagged VERB, which is that rule written
 * out; see `isOnyomiSpan` there for what the two conditions do and do not
 * exclude. Nothing else ever consulted this tag. */

/** Whether a word takes a direct object. "both" is a real answer, not a
 * hedge: JMdict genuinely lists 開く (ひらく) as *both* transitive and
 * intransitive, which is why 開 reads ひらく whether or not it has an object
 * — the character has no separate intransitive partner to switch to.
 * "unknown" means the index has nothing to say (the headword isn't listed,
 * or the entry it holds is a noun), which callers must treat as "no
 * evidence" rather than as either answer. */
export type Transitivity = "transitive" | "intransitive" | "both" | "unknown";

/** JMdict's own part-of-speech strings for the two properties, verbatim —
 * the index stores the expanded English labels the JMdict distribution
 * writes out ("transitive verb"), not the abbreviated `vt`/`vi` entity
 * codes, so these match on the long forms. */
const TRANSITIVE_POS = "transitive verb";
const INTRANSITIVE_POS = "intransitive verb";

/** The transitivity JMdict records for `headword` (a kanji spelling with
 * its modern okurigana, e.g. 立つ / 立てる).
 *
 * This is the evidence `kanjidicLookup.ts` ranks a character's kun'yomi by
 * when the sentence says whether the verb has an object: KANJIDIC2 lists
 * 立's readings as た.つ/た.てる with nothing to say about which of them is
 * the transitive one, while JMdict tags 立つ intransitive and 立てる
 * transitive outright. Deriving it from the reading's *shape* instead was
 * considered and rejected — the -eru member of a pair is transitive for
 * 立つ/立てる but intransitive for 見る/見える, so the ending alone cannot
 * decide it and only the dictionary can. */
export function lemmaTransitivity(index: JmdictIndex, headword: string): Transitivity {
  // Not 新字体-normalised, though a kyūjitai verb asked 學ぶ of a dictionary
  // holding 学ぶ does get "unknown" here and leaves the transitivity question
  // unanswered. Closing that gap moves 139 of these answers at once, in both
  // directions — see `lookupModernisedLemma` for the measurement and for why
  // that is a decision to take deliberately rather than as a side effect.
  const entry = index[headword];
  if (!entry) return "unknown";
  const transitive = entry.pos.includes(TRANSITIVE_POS);
  const intransitive = entry.pos.includes(INTRANSITIVE_POS);
  if (transitive && intransitive) return "both";
  if (transitive) return "transitive";
  if (intransitive) return "intransitive";
  return "unknown";
}

/** Relations that mark a token as fused with its head into one
 * multi-character reading/furigana span (jukugo-style compounds, reduplication,
 * and flat multi-token names), per the plan's reading-resolution order.
 * Deliberately driven *only* by relations the parser itself assigns —
 * spans are never guessed from a dictionary lookup, which risks fusing
 * tokens the tree says are unrelated (tried once, reverted: it silently
 * broke negation on a false-positive match). */
const SPAN_FUSING_DEPS = new Set(["compound", "compound@redup", "flat", "flat@vv", "flat@foreign"]);

export interface CompoundSpan {
  /** Token ids in the span, in source (left-to-right) order. */
  tokenIds: number[];
  /** Concatenated surface text of the span, in source order — the lemma to
   * look up in the JMdict index. */
  text: string;
}

/** Identifies contiguous multi-character spans in a sentence by walking
 * `SPAN_FUSING_DEPS` attachments back to their governor (a maximal run of
 * tokens where each non-initial token is attached to the previous token, or
 * to another member of the same span, via one of the fusing relations — the
 * governor token is included).
 *
 * This only *detects* spans; resolving one via JMdict is the caller's job
 * (via `lookupLemma(index, span.text)`) — span-aware furigana rendering
 * happens in the render layer, and `computeReadingOrder` (via `carrierOf`)
 * is what keeps a span's members contiguous in reading order even when they
 * don't share a governor. */
export function findCompoundSpans(sentence: Sentence): CompoundSpan[] {
  const byId = new Map<number, Token>(sentence.tokens.map((t) => [t.id, t]));
  // Union-find over token ids so a span's members can be attached to any
  // other member (not necessarily to a single fixed governor token).
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const t of sentence.tokens) parent.set(t.id, t.id);
  for (const t of sentence.tokens) {
    // A 再読文字 is never part of a fused span. It is read twice, in two
    // separate places, so it cannot share one reading with a neighbour —
    // and being absorbed into a span hides it from the reorder engine
    // entirely, since span-mates are excluded from a node's children.
    // (盍學 was being fused, which is why 盍 came out as a bare kanji with
    // no なんぞ anywhere.)
    if (isRereadUse(t, sentence)) continue;
    // Nor is a distributive 毎/每 ("every X", "each time that…"), for the
    // same structural reason: it is postposed past its head (see
    // `isDistributivePostpose`, which is what decides that movement), and a
    // token that will be read *after* its neighbour cannot also be drawn
    // fused to it as one unbroken word. Caught live with 毎事問: 毎事 was
    // being grouped — 毎/每 is a `Degree=Pos` descriptive (VERB up to parser
    // 0.3.1, ADJ from 0.3.2, which is why the `mod` branch below names both
    // tags) and its head 事 is an
    // adjacent NOUN, which is exactly the attributive-`mod` shape the
    // branch below fuses — and the group then went through JMdict as a
    // jukugo, reading まいぢ instead of 事ごとに. 毎 is a grammatical
    // quantifier, not half of a compound noun. Keyed off the shared
    // predicate rather than a second lemma list of this module's own, so
    // "which 毎 is the distributive one" is decided in one place.
    if (isDistributivePostpose(t)) continue;
    // flat@vv ("flat verb-verb") is meant for genuine serial-verb chains —
    // two VERBs sharing a subject (槁暴, both "to dry/wither" and "to be
    // exposed"). It can also land on a stative predicate attached directly
    // to the NOUN it describes (木直, "wood [that is] straight") instead of
    // to a verb — there the two tokens aren't one fused word at all: 直 is
    // its own predicate that still needs its own conjugated ending, which
    // fusing into one display span would silently swallow (a span shows
    // bare kanji per member with no per-member conjugation). Excluded by
    // requiring the flat@vv governor itself be verb-like.
    const isNominalHeadedFlatVV =
      t.dep === "flat@vv" && byId.has(t.head) && ["NOUN", "PROPN", "PRON"].includes(byId.get(t.head)!.pos);
    // A state name compounded onto a common noun is a genitive, not a fused
    // name: 秦王 is "the king OF Qin" (秦ノ王), where 黃帝 and 惠王 are one
    // name apiece. The parser labels all three `compound`; NameType is what
    // separates them, and a live parse of each confirms it — 秦/楚/齊/趙 over
    // 王 all come back `NameType=Nat`, while 黃 (Giv), 惠 (Prs) and 安陵
    // (Geo) do not, so those three keep fusing. Left unfused so
    // `conjugationContext.ts`'s `genitiveNoParticle` can put の between the
    // two: a fused span's members are drawn as bare kanji with one shared
    // group ending, which has no room for a particle between them, so the
    // の rule was never even asked about 秦王.
    if (t.dep === "compound" && t.pos === "PROPN" && parseMorphFeatures(t.morph ?? "").NameType === "Nat") continue;
    if (SPAN_FUSING_DEPS.has(t.dep) && !isNominalHeadedFlatVV && byId.has(t.head) && t.head !== t.id) {
      const a = find(t.id);
      const b = find(t.head);
      if (a !== b) parent.set(a, b);
      continue;
    }
    // Attributive modification of a noun (plain `mod`, never `mod@tmod`/
    // `mod@lmod` — those are clause-level adverbials, not NP-internal) keeps
    // the resulting noun phrase intact as one unit, same as a real compound
    // — a descriptive word directly modifying a noun (tagged VERB with
    // `Degree=Pos` up to parser 0.3.1 and ADJ from 0.3.2, which is why both
    // are named below) is part of that NP, not a separate word.
    // Restricted to: source-adjacent pairs
    // (a genuine attributive modifier always sits directly next to its
    // noun, so a non-adjacent `mod` edge is some other, looser attachment
    // display-fusion — which requires contiguous token ids — can't
    // represent as one unit anyway); and the modifier itself being
    // adjective-like (VERB/ADJ — a descriptive word, the only kind that can
    // attributively modify a noun; the ADJ arm was dead code until 0.3.2 and
    // is now the one that carries the case) rather than ADV — an adverb (亦/皆/甚
    // etc.) can also land as `mod` of a nominal *predicate* root (e.g.
    // 亦君子乎, "is it not ALSO a gentleman?"), which is a clause-level
    // adverb over the whole predicate, not part of the noun phrase itself,
    // even though its head happens to be a noun.
    //
    // **A hand-picked reading on either member stands the fusion down**, and
    // that is the reader's own rule: *at least let me select a kun reading for
    // a modifying adjective.* The default stays exactly as it was — 大夫 is
    // だいふ, 太子 たいし, 高山 かうざん — because a pair like this is far more
    // often a lexicalised title than a live adjective phrase (measured: of the
    // 6,552 descriptive-modifier-plus-nominal edges in the recoded gold, the
    // commonest are 大夫 514, 太子 354, 寡人 324, 大王 233, 皇帝 162), and
    // nothing in the tree separates the two. What was wrong was that the
    // reader could not *overrule* it: the menu offers 高 as たかシ and the
    // resolver honours the pick, but a fused span is drawn as one cell group
    // whose furigana `compoundFurigana` writes for the whole word — forcing
    // on'yomi through `lookupKanji(…, "PROPN")` — so the pick was resolved and
    // then silently discarded. Un-fusing is what gives it somewhere to land:
    // an unfused member has a cell and an okurigana slot of its own, which is
    // what 高**き** needs and what a span by construction cannot hold.
    //
    // Asked of both members, since the pair is one unit and either end of it
    // may be the one the reader is correcting. The same test, put the same
    // way, that `isDistributivePostpose` uses to let a pick stand its own
    // movement rule down.
    const pickedMember = (a: Token, b: Token) =>
      chosenReadingText(a) !== undefined || chosenReadingText(b) !== undefined;
    if (
      t.dep === "mod" &&
      (t.pos === "VERB" || t.pos === "ADJ") &&
      byId.has(t.head) &&
      t.head !== t.id &&
      Math.abs(t.id - t.head) === 1 &&
      !pickedMember(t, byId.get(t.head)!)
    ) {
      const head = byId.get(t.head)!;
      if (head.pos === "NOUN" || head.pos === "PROPN") {
        const a = find(t.id);
        const b = find(t.head);
        if (a !== b) parent.set(a, b);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const t of sentence.tokens) {
    const root = find(t.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(t.id);
  }

  const spans: CompoundSpan[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => a - b);
    // Display fusion requires a contiguous run of token ids (the renderer
    // draws one unbroken cell group) — should a chain of union-find edges
    // ever bridge a gap, skip rather than silently scrambling reading
    // order around the missing id.
    if (ids[ids.length - 1] - ids[0] !== ids.length - 1) continue;
    spans.push({ tokenIds: ids, text: ids.map((id) => byId.get(id)!.text).join("") });
  }
  return spans;
}
