import { loadJsonIndex } from "./jsonIndex.ts";
import type { HistoricalKanaIndex } from "./historicalKana.ts";
import { type JmdictIndex, lemmaTransitivity } from "./jmdictLookup.ts";

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
 * carries; the merge below appends, so kanjidic's own ordering — and with
 * it every existing default — is untouched).
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
 * Appended after たね/-ぐさ deliberately: 種 is overwhelmingly the noun in
 * this corpus, and a NOUN still takes the first *bare* kun (たね) while
 * only a VERB reaches the first *dotted* one. */
const SUPPLEMENTARY_KUN: Record<string, string[]> = {
  種: ["う."],
};

/** A character's kun'yomi as the rest of this module reads them: kanjidic's
 * own list first, then anything `SUPPLEMENTARY_KUN` adds for it. */
function kunReadings(entry: KanjidicEntry, char: string): string[] {
  const extra = SUPPLEMENTARY_KUN[char];
  return extra ? [...entry.kun, ...extra] : entry.kun;
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
 * one. */
function pickByTransitivity(char: string, dotted: string[], wantTransitive: boolean, jmdict: JmdictIndex): string | undefined {
  const wanted = wantTransitive ? "transitive" : "intransitive";
  let fallback: string | undefined;
  for (const kun of dotted) {
    const { okurigana } = splitOkurigana(stripAffixHyphen(kun));
    // The modern citation spelling is what JMdict is keyed by, and it is
    // exactly the character followed by kanjidic's own okurigana — no
    // conversion, since kanjidic's kun'yomi are modern dictionary readings
    // verbatim (see `classicalAdjectiveReading`'s doc in readingResolver).
    const transitivity = lemmaTransitivity(jmdict, char + (okurigana ?? ""));
    if (transitivity === wanted) return kun;
    // A verb the dictionary calls both is a match, but a weaker one: a
    // character that has a dedicated partner for the wanted sense should
    // use it, so this is only taken if no exact match turns up later.
    if (transitivity === "both" && fallback === undefined) fallback = kun;
  }
  return fallback;
}

function pickKun(kun: string[], pos: string | undefined, transitivity?: { char: string; wantTransitive: boolean; jmdict: JmdictIndex }): string | undefined {
  if (kun.length === 0) return undefined;
  if (pos === "VERB" || pos === "ADJ") {
    const dotted = kun.filter((k) => k.includes("."));
    if (transitivity && dotted.length > 1) {
      const byObject = pickByTransitivity(transitivity.char, dotted, transitivity.wantTransitive, transitivity.jmdict);
      if (byObject) return byObject;
    }
    return dotted[0] ?? kun[0];
  }
  // For a nominal, a dotted kun is not a worse answer but a wrong one: it
  // is an inflecting word, and a noun cannot be read as one. Where the
  // entry offers no bare kun at all, this returns undefined so the caller
  // can fall back to the on'yomi — 利 has only き.く ("to be effective"),
  // and as a noun it is り, not 利く.
  if (pos === "NOUN" || pos === "PRON") return kun.find((k) => !k.includes("."));
  return kun[0];
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
 * entry rather than appearing twice identically. */
export function candidateReadings(
  index: KanjidicIndex,
  char: string,
  pos?: string,
  historicalKana?: HistoricalKanaIndex,
): ReadingCandidate[] {
  const entry = index[char];
  if (!entry) return [];

  // Keyed by kanji spelling *and* modern reading — see HistoricalKanaIndex.
  const historical = (reading: string) => historicalKana?.[char]?.[reading] ?? reading;

  const inflecting = pos === "VERB" || pos === "ADJ";
  const nominal = pos === "NOUN" || pos === "PRON" || pos === "PROPN";
  const all = kunReadings(entry, char);
  const kun = inflecting
    ? all.filter((k) => k.includes("."))
    : nominal
      ? all.filter((k) => !k.includes("."))
      : all;

  const gloss = entry.meanings[0];
  // The prefix/suffix hyphen (see `stripAffixHyphen`) is dropped here, and
  // the de-duplication below folds anything that collides with the bare
  // form already listed.
  const fromKun: ReadingCandidate[] = kun.map((k) => {
    const { reading, okurigana } = splitOkurigana(stripAffixHyphen(k));
    // Only the reading is substituted, never the okurigana — the same
    // split `readingResolver.ts` makes, since the index is keyed by the
    // reading alone and the ending is inflected separately.
    return { reading: historical(reading), okurigana, gloss, kind: "kun" };
  });
  const fromOn: ReadingCandidate[] = entry.on.map((o) => ({ reading: historical(toHiragana(o)), gloss, kind: "on" }));
  // On'yomi first, throughout — the order a kanji dictionary lists a
  // character's readings in, and so the order the menu presents them in.
  // Purely presentational: which entry the menu marks as current is decided
  // by comparing against the reading actually on screen, not by position.
  const ordered: ReadingCandidate[] = [...fromOn, ...fromKun];

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
 * Returns null if the character isn't in the index. */
export function lookupKanji(
  index: KanjidicIndex,
  char: string,
  pos?: string,
  transitivity?: { wantTransitive: boolean; jmdict: JmdictIndex },
): KanjidicLookupResult | null {
  const entry = index[char];
  if (!entry) return null;

  const allKun = kunReadings(entry, char);
  const eligible = pos !== "PROPN" && allKun.length > 0;
  // The unconditioned choice is computed either way, so the two can be
  // compared: what makes a reading "transitivity-selected" is that the
  // syntax moved it, not merely that a transitivity argument was passed.
  const defaultChoice = eligible ? pickKun(allKun, pos) : undefined;
  const kunChoice = eligible && transitivity ? pickKun(allKun, pos, { char, ...transitivity }) : defaultChoice;
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
    return { reading: toHiragana(primary), gloss };
  }
  const { reading, okurigana } = splitOkurigana(stripAffixHyphen(primary));
  return { reading, okurigana, gloss, ...(kunChoice !== defaultChoice ? { transitivitySelected: true } : {}) };
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
