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
 * **The fold is total, and the small kana before う used to be exempt.** The
 * exemption was right about the language and is overruled by a rule about the
 * page, so both halves are worth keeping on the record.
 *
 * The linguistics first, because it has not changed: ょう and ゅう are not 拗音
 * but the *fusion* of a long vowel, whose historical spelling is a lexical fact
 * about the word and not a matter of glyph size — けう, きやう and きよう all
 * give the modern きょう, and nothing about the modern spelling says which. So
 * folding ちょう to ちよう is a guess, and for 輒 — the character that exposed
 * this — it is a wrong one: 輒 is 葉韻, a -p coda, and its historical spelling
 * is てふ. The old exception declined to guess.
 *
 * What it did instead was leave the *modern* spelling standing, and that is a
 * worse answer rather than a neutral one. The reader's rule is that
 * 歴史的仮名遣い has no 小書き仮名 anywhere, so a ちょう on the page is not a
 * cautious abstention — it is a reading written in the other orthography, sitting
 * beside a しやく and a ぢやう that are written in this one. ちよう is at least
 * this app's convention, and where the true spelling is unknown the convention is
 * the only thing left to be right about. The abstention that *is* still available
 * is the one `derive-onyomi-kana.py` makes: it derives an on'yomi's spelling from
 * the 廣韻's rime data and stays silent where the rime data cannot decide, and its
 * output is merged into the shipped index — which is why 蟲 ちゆう, 尺 しやく,
 * 乘 じよう and 丈 ぢやう never reach this function at all. What reaches it is
 * what nothing attests and nothing derives.
 *
 * **What that costs, measured over the shipped KANJIDIC index** (12,356
 * characters): 1,132 readings on 1,008 characters were coming out with a small
 * ゅ or ょ, every one of them through this exception and not one through an
 * attested spelling. 輒's ちょう is one of the 1,132; it was noticed because 輒
 * happens to stand in the 酒蟲 opening, and the other 1,007 characters were
 * waiting for a text that used them.
 *
 * **The table covers ゎ and the small vowels too, and katakana beside hiragana.**
 * ゎ is not a nicety: 合拗音 is written くわ/ぐわ full-size in 歴史的仮名遣い, the
 * index attests くゎう on 21 characters (紘, 宏, 閎, 黌 …) in Wiktionary's
 * convention rather than this app's, and 郭 in the same index is already the
 * full-size くわく — so without ゎ the data contradicted itself and the fold had
 * no entry to settle it with. The katakana half is there because the 訓読文 panel
 * writes okurigana in katakana, and KANJIDIC carries katakana kun'yomi outright
 * (竏 キロリットル, 釔 イットリウム); neither belongs in kanbun, and neither is a
 * reason for the invariant to have a hole in it. */
const SMALL_TO_FULL_SIZE: Record<string, string> = {
  "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
  "っ": "つ", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ゎ": "わ",
  "ァ": "ア", "ィ": "イ", "ゥ": "ウ", "ェ": "エ", "ォ": "オ",
  "ッ": "ツ", "ャ": "ヤ", "ュ": "ユ", "ョ": "ヨ", "ヮ": "ワ",
};
export function fullSizeKana(reading: string): string {
  return [...reading].map((kana) => SMALL_TO_FULL_SIZE[kana] ?? kana).join("");
}

/** **The historical spelling this app writes for `char` read `reading`** — the
 * index's attestation where it has one, the fold where it has not, and the fold
 * over the attestation either way.
 *
 * The one thing every display path in the reading layer wants, gathered here so
 * that it cannot be got half right in one of them. Each of those paths had
 * written its own `index[char]?.[reading] ?? fullSizeKana(reading)`, which is
 * this minus the last clause — and that missing clause is a second leak beside
 * the one `fullSizeKana`'s own note describes: **27 readings on 21 characters**
 * come back from the shipped index already carrying a small kana (掛 か -> くゎ,
 * 紘 こう -> くゎう, 乖 かい -> くゎい), because Wiktionary writes 合拗音 with a
 * small ゎ where this app writes くわ. Those went straight to the page,
 * untouched, precisely *because* they were attested.
 *
 * So the fold is not the alternative to attestation, it is the last word over
 * it. An attested spelling decides which syllables the word has; the fold
 * decides how this app writes them, and it has the final say because the way
 * this app writes them is not something a dictionary gets a vote on.
 *
 * **Not to be used before a dictionary comparison.** The compound path matches a
 * reading against JMdict's own spelling of the word, which is modern kana, and a
 * reading folded into this app's convention would not match a dictionary written
 * in the other one. That path passes no index and compares first, folding the
 * pieces on the way out — see `historicalKun` in kanjidicLookup.ts, whose gate on
 * the index being supplied at all says the same thing. */
export function historicalSpelling(
  index: HistoricalKanaIndex | null | undefined,
  char: string,
  reading: string,
): string {
  return fullSizeKana(index?.[char]?.[reading] ?? reading);
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
  // Folded on the way in, over and above `historicalSpelling` folding on the way
  // out. Two mechanisms for one invariant is worth stating a reason for: the
  // reading layer reaches the index through that helper and cannot leak, but the
  // 訓読文 panel keeps a lookup of its own (`lexiconFurigana` in
  // `KundokuView.ts`, which draws a verb-lexicon reading over its character) and
  // a copy of a rule is a place for the rule to be missing. Normalising the data
  // itself puts every reader of it — that one included, and any written later —
  // on the app's own orthography without their having to know about it.
  //
  // Values only. The keys are *modern* readings and are what KANJIDIC hands in
  // to look a spelling up with, so folding those would break every lookup.
  if (!cached) {
    cached = loadJsonIndex<HistoricalKanaIndex>(url).then((index) =>
      Object.fromEntries(
        Object.entries(index).map(([char, readings]) => [
          char,
          Object.fromEntries(Object.entries(readings).map(([modern, historical]) => [modern, fullSizeKana(historical)])),
        ]),
      ),
    );
  }
  return cached;
}
