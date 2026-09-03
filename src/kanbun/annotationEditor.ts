import { NEGATION_LEMMAS, SHIKAMO } from "../kakikudashi/conjugationContext.ts";
import {
  AUXILIARY_LEMMAS,
  SENTENCE_FINAL_PARTICLE_LEMMAS,
  SENTENCE_FINAL_WORD_LEMMAS,
  sentenceFinalParticle,
} from "../kakikudashi/bungoConjugation.ts";
// Membership only — which characters keep their kanji in the prose. This is the
// one reader of that table that never needs the division, which is why it is
// also the one that needs no kanjidic index: see `retainedAdverbOkurigana` in
// `kanjidicLookup.ts` for where the okurigana beside them comes from.
import { KANJI_RETAINED_ADVERBS } from "../reading/classicalEnding.ts";
import { REREAD_CHARACTERS } from "../kakikudashi/rereadCharacters.ts";
import { toHiragana } from "../render/kana.ts";
import { findOverride } from "../reading/overridesLookup.ts";
import { executeKunten } from "./kuntenExecutor.ts";
import { toDisplayKuntenMarks, toPlainKuntenMarks, type AnnotationToken } from "./texAnnotation.ts";

/** One CJK/punctuation base character, then optional `(furigana)`, then an
 * optional run of katakana/chōonpu okurigana, then an optional `[kunten]` —
 * see `texAnnotation.ts`'s `tokenToAnnotation` (the inverse of this). */
const UNIT_RE = /([^()[\]゠-ヿ])(?:\(([^)]*)\))?([゠-ヿ]*)(?:\[([^\]]*)\])?/gu;

/** Lemmas whose kanji `generateKakikudashi` drops from the running prose
 * *in their grammar-word use* (see `cellFor`'s `kanaOnly` doc for the full
 * branch list this mirrors) — used only as a *fallback* for a token with no
 * matching previous-render history to carry `kanaOnly` forward from (see
 * `parseAnnotationText`); a real render always tags this via the DOM
 * instead.
 *
 * **Membership is not by itself the answer, which is what the name once
 * claimed.** Nearly every character here also has an ordinary reading of
 * its own — 耳 is the noun みみ, 否 the verb いなむ, 未 the branch ひつじ, 教
 * the verb をしふ, 而 the pronoun なんぢ — and this set was tested first, so
 * it short-circuited every other rule and stripped the kanji off those
 * readings too: `耳(みみ)ヲ` came back through the round trip as みみを.
 *
 * The distinction wanted here is a part-of-speech one, and **this module
 * has no part of speech to consult and is not given one**: an
 * `AnnotationToken` carries only text/furigana/okurigana/kunten, and
 * `parseAnnotationText`'s `previous` is another array of the same, so
 * nothing at any call site has a tag or a tree to hand down. What *is*
 * present is the reading itself, and for these lemmas the reading already
 * draws the line: the particle 耳 is read のみ and the noun みみ. So this set
 * now only says "this character has a grammar-word use", and
 * `inferKanaOnly` decides from the kana whether that is the use in front of
 * it. */
const KANA_ONLY_GRAMMAR_LEMMAS: ReadonlySet<string> = new Set([
  ...NEGATION_LEMMAS,
  ...Object.keys(AUXILIARY_LEMMAS),
  ...SENTENCE_FINAL_PARTICLE_LEMMAS,
  "而",
  "於",
]);

/** The kana a grammar word of the set above puts *over* the character, in
 * the furigana slot — the one shape the two rules below cannot recognize on
 * their own, since they read a furigana as evidence of a dictionary reading.
 *
 * Every entry comes from the table that decides the reading for the panels
 * themselves rather than being restated here:
 *
 *  - `SENTENCE_FINAL_WORD_LEMMAS` is exactly the particles `cellFor` sets
 *    over the character instead of beside it — 也 なり, 耳 のみ.
 *  - `SHIKAMO` is 而's one connective reading of its own (而 しか + モ,
 *    against the plain て/して, which are endings on the word *before* 而 and
 *    carry no furigana at all).
 *  - `REREAD_CHARACTERS` supplies the 再読文字 first reading — 未 いまだ, 須
 *    すべからく, 當/應/応 まさに — which `cellFor`'s re-read branch likewise
 *    sets over the character. Narrowed to the characters already in the set
 *    above, so this stays a gate on those and does not quietly start
 *    claiming 猶 or 宜, which no rule here has ever spoken for.
 *
 * Anything else in the furigana slot on one of these characters is a reading
 * of the character rather than a gloss standing in for it: 未 ひつじ is the
 * earthly branch, 當 あたる the verb. */
const GRAMMAR_WORD_FURIGANA: ReadonlyMap<string, string> = new Map([
  ...[...SENTENCE_FINAL_WORD_LEMMAS].map((lemma) => [lemma, sentenceFinalParticle(lemma)] as const),
  ...Object.entries(REREAD_CHARACTERS)
    .filter(([text]) => KANA_ONLY_GRAMMAR_LEMMAS.has(text))
    .map(([text, entry]) => [text, entry.first] as const),
  ["而", SHIKAMO.reading!] as const,
]);

/** Best-effort `kanaOnly` guess for a token with no render history to match
 * against (a line the user typed from scratch, or edited enough that
 * position-matching against the previous parse fails) — see the module
 * doc's honesty note: this can't perfectly recover the distinction a real
 * render's `data-kana-only` attribute carries, since the plain annotation
 * text format itself doesn't encode it.
 *
 * Every rule here reasons from the *shape* of the annotation — which of the
 * two kana slots is filled — because that is what the format records, and
 * because `cellFor` puts a grammatical gloss and a dictionary reading in
 * different slots on purpose. In slot order:
 *
 *  1. **Neither slot filled, on a grammar-word character.** That is the
 *     render's blank-gloss shape and nothing else: 矣, whose entry is the
 *     empty string outright; 也/耳 with their particle suppressed by
 *     `repeatsPredicateCopula` (君子仁也 is 君子仁なり, not 仁なりなり); 而
 *     where the preceding 連用形 already supplied the して
 *     (`precedingFormSuppliesShite`). All four contribute nothing to the
 *     prose, which is what kana-only with no kana means. A content word is
 *     never written without a reading in this format.
 *  2. **Furigana that is the grammar word's own reading.** 也(なり),
 *     耳(のみ), 而(しか)モ, 未(いまだ) — see `GRAMMAR_WORD_FURIGANA`. This is
 *     where the noun 耳 parts company from the particle: 耳(みみ)ヲ falls
 *     straight past it and keeps its kanji, as 否(いな)ム and 教(をし)エル do.
 *  3. **Okurigana alone.** The negation (不ズ), the modal and causative
 *     auxiliaries (可ベシ, 使シム), 於ヨリ, the particles read beside the
 *     character (乎ヤ, 哉カナ, 焉リ, 否ヤ), 而テ/而シテ, and every other
 *     override-table gloss — all of them the same shape, a gloss in the
 *     okurigana slot with nothing read on the character. This rule already
 *     covered that whole group before the set was consulted at all, which
 *     is why none of them needs an entry above.
 *  4. **Furigana alone**, on a character the override table gives a pronoun
 *     reading: 之 これ and its like, a genuine word spelled out in the prose.
 *     Read strictly for a grammar-word character, and loosely for every
 *     other one, because `findOverride` answers a looser question than this
 *     rule asks: an entry carrying no `contextPos` at all is a candidate
 *     under *any* POS, so asking for "PRON" returns 使's own つかふ and 未's
 *     いまだ just as readily as 之's これ. On an ordinary character that is
 *     harmless enough to leave alone — a hand-picked dictionary reading and
 *     a pronoun gloss are both spelled out. On one of these it undoes rule
 *     2: 使(し) is the content verb, which rule 2 has just declined to claim,
 *     and rule 4 would claim it straight back. So here the entry has to name
 *     PRON itself — which 而's なんぢ does, and 使's つかふ does not.
 */
function inferKanaOnly(text: string, furigana: string | undefined, okurigana: string | undefined): boolean {
  const grammarWord = KANA_ONLY_GRAMMAR_LEMMAS.has(text);
  if (!furigana && !okurigana) return grammarWord;
  if (furigana && toHiragana(furigana) === GRAMMAR_WORD_FURIGANA.get(text)) return true;
  if (!furigana && okurigana && !(text in KANJI_RETAINED_ADVERBS)) return true;
  if (furigana && !okurigana) {
    const pronoun = findOverride(text, "PRON");
    return grammarWord ? !!pronoun?.contextPos?.includes("PRON") : !!pronoun;
  }
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
        // Either alphabet is accepted here — plain レ/一/二 as this format is
        // written, and the Kanbun-block ㆑/㆒/㆓ a person gets by copying the
        // panel itself — and both are recorded as the plain characters an
        // `AnnotationToken` carries. Normalizing on the way in rather than
        // where the marks are used is what lets a hand-typed line match a
        // scraped `previous` token (`sameToken` compares the field) and keep
        // its real `kanaOnly`.
        const parsed = { text: base, furigana: furigana || undefined, okurigana: okurigana || undefined, kunten: kunten ? toPlainKuntenMarks(kunten) : undefined };
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
 * kanji dropped) for a grammar-word gloss, kanji+okurigana otherwise.
 *
 * The kana are converted to hiragana here, and only here. Katakana okurigana
 * is the 訓読文's convention and this format's — `UNIT_RE` above identifies
 * the okurigana slot *by* its katakana range, so it has to stay katakana in
 * the text itself — but the 書き下し文 is the one register that rewrites the
 * sentence as running Japanese, where every kana is hiragana (the panel's
 * own `generateKakikudashi` never converts, because it works from the
 * hiragana its readings arrive in and never passes through the katakana the
 * 訓読文 cell displays). Applied to the whole assembled piece rather than to
 * the okurigana alone: the furigana slot is hiragana already, so this is a
 * no-op on it, and saying it of both leaves nothing to go wrong if a
 * hand-written line puts a katakana reading over a character. */
function kakikudashiForSentence(tokens: AnnotationToken[]): string {
  const order = executeKunten(
    tokens.map((t) => t.kunten),
    (i) => tokens[i].isPunct,
  );
  return order
    .filter((i) => !tokens[i].isPunct)
    .map((i) => {
      const t = tokens[i];
      return t.kanaOnly ? toHiragana((t.furigana ?? "") + (t.okurigana ?? "")) : t.text + toHiragana(t.okurigana ?? "");
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
        // Crammed into the gap, like every other mark of punctuation in this
        // panel — see `.punct-cell` in kunten.css.
        cell.classList.add("punct-cell");
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
        // Back into the Kanbun block on the way to the screen, which is what
        // `KundokuView.ts` puts there — so a mark a person typed as a plain
        // 一 is drawn as the annotation glyph ㆒ beside the character rather
        // than as an ideograph the size of one.
        mark.textContent = toDisplayKuntenMarks(t.kunten);
        glyph.append(mark);
      }
      if (t.furigana || t.okurigana) {
        const ruby = document.createElement("ruby");
        ruby.append(glyph);
        const rt = document.createElement("rt");
        // The two run lengths the placement rules are arithmetic in — see
        // `cellFor` in KundokuView.ts, which sets the same two.
        ruby.style.setProperty("--furi-run", String(t.furigana?.length ?? 0));
        if (t.furigana) {
          const furigana = document.createElement("span");
          furigana.className = "furigana";
          furigana.textContent = t.furigana;
          rt.append(furigana);
        }
        if (t.okurigana) {
          const oku = document.createElement("span");
          oku.className = "okurigana";
          oku.textContent = t.okurigana;
          oku.style.setProperty("--oku-run", String(t.okurigana.length));
          rt.append(oku);
        }
        ruby.append(rt);
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
