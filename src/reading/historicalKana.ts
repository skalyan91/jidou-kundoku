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
 * automatically, rather than patching words in one at a time. */
export type HistoricalKanaIndex = Record<string, Record<string, string>>;

let cached: Promise<HistoricalKanaIndex> | null = null;

export function loadHistoricalKanaIndex(url = "/data/historical-kana-index.json"): Promise<HistoricalKanaIndex> {
  if (!cached) cached = loadJsonIndex<HistoricalKanaIndex>(url);
  return cached;
}
