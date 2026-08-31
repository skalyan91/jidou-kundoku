import type { KanjidicIndex, ReadingCandidate } from "./kanjidicLookup.ts";
import { fullSizeKana, type HistoricalKanaIndex } from "./historicalKana.ts";

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

/** The readings one character of a compound can contribute to the whole
 * compound's reading: its on'yomi and the *stems* of its kun'yomi — a member
 * of a jukugo never carries its own okurigana (立場 is たちば, off た.つ) —
 * plus, for a member that is not the compound's first character, each of
 * those voiced (see `RENDAKU`).
 *
 * This is the one enumeration of what a member may be read as, and it
 * answers to two callers that must not disagree: `splitCompoundReading`
 * below, which divides a whole compound's reading by finding an assignment
 * out of this set, and the furigana menu (`readingCandidatesFor` in
 * tokenInspector.ts), which offers a member's alternatives to the reader.
 * A menu entry outside the splitter's set would be a reading that could be
 * chosen and then could not be divided back across the characters — a
 * choice that stored correctly and did not appear. Sharing the set is what
 * makes that impossible rather than merely unlikely.
 *
 * `historicalKana` spells each candidate in 歴史的仮名遣い — the same
 * per-character substitution `compoundFurigana` applies to the shares it
 * puts on the page (`historical` there), and for the same reason: the
 * annotation is historical throughout, so a menu written in modern kana
 * would offer readings in an orthography the page does not use and would
 * not recognise the reading already displayed as one of its own entries.
 * Omit it and the candidates come back in KANJIDIC's own modern kana, which
 * is what a JMdict compound reading has to be matched against. */
export function compoundMemberCandidates(
  kanjidic: KanjidicIndex,
  char: string,
  options: { nonInitial?: boolean; historicalKana?: HistoricalKanaIndex | null } = {},
): ReadingCandidate[] {
  const entry = kanjidic[char];
  if (!entry) return [];
  const { nonInitial = false, historicalKana = null } = options;
  const spell = (reading: string) =>
    historicalKana ? historicalKana[char]?.[reading] ?? fullSizeKana(reading) : reading;
  const gloss = entry.meanings[0];
  const base: ReadingCandidate[] = [
    ...entry.on.map((o) => ({ reading: spell(toHiragana(o)), gloss, kind: "on" as const })),
    ...entry.kun.map((k) => ({
      reading: spell(
        k
          .split(".")[0] // drop the okurigana-dot suffix — a compound reading never carries a member's own okurigana
          .replace(/^-|-$/g, ""), // KANJIDIC2's leading/trailing hyphen marks "used as a suffix"/"used as a prefix" respectively — a position note, not part of the reading itself; "-び" for 火 is already the rendaku-voiced suffix form
      ),
      gloss,
      kind: "kun" as const,
    })),
  ].filter((c) => c.reading.length > 0);

  // Voiced *after* the historical spelling, not before: rendaku voices a
  // reading's own first kana, and both spellings have the same first kana
  // unless the substitution changed it, which it never does (ひゃく ->
  // ひやく -> びやく, the share 三百 shows on the page).
  const all = nonInitial
    ? base.flatMap((c) => {
        const voiced = rendakuVariant(c.reading);
        return voiced ? [c, { ...c, reading: voiced }] : [c];
      })
    : base;

  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.reading) ? false : (seen.add(c.reading), true)));
}

/** Every spelling of every reading `chars[index]` may contribute, for the
 * splitter: both orthographies at once, since one reading arrives modern
 * (JMdict's own reading for the whole word) and another arrives historical
 * (a reading the reader picked off the menu, which is spelled the way the
 * page spells it). Splitting has to accept either. */
function splitCandidates(
  kanjidic: KanjidicIndex,
  char: string,
  nonInitial: boolean,
  historicalKana: HistoricalKanaIndex | null,
): string[] {
  const modern = compoundMemberCandidates(kanjidic, char, { nonInitial });
  const historical = historicalKana
    ? compoundMemberCandidates(kanjidic, char, { nonInitial, historicalKana })
    : [];
  return [...new Set([...modern, ...historical].map((c) => c.reading))];
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
 * independently-resolved reading in that case, not force a wrong split.
 *
 * `historicalKana` lets a reading already in 歴史的仮名遣い be divided too,
 * by admitting each character's historical spellings alongside its modern
 * ones (see `splitCandidates`). A hand-picked compound reading is stored as
 * it is written on the page, which is historical — さんびやく for 三百,
 * がうふ for 豪富 — and neither of those divides at all against KANJIDIC's
 * modern kana alone (measured: both come back null). Omit it and the split
 * is exactly what it was, which is what JMdict's own modern readings want. */
export function splitCompoundReading(
  chars: string[],
  reading: string,
  kanjidic: KanjidicIndex,
  historicalKana: HistoricalKanaIndex | null = null,
): string[] | null {
  function backtrack(charIndex: number, pos: number): string[] | null {
    if (charIndex === chars.length) return pos === reading.length ? [] : null;
    const candidates = splitCandidates(kanjidic, chars[charIndex], charIndex > 0, historicalKana);
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
