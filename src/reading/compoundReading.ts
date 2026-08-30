import type { KanjidicIndex } from "./kanjidicLookup.ts";

/** KANJIDIC2 stores on'yomi in katakana — converted to hiragana here so
 * candidates compare directly against a JMdict compound reading (always
 * hiragana), same fix as `kanjidicLookup.ts`'s `lookupKanji` (duplicated
 * rather than imported for the same reason: no cross-file coupling needed
 * for two lines). */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Sequential voicing (連濁): a compound's non-initial elements frequently
 * voice their own initial consonant (火 ひ -> 花火 はな*び*), so a candidate
 * reading needs trying both as-is and voiced when it isn't the compound's
 * first character. Unvoiced -> voiced, first kana only (rendaku only ever
 * affects a word's own initial mora). */
const RENDAKU: Record<string, string> = {
  か: "が", き: "ぎ", く: "ぐ", け: "げ", こ: "ご",
  さ: "ざ", し: "じ", す: "ず", せ: "ぜ", そ: "ぞ",
  た: "だ", ち: "ぢ", つ: "づ", て: "で", と: "ど",
  は: "ば", ひ: "び", ふ: "ぶ", へ: "べ", ほ: "ぼ",
};

function rendakuVariant(reading: string): string | null {
  const first = reading[0];
  const voiced = RENDAKU[first];
  return voiced ? voiced + reading.slice(1) : null;
}

function candidateReadings(kanjidic: KanjidicIndex, char: string): string[] {
  const entry = kanjidic[char];
  if (!entry) return [];
  const on = entry.on.map(toHiragana);
  const kun = entry.kun.map(
    (k) =>
      k
        .split(".")[0] // drop the okurigana-dot suffix — a compound reading never carries a member's own okurigana
        .replace(/^-|-$/g, ""), // KANJIDIC2's leading/trailing hyphen marks "used as a suffix"/"used as a prefix" respectively — a position note, not part of the reading itself; "-び" for 火 is already the rendaku-voiced suffix form
  );
  return [...new Set([...on, ...kun])].filter((r) => r.length > 0);
}

/** Splits a compound's combined dictionary reading (e.g. くんし for 君子)
 * into one substring per character (くん, し), by backtracking through each
 * character's own KANJIDIC on'yomi/kun'yomi candidates and finding an
 * assignment that exactly consumes the whole reading. Longest-candidate-
 * first at each step (a greedy shortest match can wrongly claim a prefix
 * that belongs to the next character — e.g. picking 1-mora こ for 子 over
 * the correct 2-mora candidate when both are valid readings of that
 * character in isolation) with backtracking if a later character then has
 * no match left. Each non-initial character's candidates are also tried
 * rendaku-voiced (see `RENDAKU`). Returns null if no assignment fully
 * consumes the reading — callers should fall back to each character's own
 * independently-resolved reading in that case, not force a wrong split. */
export function splitCompoundReading(chars: string[], reading: string, kanjidic: KanjidicIndex): string[] | null {
  function backtrack(charIndex: number, pos: number): string[] | null {
    if (charIndex === chars.length) return pos === reading.length ? [] : null;
    const base = candidateReadings(kanjidic, chars[charIndex]);
    const candidates = charIndex === 0 ? base : [...new Set(base.flatMap((c) => [c, rendakuVariant(c) ?? c]))];
    const sorted = [...candidates].sort((a, b) => b.length - a.length);
    for (const cand of sorted) {
      if (cand.length > 0 && reading.startsWith(cand, pos)) {
        const rest = backtrack(charIndex + 1, pos + cand.length);
        if (rest) return [cand, ...rest];
      }
    }
    return null;
  }
  return backtrack(0, 0);
}
