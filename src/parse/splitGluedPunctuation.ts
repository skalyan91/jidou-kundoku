import { BRACKETS, COMMAS, FULL_STOPS, isOpeningBracket, isPunctuationMark } from "./punctuation.ts";
import { isWellFormed } from "./deprojectivize.ts";
import type { Token } from "./types.ts";

/* ── The defect this module exists to intercept ────────────────────────────
 *
 * Every panel in this app draws one cell per character of a token's `text`,
 * on the standing assumption that a token *is* one character, or — for a
 * genuine word of more than one, 君子, 孔子, 三百 — one further character of
 * the *same kind of thing*. `lzh_sud_kyoto`'s own tokenizer occasionally
 * breaks that: it emits a token whose `text` glues a punctuation mark onto
 * the character beside it, `。干` for a full stop that should have closed the
 * sentence before it, `、安` for a comma that should have introduced the
 * quotation after it. Nothing downstream is written to expect this — the
 * kundoku panel would draw the mark inside the same kaeriten cell as the
 * character it has nothing to do with, the kakikudashi generator would read
 * a `NOUN` whose lemma starts with a full stop, `titleSpansOf` in
 * `punctuation.ts` already documents the same assumption for `《`/`》` — so it
 * has to be repaired before any of them see the tree, not worked around in
 * each of them separately.
 *
 * **Measured, not assumed.** Every stage of the treebank this model trains
 * on — `lzh_kyoto-sud-{train,dev,test}` and all twenty-odd intermediate
 * files each goes through on the way to the shipped wheel — was checked for
 * this shape and holds not one instance of it, over 460,390 training tokens
 * and the two held-out splits besides. Nor is it a general property of
 * multi-character tokens: the treebank and this app's own fixtures both hold
 * a great many genuine ones, 1,725 occurrences of 765 distinct forms over
 * the 103,041 tokens `tests/fixtures/*.conllu` and `public/data/samples/*`
 * hold between them — proper nouns (君子 147, 孔子 76, 子貢 50), numerals (三百
 * 17, 五十 14), bound compounds (弟子, 伯夷) — none of them mixing a mark with
 * a character. What the treebank never does, `lzh_sud_kyoto` still does at
 * inference: run against `kanbun-info-parses.conllu` (a 103,029-token dump
 * of the shipped wheel's own output over a much larger, unseen corpus,
 * built by `scripts/build-kanbun-info-corpus.py`), it produces exactly 12
 * such tokens — 0.0116%, about one in every 8,586 — over 12 sentences out of
 * several thousand. So this is inference noise from the model's own
 * tokenizer disagreeing with itself near punctuation, not a convention the
 * gold data or this app's own multi-character tokens share, and "occasional"
 * in the report is the right word for it: rare enough to reach a reader only
 * after a while, common enough that a reader did.
 *
 * **The shapes, measured on those 12.** Eight are a single leading mark
 * glued to one following character (`。子`, `。丘`, `、安`, `、卿`, `、道`, `、源`,
 * `、馬`), three are a single leading mark glued to a two-character word
 * (`、皋陶`, `、卿舅`, `、獲阨`), and one is a single trailing mark glued to one
 * preceding character (`慈、`). No run of two marks, no mark in the middle of
 * a longer word, no case where the surviving content is itself more than two
 * characters. `analyzeGlue` below still peels off a *run* of marks at either
 * end rather than assuming a single one, since nothing says the next release
 * of the wheel will keep to what this one happens to have produced.
 *
 * Eleven of the twelve open with the mark; only one closes with it. That
 * matters, because a *leading* mark is not introducing the token it is stuck
 * to — every leading case here is either a comma standing where `曰、` always
 * introduces a quotation (`、安`, `、皋陶`, `、道`, `、卿`, `、卿舅`, `、源`,
 * `、獲阨`, each immediately preceded, once split, by a verb of saying), or a
 * full stop that closes the clause *before* it (`。子`, `。丘`, each preceded
 * by that clause's own predicate). Either way the mark's business is with
 * what comes before it in the sentence, not with what it happens to be
 * glued to, which is the whole reason splitting this is more than cutting a
 * string — see the attachment rule below. */

/** True for a single character this module treats as punctuation to be
 * peeled off — the same three families `punctuation.ts` classifies as marks
 * at all, since those are the only shapes the treebank or the model's own
 * tag inventory (`s,記号,句点,*` / `読点` / `括弧開` / `括弧閉`) has a place for. */
function isGlueChar(ch: string): boolean {
  return isPunctuationMark(ch);
}

/** The treebank's own tag for a bare punctuation character, read off its own
 * data rather than invented: every full stop in `tests/fixtures/*.conllu`
 * and `public/data/samples/*` carries `s,記号,句点,*` (7,342 of them), every
 * comma-class mark `s,記号,読点,*` (10,770 across ，、；：), every opening
 * bracket `s,記号,括弧開,*` and every closing one `s,記号,括弧閉,*` — each with
 * no exception across the corpus. `s,記号,一般,*` is the same fallback
 * `xpos.ts` documents for a mark its tagger declines to place at all; it is
 * never reached by the three families `isPunctuationMark` recognises, and
 * kept only so a character this app does not yet classify cannot come out
 * of this function with no tag at all. */
function punctuationXpos(ch: string): string {
  if (FULL_STOPS.has(ch)) return "s,記号,句点,*";
  if (COMMAS.has(ch)) return "s,記号,読点,*";
  if (isOpeningBracket(ch)) return "s,記号,括弧開,*";
  if (BRACKETS.has(ch)) return "s,記号,括弧閉,*";
  return "s,記号,一般,*";
}

/** A token's text taken apart into a leading run of marks, the content
 * between them, and a trailing run of marks — `null` for a token this
 * module has nothing to do to, which is every ordinary token, punctuation or
 * content alone, and is therefore the overwhelmingly common answer. */
interface GluedShape {
  lead: string[];
  content: string;
  trail: string[];
}

function analyzeGlue(text: string): GluedShape | null {
  const chars = Array.from(text);
  if (chars.length <= 1) return null; // one character can mix nothing with itself
  let leadEnd = 0;
  while (leadEnd < chars.length && isGlueChar(chars[leadEnd])) leadEnd++;
  let trailStart = chars.length;
  while (trailStart > leadEnd && isGlueChar(chars[trailStart - 1])) trailStart--;
  if (leadEnd === 0 && trailStart === chars.length) return null; // an ordinary word, whatever its length
  return { lead: chars.slice(0, leadEnd), content: chars.slice(leadEnd, trailStart).join(""), trail: chars.slice(trailStart) };
}

/** Every token in `tokens` whose own text mixes a punctuation mark with a
 * character that is not one — the guard this module exists to make true.
 * Exported so a test can assert it holds of this module's own output (and,
 * pointedly, fails to hold of a tree nobody has run through
 * `splitGluedPunctuation` yet — see `splitGluedPunctuation.test.ts` for the
 * "verify it fails first" half of that). Not the same question as "is this
 * token more than one character": 君子 answers yes to that and no to this,
 * which is the distinction the whole module rests on. */
export function gluedPunctuationTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => {
    const glue = analyzeGlue(t.text);
    return glue !== null && glue.content.length > 0;
  });
}

/** The lemma a split token's content half should carry.
 *
 * Every one of the 12 measured cases has `lemma === text` exactly — this
 * parser does no lemmatisation beyond copying the surface form for a
 * language with no inflectional morphology to strip — so stripping the same
 * `lead`/`trail` counts off the lemma is exact whenever the two fields still
 * have the same length. Where they do not (never observed, kept only so an
 * unexpected shape degrades rather than throws), the content string itself
 * is the least wrong lemma available: better a word's own surface form than
 * a lemma field that may still be carrying the mark this split exists to
 * remove. */
function contentLemma(token: Token, lead: number, trail: number, content: string): string {
  const lemmaChars = Array.from(token.lemma);
  if (lemmaChars.length !== Array.from(token.text).length) return content;
  return lemmaChars.slice(lead, lemmaChars.length - trail).join("");
}

/** The rightmost position reachable from `i` by repeatedly following `head`
 * — how far right token `i`'s own governing chain still has descendants,
 * computed once for a whole sentence from its *original* heads, before any
 * splitting touches them. The same frozen-subtree quantity
 * `deprojectivizeSentence` computes as `hi` for the same reason: what
 * `climbToAttachmentHead` below needs to ask is a question about the tree as
 * the parser actually built it, not about a tree already half rewritten. */
function subtreeRightEdges(heads: number[]): number[] {
  const n = heads.length;
  const hi = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    let cur = i;
    for (let steps = 0; steps <= n; steps++) {
      if (i > hi[cur]) hi[cur] = i;
      const next = heads[cur];
      if (next === cur) break;
      cur = next;
    }
  }
  return hi;
}

/** Where a split-off mark attaches, in the *original* sentence's own
 * positions — the Kyoto treebank's own convention for punctuation, read off
 * its data rather than invented for this.
 *
 * A mark attaches to the highest ancestor of its neighbour whose subtree
 * still ends exactly at that neighbour, climbing from the neighbour itself
 * (`anchor`) up through `heads` while the *parent's* `hi` keeps agreeing.
 * The climb stops the moment a parent reaches further right than the mark
 * does, or at the root, whichever comes first — so a mark after a leaf whose
 * own head governs nothing beyond it keeps climbing past several ancestors
 * (法 in 卿爲我擇古陳法、悉圖以上, comma measured at head 7 擇, three links above
 * its own leaf), while a mark after a token that already has rightward
 * children of its own — a verb of saying with its quotation still to come —
 * stops on the first step and attaches directly to it, which is the
 * ordinary `曰、` shape eight of the twelve measured cases are built on.
 *
 * `anchor` is the neighbour's position in *this* sentence's original
 * numbering — the token just before a leading mark, or the glued token's own
 * position for a trailing one, since by the time this runs that position's
 * content *is* the neighbour the mark follows. Both directions are one
 * function because both ask the same question of the tree: what is the
 * largest constituent that happens to end exactly here. */
function climbToAttachmentHead(anchor: number, heads: number[], hi: number[]): number {
  let cur = anchor;
  for (let steps = 0; steps <= heads.length; steps++) {
    const parent = heads[cur];
    if (parent === cur) break; // the root: nothing stands above it to climb to
    if (hi[parent] !== anchor) break; // the parent's own subtree runs past the mark
    cur = parent;
  }
  return cur;
}

/** One sentence mid-split: the new tokens built so far, keyed back to the
 * original position each descends from, and the placeholders still waiting
 * for a head. Kept apart from the finished `Token[]` because a head may name
 * an original position this loop has not reached yet (heads point in either
 * direction; 之 at position 4 can head position 7's mark, and position 7 can
 * just as easily head position 4's). */
interface SentenceBuild {
  pieces: Token[];
  /** original position -> the id of the piece that speaks for it: an
   * ordinary token's own single piece, a glued token's content half, or
   * (never observed, see `analyzeGlue`'s header) the one piece emitted for a
   * token that dissolved into marks entirely. Always set for every position
   * by the time either resolution pass below reads it. */
  representative: number[];
  /** pieces whose `head` is the original token's own `head` field, still
   * naming an original position. */
  pendingOriginalHeads: { pieceId: number; originalHead: number }[];
  /** split-off marks whose head is "whatever the climb from this original
   * position finds", not resolved yet because the climb's answer also has
   * to go through `representative`. */
  pendingClimbs: { pieceId: number; anchor: number }[];
}

/** `representative[pos]`, guarded. `buildSentence` fills every position of
 * `representative` in the same pass that reads `original`, so by the time
 * either resolution loop below calls this, `representative[pos]` is always
 * already set for any `pos` in range — this should therefore always return
 * on its first iteration. Written as a walk-back rather than a direct index
 * anyway, on the same reasoning `deprojectivizeSentence` gives for its own
 * belt-and-braces cycle check: a tree this module got wrong is a worse
 * failure than a few wasted iterations, so the fallback stays even though
 * nothing exercises it. */
function resolveRepresentative(representative: number[], pos: number): number {
  for (let p = pos; p >= 0; p--) {
    if (representative[p] !== undefined) return representative[p];
  }
  return 0;
}

function buildSentence(original: Token[], heads: number[], hi: number[]): SentenceBuild {
  const build: SentenceBuild = { pieces: [], representative: [], pendingOriginalHeads: [], pendingClimbs: [] };
  const emit = (piece: Omit<Token, "id" | "head">): number => {
    const id = build.pieces.length;
    build.pieces.push({ ...piece, id, head: -1 });
    return id;
  };

  for (let p = 0; p < original.length; p++) {
    const token = original[p];
    const glue = analyzeGlue(token.text);

    if (glue === null || glue.content.length === 0) {
      // Either an ordinary token, or (never observed) one that dissolved
      // into marks entirely — either way there is exactly one thing to
      // emit for it, keeping every field this app relies on downstream.
      const id = emit({
        text: token.text,
        lemma: token.lemma,
        pos: token.pos,
        xpos: token.xpos,
        dep: token.dep,
        morph: token.morph,
        misc: token.misc,
      });
      build.representative[p] = id;
      build.pendingOriginalHeads.push({ pieceId: id, originalHead: token.head });
      continue;
    }

    const { lead, content, trail } = glue;

    for (const ch of lead) {
      const id = emit({ text: ch, lemma: ch, pos: "PUNCT", xpos: punctuationXpos(ch), morph: undefined, misc: undefined, dep: "punct" });
      // A leading mark's neighbour is the token before it — see
      // `climbToAttachmentHead`'s header for why `p === 0` (nothing before
      // it *in this sentence*) is handled by the caller before this
      // function ever runs, by moving the mark to the previous sentence
      // instead.
      build.pendingClimbs.push({ pieceId: id, anchor: p === 0 ? p : p - 1 });
    }

    const contentId = emit({
      text: content,
      lemma: contentLemma(token, lead.length, trail.length, content),
      pos: token.pos,
      xpos: token.xpos,
      dep: token.dep,
      morph: token.morph,
      misc: token.misc,
    });
    build.representative[p] = contentId;
    build.pendingOriginalHeads.push({ pieceId: contentId, originalHead: token.head });

    for (const ch of trail) {
      const id = emit({ text: ch, lemma: ch, pos: "PUNCT", xpos: punctuationXpos(ch), morph: undefined, misc: undefined, dep: "punct" });
      // A trailing mark's neighbour is the content that precedes it — its
      // own position, now that that content is what stands there.
      build.pendingClimbs.push({ pieceId: id, anchor: p });
    }
  }

  for (const { pieceId, originalHead } of build.pendingOriginalHeads) {
    build.pieces[pieceId].head = resolveRepresentative(build.representative, originalHead);
  }
  for (const { pieceId, anchor } of build.pendingClimbs) {
    const climbed = climbToAttachmentHead(anchor, heads, hi);
    build.pieces[pieceId].head = resolveRepresentative(build.representative, climbed);
  }

  return build;
}

/** Splits every token that fuses a punctuation mark to a content character
 * out of `sentences`, so nothing downstream ever has to know the parser
 * occasionally produces one. Sentences are processed in document order and
 * a sentence's own result can still grow after it is "done" — see the
 * leading-mark case below — so this returns a wholly new array rather than
 * mapping each sentence in isolation.
 *
 * ── Where the split-off mark attaches ─────────────────────────────────────
 * A trailing mark and a leading mark that is not its sentence's first token
 * both resolve within their own sentence, by `climbToAttachmentHead` off
 * that sentence's own original tree.
 *
 * A leading mark on a sentence's *first* token is the one shape that cannot
 * resolve locally — there is no token before it in this tree to be its
 * neighbour — and it is also the shape this codebase already has a name
 * for. `provisionalSentences.ts` documents `sent_join`'s own defect of
 * re-heading a clause onto whatever token the previous unit happened to end
 * at, and one of `kanbun-info-parses.conllu`'s own twelve cases is exactly
 * that: the sentence before `、馬冒其目也。` is `謂接連前矛` with no trailing
 * mark of its own at all, because the comma that should have closed it was
 * carried into the next `doc.sents` group instead and fused there. The mark
 * belongs to the sentence that has no mark, not to the one that follows it,
 * so it is moved: pushed onto the *previous* sentence's own token list as an
 * ordinary trailing `punct`, attached by the same climb, off *that*
 * sentence's original tree, anchored on its own last token (§ `謂`, three
 * steps up from 矛 by the same rule a genuine `。` would have climbed).
 *
 * Where there is no previous sentence to move it to — the very first
 * sentence of the document opening on a fused mark, never measured but not
 * impossible — the mark cannot be a previous sentence's problem, so it
 * falls back to the ordinary trailing rule instead: attached as if it stood
 * after its own content, which is the least wrong reading available when
 * there is truly nothing to its left. */
export function splitGluedPunctuation(sentences: Token[][]): Token[][] {
  const out: Token[][] = [];
  /** The id, within the previous *output* sentence, that a mark closing it
   * from outside should attach to — the same climb a trailing mark inside
   * that sentence would have used, computed once as soon as the sentence is
   * finished and reused here rather than recomputed. `null` until a first
   * sentence has actually produced one. */
  let previousTrailingAttachId: number | null = null;

  for (const sentence of sentences) {
    const original = [...sentence].sort((a, b) => a.id - b.id);
    if (original.length === 0) {
      out.push([]);
      previousTrailingAttachId = null;
      continue;
    }

    const heads = original.map((t) => t.head);
    const hi = subtreeRightEdges(heads);
    const previous = out[out.length - 1];
    const canAttachToPrevious = previous !== undefined && previous.length > 0 && previousTrailingAttachId !== null;

    // A first-token leading mark that has somewhere else to go is peeled off
    // before `buildSentence` ever sees this sentence, so the rest of the
    // pipeline only has to reason about marks that resolve locally.
    let leadingSentence = original;
    const firstGlue = analyzeGlue(original[0].text);
    if (canAttachToPrevious && firstGlue !== null && firstGlue.content.length > 0 && firstGlue.lead.length > 0) {
      for (const ch of firstGlue.lead) {
        previous.push({
          id: previous.length,
          text: ch,
          lemma: ch,
          pos: "PUNCT",
          xpos: punctuationXpos(ch),
          dep: "punct",
          head: previousTrailingAttachId!,
        });
      }
      const strippedFirst: Token = {
        ...original[0],
        text: firstGlue.trail.length > 0 ? firstGlue.content + firstGlue.trail.join("") : firstGlue.content,
      };
      leadingSentence = [strippedFirst, ...original.slice(1)];
    }

    const build = buildSentence(leadingSentence, heads, hi);
    const newHeads = build.pieces.map((t) => t.head);

    // Fail closed exactly as `deprojectivizeSentence` does: a rewrite this
    // module cannot show is still a tree is worse than the fused token it
    // was trying to remove. `leadingSentence`, not `original`, is what
    // survives — the cross-sentence move above (if it ran) already landed
    // safely on `previous`, a tree of its own that this sentence's own
    // trouble cannot unwind, and reverting to `original` here would print
    // its leading mark a second time.
    const wellFormed = isWellFormed(newHeads);
    if (wellFormed) {
      out.push(build.pieces);
    } else {
      out.push(leadingSentence.map((t, i) => ({ ...t, id: i })));
    }

    const finished = out[out.length - 1];
    const lastOriginalPosition = leadingSentence.length - 1;
    // The representative to climb through for the *next* sentence's sake:
    // this sentence's own split when it held, or the identity (every
    // original position is its own id) when it was reverted.
    const representative = wellFormed ? build.representative : leadingSentence.map((_, i) => i);
    previousTrailingAttachId =
      finished.length > 0 ? resolveRepresentative(representative, climbToAttachmentHead(lastOriginalPosition, heads, hi)) : null;
  }

  return out;
}
