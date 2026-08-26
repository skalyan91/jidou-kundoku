/** Converts hiragana to katakana (fixed +0x60 codepoint offset across the
 * whole hiragana block, U+3041-3096 -> U+30A1-30F6; everything else,
 * including the iteration marks U+309D/309E, passes through unchanged since
 * they don't have katakana counterparts in this simple offset scheme).
 *
 * `readingResolver`'s data sources (KANJIDIC2, JMdict, the curated
 * overrides table) all give readings in hiragana. The kundoku-bun panel
 * needs them in katakana instead — traditional kanbun annotation practice
 * (furigana readings and okurigana both) uses katakana on the original,
 * unreordered text; only the fully-rewritten kakikudashibun switches to
 * hiragana. Call this only when rendering the kundoku panel. */
export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** Inverse of `toKatakana` (U+30A1-30F6 -> U+3041-3096). KANJIDIC2 stores
 * on'yomi in katakana (its own source convention) but every reading this
 * app shows as furigana is hiragana — needed to bring `lookupKanji`'s
 * on'yomi path in line with that, and to compare a combined JMdict
 * compound reading (hiragana) against KANJIDIC's per-character on'yomi
 * candidates when splitting one across the compound's characters. */
export function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
