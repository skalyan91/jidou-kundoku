import { loadJsonIndex } from "./jsonIndex.ts";

/** Kanji spelling -> modern reading -> attested 歴史的仮名遣い (historical
 * kana) spelling, built from Wiktionary data (via kaikki.org) by
 * `scripts/build-historical-kana-index.mjs` — see that script's own doc for
 * the extraction rule and why it's keyed by kanji *and* reading (not just
 * kanji: a single character can have multiple readings with independently
 * attested historical spellings, e.g. 氷's kun'yomi こおり vs. its on'yomi
 * ひょう; not by reading alone either: two unrelated kanji can share one
 * modern reading with different — or no — attested historical spelling for
 * each). This is the *only* mechanism `readingResolver.ts` uses for this —
 * a general, data-driven fallback that lets any new text benefit
 * automatically, rather than patching words in one at a time.
 *
 * Keyed by *reading*, which for a kun'yomi means the stem alone: KANJIDIC2
 * holds 思 as おも with the う as separate okurigana, so the pass that builds
 * this has to divide 思ふ's historical form between the two before either
 * half can be looked up. See `kunPairsOf` in the build script.
 *
 * The one thing not in here is the orthographic fold — 歴史的仮名遣い writes
 * 促音 and 拗音 full-size — which `kanjidicLookup.ts` applies to a kun'yomi
 * this index has nothing for. That is deliberate: this file holds what is
 * attested, and the fold is a convention rather than an attestation. */
export type HistoricalKanaIndex = Record<string, Record<string, string>>;

/** 歴史的仮名遣い writes 促音 and 拗音 full-size — もつて, つつしむ, しやべる —
 * where 現代仮名遣い writes っ and ゃゅょ. This puts a reading that arrived in
 * the modern convention (KANJIDIC2's, and `VERB_LEXICON`'s where its own
 * extraction found no classical table) into the one this app writes in.
 *
 * It is the same fold `derive-onyomi-kana.py` applies to this index's own
 * values, and the *only* change made to a reading without attestation,
 * because it is the only one that is not a claim about the word: the small
 * and full-size kana denote the same syllable, so nothing is being decided.
 * Every other modern-to-historical correspondence is one-to-many and stays
 * where it belongs, in the index — a medial わ is は in 変はる and わ in 川,
 * and no rule over the modern kana can tell those apart, so an unattested one
 * is left exactly as it stands.
 *
 * A small kana before う is the one exception, and it is exceptional for that
 * same reason: ょう and ゅう are not 拗音 but the *fusion* of a long vowel,
 * whose historical spelling is a lexical fact about the word rather than a
 * matter of glyph size — けう, きやう and きよう all give きょう. Folding those
 * would put a confident wrong spelling where there is genuinely nothing to
 * say. 鰍's どじょう (historically どぢやう) and 姑's しゅうとめ (しうとめ) are
 * left alone on that ground; 姑 is in fact attested and comes out right, and
 * 鰍 is one of the 36 kun'yomi stems that stay uncorrected.
 *
 * Never applied to an on'yomi, which is a long vowel almost throughout: the
 * exception above would swallow the useful cases, and on'yomi have their own
 * and better source in `derive-onyomi-kana.py`, which derives from the 廣韻's
 * rime data what Wiktionary does not attest and abstains where it cannot. */
const SMALL_TO_FULL_SIZE: Record<string, string> = { "っ": "つ", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ" };
export function fullSizeKana(reading: string): string {
  return [...reading].map((kana, i) => (reading[i + 1] === "う" ? kana : SMALL_TO_FULL_SIZE[kana] ?? kana)).join("");
}

/** The historical spelling of a *reading*, for a character the index has
 * nothing for — because a reading's spelling is a fact about the word, and the
 * same word on another character is spelled the same way.
 *
 * 輒 is the case that asked for it: KANJIDIC gives it すなわち, nothing attests
 * 輒 itself, and the fold above cannot help because わ→は is not orthographic.
 * Yet 乃/則/即 all establish すなはち, and 輒's すなわち is not a similar word but
 * the same one. Twenty-nine characters were reaching the page in modern kana
 * for exactly this reason (輒 輙 迺 廼 皍 · 况 矤 矧 訠 · 卆 叵 訖 · 言 謂 道 ·
 * 遣 事 亊 · 仍 犹 · 仵 …).
 *
 * **Only where every attestation of that reading agrees.** A modern spelling
 * can descend from more than one historical one, and then the reading alone
 * cannot say which: あい is あひ on 相 but あゐ on 藍, so 靛's あい — which is
 * the 藍 word — must be left alone rather than given 相's spelling. Measured
 * over the shipped index, 531 of 605 attested readings are unanimous and 74
 * are not; this takes the 531 and abstains on the rest, which is the same
 * shape as `derive-onyomi-kana.py` abstaining where its votes are split.
 *
 * Both tables count as attestation: the index (Wiktionary) and
 * `overrides.json`, whose readings are hand-verified statements that this word
 * is spelled this way. They are pooled *before* the unanimity test, so a
 * curated reading cannot override a conflict either — 相's あひ does not
 * license 靛. */
export interface ReadingSplit {
  reading: string;
  /** Where the kanji's reading ends and its ending begins, when the source
   * attestation records one. KANJIDIC writes that boundary as a dot, and the
   * characters this transfer serves are exactly those it writes *without* one:
   * 輒's kun is the undivided すなわち where 乃's override is すなは + ち, and
   * the boundary is as much a fact about the word as the spelling is. */
  okurigana?: string;
}

let byReading: Map<string, ReadingSplit | null> | null = null;

/** The modern spelling of a historical one — medial は行 to わ行, ゐ/ゑ/を to
 * い/え/お, ぢ/づ to じ/ず. Only ever used to key an override entry by what a
 * modern dictionary would call it, so an imperfect answer costs a missed
 * transfer rather than a wrong one. Word-initial は/ひ/ふ/へ/ほ are untouched,
 * which is what makes 早 はや and 舟 ふね come through unchanged. */
function modernKana(historical: string): string {
  const medial: Record<string, string> = { は: "わ", ひ: "い", ふ: "う", へ: "え", ほ: "お", ゐ: "い", ゑ: "え", を: "お", ぢ: "じ", づ: "ず" };
  return [...historical].map((k, i) => (i === 0 ? k : medial[k] ?? k)).join("");
}

function readingTable(index: HistoricalKanaIndex, overrides: { reading?: string; okurigana?: string }[]): Map<string, ReadingSplit | null> {
  const seen = new Map<string, Map<string, ReadingSplit>>();
  const add = (modern: string, hist: string, split?: ReadingSplit): void => {
    if (modern === hist) return;
    // Only a difference that is *medial* transfers. は行転呼 and the ゐゑを/ぢづ
    // mergers all happen inside a word, so `modernKana` reproducing the modern
    // spelling exactly is the test that this pair is one of them — and that
    // the reading carries the position information a transfer needs.
    //
    // The index attests わ→は on ten characters (磐, 訪, 波, 羽 …), unanimously,
    // but every one is a stem sitting mid-word. 別 is わく, with わ word-initial
    // and staying わ, and a bare one-kana reading cannot tell the two apart —
    // it was coming out はく. Excluded here rather than at lookup time, so a
    // pair that cannot transfer also cannot outvote one that can.
    if (modernKana(hist) !== modern) return;
    const spellings = seen.get(modern) ?? new Map<string, ReadingSplit>();
    // First writer wins for the boundary, and a later one without it does not
    // erase it: the index carries no boundary at all, so an override's split
    // would otherwise be lost to whichever source happened to come second.
    if (!spellings.has(hist) || (split && !spellings.get(hist)!.okurigana)) {
      spellings.set(hist, split ?? { reading: hist });
    }
    seen.set(modern, spellings);
  };
  for (const [char, readings] of Object.entries(index)) {
    if ([...char].length !== 1) continue;
    for (const [modern, hist] of Object.entries(readings)) add(modern, hist);
  }
  for (const entry of overrides) {
    const hist = (entry.reading ?? "") + (entry.okurigana ?? "");
    if (hist) add(modernKana(hist), hist, { reading: entry.reading ?? hist, okurigana: entry.okurigana });
  }
  // A reading every source spells one way; null where they disagree, so a
  // conflict is recorded rather than silently absent.
  return new Map([...seen].map(([modern, spellings]) => [modern, spellings.size === 1 ? [...spellings.values()][0] : null]));
}

export function historicalSplitByReading(
  index: HistoricalKanaIndex | undefined,
  overrides: { reading?: string; okurigana?: string }[],
  reading: string,
): ReadingSplit | undefined {
  if (!index) return undefined;
  if (!byReading) byReading = readingTable(index, overrides);
  return byReading.get(reading) ?? undefined;
}

/** The spelling alone, for a caller that already has its own boundary. */
export function historicalByReading(
  index: HistoricalKanaIndex | undefined,
  overrides: { reading?: string; okurigana?: string }[],
  reading: string,
): string | undefined {
  const split = historicalSplitByReading(index, overrides, reading);
  return split && (split.reading + (split.okurigana ?? ""));
}

/** Dropped when the index is replaced, so a test can build a second one. */
export function resetReadingTable(): void {
  byReading = null;
}

let cached: Promise<HistoricalKanaIndex> | null = null;

export function loadHistoricalKanaIndex(url = "/data/historical-kana-index.json"): Promise<HistoricalKanaIndex> {
  if (!cached) cached = loadJsonIndex<HistoricalKanaIndex>(url);
  return cached;
}
