import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import type { CompoundSpan, JmdictIndex } from "../reading/jmdictLookup.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { type KanjidicIndex, seriesAmbiguousReading } from "../reading/kanjidicLookup.ts";
import { fullSizeKana, type HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { compoundFurigana } from "../reading/compoundFurigana.ts";
import { compoundSuruOkurigana } from "../reading/readingResolver.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../kundoku/kundokuTenAssigner.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { buildKundokuGlyphMap } from "./kundokuGlyphs.ts";
import { toKatakana } from "./kana.ts";
import {
  auxiliaryFormFor,
  caseParticleFor,
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  extraEndingFor,
  fixedExpressionPart,
  findRoot,
  isNamingUse,
  isNegationUse,
  isSentenceFinalParticleUse,
  negationEnding,
  nextMeaningfulToken,
  pickedEnding,
  quoteClosing,
  repeatsPredicateCopula,
  selectForm,
  conjugationSubject,
  lexiconEntryFor,
  teOrShite,
  usesLexiconEntry,
  yuParts,
  ziReading,
} from "../kakikudashi/conjugationContext.ts";
import { SENTENCE_FINAL_WORD_LEMMAS, sentenceFinalParticle } from "../kakikudashi/bungoConjugation.ts";
import { registerSentence, setupTokenInspector, setReadingIndex } from "./tokenInspector.ts";
import { chosenReadingParts, chosenReadingText } from "../reading/chosenReading.ts";
import { sourceLayoutOf } from "../parse/sourceLayout.ts";
import { BRACKETS, japanesePunct, OPENING_BRACKETS } from "../parse/punctuation.ts";
import { isRereadUse, rereadCharacter, rereadGovernedForm } from "../kakikudashi/rereadCharacters.ts";
import { VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";
import { retainedAdverbParts } from "../kakikudashi/generator.ts";

const PUNCT_DEP = "punct";

/** How many kana of annotation the lane beside a character can hold before
 * the reading and the okurigana together would have to run past the gap and
 * into the next character's own annotation — the point at which rule 5 sends
 * the reading to the lane outside.
 *
 * The character's own height plus the gap after it, over the height of one
 * kana: M(1 + g) / f, where g is `--kanji-gap-ratio`. Read off the type scale
 * rather than written down, since it is a fact about the sizes and would
 * otherwise be a further number to remember when any of them moved — the gap
 * ratio included, which is why typography.css states it as a bare number this
 * can read rather than only as the `calc()` the stylesheet uses.
 * `--size-main` and `--size-furigana` are declared on `:root` in rem, so the
 * root font size converts them.
 *
 * Falls back to the value the current scale gives if the document can't be
 * read — a cell built before the stylesheet has applied, or in a test — and
 * caches, since the scale doesn't change while the page is up. */
let annotationCapacityCache: number | null = null;
function annotationCapacity(): number {
  if (annotationCapacityCache !== null) return annotationCapacityCache;
  const fallback = 4;
  try {
    const root = getComputedStyle(document.documentElement);
    const rem = parseFloat(root.fontSize);
    const len = (name: string): number => {
      const raw = root.getPropertyValue(name).trim();
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return NaN;
      return raw.endsWith("rem") ? n * rem : raw.endsWith("px") ? n : NaN;
    };
    const main = len("--size-main");
    const furigana = len("--size-furigana");
    const gapRatio = parseFloat(root.getPropertyValue("--kanji-gap-ratio"));
    annotationCapacityCache =
      Number.isFinite(main) && Number.isFinite(furigana) && furigana > 0 && Number.isFinite(gapRatio)
        ? Math.floor((main * (1 + gapRatio)) / furigana)
        : fallback;
  } catch {
    annotationCapacityCache = fallback;
  }
  return annotationCapacityCache;
}

/** Opening quotes/brackets are the one class of punctuation Japanese
 * typesetting *allows* at the top of a new column (行頭禁則 — kinsoku shori —
 * forbids everything else there: 、。？！ closing brackets, etc.). Every
 * other punct token gets glued to the cell before it (see `appendPunct`)
 * so a column break can never fall between them and strand it at the top
 * of the next column.
 *
 * The lists themselves live in `parse/punctuation.ts`, which both panels now
 * read: the kakikudashibun has to classify the same mark the same way, and
 * two copies of the answer were two answers. */
const OPENING_PUNCT = OPENING_BRACKETS;
const BRACKET_PUNCT = BRACKETS;

/** Whether `token` is the last thing in its sentence that isn't a closing
 * bracket — 也。」 ends at the 。, not at the 」.
 *
 * The structural signal, and it decides only where the mark itself says
 * nothing (see `kundokuPunct`). It cannot be trusted on its own here,
 * because this parser segments *at* punctuation: 學而時習之，不亦說乎？有朋
 * 自遠方來。 comes back as three sentences ending in ，, ？ and 。 —
 * measured — so "last in its sentence" is true of the comma as well, and
 * splitting a sentence at a comma does not make the comma a full stop. */
function endsSentence(sentence: Sentence, token: Token): boolean {
  return sentence.tokens
    .filter((t) => t.id > token.id)
    .every((t) => BRACKET_PUNCT.has(t.text));
}

/** What the kundoku panel writes for a mark of punctuation, which is not
 * always what the source wrote — see `japanesePunct`, which both panels
 * write their marks through. */
const kundokuPunct = japanesePunct;

/** Appends a punctuation cell, gluing it to the previously-appended element
 * (whatever that was — a plain cell, a compound-group, or an earlier
 * glued unit) inside a `white-space: nowrap` wrapper unless it's an
 * opening quote/bracket. This guarantees 、/。/？/！/etc. can never end up
 * as the first character of a new tategaki column — plain CSS line-
 * breaking treats each `.kanji-cell` as an opaque atomic box and can't be
 * trusted to apply kinsoku shori *between* them the way it would for a
 * run of ordinary text. */
function appendPunct(frag: DocumentFragment, cell: HTMLElement, text: string): void {
  const prev = frag.lastElementChild;
  if (OPENING_PUNCT.has(text) || !prev) {
    frag.append(cell);
    return;
  }
  const glued = document.createElement("span");
  glued.className = "no-break-unit";
  prev.replaceWith(glued);
  glued.append(prev, cell);
}
/** How long an annotation switch takes to settle. Longer than the 160ms the
 * overlay and the menus fade in: this moves the text itself rather than
 * bringing a label up over it, and something the reader has to follow from
 * one place to another needs longer than something that merely appears. */
const REFLOW_MS = 260;

/** Runs `apply` — a change to which annotations are shown — and walks
 * everything it moves from where it was to where that leaves it.
 *
 * Nothing declarative can express this: what moves comes out of layout being
 * redone, which no transition covers. So the old position is measured, the
 * change applied, the new position measured, and the difference played back
 * as a displacement returning to zero.
 *
 * What actually moves is the okurigana, within its own cell. Rule 4 hangs
 * the reading from the character's top and pushes the okurigana clear of
 * where the reading ends, so switching the reading off releases the push and
 * the kana slide back up to where rule 3 alone puts them. `.okurigana`'s
 * `top` is what states that — a `max()` of the two rules over `--furi-run`,
 * which `body.hide-furigana rt` zeroes (see kunten.css) — so `top` is what
 * is walked, from the value the old layout resolved it to to the value the
 * new one does.
 *
 * A small move on most characters and a real one on a few. Of the 26
 * okurigana in 學而時習之…, 18 do not move at all, six move 1.6px (a one-kana
 * ending under a reading that reaches just past the character's foot), and
 * 自's ラ and 樂's シカラ move 16.8px — measured, both switches exercised.
 * The `< 0.5px` guard is what keeps the 18 still: a character whose reading
 * never reached its okurigana has no push to be released from, and nothing
 * there should stir while the two that do travel are travelling.
 *
 * The characters themselves no longer move at all, and the walk over the
 * cells is kept against the day they do. It was written when the <rt> was
 * still in flow, where switching a layer off shortened the annotation column
 * beside each character and every character after it came up to close the
 * gap — 32 of 36 characters moving, 13 into a different column, the furthest
 * by 314px. Every annotation is out of flow now (see kunten.css's header),
 * so a cell is exactly one character tall whatever it carries and no switch
 * shortens anything: measured on the same passage, 0 of 36 cells move, on
 * all three switches. Nothing here special-cases that — a `.kanji-cell` is
 * an inline *block* and takes a transform, which carries its annotations
 * with it, so anything that goes back into flow is covered without being
 * asked, and until then every cell measures as having stayed put and none is
 * animated.
 *
 * Which is also why the okurigana takes a `top` and not a transform of its
 * own: the cell's transform already applies to it, so a second one would
 * have to be measured against the cell to keep from counting the cell's
 * travel twice, where the two resolved `top`s are this movement itself and
 * say nothing about what the cell is doing. */
export function animateAnnotationShift(apply: () => void): void {
  const cells = [...document.querySelectorAll<HTMLElement>("#kundoku-view .kanji-cell")];
  const cellsBefore = cells.map((c) => c.getBoundingClientRect());
  const okurigana = cells.map((c) => c.querySelector<HTMLElement>(".okurigana"));
  const okuBefore = okurigana.map(resolvedTop);

  apply();

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  cells.forEach((cell, i) => {
    const now = cell.getBoundingClientRect();
    const dx = cellsBefore[i].left - now.left;
    const dy = cellsBefore[i].top - now.top;
    if (typeof cell.animate !== "function") return;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    cell.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: REFLOW_MS,
      easing: "ease-out",
    });
  });

  // Measured after the loop above has already started animating the cells,
  // which costs nothing here: those are transforms, and a transform does not
  // touch `top`. Every animation created in this one task shares a start
  // time, so the two travel together whatever order they were asked for in.
  okurigana.forEach((oku, i) => {
    if (!oku || typeof oku.animate !== "function") return;
    const from = okuBefore[i];
    const to = resolvedTop(oku);
    if (from === null || to === null) return;
    if (Math.abs(from - to) < 0.5) return;
    oku.animate([{ top: `${from}px` }, { top: `${to}px` }], { duration: REFLOW_MS, easing: "ease-out" });
  });
}

/** Where `top` has actually resolved to for an okurigana that is on the
 * screen, or null for one that isn't.
 *
 * The used value, which is what `getComputedStyle` gives for a positioned
 * element with a box, and is the only form of it there is to walk between:
 * the declaration is a `max()` over a custom property and resolves to a
 * different number on either side of the switch.
 *
 * The box is what decides whether there is anything to walk. The okurigana
 * switch takes the run out with `display: none`, and the two switches
 * together take the whole `<rt>` out, so a run can be missing a box on one
 * side of the change and have one on the other — and something that was not
 * on the screen a moment ago has not travelled to where it now is. It
 * appears where it belongs, as it always did. */
function resolvedTop(oku: HTMLElement | null): number | null {
  if (!oku || !oku.getClientRects().length) return null;
  const top = parseFloat(getComputedStyle(oku).top);
  return Number.isFinite(top) ? top : null;
}

/** Furigana (a content word's dictionary reading) is hiragana; okurigana
 * (inflectional kana, and — per the same convention real kanbun annotation
 * uses — a *function word's* reading generally, since it's a grammatical
 * gloss rather than an independent word's pronunciation) is katakana. Both
 * live in the same `<rt>`, which is the lane beside the character; each is
 * wrapped in a span of its own and placed there by its own rule, the
 * furigana against the character's top and the okurigana against its foot
 * (rules 3 and 4 — see kunten.css). Every annotation is positioned against
 * `.kanji-glyph`, the box that is exactly the character.
 *
 * How long each run is goes onto the element as a custom property, since
 * the rules are arithmetic in the two lengths and CSS cannot count
 * characters. Counted rather than measured, and exact: these are kana set
 * vertically at `line-height: 1`, where every one advances a full em of its
 * own size, small kana included. */
/** `kanaOnly`: marks this cell with `data-kana-only` — purely a hook for
 * `kanbun/texAnnotation.ts`'s DOM-scraper, which needs to know (something
 * the DOM otherwise doesn't expose) whether *this exact token* is one whose
 * kanji `generateKakikudashi` drops entirely in the running prose (a
 * grammar-word gloss — discourse particles, negation, modal auxiliaries,
 * 而, 於, and any other override-table reading) versus a content word whose
 * kanji it keeps. Never affects rendering — the kundoku panel shows the
 * base glyph either way. */
export function cellFor(
  base: string,
  reading: string | undefined,
  okurigana: string | undefined,
  kunten: string | undefined,
  tokenId: number,
  kanaOnly = false,
  /** A 再読文字's second reading, set down the character's left-hand side —
   * see `.reread-second`. */
  rereadSecond?: string,
): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "kanji-cell";
  cell.dataset.tokenId = String(tokenId);
  if (kanaOnly) cell.dataset.kanaOnly = "true";

  const glyph = document.createElement("span");
  glyph.className = "kanji-glyph";
  glyph.append(base);

  if (kunten) {
    const mark = document.createElement("span");
    mark.className = "kunten-glyph";
    mark.textContent = kunten;
    glyph.append(mark);
  }

  // Anchored inside `.kanji-glyph` like the kunten mark, and for the same
  // reason: it belongs the same distance from the character itself as the
  // furigana on the other side, and `.kanji-cell`'s box is stretched by the
  // ruby.
  if (rereadSecond) {
    const second = document.createElement("span");
    second.className = "reread-second";
    second.textContent = toKatakana(rereadSecond);
    // How long the run is, for the placement arithmetic in `.reread-second`:
    // it has to know its own height to centre itself against the character,
    // and to tell whether it is too tall to be centred at all. Counted rather
    // than measured, and exact — these are all plain kana set vertically at
    // `line-height: 1`, where every character advances one full em, small
    // kana included. Two of them fit beside a 44px character at the furigana
    // size; がごとし's five do not.
    second.style.setProperty("--reread-run", String(rereadSecond.length));
    glyph.append(second);
  }

  if (reading || okurigana) {
    const ruby = document.createElement("ruby");
    ruby.append(glyph);
    const rt = document.createElement("rt");
    // How far down the lane the reading reaches, which is what the okurigana
    // has to be pushed clear of (rule 4). On the <ruby> rather than inline on
    // the <rt>, so the rules that have to cancel the push — the reading
    // switched off, or sent outside — can override it on the <rt> itself
    // rather than losing to an inline style.
    ruby.style.setProperty("--furi-run", String(reading?.length ?? 0));
    if (reading) {
      // Wrapped rather than appended as bare text so that furigana and
      // okurigana — which share this one <rt> — can be shown and hidden
      // independently of each other.
      const furigana = document.createElement("span");
      furigana.className = "furigana";
      furigana.textContent = reading;
      rt.append(furigana);
    }
    if (okurigana) {
      const oku = document.createElement("span");
      oku.className = "okurigana";
      oku.textContent = toKatakana(okurigana);
      // Which kana sits level with the character's foot is a function of how
      // many there are (rule 3), so the count goes to CSS.
      oku.style.setProperty("--oku-run", String(okurigana.length));
      rt.append(oku);
    }
    // Rule 5. The two runs share one lane, the reading from the character's
    // top and the okurigana at its foot, and where they cannot both fit it is
    // the reading that gives way — the okurigana stays where rule 3 puts it,
    // and the reading moves to the lane outside rather than the characters
    // moving apart to make room.
    if ((reading?.length ?? 0) + (okurigana?.length ?? 0) > annotationCapacity()) {
      ruby.classList.add("reading-outside");
    }
    ruby.append(rt);
    cell.append(ruby);
  } else {
    cell.append(glyph);
  }

  return cell;
}

/** Extra okurigana this token needs beyond its own reading — a morph-driven
 * auxiliary, or a synthesized copula for a bare nominal-predicate root —
 * appended to whatever okurigana the token already has. Same source of
 * truth as the kakikudashi generator (`conjugationContext.ts`), so a なり
 * the generator inserts out of nothing (no source token at all) still
 * shows up here, attached to the predicate it belongs to. */
function withExtraEnding(okurigana: string | undefined, token: Token, root: Token | undefined, plan: ReadingPlan): string | undefined {
  const extra = extraEndingFor(token, root, plan.sentence);
  if (!extra) return okurigana;
  return (okurigana ?? "") + selectForm(extra, plan, token.id);
}

/** A case particle (を/に) this token takes, appended as trailing okurigana
 * — see `caseParticleFor`. Kundoku conventionally supplies this even though
 * nothing in the source text realizes it, same as the kakikudashi generator
 * appends it directly to the word's own text. */
function withCaseParticle(okurigana: string | undefined, token: Token, sentence: Sentence): string | undefined {
  const particle = caseParticleFor(token, sentence);
  if (!particle) return okurigana;
  return (okurigana ?? "") + particle;
}

/** The closing of a quoted/reported-speech complement of a speech verb
 * (rendered katakana in the okurigana slot per the usual function-word
 * convention) on the token that ends it — see `ReadingPlan.quoteEndIds` and
 * `depClassification.ts`'s `isSpeechQuoteComplement`. Applied as the
 * outermost wrap in every dispatch branch below, since the quote can end on
 * any kind of token (a plain verb, a sentence-final particle, a negation,
 * the last member of a compound...).
 *
 * What is appended is `quoteClosing`'s and not a bare と: the quoted complement
 * of a verb of *asking* is a question, and a question closes 〜やと — the や
 * inside the quotation, where it is what makes the quoted sentence a question,
 * and the と outside it, where it is what reports the quotation. 問：「需何藥？」
 * drew 需 フト here against a prose panel already writing 需ふやと. Both panels
 * now call the one function, which is that function's own stated reason for
 * existing. */
function withQuoteEnd(okurigana: string | undefined, tokenId: number, plan: ReadingPlan): string | undefined {
  if (!plan.quoteEndIds.has(tokenId)) return okurigana;
  return (okurigana ?? "") + quoteClosing(tokenId, plan);
}

/** Just the furigana-reading half of the per-token dispatch below — used
 * for an ordinary standalone token (as `reading`) and, individually, for
 * each member of a compound span or multi-character token (see the span
 * and multi-character branches in `renderSentence`): each character gets
 * its own reading, never a single fused whole-word reading spanning the
 * group. Negation/discourse/auxiliary/而 tokens never appear as compound
 * members in this treebank (those relations mark grammatical function
 * words, not nominal compounds), so this only needs the ziReading/
 * VERB_LEXICON/override/kanjidic paths. */
/** A `VERB_LEXICON` entry's own `reading` (see that file's doc for why this
 * can't just be `kanjidicLookup.ts`'s generic kun'yomi lookup), historical-
 * kana-corrected the same way the generic kanjidic path is — the same
 * `historicalKana[token.text][reading]` lookup `lookupKanji` makes, keyed by
 * *kanji spelling* for the same cross-homonym-safety reason documented there,
 * and then the same `fullSizeKana` fold over what it does not cover.
 *
 * The lexicon's readings come from Wiktionary's classical conjugation tables
 * and are written historically already, which is the whole reason it is
 * preferred to kanjidic here — but only where the extraction found such a
 * table. Where it did not, the reading it fell back on is a modern one, and
 * 39 entries carry a small kana because of it (則 のっと, 仰 おっしゃ, 尊
 * たっと, 全 まった). Those reach the page through this function and nothing
 * else: `generator.ts` keeps the kanji in the running prose and shows only
 * the okurigana, so this is the one place a lexicon reading is displayed.
 *
 * …and the same *guard* on that lookup, which is what `kanjidicLookup.ts`
 * shares `seriesAmbiguousReading` for. The index records no series, so a
 * reading a character has in both of them cannot be looked up there at all —
 * 謂's kun stem い collided with its on'yomi イ, whose derived ゐ this
 * function then drew over the character: 謂 printed ゐフ where 謂ふ is いフ.
 * The generic kanjidic path has refused that lookup for as long as the index
 * has existed, and this path is where a character with a lexicon entry — 謂
 * has one, 四段ハ行 — went instead. */
function lexiconFurigana(token: Token, historicalKana: HistoricalKanaIndex | null, kanjidic?: KanjidicIndex | null): string | undefined {
  const reading = VERB_LEXICON[token.lemma]?.reading;
  if (!reading) return undefined;
  if (seriesAmbiguousReading(kanjidic, token.text, reading)) return fullSizeKana(reading);
  return historicalKana?.[token.text]?.[reading] ?? fullSizeKana(reading);
}

export function furiganaFor(
  token: Token,
  sentence: Sentence,
  resolve: ReadingResolver,
  historicalKana: HistoricalKanaIndex | null,
  /** Optional, and consulted for one thing only: whether the lexicon reading
   * below may be looked up in the historical-kana index at all (see
   * `lexiconFurigana`). Omit it — as a test with no index loaded does — and
   * every reading comes back exactly as it did before the guard existed. */
  kanjidic?: KanjidicIndex | null,
): string | undefined {
  // Ahead of every rule below, for the same reason the resolver checks it
  // first: this is a correction of whatever they would have produced.
  const chosen = chosenReadingText(token);
  if (chosen) return chosen;
  // A lexicalised formula's own reading, ahead of every rule that would work
  // one out — the same position the render loop below gives it, and it has to
  // be asked here too rather than only there. This function is what the
  // 書き下し文 panel asks for the reading it draws over a word (see
  // `KakikudashiView.ts`'s `readingsOf`), so leaving it out put たふ — the
  // resolver's on'yomi — over the 答 of 劉答言 in one panel while the other
  // showed こた. Two panels showing two readings of one character is the
  // failure this shared route exists to prevent.
  const formula = fixedExpressionPart(token, sentence);
  if (formula) return formula.reading;
  const zi = ziReading(token, sentence);
  if (zi) return zi;
  const resolved = resolve(token, sentence);
  // A reading the *syntax* chose outranks the lexicon, which holds one
  // reading per lemma and so cannot express a choice that varies within the
  // sentence: 立 is たツ or たテル depending on whether it has an object, and
  // 破 is read on'yomi inside 大破. See `readingResolver.ts`'s `beatsLexicon`.
  // Consulted only for that flag, so every lemma nothing in the sentence
  // moved still goes through the lexicon exactly as before.
  // `usesLexiconEntry` is the same POS gate the okurigana branch below puts on
  // the same lookup — shared rather than restated, so the two cannot drift.
  // It was missing here, and the drift was on screen: 縛/驚/覺/解 arrive PROPN
  // from the parser, failing the gate below and passing this one, so each was
  // glossed with its lexicon kun'yomi in the prose (which reads its ruby from
  // this function) beside the resolver's on'yomi in the 訓読文.
  if (usesLexiconEntry(token) && VERB_LEXICON[token.lemma] && !resolved.beatsLexicon) {
    return lexiconFurigana(token, historicalKana, kanjidic);
  }
  if (resolved.spellOutInProse && token.pos !== "PRON") return undefined; // written out in kana, so nothing goes over the character
  return resolved.reading || undefined;
}

/** Whether a compound's members are about to be pulled apart, and so need
 * the connecting line drawn between them.
 *
 * The line is not decoration and not a claim that these characters are one
 * word — the characters say that themselves, standing side by side. It is
 * there for the one case where standing side by side stops meaning it: the
 * kaeriten take the eye off the column, and a reader following them has to
 * be told that these two are read together anyway. Where nothing comes
 * between the members, nothing has to be said, and a line drawn there is a
 * mark on the page answering a question no reader asked.
 *
 * Two ways they come apart, and the second is the one that fires today:
 *
 *  - the reading order separates them — some other token is read between
 *    two characters that are written together. This cannot currently
 *    happen, and deliberately: `computeReadingOrder` is handed the same
 *    `findCompoundSpans` result this panel renders from, and emits a span's
 *    token ids together in source order wherever its carrier would have
 *    gone (see `emit` in reorderEngine.ts), so a span is contiguous in
 *    `plan.order` by construction. It is checked anyway because it is the
 *    thing the line is *for*, and because that guarantee lives in another
 *    file: if the engine ever places a member on its own, the line has to
 *    appear without anyone remembering to ask for it here. A single fused
 *    token's members share one id and can never be separated at all.
 *
 *  - a kaeriten lands between them. A mark is written below its character
 *    (rule 6), so a mark under any member but the last falls in a gap
 *    *inside* the group — the reader is being sent away from the column
 *    from a point halfway through the compound. That is exactly the case
 *    the line exists for. A mark under the last member sits after the
 *    whole group and takes the group with it, so it needs no line.
 *
 *    Which member carries a mark is a fact about the parse, not about the
 *    span: `buildKundokuGlyphMap` marks a splice group's `rankTokenIds`,
 *    and an INVERT group names the *last*-read token of each child (so a
 *    span read as a child is marked on its last member) but the span's own
 *    `carrierOf` where the span is the group's governor — and a carrier can
 *    be any member. 教誨其子 is the case: 教誨 is the governor of an
 *    inverted 其子, `carrierOf` picks 教 (誨 is attached to it from inside
 *    the span), and the ㆓ is written under 教, between the two characters. */
function compoundNeedsTie(members: { kunten: string | undefined; id: number }[], plan: ReadingPlan): boolean {
  if (members.slice(0, -1).some((m) => m.kunten)) return true;

  const ids = [...new Set(members.map((m) => m.id))];
  if (ids.length < 2) return false;
  const ranks = ids.map((id) => plan.order.indexOf(id));
  // A member the plan never places says nothing either way — treat the
  // group as whole rather than tying it on the strength of a missing id.
  if (ranks.some((rank) => rank < 0)) return false;
  return Math.max(...ranks) - Math.min(...ranks) !== ranks.length - 1;
}

/** Renders a compound's members (either a real multi-token span, or the
 * individual characters of a single token the tokenizer already fused —
 * see the two call sites in `renderSentence`) with exactly the same
 * conventions either way: each member is a plain, individually-spaced
 * `.kanji-cell` with its own furigana; one shared group-level okurigana
 * (case particle / extra ending, keyed off `groupToken`'s own dep/pos —
 * the span's carrier, or the token itself for a single fused token)
 * attaches only to the last member; `.compound-group` draws the kanbun
 * connecting line between the characters (see kunten.css), when the
 * kaeriten are about to break them up (see `compoundNeedsTie`). */
function compoundGroupCell(
  members: { text: string; furigana: string | undefined; kunten: string | undefined; id: number }[],
  groupToken: Token,
  lastMemberId: number,
  root: Token | undefined,
  plan: ReadingPlan,
  suru?: string,
): HTMLElement {
  // `suru` — the group's own サ変 ending, for a span JMdict lists as a
  // する-verb — stands *in place of* the copula/morph ending, not beside it,
  // mirroring the per-token lexicon branch below (which skips its own
  // `extraEndingFor` for the same reason): a word carrying its own conjugated
  // ending has said everything the sentence needs of it, and 蠕動シナリ is not
  // a form. Passed in rather than worked out here because only one of this
  // function's two call sites can have one — the other renders a single token
  // the *tokenizer* fused, which is not a span and has no span reading to
  // conjugate.
  const extra = suru === undefined ? extraEndingFor(groupToken, root, plan.sentence, true) : undefined;
  const groupOkurigana = withQuoteEnd(
    withCaseParticle(suru ?? (extra ? selectForm(extra, plan, lastMemberId) : undefined), groupToken, plan.sentence),
    lastMemberId,
    plan,
  );
  const group = document.createElement("span");
  group.className = "compound-group";
  // A data attribute rather than a second class: the class is what makes
  // this a group at all (the positioning parent every member's geometry is
  // measured against, and what `positionCompoundLines` walks), and whether
  // the line is drawn is a state of that group rather than a different kind
  // of thing.
  //
  // It is also what decides whether the group may break across a column:
  // being one word is no reason to hold characters back from the column end
  // (a printed text wraps a compound like anything else), but a *tie* is a
  // mark drawn down the gap between the members, and a mark cannot be made
  // across a column boundary. So the constraint is hung off this same
  // attribute — see `.compound-group[data-tied]` in kunten.css — rather than
  // off a second test that could come to disagree with this one.
  if (compoundNeedsTie(members, plan)) group.dataset.tied = "true";
  members.forEach((member, i) => {
    const isLast = i === members.length - 1;
    group.append(cellFor(member.text, member.furigana, isLast ? groupOkurigana : undefined, member.kunten, member.id));
  });
  return group;
}

/** One blank character cell — 一字下げ, the indent a new paragraph takes in
 * Japanese typesetting.
 *
 * An element rather than a bare ideographic space, because this panel's
 * character spacing is a margin on `.kanji-cell` rather than letter-spacing
 * on an ancestor (see kunten.css): a plain space would occupy a glyph's
 * width but not the gap that follows it, so an indent of n cells came out
 * narrower than the n characters it is meant to line up with. */
function indentCell(): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "indent-cell";
  cell.textContent = "\u3000";
  return cell;
}

/** Reproduces the source's own line structure ahead of `token`.
 *
 * A `<br>` starts a new column here, this text being vertical: lines in the
 * source become columns on the page, which is what a line break *is* in
 * tategaki.
 *
 * Indentation is one blank cell per leading whitespace character in the
 * source, so what was typed is what appears, just measured in characters
 * rather than in spaces. A new paragraph takes one cell where the source
 * gave it none; where the source indented it, that indent stands rather
 * than being added to. */
function appendSourceBreak(frag: DocumentFragment, token: Token): void {
  const layout = sourceLayoutOf(token);
  if (!layout) return;
  if (layout.breakBefore) frag.append(document.createElement("br"));
  const cells = layout.indent > 0 ? layout.indent : layout.breakBefore === "para" ? 1 : 0;
  for (let i = 0; i < cells; i++) frag.append(indentCell());
}

function renderSentence(
  sentence: Sentence,
  resolve: ReadingResolver,
  root: Token | undefined,
  plan: ReadingPlan,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
): DocumentFragment {
  const glyphs = buildKundokuGlyphMap(plan);
  const spans = findCompoundSpans(sentence);

  const spanStart = new Map<number, CompoundSpan>();
  const spanMember = new Set<number>();
  for (const span of spans) {
    spanStart.set(span.tokenIds[0], span);
    for (const id of span.tokenIds) spanMember.add(id);
  }

  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const frag = document.createDocumentFragment();

  for (const token of [...sentence.tokens].sort((a, b) => a.id - b.id)) {
    if (spanMember.has(token.id) && !spanStart.has(token.id)) continue; // already rendered as part of its span

    appendSourceBreak(frag, token);

    const span = spanStart.get(token.id);
    if (span) {
      // extraEndingFor's root check needs the *carrier* (the member that
      // actually carries the span's syntactic relation), but selectForm's
      // "what comes next in reading order" check needs the *last* member's
      // own position — the group's shared ending attaches after the whole
      // span, so it's the last member's neighbor (e.g. a following
      // negation), not the carrier's own neighbor, that decides mizen vs.
      // shuushi (君子 -> 君子ならずや, mizen from what follows 子, even
      // though 君 — the carrier — is what makes it root-nominal).
      const carrier = carrierOf(span, sentence);
      const lastMemberId = span.tokenIds[span.tokenIds.length - 1];
      const spanTokens = span.tokenIds.map((id) => byId.get(id)!);
      const chars = spanTokens.map((t) => t.text);
      const furiganas = compoundFurigana(chars, span.text, jmdict, kanjidic, historicalKana, (i) => furiganaFor(spanTokens[i], sentence, resolve, historicalKana, kanjidic));
      const members = span.tokenIds.map((id, i) => ({ text: chars[i], furigana: furiganas[i], kunten: glyphs.get(id), id }));
      // A span JMdict lists as a する-verb conjugates サ変, exactly as 獨酌スル
      // and 封シテ do — 蠕動 was drawn as two bare characters until it did. The
      // string is `compoundSuruOkurigana`'s, shared with generator.ts's own
      // span branch so that the ending hung off this group's last member and
      // the one that panel prints after the same span cannot come apart.
      frag.append(
        compoundGroupCell(members, carrier, lastMemberId, root, plan, compoundSuruOkurigana(carrier, lastMemberId, plan, resolve)),
      );
      continue;
    }

    // The part of speech as well as the relation: a mark left alone in a
    // sentence of its own — which is what the segmenter does with a closing
    // quote after a full stop — heads that sentence and so is tagged ROOT,
    // and was being drawn as though it were a character of the text.
    if (token.dep === PUNCT_DEP || token.pos === "PUNCT") {
      const cell = document.createElement("span");
      // `punct-cell` is what takes its advance away again: a mark of
      // punctuation is crammed into the space between two characters rather
      // than being given a place of its own in the line (rule 2 — see
      // kunten.css).
      cell.className = "kanji-cell punct-cell";
      cell.dataset.tokenId = String(token.id);
      const written = kundokuPunct(token.text, endsSentence(sentence, token));
      // A bracket is set a step below the rest of the apparatus — see
      // `.punct-cell[data-punct-bracket]` in kunten.css. Marked from the
      // written mark rather than the source one, since that is what is on
      // the page and what the rule colours.
      if (BRACKET_PUNCT.has(written)) cell.dataset.punctBracket = "true";
      cell.append(written);
      appendPunct(frag, cell, token.text);
      continue;
    }

    // The tokenizer itself sometimes fuses a nominal compound (e.g. 君子)
    // into one multi-character token instead of two linked by `flat` — from
    // the display's perspective this should look identical to a real
    // multi-token span either way (individual per-character furigana, one
    // connecting line, one shared okurigana on the last character), so it
    // goes through the exact same rendering, keyed off this one token's own
    // dep/pos throughout (there's only one token's worth of grammatical
    // information to go on).
    if (token.text.length > 1) {
      const chars = [...token.text];
      const tokenKunten = glyphs.get(token.id);
      // The hand-picked reading goes to `compoundFurigana` rather than being
      // left to the per-character fallback, because the two would ask for it
      // in different units: this one token's `misc` holds one reading for the
      // whole word, and `furiganaFor` — asked here about a single character
      // at a time, with the token's own `misc` still attached — hands that
      // whole-word reading back for *every* character. `compoundFurigana`
      // divides it across them instead, and (this is what keeps the fallback
      // safe) never reaches the fallback at all once it has one.
      const furiganas = compoundFurigana(chars, token.text, jmdict, kanjidic, historicalKana, (i) => furiganaFor({ ...token, text: chars[i] }, sentence, resolve, historicalKana, kanjidic), chosenReadingText(token));
      const members = chars.map((ch, i) => ({
        text: ch,
        furigana: furiganas[i],
        // Only one real token id exists for the whole fused run, so any
        // kunten mark it carries can only be shown once — attached to the
        // last character, same as the group's shared okurigana — and every
        // member shares that one token's own id for click-to-inspect.
        kunten: i === chars.length - 1 ? tokenKunten : undefined,
        id: token.id,
      }));
      frag.append(compoundGroupCell(members, token, token.id, root, plan));
      continue;
    }

    // Ahead of every branch below, which claim these characters on features
    // they genuinely have (未 is tagged Polarity=Neg, 須 comes through as an
    // auxiliary) and would print the second reading as this cell's own
    // okurigana — 未 rendered as 未ズ, with the negation sitting before the
    // verb it negates instead of after it. Both readings belong to this
    // character, but on opposite sides of it.
    if (isRereadUse(token, sentence)) {
      const entry = rereadCharacter(token.text)!;
      frag.append(cellFor(token.text, entry.first, undefined, glyphs.get(token.id), token.id, false, entry.second));
      continue;
    }

    // A reading picked by hand outranks every context-specific reading below
    // it — the grammar-word branches, 子's and 於's special cases, and the
    // lexicon — because each of those is this app's own guess at what the
    // character is doing, and the choice is the reader overruling that guess.
    // They ignored it: 未 with ひつじ picked went on rendering as 未ズ, and the
    // whole point of picking a reading is that it appears.
    //
    // Behind the re-read check, not in front of it, since that consults the
    // choice itself (see `isRereadUse`) — a re-read reaching this line has
    // been left in its construction by that check, or was never in one.
    //
    // This branch's standing hazard — that sitting above everything means
    // silently skipping everything, which three separate bugs have come out
    // of — is written out at its twin in generator.ts. Read it before adding
    // a rule below this line.
    //
    // Furigana rather than the okurigana slot the branches below use, and the
    // kanji kept: a picked reading comes off the kanjidic candidate list, so
    // it is a dictionary reading of the character rather than a grammatical
    // gloss standing in for it (see `chosenReading`'s own note on the tag).
    //
    // The ending is inflected for where the character stands rather than left
    // in its dictionary form, and the sentence still gets whatever ending it
    // needs of this token — a synthesized なり/あり included, which this
    // branch used to drop by `continue`ing past `extraEndingFor`.
    // `pickedEnding` decides both, and is shared with generator.ts so the two
    // panels cannot come to disagree about them. Concatenated here rather
    // than kept apart, which is all the difference between the panels: a cell
    // has one okurigana slot, where the prose has a piece per part.
    const picked = chosenReadingParts(token);
    if (picked) {
      const ending = pickedEnding(picked, token, root, plan, resolve);
      frag.append(
        cellFor(
          token.text,
          picked.reading,
          withQuoteEnd(withCaseParticle(ending.okurigana + ending.extra || undefined, token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    // A lexicalised formula — 答曰 and its three siblings, read 答へて曰はく —
    // ahead of every branch that would work the reading out, exactly as in
    // generator.ts and in the same place relative to the hand-picked reading
    // above. The two panels call one function for it (`fixedExpressionPart`),
    // which is what divides the reading across the characters: こた over 答
    // with ヘテ beside it, い over 曰 with ハク beside it, rather than one kana
    // run spanning both. Nothing here moves a token, so the kunten this
    // sentence already carried are untouched.
    const formula = fixedExpressionPart(token, sentence);
    if (formula) {
      frag.append(
        cellFor(
          token.text,
          formula.reading,
          withQuoteEnd(formula.okurigana, token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    // 子: し ("master/teacher") unless it carries its own possessive
    // modifier, in which case こ ("child") — see `ziReading`. Checked here,
    // ahead of the generic kanjidic fallback below (which would otherwise
    // always give こ, kanjidic's own default reading, regardless of context).
    const zi = ziReading(token, sentence);
    if (zi) {
      frag.append(
        cellFor(
          token.text,
          zi,
          withQuoteEnd(withCaseParticle(withExtraEnding(undefined, token, root, plan), token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    // 於 always inverts before its governor and reads either より
    // (source/standard of comparison) or おいて (bare location) — see
    // `yuParts`, which is the one place the two senses are told apart.
    // Checked here, ahead of the generic override fallback below, purely so
    // this shares the same `withQuoteEnd`/okurigana treatment as the other
    // special-cased function words above rather than going through the plain
    // override lookup.
    //
    // The split `yuParts` returns is the split between the two slots, and it
    // is the same one `generator.ts` writes in the prose:
    //
    //  - **より is a case particle**, so it carries no reading of its own and
    //    the character is not written at all in the prose — 取之於藍 is
    //    藍より取る. Okurigana slot only, and `kanaOnly`, which is what tells
    //    `texAnnotation.ts` the prose drops this kanji.
    //  - **おいて is a verb form and keeps its kanji** — 日中に於いて, never
    //    日中におい て. お goes over the character and いて beside it, so the
    //    two panels show the same word, and the cell is *not* `kanaOnly`: the
    //    prose writes 於 out. The boundary is お + いて and not おい + て — see
    //    `yuParts` for KANJIDIC2's two entries and why 於ける settles it.
    const yu = yuParts(token, sentence);
    if (yu) {
      frag.append(
        cellFor(
          token.text,
          yu.reading,
          withQuoteEnd(yu.okurigana, token.id, plan),
          glyphs.get(token.id),
          token.id,
          yu.reading === undefined,
        ),
      );
      continue;
    }

    // Sentence-final particles, postposed negation, and modal auxiliaries
    // (可/能/須/當/應/欲) are all grammatical markers, not an independent
    // word's dictionary reading — their reading goes in the *okurigana*
    // slot (katakana, bottom-right), never furigana, same convention as
    // real kanbun annotation. All three also get their reading from the
    // same single source of truth the kakikudashi generator uses
    // (sentenceFinalParticle/NEGATION/AUXILIARY_LEMMAS+selectForm), rather
    // than whatever readingResolver's independently-curated override table
    // happens to give, so the two panels can't silently disagree — and
    // 可's mizenkei chains correctly before a following negation (不可 ->
    // べからず), not a bare "べし"+ず.
    // `isSentenceFinalParticleUse` stands beside the dep test, not in place of
    // it, and for the reasons generator.ts's copy of this condition gives: the
    // dep test admits every `discourse` token whether or not the table knows
    // its lemma, and the predicate adds the one particle the parser mis-tags —
    // 否 in 君飲嘗不醉否？, which arrives VERB/`comp:obj` and was showing the
    // verb 否ム. Both panels test the same thing here so that neither can read
    // the character differently from the other.
    if (token.dep === "discourse" || token.dep === "discourse@sp" || isSentenceFinalParticleUse(token, sentence)) {
      // A particle whose kana are read *in place of the character* gets them
      // over it, not beside it: 也 reads as なり and 耳 as のみ, each a word of
      // the sentence the way これ is a reading of 之, where 乎's や and 哉's かな
      // are endings completing the predicate they follow. See
      // `SENTENCE_FINAL_WORD_LEMMAS`, which is where that criterion is stated.
      // The quote-closing ト stays in the okurigana slot either way — it
      // attaches after the word, not over the character.
      // Suppressed where it would repeat the predicate's own copula (君子仁也
      // is 君子仁なり, not 仁なりなり) — see `repeatsPredicateCopula`.
      const particle = (repeatsPredicateCopula(token, sentence) ? "" : sentenceFinalParticle(token.lemma)) || undefined;
      const overCharacter = particle !== undefined && SENTENCE_FINAL_WORD_LEMMAS.has(token.lemma);
      frag.append(
        cellFor(
          token.text,
          overCharacter ? particle : undefined,
          withQuoteEnd(overCharacter ? undefined : particle, token.id, plan),
          glyphs.get(token.id),
          token.id,
          true,
        ),
      );
      continue;
    }
    if (isNegationUse(token)) {
      frag.append(
        cellFor(
          token.text,
          undefined,
          // `negationEnding`, not `negationForm`: everything a negation piece
          // writes, which is the ず/ぬ/ざる *and* the case particle owed by the
          // clause it closes. A negation is postposed past its predicate, so on
          // a negated clause the predicate is no longer what stands at the
          // clause's end and the particle written there lands inside the
          // negation — 苦不得飲 drew 得 に ズ. The ざる carries it instead, and
          // 不 reads ザルニ. Calling the one function `generator.ts` calls also
          // closes a divergence this site had on its own: it never passed
          // `rereadGovernedForm`, which that panel did.
          withQuoteEnd(negationEnding(token, plan), token.id, plan),
          glyphs.get(token.id),
          token.id,
          true,
        ),
      );
      continue;
    }
    const aux = auxiliaryFormFor(token, sentence);
    if (aux) {
      frag.append(cellFor(token.text, undefined, withQuoteEnd(selectForm(aux, plan, token.id), token.id, plan), glyphs.get(token.id), token.id, true));
      continue;
    }
    // て/して liaison (see `teOrShite`) — same shared decision the
    // kakikudashi generator uses, so both panels render the same gloss.
    if (token.lemma === "而") {
      // `reading` is set only where 而 is read as a word of its own (しかも),
      // and goes over the character; て and して are endings and sit beside it.
      const eru = teOrShite(plan, token.id);
      frag.append(
        cellFor(token.text, eru.reading, withQuoteEnd(eru.okurigana, token.id, plan), glyphs.get(token.id), token.id, true),
      );
      continue;
    }

    // Gated on `usesLexiconEntry` — a lexicon entry represents that lemma's
    // verb/adjective/copula sense specifically (its conjugation), not every
    // use of the character; see that predicate for what the gate admits and
    // why the same call stands in `furiganaFor` above and in generator.ts's
    // matching branch, so all three ask one question and the two panels
    // cannot silently disagree about a character.
    // `beatsLexicon` stands the lexicon down for a reading the syntax chose,
    // matching `furiganaFor` above and the generator's own copy of this
    // condition. That reading then supplies a stand-in entry of its own
    // (`syntheticLexiconEntry`, the same helper generator.ts calls) carrying
    // the class the stood-down entry was holding, so it is still conjugated
    // here rather than shown in citation form — 立㆑たテ before a following て,
    // not 立㆑たツ.
    // …and a タリ suffix reaches it by its own gate instead, `usesLexiconEntry`
    // having no arm a PART-tagged 然 can pass and `VERB_LEXICON` holding the
    // standalone 然り for it. All of that now lives in `lexiconEntryFor`, one
    // function shared with generator.ts's identical branch rather than a
    // ternary copied into each — which is the same reason the three sites
    // already share `usesLexiconEntry` itself.
    const resolvedForLex = resolve(token, sentence);
    const lex = lexiconEntryFor(token, resolvedForLex);
    if (lex) {
      // Same okurigana verbLexicon.ts/classicalConjugation.ts pipeline the
      // kakikudashi generator uses, so both panels agree — e.g. 知 before a
      // postposed 不 shows conjugated ラ (mizenkei), not the dictionary-form
      // ル a static kanjidic lookup would give. Applied *after* the form is
      // decided, never before it (conjugatedOkurigana takes the form as an
      // input, not the other way around).
      // extraEndingFor (copula/morph-ending) deliberately not applied here:
      // generator.ts's own VERB_LEXICON branch `continue`s before reaching
      // its extraEndingFor check too (a lexicon entry is POS=VERB/ADJ, so
      // the copula check wouldn't fire anyway). `converbSuffix` is the one
      // morph-driven ending a lexicon word *does* still need — see its own
      // doc for why VerbForm=Conv specifically can't just go through
      // extraEndingFor like the copula case does.
      // A hand-picked reading never reaches here — it is taken by its own
      // branch, far above, ahead of every context-specific reading including
      // this one.
      const nextForLex = nextMeaningfulToken(plan, token.id);
      const useFixedReading = lex.fixedReading && !isNamingUse(token, sentence);
      // Named rather than written inline into `conjugatedOkurigana` because
      // `converbSuffix` below now needs the same answer: a 已然形 takes ば and
      // must not also take て, and the form is the only thing that says so.
      // One evaluation, so the ending and the て cannot be decided from two
      // different forms — the discipline `lex.conjClass` is already passed by.
      const lexForm =
              // A governing 再読文字 dictates the form outright — 未 wants
              // 未然形 whatever else follows — and is consulted ahead of the
              // ordinary context rules, exactly as generator.ts does. Without
              // it the two panels disagreed about the same character: 未來
              // read いまだ來たらず in the kakikudashibun and きタル in the ruby,
              // the second reading being no token of its own for
              // `decideConjForm` to see following the predicate.
              // The resolver goes through with it, exactly as it does in
              // generator.ts: a following 者 is attributive only under its
              // もの reading, and nothing but the resolver knows which of its
              // two readings this one took (see `isNominalizerAhead`).
              // The subject of the form question is `conjugationSubject`, not
              // the token itself — a タリ suffix writes its group's ending while
              // the stem is what holds the group onto the sentence. Same
              // substitution generator.ts makes, and `nextForLex` stays this
              // token's own neighbour in both.
        rereadGovernedForm(token.id, plan) ??
        decideConjForm(conjugationSubject(token, sentence), nextForLex, sentence, lex.conjClass, resolve);
      const okurigana =
        (useFixedReading ? lex.fixedReading! : conjugatedOkurigana(lex, lexForm)) +
        // `lex`'s own class, the one the okurigana above was conjugated with —
        // never a fresh lookup, which would test the shape of a 連用形 this
        // token did not take. Undefined on the `fixedReading` path, which has
        // no paradigm at all, and that is the right answer there. Same
        // argument generator.ts passes, so the two panels cannot disagree
        // about whether the て is written — and the form beside it, for the
        // same reason, so they cannot disagree about the 已然形 either.
        converbSuffix(token, nextForLex, lex.conjClass, lexForm);
      frag.append(
        cellFor(
          token.text,
          // `furiganaFor`, not `lexiconFurigana` directly: a synthesized
          // entry's reading is the resolver's, already historical-kana
          // corrected there, while a real entry's is the lexicon's and still
          // needs correcting. `furiganaFor` is where that fork is already
          // decided (on the same `beatsLexicon` this branch keys off), so
          // going through it keeps one answer to "what is this token's
          // furigana?" rather than a second copy that could disagree.
          furiganaFor(token, sentence, resolve, historicalKana, kanjidic),
          withQuoteEnd(withCaseParticle(okurigana || undefined, token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    const resolved = resolve(token, sentence);

    // Ahead of the override branch below, and standing it down for the
    // kanji-retained adverbs — the same order `generateKakikudashi` puts these
    // two in, and for the same reason.
    //
    // These words reach this panel through the override table (they are in it),
    // so `spellOutInProse` was true for them and the branch below drew the whole
    // reading as one katakana run in the okurigana slot, with no furigana and
    // the cell tagged `kanaOnly` — 亦 came out マタ beside a bare 亦. That tag is
    // a claim that the prose drops the character, and `KANJI_RETAINED_ADVERBS`
    // is precisely the statement that it does not: the prose panel writes 亦 and
    // 必ず. An adverb is a content word with a dictionary reading of its own,
    // exactly as an adjective is, so it is annotated the way one is — the
    // reading over the character, the table's okurigana beside it — and the cell
    // is not `kanaOnly`, because the character survives into the prose.
    //
    // `retainedAdverbParts` is that split, and it lives beside the table in
    // `generator.ts` so the two panels divide the word in one place. It declines
    // where the resolver's reading does not end in the table's okurigana, which
    // is what keeps a reading this table does not describe out of it.
    //
    // `beatsLexicon` is the same stand-down the prose panel's own call makes: a
    // reading the *syntax* chose is not this adverb's own word (獨酌 is どく・
    // しやく, not 獨り酌), and the per-lemma table must not divide it.
    const retainedAdverb = resolved.beatsLexicon ? undefined : retainedAdverbParts(token.lemma, resolved.reading);
    if (retainedAdverb) {
      frag.append(
        cellFor(
          token.text,
          retainedAdverb.reading,
          // No `withExtraEnding`: the table's okurigana is the whole of this
          // word's ending, exactly as the prose panel's own branch treats it
          // (it pushes its piece and closes the token without consulting the
          // morph-driven ending at all).
          withQuoteEnd(withCaseParticle(retainedAdverb.okurigana || undefined, token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    // readingResolver's override table is mostly the curated set of kanbun
    // grammar words (case-marking particles, etc.) whose "reading" is a
    // Japanese grammatical gloss rather than the character's own dictionary
    // pronunciation — same distinction generator.ts already makes
    // (kanji-retained vs. kana-only) to decide whether a word keeps its
    // kanji in kakikudashi. Here it decides which annotation slot the
    // reading goes in: furigana for a real dictionary reading (kanjidic/
    // jmdict) OR a pronoun (之/我/自 etc. — a pronoun is a genuine word with
    // its own reading, not a grammatical inflection marker, even though its
    // reading happens to live in the override table); okurigana for
    // everything else the override table covers (particles, sentence-final
    // markers).
    // Same "override" source condition generateKakikudashi keys its
    // kanji-drop off (see cellFor's `kanaOnly` doc) — computed once here so
    // both branches below tag their cell identically regardless of which
    // display slot (furigana vs. okurigana) the reading itself lands in.
    const kanaOnlyInProse = !!resolved.spellOutInProse;
    if (resolved.spellOutInProse && token.pos !== "PRON") {
      // No withExtraEnding here — the override table's entries are already
      // complete, self-contained grammatical glosses, so e.g. 以's own
      // VerbForm=Conv morph must not *also* tack on a further て (もってて)
      // on top of もって, which already carries that sense.
      // An override entry that supplies its own `okurigana` is declaring a
      // split rather than a single gloss: 毎 is ごと — a reading of the
      // character itself, so furigana — followed by the ending に. An entry
      // with no okurigana of its own is the other kind, a whole gloss
      // standing in for the character, which belongs in the okurigana slot
      // entire. Both still read as bare kana in the prose panel, which is
      // what `kanaOnlyInProse` above is for and why this only moves the
      // annotation slot, not the kakikudashi.
      const split = resolved.okurigana !== undefined;
      const okurigana = split ? resolved.okurigana! : (resolved.reading ?? "");
      frag.append(
        cellFor(
          token.text,
          split ? resolved.reading || undefined : undefined,
          withQuoteEnd(withCaseParticle(okurigana || undefined, token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
          kanaOnlyInProse,
        ),
      );
    } else {
      frag.append(
        cellFor(
          token.text,
          resolved.reading || undefined,
          // `endingComplete` skips the morph-driven ending for a reading that
          // already carries all of its own — the same exemption the override
          // branch above makes, reached by a different route. See its doc.
          withQuoteEnd(
            withCaseParticle(
              resolved.endingComplete ? resolved.okurigana : withExtraEnding(resolved.okurigana, token, root, plan),
              token,
              sentence,
            ),
            token.id,
            plan,
          ),
          glyphs.get(token.id),
          token.id,
          kanaOnlyInProse,
        ),
      );
    }
  }

  return frag;
}

/** Sets each tied `.compound-group`'s `--line-top`/`--line-bottom`
 * (consumed by kunten.css's `::before` connecting line) from the *actual*
 * rendered position of its first and last `.kanji-glyph` — not the group's
 * own box, which also includes ruby/kunten annotations that can make a
 * member taller without making the glyph itself any taller (see
 * kunten.css's doc).
 *
 * The first glyph's *foot* and the last glyph's *top*, not their centres:
 * the line lives in the gaps between the characters and never runs beside
 * one (see the `::before` rule, which paints only the gaps out of the span
 * these two leave). Measured rather than written down for the reason the
 * centres were: what the two ends have to be flush with is where the glyphs
 * actually landed.
 *
 * Must run after the tree is attached to the real document
 * (`container.append` below) — `getBoundingClientRect` on a still-detached
 * `DocumentFragment` returns all-zero rects, so this can't happen inside
 * `compoundGroupCell` itself while the group is still being assembled
 * off-document. Untied groups are skipped: they draw nothing, so there is
 * nothing to place. */
export function positionCompoundLines(root: HTMLElement): void {
  for (const group of root.querySelectorAll<HTMLElement>(".compound-group[data-tied]")) {
    const cells = group.querySelectorAll<HTMLElement>(".kanji-cell");
    const firstGlyph = cells[0]?.querySelector<HTMLElement>(".kanji-glyph");
    const lastGlyph = cells[cells.length - 1]?.querySelector<HTMLElement>(".kanji-glyph");
    if (!firstGlyph || !lastGlyph) continue;
    const groupRect = group.getBoundingClientRect();
    const top = firstGlyph.getBoundingClientRect().bottom - groupRect.top;
    const bottom = groupRect.bottom - lastGlyph.getBoundingClientRect().top;
    group.style.setProperty("--line-top", `${top}px`);
    group.style.setProperty("--line-bottom", `${bottom}px`);
  }
}

/** Real 行末禁則 (kinsoku shori) forbids an opening quote/bracket from
 * *ending* a column, even though it's the one class of punctuation allowed
 * to *start* one (see `OPENING_PUNCT`/`appendPunct`'s own 行頭禁則 handling
 * for every other punctuation mark) — plain CSS line-breaking can't apply
 * that rule to `.kanji-cell`'s opaque atomic boxes any more than it can the
 * closing-punct case, so this is a DOM pass over the whole finished column,
 * gluing any still-standalone opening-punct cell to whatever rendered unit
 * immediately follows it — crossing a `.sentence-gap` boundary if that's
 * where it falls (`querySelectorAll` here returns every sentence's
 * top-level cells/groups flattened into one document-order sequence, and
 * `Node.append` moves a node into a new parent regardless of where it
 * started, so this works the same whether or not that boundary is
 * crossed). Run once after the whole tree is built rather than threaded
 * through `renderSentence`'s many append call sites — the finished DOM
 * already has everything this needs to know (is this cell an opening-punct
 * cell; is there anything after it). Two consecutive opening-punct cells
 * (「『, vanishingly rare) still end up transitively glued: the second
 * merge finds the first one already moved inside a `.no-break-unit` and
 * simply nests a further one there, `replaceWith` following it to its
 * current parent either way. */
/** Numbers each mark of punctuation by how many marks already share the gap
 * it is being crammed into, so `.punct-cell` can set them beside each other
 * across the column (see its rule in kunten.css). A mark's index is 0 unless
 * the cell before it is itself a mark, and an index of 0 is left unset: the
 * first mark of a run is drawn exactly where a lone mark is, and only the
 * ones after it move.
 *
 * A pass over the finished column rather than a count kept while building,
 * for two reasons the DOM makes plain: consecutive marks are not siblings —
 * `appendPunct` nests each glued unit inside the last, so 之。」 puts the 」
 * beside a wrapper rather than beside the 。 — and a run can cross a
 * sentence, this parser leaving a closing quote after a full stop alone in a
 * sentence of its own. Document order is the only place the run is visible
 * as a run, and it is exactly what a pass over it reads. */
function indexPunctRuns(column: HTMLElement): void {
  let run = 0;
  /** The character the run hangs off, whose kaeriten (if it has one) is the
   * only thing under a closing bracket that the raise has to clear. */
  let host: HTMLElement | null = null;
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    if (!cell.classList.contains("punct-cell")) {
      run = 0;
      host = cell;
      continue;
    }
    if (run > 0) {
      cell.style.setProperty("--punct-index", String(run));
      // A closing bracket rides a third of a character higher than the stack
      // puts it — see `.punct-cell[data-punct-raised]` in kunten.css. Marked
      // here rather than matched in CSS because the raise applies only to a
      // bracket that *follows* another mark: a lone one keeps the place every
      // lone mark keeps, and a stylesheet cannot ask whether the custom
      // property above was set.
      if (BRACKET_PUNCT.has(cell.textContent ?? "") && !OPENING_PUNCT.has(cell.textContent ?? "")) {
        // How far it rides depends on what is under it. A kaeriten is the one
        // thing in that space, and with no kaeriten to clear the bracket takes
        // the whole half character, tucking right up under the mark it
        // follows; with one, it takes the sixth that leaves the mark its room.
        cell.dataset.punctRaised = host?.querySelector(".kunten-glyph") ? "kaeriten" : "full";
      }
    }
    run += 1;
  }
}

function glueOpeningPunctForward(column: HTMLElement): void {
  const units = Array.from(column.querySelectorAll<HTMLElement>(".sentence-gap > *"));
  for (let i = 0; i < units.length - 1; i++) {
    const el = units[i];
    if (!el.classList.contains("kanji-cell") || !OPENING_PUNCT.has(el.textContent ?? "")) continue;
    const next = units[i + 1];
    const glued = document.createElement("span");
    glued.className = "no-break-unit";
    el.replaceWith(glued);
    glued.append(el, next);
  }
}

/** Everything a character hangs below itself — the reading, the okurigana,
 * a 再読文字's second reading, the kaeriten. `.kanji-cell` and
 * `.kanji-glyph` are both exactly one character tall whatever they carry
 * (every annotation is out of flow), so none of these is inside any box
 * that could be measured instead. */
const ANNOTATION_PARTS = ".furigana, .okurigana, .reread-second, .kunten-glyph";

/** Publishes how far the deepest annotation on the page reaches below its
 * character's foot, which is what the panel has to leave room for below the
 * last character of a column (see `--panel-margin-bottom` in
 * typography.css, which takes the larger of its own margin and this).
 *
 * The panel's height is rounded down to a whole number of characters, and
 * what a column leaves after its last character is that character's own gap
 * plus the panel's bottom margin — 55px at the current scale, sized for the
 * *character* and not for what hangs off it. A reading is pinned to the
 * character's top and runs one kana per 15.2px, so it reaches
 * `run - --size-main` below the foot and needs more than 55px from seven
 * kana on. Measured, on a seven-kana reading on a column's last character:
 * the last kana was cut 7.4px short by `.tategaki`'s own `overflow-y:
 * hidden`, and an eight-kana one by 22.6px — at every panel height, since
 * the rounding makes the shortfall the same wherever the column ends. Both
 * lengths are real: kanjidic carries 64 readings of seven kana or more (up
 * to twelve), and any of them can be picked from the readings menu.
 *
 * Measured rather than derived: the placement of both runs is a stack of
 * `max()`es in kunten.css (rules 3, 4 and 5), and restating it here in
 * TypeScript would be a second copy of that arithmetic to keep in step.
 * What is wanted is one number — how deep the deepest one actually went —
 * and the laid-out page is where that is written.
 *
 * The switches are lifted for the measurement and put straight back, within
 * the one task, so nothing is painted in between: `display: none` leaves no
 * box to measure, and a page rendered with the readings switched off would
 * otherwise reserve nothing and clip them the moment they were switched
 * back on — which redraws nothing and so would never be re-measured.
 *
 * Costs nothing on ordinary text: rule 5 keeps a lane to at most
 * `annotationCapacity()` kana, which is 76px against the 99px a character
 * and its gap come to, so the margin stays exactly what it was and the
 * `max()` never fires. */
function publishAnnotationOverhang(column: HTMLElement): void {
  const switches = ["hide-furigana", "hide-okurigana", "hide-kunten"].filter((name) => document.body.classList.contains(name));
  document.body.classList.remove(...switches);

  let deepest = 0;
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    const glyph = cell.querySelector<HTMLElement>(".kanji-glyph");
    if (!glyph) continue;
    const foot = glyph.getBoundingClientRect().bottom;
    for (const part of cell.querySelectorAll<HTMLElement>(ANNOTATION_PARTS)) {
      deepest = Math.max(deepest, part.getBoundingClientRect().bottom - foot);
    }
  }

  document.body.classList.add(...switches);
  // On `:root`, where `--panel-margin-bottom` is declared and where both of
  // its readers — the panel's own padding and the grid row that holds it
  // (tategaki.css) — can see it. A whole pixel up, so a fractional
  // shortfall can never take the last kana with it.
  document.documentElement.style.setProperty("--annotation-overhang", `${Math.ceil(deepest)}px`);
}

export function renderKundokuView(
  container: HTMLElement,
  tree: TokenTree,
  resolve: ReadingResolver,
  jmdict: JmdictIndex | null = null,
  kanjidic: KanjidicIndex | null = null,
  historicalKana: HistoricalKanaIndex | null = null,
): void {
  container.replaceChildren();
  const column = document.createElement("div");
  column.className = "tategaki-column text-main";
  for (const sentence of tree.sentences) {
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    assignKundokuTen(plan); // mutates plan.spliceGroups' depth/isRe in place
    const root = findRoot(sentence);
    const wrapper = document.createElement("span");
    wrapper.className = "sentence-gap";
    wrapper.append(renderSentence(sentence, resolve, root, plan, jmdict, kanjidic, historicalKana));
    registerSentence(wrapper, sentence);
    column.append(wrapper);
  }
  glueOpeningPunctForward(column);
  indexPunctRuns(column);
  container.append(column);
  positionCompoundLines(column);
  publishAnnotationOverhang(column);
  // Set per render, not once at setup: the index arrives asynchronously,
  // so the first render can precede it.
  setReadingIndex(kanjidic, historicalKana, jmdict);
  setupTokenInspector(container);
  // Reading starts at this (vertical-rl) panel's own *right* edge —
  // `scrollLeft = 0` is that start, not the browser's own idea of "start"
  // carried over from whatever position scroll-anchoring (or a previous
  // render's leftover scrollLeft on this same, reused container element)
  // last left it at. Without this, a fresh render can open already
  // scrolled partway through the text, cutting off content at *both*
  // edges instead of showing the beginning. Set after the new content is
  // in the DOM, since scrollWidth isn't known beforehand.
  //
  // Instant, overriding the `scroll-behavior: smooth` the panel carries in
  // tategaki.css: this is a reset, not a journey, and the reader should never
  // watch the panel travel to it. It also has to *finish* within this call,
  // because a re-render of the text already on screen puts the panel straight
  // back where the reader had it (`ScrollSync.captureScroll`) — a smooth reset
  // would still be animating underneath that restore.
  container.scrollTo({ left: 0, behavior: "instant" });
}
