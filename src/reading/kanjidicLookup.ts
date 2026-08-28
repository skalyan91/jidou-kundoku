import { loadJsonIndex } from "./jsonIndex.ts";
import type { HistoricalKanaIndex } from "./historicalKana.ts";

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

export interface KanjidicLookupResult {
  reading: string;
  okurigana?: string;
  gloss?: string;
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
function pickKun(kun: string[], pos: string | undefined): string | undefined {
  if (kun.length === 0) return undefined;
  if (pos === "VERB" || pos === "ADJ") return kun.find((k) => k.includes(".")) ?? kun[0];
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
  const kun = inflecting
    ? entry.kun.filter((k) => k.includes("."))
    : nominal
      ? entry.kun.filter((k) => !k.includes("."))
      : entry.kun;

  const gloss = entry.meanings[0];
  // KANJIDIC2 marks a reading that only occurs as a prefix or suffix with a
  // hyphen on the joining side ("こ-", "-なお.す"). That is positional
  // notation, not part of the reading, and would otherwise be written into
  // the ruby verbatim — so it is stripped here, and the de-duplication
  // below folds anything that collides with the bare form already listed.
  const fromKun: ReadingCandidate[] = kun.map((k) => {
    const { reading, okurigana } = splitOkurigana(k.replace(/^-|-$/g, ""));
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
 * Returns null if the character isn't in the index. */
export function lookupKanji(index: KanjidicIndex, char: string, pos?: string): KanjidicLookupResult | null {
  const entry = index[char];
  if (!entry) return null;

  const kunChoice = pos !== "PROPN" && entry.kun.length > 0 ? pickKun(entry.kun, pos) : undefined;
  // A nominal with no bare kun falls through to the on'yomi rather than
  // being read as the verb it isn't — see `pickKun`.
  const useKun = kunChoice !== undefined;
  const primary = useKun ? kunChoice : entry.on[0] ?? entry.kun[0];
  if (primary === undefined) return null;

  const gloss = entry.meanings[0];
  if (!useKun) {
    // on'yomi readings have no okurigana-dot notation, but do need
    // converting from KANJIDIC2's own katakana to this app's hiragana
    // furigana convention.
    return { reading: toHiragana(primary), gloss };
  }
  const { reading, okurigana } = splitOkurigana(primary);
  return { reading, okurigana, gloss };
}
