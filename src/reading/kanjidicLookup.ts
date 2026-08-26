import { loadJsonIndex } from "./jsonIndex.ts";

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
  if (pos === "NOUN" || pos === "PRON") return kun.find((k) => !k.includes(".")) ?? kun[0];
  return kun[0];
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

  const useKun = pos !== "PROPN" && entry.kun.length > 0;
  const primary = useKun ? pickKun(entry.kun, pos) : entry.on[0] ?? entry.kun[0];
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
