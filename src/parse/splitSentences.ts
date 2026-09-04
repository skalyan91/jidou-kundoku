import { isBracket, isOpeningBracket, isSentenceFinalPunct, medialPunctuation } from "./punctuation.ts";
import { sourceLayoutOf } from "./sourceLayout.ts";
import type { Sentence, Token, TokenTree } from "./types.ts";

/** Splits parsed sentences at sentence boundaries the parser missed.
 *
 * Two kinds, both of which its own segmentation ignores:
 *
 *  - Sentence-final punctuation. 青、取之於藍，而青於藍。 comes back as a
 *    single sentence spanning both marks.
 *  - A line or paragraph break in the source. A verse line and the one
 *    after it come back as one sentence, so the two lines are read as a
 *    single clause.
 *
 * Either way relations reach across a boundary, and that matters beyond
 * tidiness: reading order, kaeriten numbering and the copula rules all work
 * per sentence, so a tree that spans a boundary reads the two clauses as
 * one. Requires `annotateSourceLayout` to have run first, which is where
 * the line structure comes from.
 *
 * Splitting a dependency tree means re-rooting each piece. A token whose
 * head is left on the other side of the cut has lost it, so the first such
 * token becomes the fragment's ROOT and any others attach to it, keeping
 * their own relation to say what they were. Every fragment ends up with
 * exactly one root, which is what `computeReadingOrder` requires. */
export function splitIntoSentences(tree: TokenTree): TokenTree {
  return { ...tree, sentences: tree.sentences.flatMap(splitSentence) };
}

function splitSentence(sentence: Sentence): Sentence[] {
  const ordered = [...sentence.tokens].sort((a, b) => a.id - b.id);

  // Cut *after* a sentence-final mark and *before* a token that begins a
  // new line — the mark closes what precedes it, the break opens what
  // follows. Never leaving an empty fragment either way.
  const groups: Token[][] = [];
  let current: Token[] = [];
  /** How many quotation brackets are open — see the cut test below. */
  let quoteDepth = 0;
  for (const token of ordered) {
    if (sourceLayoutOf(token)?.breakBefore && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(token);
    if (isBracket(token.text)) {
      // Clamped at zero, for the reason `splitProvisional` gives.
      quoteDepth = isOpeningBracket(token.text) ? quoteDepth + 1 : Math.max(0, quoteDepth - 1);
    }
    // **Never inside a quotation**, which is the other half of deferring to
    // the parser. `splitProvisional` now hands the pipeline a whole quotation;
    // cutting the tree it returns at the same marks would put the boundary
    // straight back, and this pass is the one that also *re-roots* each
    // fragment — so the tokens after the cut stop being any speech verb's
    // complement at all, and the と that closes the quotation has nothing left
    // to attach to. The reader's 異史氏曰：「…乎？…。』然歟否歟？」 lost it
    // entirely from the second fragment onward and wrote it after the first.
    //
    // A 。 inside 「」 is a sentence boundary of the quoted text, not of the
    // sentence doing the quoting, and the matrix sentence is what this
    // function divides. `quoteClosing` then finds the complement's own last
    // token by the ordinary route and needs no cross-sentence knowledge.
    if (quoteDepth === 0 && token.dep === "punct" && isSentenceFinalPunct(token.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  if (groups.length <= 1) return [sentence];

  return groups.map((group) => ({ tokens: rebase(group) }));
}

/** Renumbers a fragment's tokens from 0 and repairs its heads. */
function rebase(group: Token[]): Token[] {
  const newIdOf = new Map<number, number>();
  group.forEach((token, i) => newIdOf.set(token.id, i));

  const tokens = group.map((token, i) => ({ ...token, id: i, misc: token.misc ? { ...token.misc } : undefined }));

  // Whoever lost their head to the cut. In source order, so "first" below
  // means leftmost, which for these clauses is the one the rest hangs off.
  const orphans = tokens.filter((_, i) => !newIdOf.has(group[i].head) || group[i].head === group[i].id);
  const rootIndex = orphans.length > 0 ? orphans[0].id : 0;

  for (let i = 0; i < tokens.length; i++) {
    const originalHead = group[i].head;
    if (i === rootIndex) {
      tokens[i].head = rootIndex;
      tokens[i].dep = "ROOT";
      continue;
    }
    const remapped = newIdOf.get(originalHead);
    if (remapped !== undefined && originalHead !== group[i].id) {
      tokens[i].head = remapped;
      continue;
    }
    // Its head went the other side of the cut: attach to this fragment's
    // root, keeping whatever relation it had so the label still says what
    // the token was doing.
    tokens[i].head = rootIndex;
    if (tokens[i].dep === "ROOT") tokens[i].dep = "conj:coord";
  }
  return tokens;
}

/** Undoes the parser's own segmentation at a medial mark.
 *
 * It ends a sentence at ： and ；, which end no sentence: a ： introduces
 * reported speech inside the sentence that reports it (子曰：…), and a ；
 * joins clauses too closely bound to stand apart. Left alone, the two
 * halves are analysed as separate sentences, each with its own root, so
 * nothing relates what is said to the saying of it.
 *
 * Joining two trees needs one of the roots to give way: the second
 * sentence's root attaches to the first's as `parataxis`, the relation for
 * a clause juxtaposed with another rather than governed by it. That is
 * also what makes the pair read as one — a non-final clause in such a chain
 * takes 連用形 (see `isNonFinalCoordinand`), so 青於藍；寒於水 reads
 * 藍より青く水より寒し rather than as two flat statements. */
export function mergeAtMedialPunctuation(tree: TokenTree): TokenTree {
  const merged: Sentence[] = [];
  for (const sentence of tree.sentences) {
    const previous = merged[merged.length - 1];
    const endsMedial = previous !== undefined && endsWithMedialMark(previous);
    // A sentence that opens a new line stays its own, whatever the mark
    // before it: the break is a boundary in its own right.
    const opensLine = sourceLayoutOf([...sentence.tokens].sort((a, b) => a.id - b.id)[0])?.breakBefore;
    if (!endsMedial || opensLine) {
      merged.push(sentence);
      continue;
    }
    merged[merged.length - 1] = join(previous, sentence);
  }
  return { ...tree, sentences: merged };
}

function endsWithMedialMark(sentence: Sentence): boolean {
  const last = [...sentence.tokens].sort((a, b) => a.id - b.id).at(-1);
  return !!last && last.dep === "punct" && !isSentenceFinalPunct(last.text) && medialPunctuation(last.text) !== null;
}

function join(first: Sentence, second: Sentence): Sentence {
  const offset = first.tokens.length;
  const firstRoot = first.tokens.find((t) => t.head === t.id)?.id ?? 0;
  const shifted = [...second.tokens]
    .sort((a, b) => a.id - b.id)
    .map((token) => {
      const wasRoot = token.head === token.id;
      return {
        ...token,
        misc: token.misc ? { ...token.misc } : undefined,
        id: token.id + offset,
        head: wasRoot ? firstRoot : token.head + offset,
        dep: wasRoot ? "parataxis" : token.dep,
      };
    });
  return { tokens: [...first.tokens.map((t) => ({ ...t })), ...shifted] };
}
