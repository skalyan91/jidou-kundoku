import type { Sentence, Token, TokenTree } from "../parse/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import type { CompoundSpan, JmdictIndex } from "../reading/jmdictLookup.ts";
import { findCompoundSpans, lookupLemma } from "../reading/jmdictLookup.ts";
import { lookupKanji, type KanjidicIndex } from "../reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { splitCompoundReading } from "../reading/compoundReading.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../kundoku/kundokuTenAssigner.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { buildKundokuGlyphMap } from "./kundokuGlyphs.ts";
import { toKatakana } from "./kana.ts";
import {
  AUXILIARY_LEMMAS,
  caseParticleFor,
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  extraEndingFor,
  findRoot,
  isConverbUse,
  isMistaggedLocativeVerb,
  isNamingUse,
  isNominalizedFaultNoun,
  isNominalizedVerbClause,
  isNegationUse,
  negationForm,
  nextMeaningfulToken,
  selectForm,
  teOrShite,
  yuReading,
  ziReading,
} from "../kakikudashi/conjugationContext.ts";
import { sentenceFinalParticle } from "../kakikudashi/bungoConjugation.ts";
import { registerSentence, setupTokenInspector, setReadingIndex } from "./tokenInspector.ts";
import { chosenReadingParts, chosenReadingText } from "../reading/chosenReading.ts";
import { sourceLayoutOf } from "../parse/sourceLayout.ts";
import { BRACKETS, japanesePunct, OPENING_BRACKETS } from "../parse/punctuation.ts";
import { isRereadUse, rereadCharacter, rereadGovernedForm } from "../kakikudashi/rereadCharacters.ts";
import { VERB_LEXICON } from "../kakikudashi/verbLexicon.ts";

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
 * overlay and the menus fade in: this moves the text itself, sometimes the
 * better part of a column of it, and a page of characters changing places
 * needs longer to be followed than a label appearing does. */
const REFLOW_MS = 260;

/** Runs `apply` — a change to which annotations are shown — and walks
 * everything it moves from where it was to where that leaves it.
 *
 * Switching a layer off takes it out of the <rt>, so the annotation column
 * beside each character gets shorter, and every character after it moves up
 * to close the gap. That is not a small rearrangement: 32 of 36 characters
 * move, 13 of them into a different column entirely, the furthest by 314px
 * (measured). Done between one frame and the next it reads as the text
 * having been replaced by different text. Walked, it reads as the same text
 * settling into the space the annotations were taking up — which is what
 * has happened, and the reason for turning a layer off in the first place.
 *
 * (The kunten switch moves nothing at all: those marks are positioned
 * absolutely, so they leave no gap to close. Nothing here special-cases it —
 * every character measures as having stayed put, and nothing is animated.)
 *
 * Nothing declarative can express this: the move comes out of layout being
 * redone, which no transition covers. So the old position is measured, the
 * change applied, the new position measured, and the difference played back
 * as a displacement returning to zero.
 *
 * The characters themselves, and only those. A `.kanji-cell` is an inline
 * *block* and takes a transform, which carries its annotations with it, so
 * everything on the screen travels. What is not animated is the okurigana's
 * own last few pixels *within* its cell — the re-centring when the reading
 * beside it goes. Moving that separately needs it to be a box of its own,
 * and both ways of making it one cost the ruby its lane or its line
 * breaking (see `.okurigana` in kunten.css). A 16px re-centre is not worth
 * the typography of every character that has an okurigana. */
export function animateAnnotationShift(apply: () => void): void {
  const cells = [...document.querySelectorAll<HTMLElement>("#kundoku-view .kanji-cell")];
  const cellsBefore = cells.map((c) => c.getBoundingClientRect());

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

/** Trailing と (rendered ト, katakana, in the okurigana slot per the usual
 * function-word convention) on the token that ends a quoted/reported-speech
 * complement of a speech verb — see `ReadingPlan.quoteEndIds` and
 * `depClassification.ts`'s `isSpeechQuoteComplement`. Applied as the
 * outermost wrap in every dispatch branch below, since the quote can end on
 * any kind of token (a plain verb, a sentence-final particle, a negation,
 * the last member of a compound...). */
function withQuoteEnd(okurigana: string | undefined, tokenId: number, plan: ReadingPlan): string | undefined {
  if (!plan.quoteEndIds.has(tokenId)) return okurigana;
  return (okurigana ?? "") + "と";
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
 * kana-corrected the same way the generic kanjidic path is — see
 * `readingResolver.ts`'s identical `historicalKana?.[token.text]?.[...]`
 * lookup, keyed by *kanji spelling* for the same cross-homonym-safety
 * reason documented there. */
function lexiconFurigana(token: Token, historicalKana: HistoricalKanaIndex | null): string | undefined {
  const reading = VERB_LEXICON[token.lemma]?.reading;
  if (!reading) return undefined;
  return historicalKana?.[token.text]?.[reading] ?? reading;
}

function furiganaFor(token: Token, sentence: Sentence, resolve: ReadingResolver, historicalKana: HistoricalKanaIndex | null): string | undefined {
  // Ahead of every rule below, for the same reason the resolver checks it
  // first: this is a correction of whatever they would have produced.
  const chosen = chosenReadingText(token);
  if (chosen) return chosen;
  const zi = ziReading(token, sentence);
  if (zi) return zi;
  if (VERB_LEXICON[token.lemma]) return lexiconFurigana(token, historicalKana);
  const resolved = resolve(token, sentence);
  if (resolved.source === "override" && token.pos !== "PRON") return undefined; // function-word gloss, not a dictionary reading
  return resolved.reading || undefined;
}

/** A compound's furigana, one string per character: the whole compound's
 * own combined JMdict reading (e.g. くんし for 君子 — a real dictionary
 * word's actual pronunciation, not each character read in isolation, which
 * can differ; 子 alone defaults to し but so does 君子's own 子 here, and a
 * less predictable compound could easily diverge) split across its
 * characters via `splitCompoundReading`. Falls back to each character's own
 * independently-resolved reading (`furiganaFor`) when there's no JMdict
 * entry for the whole compound, or the split can't fully account for the
 * reading — a forced/partial split would risk showing a wrong reading with
 * unwarranted confidence. */
function compoundFurigana(
  chars: string[],
  combinedText: string,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  fallback: (charIndex: number) => string | undefined,
): (string | undefined)[] {
  if (jmdict && kanjidic) {
    const hit = lookupLemma(jmdict, combinedText);
    if (hit) {
      const split = splitCompoundReading(chars, hit.reading, kanjidic);
      if (split) return split;
    }
  }
  if (kanjidic) {
    // A fused compound (drawn with its own connecting line) that JMdict
    // doesn't list as a single entry is virtually always a jukugo —
    // a name, title, or technical term read on'yomi straight through, not
    // each member's own independently-chosen kun'yomi/on'yomi. Forced here
    // by passing "PROPN" to `lookupKanji` regardless of the member's own
    // (possibly wrong) POS tag — the same lever that already selects
    // on'yomi for a genuine proper noun — deliberately unconditional, not
    // limited to spans whose members happen to be tagged PROPN: 黄帝 ("the
    // Yellow Emperor") parses as VERB+NOUN in a mistagged comp:obj relation
    // (this app's compound-span detection also fuses attributive `mod`
    // pairs, not just genuine `compound`/`flat` relations — see
    // `findCompoundSpans`), and per-member kun'yomi there gave a nonsense
    // reading (きみかど) no real jukugo compound ever takes. Falls back to
    // the caller's own per-token resolution only if a character isn't in
    // kanjidic at all.
    return chars.map((ch, i) => lookupKanji(kanjidic, ch, "PROPN")?.reading ?? fallback(i));
  }
  return chars.map((_, i) => fallback(i));
}

/** Renders a compound's members (either a real multi-token span, or the
 * individual characters of a single token the tokenizer already fused —
 * see the two call sites in `renderSentence`) with exactly the same
 * conventions either way: each member is a plain, individually-spaced
 * `.kanji-cell` with its own furigana; one shared group-level okurigana
 * (case particle / extra ending, keyed off `groupToken`'s own dep/pos —
 * the span's carrier, or the token itself for a single fused token)
 * attaches only to the last member; `.compound-group` draws the kanbun
 * connecting line down the characters' central axis (see kunten.css). */
function compoundGroupCell(
  members: { text: string; furigana: string | undefined; kunten: string | undefined; id: number }[],
  groupToken: Token,
  lastMemberId: number,
  root: Token | undefined,
  plan: ReadingPlan,
): HTMLElement {
  const extra = extraEndingFor(groupToken, root, plan.sentence, true);
  const groupOkurigana = withQuoteEnd(
    withCaseParticle(extra ? selectForm(extra, plan, lastMemberId) : undefined, groupToken, plan.sentence),
    lastMemberId,
    plan,
  );
  const group = document.createElement("span");
  group.className = "compound-group";
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
      const furiganas = compoundFurigana(chars, span.text, jmdict, kanjidic, (i) => furiganaFor(spanTokens[i], sentence, resolve, historicalKana));
      const members = span.tokenIds.map((id, i) => ({ text: chars[i], furigana: furiganas[i], kunten: glyphs.get(id), id }));
      frag.append(compoundGroupCell(members, carrier, lastMemberId, root, plan));
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
      cell.append(kundokuPunct(token.text, endsSentence(sentence, token)));
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
      const furiganas = compoundFurigana(chars, token.text, jmdict, kanjidic, (i) => furiganaFor({ ...token, text: chars[i] }, sentence, resolve, historicalKana));
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
    // Furigana rather than the okurigana slot the branches below use, and the
    // kanji kept: a picked reading comes off the kanjidic candidate list, so
    // it is a dictionary reading of the character rather than a grammatical
    // gloss standing in for it (see `chosenReading`'s own note on the tag).
    const picked = chosenReadingParts(token);
    if (picked) {
      frag.append(
        cellFor(
          token.text,
          picked.reading,
          withQuoteEnd(withCaseParticle(picked.okurigana || undefined, token, sentence), token.id, plan),
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

    // 於 always inverts before its governor and reads より (source/standard
    // of comparison — see `yuReading`). Checked here, ahead of the generic
    // override fallback below, purely so this shares the same
    // `withQuoteEnd`/okurigana treatment as the other special-cased
    // function words above rather than going through the plain override
    // lookup.
    const yu = yuReading(token, sentence);
    if (yu) {
      frag.append(cellFor(token.text, undefined, withQuoteEnd(yu, token.id, plan), glyphs.get(token.id), token.id, true));
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
    if (token.dep === "discourse" || token.dep === "discourse@sp") {
      frag.append(
        cellFor(
          token.text,
          undefined,
          withQuoteEnd(sentenceFinalParticle(token.lemma) || undefined, token.id, plan),
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
          withQuoteEnd(negationForm(nextMeaningfulToken(plan, token.id)), token.id, plan),
          glyphs.get(token.id),
          token.id,
          true,
        ),
      );
      continue;
    }
    const aux = AUXILIARY_LEMMAS[token.lemma];
    if (aux) {
      frag.append(cellFor(token.text, undefined, withQuoteEnd(selectForm(aux, plan, token.id), token.id, plan), glyphs.get(token.id), token.id, true));
      continue;
    }
    // て/して liaison (see `teOrShite`) — same shared decision the
    // kakikudashi generator uses, so both panels render the same gloss.
    if (token.lemma === "而") {
      frag.append(cellFor(token.text, undefined, withQuoteEnd(teOrShite(plan, token.id), token.id, plan), glyphs.get(token.id), token.id, true));
      continue;
    }

    // Gated on pos === "VERB"/"AUX" — a lexicon entry represents that
    // lemma's verb/adjective/copula sense specifically (its conjugation),
    // not every use of the character. 青/寒 are also plain NOUNs elsewhere
    // (the color/condition itself as a substance, e.g. 青 as subj of 取之於
    // 藍) where conjugating them would be wrong — 青 alone (bare, no
    // reading shown), never 青し, when it's functioning as a noun. AUX
    // joins VERB for 爲/為's copula-like "becomes X" use (comp:pred child,
    // VerbType=Cop morph), which this parser tags AUX rather than VERB.
    // isConverbUse joins them too for a lexicon word tagged ADV when used
    // adverbially before a further verb (博/參 in 博學而日參省乎己).
    const lex =
      (token.pos === "VERB" ||
        token.pos === "AUX" ||
        isMistaggedLocativeVerb(token) ||
        isNominalizedVerbClause(token) ||
        isConverbUse(token)) &&
      !isNominalizedFaultNoun(token)
        ? VERB_LEXICON[token.lemma]
        : undefined;
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
      const okurigana =
        (useFixedReading
          ? lex.fixedReading!
          : conjugatedOkurigana(
              lex,
              // A governing 再読文字 dictates the form outright — 未 wants
              // 未然形 whatever else follows — and is consulted ahead of the
              // ordinary context rules, exactly as generator.ts does. Without
              // it the two panels disagreed about the same character: 未來
              // read いまだ來たらず in the kakikudashibun and きタル in the ruby,
              // the second reading being no token of its own for
              // `decideConjForm` to see following the predicate.
              rereadGovernedForm(token.id, plan) ?? decideConjForm(token, nextForLex, sentence, lex.conjClass),
            )) + converbSuffix(token, nextForLex);
      frag.append(
        cellFor(
          token.text,
          lexiconFurigana(token, historicalKana),
          withQuoteEnd(withCaseParticle(okurigana || undefined, token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
        ),
      );
      continue;
    }

    const resolved = resolve(token, sentence);
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
    const kanaOnlyInProse = resolved.source === "override";
    if (resolved.source === "override" && token.pos !== "PRON") {
      // No withExtraEnding here — the override table's entries are already
      // complete, self-contained grammatical glosses, so e.g. 以's own
      // VerbForm=Conv morph must not *also* tack on a further て (もってて)
      // on top of もって, which already carries that sense.
      const okurigana = (resolved.reading ?? "") + (resolved.okurigana ?? "");
      frag.append(
        cellFor(
          token.text,
          undefined,
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
          withQuoteEnd(withCaseParticle(withExtraEnding(resolved.okurigana, token, root, plan), token, sentence), token.id, plan),
          glyphs.get(token.id),
          token.id,
          kanaOnlyInProse,
        ),
      );
    }
  }

  return frag;
}

/** Sets each `.compound-group`'s `--line-top`/`--line-bottom` (consumed by
 * kunten.css's `::before` connecting line) from the *actual* rendered
 * position of its first and last `.kanji-glyph` — not the group's own box,
 * which also includes ruby/kunten annotations that can make a member taller
 * without making the glyph itself any taller (see kunten.css's doc). Must
 * run after the tree is attached to the real document (`container.append`
 * below) — `getBoundingClientRect` on a still-detached `DocumentFragment`
 * returns all-zero rects, so this can't happen inside `compoundGroupCell`
 * itself while the group is still being assembled off-document. */
export function positionCompoundLines(root: HTMLElement): void {
  for (const group of root.querySelectorAll<HTMLElement>(".compound-group")) {
    const cells = group.querySelectorAll<HTMLElement>(".kanji-cell");
    const firstGlyph = cells[0]?.querySelector<HTMLElement>(".kanji-glyph");
    const lastGlyph = cells[cells.length - 1]?.querySelector<HTMLElement>(".kanji-glyph");
    if (!firstGlyph || !lastGlyph) continue;
    const groupRect = group.getBoundingClientRect();
    const firstRect = firstGlyph.getBoundingClientRect();
    const lastRect = lastGlyph.getBoundingClientRect();
    const top = (firstRect.top + firstRect.bottom) / 2 - groupRect.top;
    const bottom = groupRect.bottom - (lastRect.top + lastRect.bottom) / 2;
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
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    if (!cell.classList.contains("punct-cell")) {
      run = 0;
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
        cell.dataset.punctRaised = "true";
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
  // Set per render, not once at setup: the index arrives asynchronously,
  // so the first render can precede it.
  setReadingIndex(kanjidic, historicalKana);
  setupTokenInspector(container);
  // Reading starts at this (vertical-rl) panel's own *right* edge —
  // `scrollLeft = 0` is that start, not the browser's own idea of "start"
  // carried over from whatever position scroll-anchoring (or a previous
  // render's leftover scrollLeft on this same, reused container element)
  // last left it at. Without this, a fresh render can open already
  // scrolled partway through the text, cutting off content at *both*
  // edges instead of showing the beginning. Set after the new content is
  // in the DOM, since scrollWidth isn't known beforehand.
  container.scrollLeft = 0;
}
