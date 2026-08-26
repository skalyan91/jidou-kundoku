import type { Token } from "../parse/types.ts";

export type ReadingSource = "override" | "kanjidic" | "jmdict" | "unresolved";

export interface ResolvedReading {
  /** Kana reading to render as furigana over the token's/span's base text. */
  reading: string;
  /** Trailing inflectional kana not covered by the kanji base (e.g. verb
   * okurigana), rendered as plain text after the base rather than as ruby. */
  okurigana?: string;
  gloss?: string;
  source: ReadingSource;
}

/** A resolver looks up one token in the context of its sentence (needed for
 * multi-character compound spans and dep/POS-conditioned overrides). */
export type ReadingResolver = (token: Token, sentence: { tokens: Token[] }) => ResolvedReading;
