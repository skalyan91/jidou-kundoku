import { isSentenceFinalPunct } from "./punctuation.ts";
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
  for (const token of ordered) {
    if (sourceLayoutOf(token)?.breakBefore && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(token);
    if (token.dep === "punct" && isSentenceFinalPunct(token.text)) {
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
