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

/** Every kana this project writes that already *is* a voiced obstruent —
 * the が/ざ/だ/ば rows plus their small-kana and ヴ counterparts. Only
 * obstruents count: the nasals (な/ま rows), liquids (ら row), glides and
 * bare vowels are voiced too, phonetically, but Lyman's Law is a
 * restriction on voiced *obstruents* specifically (やまみち stays やまみち
 * because み is not one, which is why 山道 rendaku-voices nothing and
 * 山風 does not either). ぱ-row kana are deliberately absent: they are
 * voiceless, and no reading in this project's data starts a word with one
 * anyway. */
const VOICED_OBSTRUENTS = /[がぎぐげござじずぜぞだぢづでどばびぶべぼヴ]/;

/** The 連濁 (sequential voicing) form of `reading` as the *non-initial*
 * element of a compound read as one word — か→が, さ→ざ, た→だ, は→ば on the
 * first mora only — or null where the rule does not apply.
 *
 * The generative counterpart of `rendakuVariant` above, and separate from
 * it on purpose. That one only ever proposes a candidate to be checked
 * against a dictionary reading that already exists, so it can afford to
 * offer a voicing that no real word takes; this one is the answer, with no
 * attested reading behind it, so it has to decline the cases the rule
 * itself excludes:
 *
 *  - the initial kana must be a voiceless obstruent (the four rows above) —
 *    a reading starting with a vowel, nasal, or liquid has nothing to voice
 *    (やまみち, はるあめ);
 *  - Lyman's Law: no rendaku in a second element that already contains a
 *    voiced obstruent of its own — 山風 is やまかぜ, never *やまがぜ, because
 *    かぜ already has ぜ. This is the one exceptionless constraint on the
 *    rule, so it is enforced rather than left to a dictionary check.
 *
 * Historical kana is what goes in and what comes out: the は row voices to
 * ば (竹林 たけ+はやし -> たけばやし), which is exactly why the reading must
 * already be in 歴史的仮名遣い before this is applied — voicing a modern わ
 * would give a わ with no ば to become. */
export function sequentialVoicing(reading: string): string | null {
  if (reading.length === 0) return null;
  if (VOICED_OBSTRUENTS.test(reading)) return null;
  return rendakuVariant(reading);
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
