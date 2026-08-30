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

let cached: Promise<HistoricalKanaIndex> | null = null;

export function loadHistoricalKanaIndex(url = "/data/historical-kana-index.json"): Promise<HistoricalKanaIndex> {
  if (!cached) cached = loadJsonIndex<HistoricalKanaIndex>(url);
  return cached;
}
