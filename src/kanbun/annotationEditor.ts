import { AUXILIARY_LEMMAS, NEGATION_LEMMAS } from "../kakikudashi/conjugationContext.ts";
import { SENTENCE_FINAL_PARTICLE_LEMMAS } from "../kakikudashi/bungoConjugation.ts";
import { KANJI_RETAINED_ADVERBS } from "../kakikudashi/generator.ts";
import { findOverride } from "../reading/overridesLookup.ts";
import { executeKunten } from "./kuntenExecutor.ts";
import type { AnnotationToken } from "./texAnnotation.ts";

/** One CJK/punctuation base character, then optional `(furigana)`, then an
 * optional run of katakana/chōonpu okurigana, then an optional `[kunten]` —
 * see `texAnnotation.ts`'s `tokenToAnnotation` (the inverse of this). */
const UNIT_RE = /([^()[\]゠-ヿ])(?:\(([^)]*)\))?([゠-ヿ]*)(?:\[([^\]]*)\])?/gu;

/** Lemmas whose kanji `generateKakikudashi` always drops from the running
 * prose (see `cellFor`'s `kanaOnly` doc for the full branch list this
 * mirrors) — used only as a *fallback* for a token with no matching
 * previous-render history to carry `kanaOnly` forward from (see
 * `parseAnnotationText`); a real render always tags this via the DOM
 * instead. */
const ALWAYS_KANA_ONLY_LEMMAS: ReadonlySet<string> = new Set([
  ...NEGATION_LEMMAS,
  ...Object.keys(AUXILIARY_LEMMAS),
  ...SENTENCE_FINAL_PARTICLE_LEMMAS,
  "而",
  "於",
]);

/** Best-effort `kanaOnly` guess for a token with no render history to match
 * against (a line the user typed from scratch, or edited enough that
 * position-matching against the previous parse fails) — see the module
 * doc's honesty note: this can't perfectly recover the distinction a real
 * render's `data-kana-only` attribute carries, since the plain annotation
 * text format itself doesn't encode it. */
function inferKanaOnly(text: string, furigana: string | undefined, okurigana: string | undefined): boolean {
  if (ALWAYS_KANA_ONLY_LEMMAS.has(text)) return true;
  if (!furigana && okurigana && !(text in KANJI_RETAINED_ADVERBS)) return true;
  if (furigana && !okurigana) return !!findOverride(text, "PRON");
  return false;
}

function sameToken(a: AnnotationToken, b: { text: string; furigana?: string; okurigana?: string; kunten?: string }): boolean {
  return a.text === b.text && a.furigana === b.furigana && a.okurigana === b.okurigana && a.kunten === b.kunten;
}

/** Parses edited annotation text (one sentence per line, see
 * `texAnnotation.ts`'s `generateAnnotationText`) back into per-sentence
 * `AnnotationToken[]`, for `renderAnnotationTokensToKundoku`/
 * `kakikudashiFromAnnotation` to re-render both panels from directly — no
 * dependency tree involved at all, this operates purely on the linear
 * kunten-annotated text, same as how a person actually reads kunten off a
 * page. `previous` (the last successfully rendered token set, if any) lets
 * an unchanged token keep its real `kanaOnly` flag across small edits
 * (matched by exact position + content) rather than falling back to
 * `inferKanaOnly` for the *whole* sentence just because one token in it
 * changed. */
export function parseAnnotationText(text: string, previous?: AnnotationToken[][]): AnnotationToken[][] {
  const CLOSING_PUNCT = new Set(["，", "。", "？", "！", "、", "；", "："]);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, sentenceIndex) => {
      const tokens: AnnotationToken[] = [];
      for (const m of line.matchAll(UNIT_RE)) {
        const [, base, furigana, okurigana, kunten] = m;
        const isPunct = CLOSING_PUNCT.has(base) || /\p{P}/u.test(base);
        const prev = previous?.[sentenceIndex]?.[tokens.length];
        const parsed = { text: base, furigana: furigana || undefined, okurigana: okurigana || undefined, kunten: kunten || undefined };
        const kanaOnly = prev && sameToken(prev, parsed) ? prev.kanaOnly : isPunct ? false : inferKanaOnly(base, parsed.furigana, parsed.okurigana);
        tokens.push({ ...parsed, isPunct, kanaOnly });
      }
      return tokens;
    });
}

/** Regenerates kakikudashibun text purely from a sentence's
 * `AnnotationToken[]` and their kaeriten marks — `executeKunten` recovers
 * the reading order, then each non-punct token contributes exactly what
 * `generateKakikudashi` itself would: kana-only (furigana+okurigana,
 * kanji dropped) for a grammar-word gloss, kanji+okurigana otherwise. */
function kakikudashiForSentence(tokens: AnnotationToken[]): string {
  const order = executeKunten(tokens.map((t) => t.kunten));
  return order
    .filter((i) => !tokens[i].isPunct)
    .map((i) => {
      const t = tokens[i];
      return t.kanaOnly ? (t.furigana ?? "") + (t.okurigana ?? "") : t.text + (t.okurigana ?? "");
    })
    .join("");
}

/** Full kakikudashibun for the whole edited text — sentences joined with
 * 、, terminated with 。, matching `generateKakikudashiForTree`'s own
 * convention (see there for why the join is positional rather than taken
 * from the source's own punctuation). */
export function kakikudashiFromAnnotation(sentences: AnnotationToken[][]): string {
  const bodies = sentences.map(kakikudashiForSentence);
  return bodies.map((body, i) => body + (i === bodies.length - 1 ? "。" : "、")).join("");
}

/** Rebuilds the kundoku panel DOM directly from edited `AnnotationToken`s —
 * source order, exactly the shape `KundokuView.ts`'s own cells already
 * have, so no dependency tree or reading-order computation is needed here
 * at all (the kundoku panel was always just source order + these same four
 * fields). */
export function renderAnnotationTokensToKundoku(sentences: AnnotationToken[][]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const column = document.createElement("div");
  column.className = "tategaki-column text-main";
  for (const tokens of sentences) {
    const wrapper = document.createElement("span");
    wrapper.className = "sentence-gap";
    for (const t of tokens) {
      const cell = document.createElement("span");
      cell.className = "kanji-cell";
      if (t.isPunct) {
        cell.append(t.text);
        wrapper.append(cell);
        continue;
      }
      if (t.kanaOnly) cell.dataset.kanaOnly = "true";
      const glyph = document.createElement("span");
      glyph.className = "kanji-glyph";
      glyph.append(t.text);
      if (t.kunten) {
        const mark = document.createElement("span");
        mark.className = "kunten-glyph";
        mark.textContent = t.kunten;
        glyph.append(mark);
      }
      if (t.furigana || t.okurigana) {
        const ruby = document.createElement("ruby");
        ruby.append(glyph);
        const rt = document.createElement("rt");
        if (t.furigana) rt.append(t.furigana);
        if (t.okurigana) {
          const oku = document.createElement("span");
          oku.className = "okurigana";
          oku.textContent = t.okurigana;
          rt.append(oku);
        }
        ruby.append(rt);
        if ((t.furigana?.length ?? 0) + (t.okurigana?.length ?? 0) >= 3) ruby.classList.add("rt-tall");
        cell.append(ruby);
      } else {
        cell.append(glyph);
      }
      wrapper.append(cell);
    }
    column.append(wrapper);
  }
  frag.append(column);
  return frag;
}
