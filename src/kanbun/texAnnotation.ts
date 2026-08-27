import type { KundokuTier, ReadingPlan } from "../kundoku/types.ts";
import { buildMarkMap } from "../render/kundokuGlyphs.ts";

/** Plain-character kaeriten marks, as used both by real kanbun.sty-family
 * LaTeX packages' annotation syntax and by this module's own editable
 * round-trip format — distinct from `render/kundokuGlyphs.ts`'s Unicode
 * Kanbun-block glyphs (U+3190-319F), which are for on-screen display only
 * and aren't what a LaTeX source file (or a human typing kunten by hand)
 * would use. */
const PLAIN_TIER_GLYPHS: Record<Exclude<KundokuTier, "re">, Record<number, string[]>> = {
  "ichi-ni": { 2: ["一", "二"], 3: ["一", "二", "三"], 4: ["一", "二", "三", "四"] },
  "jou-ge": { 2: ["上", "下"], 3: ["上", "中", "下"] },
  "kou-otsu": { 2: ["甲", "乙"], 3: ["甲", "乙", "丙"] },
  "ten-chi": { 2: ["天", "地"], 3: ["天", "地", "人"] },
};
const PLAIN_NUMERAL_FALLBACK = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function plainGlyphsForGroup(tier: KundokuTier, count: number): string[] {
  if (tier === "re") return ["レ"];
  const byCount = PLAIN_TIER_GLYPHS[tier][count];
  if (byCount) return byCount;
  return PLAIN_NUMERAL_FALLBACK.slice(0, count);
}

/** Per-token plain-character kaeriten marks (see `buildMarkMap` — same
 * stacking logic `buildKundokuGlyphMap` uses for the on-screen Unicode
 * glyphs, so the two never disagree about which marks a token carries). */
export function buildPlainKuntenMarks(plan: ReadingPlan): Map<number, string> {
  return buildMarkMap(plan, plainGlyphsForGroup);
}

/** One rendered character's worth of annotation, in the shape both the
 * `.tex` generator and `kuntenExecutor.ts` need — scraped directly from the
 * already-rendered kundoku panel DOM (see `scrapeAnnotationTokens`) rather
 * than recomputed independently, so this can never drift from what's
 * actually on screen. */
export interface AnnotationToken {
  text: string;
  furigana?: string;
  okurigana?: string;
  kunten?: string;
  isPunct: boolean;
  /** True for a grammar-word gloss whose kanji `generateKakikudashi` drops
   * entirely from the running prose (discourse particles, negation, modal
   * auxiliaries, 而, 於, any other override-table reading) — see
   * `KundokuView.ts`'s `cellFor` `kanaOnly` param, the only place this is
   * actually decided; scraped back from its `data-kana-only` marker rather
   * than re-derived. */
  kanaOnly: boolean;
}

/** Reads the rendered kundoku panel's DOM back into one `AnnotationToken[]`
 * per sentence (`.sentence-gap` wrapper), in source order — the same order
 * kaeriten marks are defined relative to. Each `.kanji-cell` (see
 * `render/KundokuView.ts`'s `cellFor`) is either a bare punctuation cell
 * (no `.kanji-glyph`/ruby at all) or a `<ruby>` of `.kanji-glyph` (the base
 * character, plus an optional nested `.kunten-glyph`) + `<rt>` (furigana
 * text, plus an optional nested `.okurigana` span) — this walks exactly
 * that structure, so it stays correct automatically if `cellFor` changes,
 * without needing a parallel "recompute furigana/okurigana/kunten" pass. */
export function scrapeAnnotationTokens(kundokuViewEl: Element): AnnotationToken[][] {
  const sentences: AnnotationToken[][] = [];
  for (const sentenceEl of kundokuViewEl.querySelectorAll(".sentence-gap")) {
    const tokens: AnnotationToken[] = [];
    for (const cell of sentenceEl.querySelectorAll(".kanji-cell")) {
      const glyph = cell.querySelector(".kanji-glyph");
      if (!glyph) {
        tokens.push({ text: cell.textContent ?? "", isPunct: true, kanaOnly: false });
        continue;
      }
      const text = glyph.childNodes[0]?.textContent ?? "";
      const kuntenEl = glyph.querySelector(".kunten-glyph");
      const kunten = kuntenEl?.textContent || undefined;
      const rt = cell.querySelector("rt");
      let furigana: string | undefined;
      let okurigana: string | undefined;
      if (rt) {
        const okuriEl = rt.querySelector(".okurigana");
        okurigana = okuriEl?.textContent || undefined;
        furigana =
          [...rt.childNodes]
            .filter((n) => n !== okuriEl)
            .map((n) => n.textContent ?? "")
            .join("") || undefined;
      }
      const kanaOnly = (cell as HTMLElement).dataset?.kanaOnly === "true";
      tokens.push({ text, furigana, okurigana, kunten, isPunct: false, kanaOnly });
    }
    sentences.push(tokens);
  }
  return sentences;
}

function tokenToAnnotation(t: AnnotationToken): string {
  if (t.isPunct) return t.text;
  let s = t.text;
  if (t.furigana) s += `(${t.furigana})`;
  if (t.okurigana) s += t.okurigana;
  if (t.kunten) s += `[${t.kunten}]`;
  return s;
}

/** The editable annotation text itself (no LaTeX document wrapper) — one
 * character per unit: kanji/punctuation, then `(furigana)` if any, then
 * katakana okurigana if any, then `[kaeriten]` if any. This is also,
 * verbatim, the body of a `kanbun` package `\Kanbun ... \EndKanbun` block
 * (see `generateKanbunTex`) — the same text serves as both the compilable
 * LaTeX source and this app's own editable intermediate representation,
 * parsed back by `parseAnnotationText` in `annotationEditor.ts`. */
export function generateAnnotationText(sentences: AnnotationToken[][]): string {
  return sentences.map((tokens) => tokens.map(tokenToAnnotation).join("")).join("\n");
}

/** Wraps annotation text in a minimal, real, compilable LuaLaTeX document
 * using the `kanbun` package (https://ctan.org/pkg/kanbun) — not classical
 * pLaTeX: pLaTeX's dvi-based pipeline has no equivalent actively-maintained
 * package for this, while `kanbun` is a modern expl3 package built
 * specifically for LuaLaTeX's programmability, and LuaLaTeX handles
 * Japanese (via luatexja) at least as well as pLaTeX does. Requires the
 * `kanbun` package and a Japanese font (Haranoaji here, freely available on
 * any current TeX Live/Overleaf install) to actually compile — this app
 * doesn't bundle either, only generates source text. */
/** The Kanbun-block marks (U+3190-319F) back to the plain characters they
 * stand for.
 *
 * `scrapeAnnotationTokens` reads the marks off the panel, where they are the
 * Unicode display glyphs — that is what `render/kundokuGlyphs.ts` puts on
 * the screen, and the right thing there. A LaTeX source is the other case
 * this file's own `PLAIN_TIER_GLYPHS` exists for: the `kanbun` package reads
 * `[レ]` and `[一]`, and would make nothing of `[㆑]`. So the display glyphs
 * are translated on the way out, and only here — the annotation text is also
 * this app's editable round-trip format, which is written and read back in
 * the glyphs the panel uses. */
const PLAIN_FOR_DISPLAY_MARK: Readonly<Record<string, string>> = {
  "㆑": "レ",
  "㆒": "一",
  "㆓": "二",
  "㆔": "三",
  "㆕": "四",
  "㆖": "上",
  "㆗": "中",
  "㆘": "下",
  "㆙": "甲",
  "㆚": "乙",
  "㆛": "丙",
  "㆜": "丁",
  "㆝": "天",
  "㆞": "地",
  "㆟": "人",
};

function toPlainKuntenMarks(text: string): string {
  return text.replace(/[㆐-㆟]/g, (mark) => PLAIN_FOR_DISPLAY_MARK[mark] ?? mark);
}

export function generateKanbunTex(annotationText: string): string {
  return `\\documentclass{ltjtarticle}
\\usepackage[match]{luatexja-fontspec}
\\usepackage[haranoaji]{luatexja-preset}
\\usepackage[kumi=beta]{kanbun}

\\begin{document}
\\Kanbun
${toPlainKuntenMarks(annotationText.replace(/\n/g, ""))}
\\EndKanbun

\\printkanbun
\\end{document}
`;
}
