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

/** The Kanbun-block marks (U+3190-319F) and the plain characters they stand
 * for — the same mark in the two alphabets this app has to speak.
 *
 * The panel is drawn in the Unicode glyphs (`render/kundokuGlyphs.ts`),
 * which is the right thing on screen: they are purpose-built annotation
 * marks and sit beside the character rather than reading as ideographs of
 * their own. Everything *else* speaks plain: the `kanbun` LaTeX package
 * reads `[レ]` and `[一]` and would make nothing of `[㆑]`;
 * `kuntenExecutor.ts` reads plain characters too (see its doc); and a person
 * editing the annotation text can type 一 and レ off any keyboard, where ㆒
 * and ㆑ are all but unreachable.
 *
 * So plain is this app's canonical form for a mark — what an
 * `AnnotationToken` carries, what `generateAnnotationText` writes — and the
 * display glyphs are a rendering of it, converted back at exactly the two
 * boundaries where the panel's DOM is read (`scrapeAnnotationTokens`) and
 * written (`annotationEditor.ts`'s `renderAnnotationTokensToKundoku`). */
const MARK_ALPHABETS: readonly (readonly [display: string, plain: string])[] = [
  ["㆑", "レ"],
  ["㆒", "一"],
  ["㆓", "二"],
  ["㆔", "三"],
  ["㆕", "四"],
  ["㆖", "上"],
  ["㆗", "中"],
  ["㆘", "下"],
  ["㆙", "甲"],
  ["㆚", "乙"],
  ["㆛", "丙"],
  ["㆜", "丁"],
  ["㆝", "天"],
  ["㆞", "地"],
  ["㆟", "人"],
];

const PLAIN_FOR_DISPLAY_MARK: ReadonlyMap<string, string> = new Map(MARK_ALPHABETS);
const DISPLAY_FOR_PLAIN_MARK: ReadonlyMap<string, string> = new Map(MARK_ALPHABETS.map(([display, plain]) => [plain, display]));

/** Kanbun-block marks in `text` rewritten as the plain characters they stand
 * for; anything else (including a `NUMERAL_FALLBACK` 五..十, which the block
 * has no glyph for) passes through. Idempotent, so it is safe on text of
 * unknown provenance — a document a person hand-edited, say, which may mix
 * the two alphabets freely. */
export function toPlainKuntenMarks(text: string): string {
  return text.replace(/[㆐-㆟]/g, (mark) => PLAIN_FOR_DISPLAY_MARK.get(mark) ?? mark);
}

/** The inverse, for putting a canonical plain mark back on screen. Applied
 * only to a kunten string — the plain marks are ordinary CJK characters, and
 * running this over running text would turn the *word* 上 into a kaeriten. */
export function toDisplayKuntenMarks(kunten: string): string {
  return [...kunten].map((mark) => DISPLAY_FOR_PLAIN_MARK.get(mark) ?? mark).join("");
}

/** One rendered character's worth of annotation, in the shape both the
 * `.tex` generator and `kuntenExecutor.ts` need — scraped directly from the
 * already-rendered kundoku panel DOM (see `scrapeAnnotationTokens`) rather
 * than recomputed independently, so this can never drift from what's
 * actually on screen. */
export interface AnnotationToken {
  text: string;
  /** The character's own reading, in hiragana, as the panel shows it. */
  furigana?: string;
  /** Inflectional kana and function-word glosses, in katakana — the panel's
   * convention, and this format's (`annotationEditor.ts`'s `UNIT_RE`
   * identifies the okurigana slot *by* its katakana range). The
   * kakikudashibun is the one place that switches to hiragana, and does the
   * conversion itself. */
  okurigana?: string;
  /** This token's stacked kaeriten, in the plain characters
   * (一二三四/上中下/甲乙丙/天地人/レ) — never the panel's Kanbun-block display
   * glyphs, which `scrapeAnnotationTokens` converts on the way in. See
   * `MARK_ALPHABETS`. */
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
      // The panel draws its marks in the Kanbun block; an `AnnotationToken`
      // carries the plain characters every consumer of one reads — see
      // `MARK_ALPHABETS`.
      const kunten = kuntenEl?.textContent ? toPlainKuntenMarks(kuntenEl.textContent) : undefined;
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
 * katakana okurigana if any, then `[kaeriten]` — in the plain characters an
 * `AnnotationToken` carries, which are also the ones a person can type and
 * the ones `kuntenExecutor.ts` reads — if any. This is also,
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
 * doesn't bundle either, only generates source text.
 *
 * `toPlainKuntenMarks` is applied even though `generateAnnotationText`
 * already emits plain marks: this takes *text*, which may equally have come
 * from the annotation editor with a ㆑ a person pasted off the panel, and
 * the `kanbun` package would make nothing of that. It is idempotent, so it
 * costs the generated path nothing. */
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
