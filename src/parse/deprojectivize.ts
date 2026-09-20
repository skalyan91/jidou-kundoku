import { normalizeDeprel, type Token } from "./types.ts";

/* ── Undoing pseudo-projective parsing ────────────────────────────────────
 *
 * A transition-based parser of the arc-eager kind can only build *projective*
 * trees — no arc may cross another. Literary Chinese trees are not always
 * projective, so spaCy trains on a projective approximation: Nivre & Nilsson
 * 2005's pseudo-projective transform *lifts* each crossing arc onto an
 * ancestor of its true head and rewrites the label to record what was lost.
 * At inference the transform is supposed to be inverted, lowering the arc
 * back onto the head it came from.
 *
 * The scheme in play here is **HEAD** — the first of Nivre & Nilsson's three
 * (HEAD, HEAD+PATH, PATH). Established by reading spaCy's own implementation
 * in `spacy/pipeline/_parser_internals/nonproj.pyx`, which says so in its
 * module docstring ("implementation uses the HEAD decoration scheme") and
 * then behaves that way in both directions:
 *
 *   - `_decorate` writes `f"{labels[tokenid]}||{labels[head]}"` — the
 *     dependent's own relation, then the relation borne by its *true head*.
 *     Nothing marks the path, which is what distinguishes HEAD from the two
 *     PATH variants.
 *   - `deprojectivize` inverts it by `_find_new_head(token, head_label)`,
 *     which breadth-first-searches downward from the lifted head for the
 *     first node whose own incoming relation is `head_label`.
 *
 * So `d ──a||b──> h'` means: `d`'s relation is really **a**, and its real
 * head is a descendant of `h'` whose own incoming relation is **b**.
 *
 * ── Why this exists at all, given that spaCy already does it ─────────────
 *
 * `DependencyParser.postprocesses` is `[nonproj.deprojectivize]`, and
 * `Parser.set_annotations` runs it on every doc, so the Pyodide path's
 * `nlp.pipe` hands us trees that are *already* deprojectivized. Measured
 * against the shipped `lzh_sud_kyoto` **0.3.2** wheel: of its **79 parser
 * moves 31 are decorated** (`L-punct||mod`, `L-conj:coord||comp:obj`,
 * `L-punct||subj`, …), and after the pipeline **no token bears a `||` label
 * at all** — 0 of 20,070 tokens over the 4,000 held-out dev sentences.
 * This module is therefore a no-op on that path in practice,
 *
 * **Re-counted on 0.3.2 and unchanged, which was expected**: that release
 * retrains only the UPOS-reading components (see `bungoConjugation.ts` for the
 * 8 bundles that move), leaves `tok2vec` and `parser` frozen, and ships a
 * relation inventory byte-identical to 0.3.1's — 34 labels, 79 moves, the same
 * 31 decorated. Nothing here needed re-deriving; only the version this was
 * measured against did.
 *
 * **And again on 0.3.3, by checksum rather than by count.** That release
 * retrains the morphologiser alone, to read the SikuBERT vector channel the
 * tagger already read. Diffed file by file against 0.3.2, `parser/model`,
 * `parser/moves`, `tok2vec/model`, `tagger/model`, `sud_shared/model` and
 * `vocab/vectors` are byte-identical, so the moves and their decorations
 * cannot have changed.
 *
 * **0.3.4 and 0.3.5 are code-only releases of one pipe.** Both change
 * `sent_join` and nothing else — 0.3.4 adds `final_pull` and
 * `classifier_join`, 0.3.5 `join_unpunctuated` — and that pipe runs after the
 * parser and rewrites heads rather than labels. Every model file, `parser/moves`
 * included, is byte-identical to 0.3.3's.
 *
 * The decorated share is far larger than it was measured at under 0.2.0,
 * where this comment claimed 46 moves and a single decorated one. That
 * figure was taken from a 0.1.0 model in a stale virtualenv — the version
 * trap this project has hit before — so treat it as never having described
 * the shipped wheel. What has not changed is the conclusion: the postprocess
 * removes every decoration before the trees reach us, so what 31 decorated
 * moves actually affect is `scoreArc`'s label distribution, whose argmax is
 * a *move name* and therefore does carry them (see `normalizeDeprel`).
 * and is applied there only so the invariant "no token downstream carries a
 * decorated label, and no arc downstream is knowingly left lifted" is one
 * this app enforces rather than one it inherits.
 *
 * Where it does work is the **upload** path. A CoNLL-U file written by
 * something else — a raw spaCy dump taken before the postprocess, another
 * pseudo-projective parser, a training corpus in its projectivized form —
 * can carry decorated labels, and until now those arrived merely collapsed:
 * the relation recovered, the attachment still lifted.
 *
 * ── Fidelity to spaCy, deliberately ──────────────────────────────────────
 *
 * `deprojectivize` rewrites the tree *while* it walks it, and what
 * `_find_new_head` sees at each step is a specific mixture of the old tree
 * and the new one. Reproduced here exactly rather than tidied up, because
 * the point is to invert the encoder that produced these labels, not to
 * search a tree the way one might prefer. Three parts to it:
 *
 *   1. **The labels are live.** `child.dep_` reads the current label, so a
 *      token whose `punct||mod` was already collapsed to `punct` earlier in
 *      the loop can be matched as a `punct` head later on.
 *   2. **Parenthood is live too.** `Token.lefts`/`Token.rights` do not read
 *      a stored child list; they scan a span and test `ptr + ptr.head ==
 *      self.c`, i.e. the token's *current* head. So an arc already lowered
 *      earlier in the loop has left its old parent's children and joined its
 *      new one's.
 *   3. **But the span they scan is frozen.** That scan runs from `l_edge` to
 *      `r_edge`, which `set_children_from_heads` last wrote before the loop
 *      began and does not write again until after it — the subtree span each
 *      node had in the tree as it arrived. A token re-attached *out* of that
 *      span is therefore invisible to its new parent.
 *
 * The third is what makes this worth spelling out: children are neither the
 * old tree's nor the new one's, and a search written either way disagrees
 * with spaCy on real input. Cross-checked against `nonproj.deprojectivize`
 * itself over 3,000 random decorated trees.
 *
 * Order within a level is source order: `Token.children` yields `lefts` then
 * `rights`, each ascending, and every left child precedes the parent which
 * precedes every right child — so the concatenation is ascending position
 * order.
 *
 * ── Where this departs from spaCy, deliberately ──────────────────────────
 *
 * spaCy re-attaches unconditionally. This app cannot afford to: a reading
 * order is walked off these trees, and a cycle or a second root there is not
 * a worse parse but a hang or a thrown reorder. So every candidate is
 * checked before it is taken (`isAncestorOf`), and the finished tree is
 * checked as a whole (`isWellFormed`) with the entire re-attachment pass
 * discarded if it does not hold. A wrong attachment is worse than a lifted
 * one; failing closed keeps the lifted one. */

/** What one pass of `deprojectivizeSentence` did, so callers can report it
 * rather than guess. `decorated` counts arcs that bore a `a||b` label at
 * all; `reattached` those actually lowered onto a recovered head;
 * `failedClosed` those left on the lifted head — either because no node
 * with the recorded relation was found below it, or because taking the one
 * found would have made a cycle. `reverted` is the whole-sentence escape
 * hatch: the pass produced something that was not a tree, so none of it was
 * kept. `decorated === reattached + failedClosed` always. */
export interface DeprojectivizeStats {
  decorated: number;
  reattached: number;
  failedClosed: number;
  reverted: boolean;
}

export interface DeprojectivizeResult {
  tokens: Token[];
  stats: DeprojectivizeStats;
}

/** A fresh zeroed count, so no caller can mutate a shared one. */
export function emptyDeprojectivizeStats(): DeprojectivizeStats {
  return { decorated: 0, reattached: 0, failedClosed: 0, reverted: false };
}

/** True for a label carrying Nivre & Nilsson's decoration — `subj||comp:obj`
 * and the like. */
export function isDecorated(dep: string): boolean {
  return dep.includes("||");
}

/** The head half of a decorated label: the relation the *true* head bears.
 * Empty for an undecorated label. */
function headLabelOf(dep: string): string {
  const bar = dep.indexOf("||");
  return bar === -1 ? "" : dep.slice(bar + 2);
}

/** Walks up from `start` through `heads`, reporting whether `target` is on
 * the path — used both as the cycle guard and, from the root, as the
 * connectedness check. Bounded by the token count, so it terminates on a
 * tree that already has a cycle in it rather than spinning. */
function isAncestorOf(target: number, start: number, heads: number[]): boolean {
  let cur = start;
  for (let steps = 0; steps <= heads.length; steps++) {
    if (cur === target) return true;
    const next = heads[cur];
    if (next === cur) return false; // root, self-loop convention
    if (next === undefined) return false;
    cur = next;
  }
  return false;
}

/** Exactly one self-loop root, every head in range, no cycles, and every
 * token reachable from the root — the four properties everything downstream
 * assumes and none of which a re-attachment pass may break. In the spirit of
 * `computeReadingOrder`'s coverage check: state the invariant and test it,
 * rather than trust that the algorithm maintained it. */
function isWellFormed(heads: number[]): boolean {
  const n = heads.length;
  if (n === 0) return true;

  let root = -1;
  for (let i = 0; i < n; i++) {
    const h = heads[i];
    if (!Number.isInteger(h) || h < 0 || h >= n) return false;
    if (h === i) {
      if (root !== -1) return false; // a second root
      root = i;
    }
  }
  if (root === -1) return false; // no root

  // Connected and acyclic at once: from every token the walk up must reach
  // the root within n steps. A cycle never reaches it; a token in a
  // disconnected component cannot either, since the only self-loop is the
  // root.
  for (let i = 0; i < n; i++) {
    let cur = i;
    let steps = 0;
    while (cur !== root && steps <= n) {
      cur = heads[cur];
      steps++;
    }
    if (cur !== root) return false;
  }
  return true;
}

/** Lowers every lifted arc in one sentence back onto the head its label
 * records, and collapses the label either way.
 *
 * Returns the same `tokens` array reference, untouched, when the sentence
 * carries no decorated label — the overwhelmingly common case, and worth not
 * allocating for. Otherwise returns fresh `Token` objects; the input is
 * never mutated.
 *
 * `tokens` must be 0-based and contiguous with `head` a valid index and the
 * root a self-loop, which is what both entry points produce. A sentence that
 * is not already a well-formed tree is left alone apart from the label
 * collapse — there is no true tree to restore an arc into. */
export function deprojectivizeSentence(tokens: Token[]): DeprojectivizeResult {
  const decoratedIds: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isDecorated(tokens[i].dep)) decoratedIds.push(i);
  }
  if (decoratedIds.length === 0) {
    return { tokens, stats: emptyDeprojectivizeStats() };
  }

  const collapsed = tokens.map((t) => ({ ...t, dep: normalizeDeprel(t.dep) }));
  const stats: DeprojectivizeStats = {
    decorated: decoratedIds.length,
    reattached: 0,
    failedClosed: decoratedIds.length,
    reverted: false,
  };

  const originalHeads = tokens.map((t) => t.head);
  if (!isWellFormed(originalHeads)) {
    // Not a tree to begin with (a malformed upload). Keep the relation,
    // keep the attachment, say nothing about a structure we cannot trust.
    return { tokens: collapsed, stats };
  }

  // The frozen scan windows: `l_edge`/`r_edge` as spaCy last wrote them,
  // which for a tree is the span of each node's subtree. Computed by walking
  // each token's ancestor chain once, which is what the repeated
  // `_set_lr_kids_and_edges` passes converge to.
  const lo = tokens.map((_, i) => i);
  const hi = tokens.map((_, i) => i);
  for (let i = 0; i < tokens.length; i++) {
    let cur = i;
    for (let steps = 0; steps <= tokens.length; steps++) {
      if (i < lo[cur]) lo[cur] = i;
      if (i > hi[cur]) hi[cur] = i;
      const next = originalHeads[cur];
      if (next === cur) break;
      cur = next;
    }
  }

  // Live labels and live heads: both are rewritten in place as the loop
  // proceeds, exactly as spaCy rewrites `doc.c[i].dep` and `doc.c[i].head`
  // before moving on to the next token.
  const labels = tokens.map((t) => t.dep);
  const heads = originalHeads.slice();
  let reattached = 0;

  for (const d of decoratedIds) {
    const wanted = headLabelOf(tokens[d].dep);
    labels[d] = normalizeDeprel(tokens[d].dep);

    // The root's attachment is not a claim about anything and must stay a
    // self-loop; a decorated label on it is meaningless.
    if (heads[d] === d) continue;

    const lifted = heads[d];
    const found = findNewHead(lifted, d, wanted, lo, hi, heads, labels);
    if (found === null) continue;
    // spaCy has no such check. Its search cannot descend through `d`, so it
    // cannot reach `d`'s subtree by the ordinary route — but parenthood is
    // live, so an earlier re-attachment in this same loop may have moved a
    // node under `d` since, and lowering onto that would close a cycle.
    if (found === d || isAncestorOf(d, found, heads)) continue;
    heads[d] = found;
    reattached++;
  }

  if (reattached > 0 && isWellFormed(heads)) {
    for (let i = 0; i < collapsed.length; i++) collapsed[i].head = heads[i];
    stats.reattached = reattached;
    stats.failedClosed = decoratedIds.length - reattached;
  } else if (reattached > 0) {
    // Should be unreachable given the per-arc guard; kept because a tree
    // that is silently not a tree is the failure this module exists to
    // avoid, and reverting costs nothing.
    stats.reverted = true;
  }

  return { tokens: collapsed, stats };
}

/** The children of `parent` as `Token.children` reports them mid-loop: the
 * tokens inside the frozen `[lo, hi]` scan window whose *current* head is
 * `parent`, left children first and each group ascending. */
function liveChildren(parent: number, lo: number[], hi: number[], heads: number[]): number[] {
  const out: number[] = [];
  for (let c = lo[parent]; c < parent; c++) if (heads[c] === parent) out.push(c);
  for (let c = parent + 1; c <= hi[parent]; c++) if (heads[c] === parent) out.push(c);
  return out;
}

/** spaCy's `_find_new_head`: breadth-first downward from `lifted`, level by
 * level, source order within a level, for the first node whose own incoming
 * relation is `wanted`. `dependent` is skipped and so, transitively, is
 * everything still below it — the only route into its subtree is through it.
 * Returns null where spaCy returns `token.head` (no change).
 *
 * `seen` is this implementation's own: spaCy's queue can revisit a node if
 * the live/frozen mixture above makes one reachable twice, and while that
 * only wastes work there, an unbounded queue is not something to leave to
 * luck. Visiting each node at most once cannot change which node is found
 * first, since BFS reaches every node at its shallowest depth anyway. */
function findNewHead(
  lifted: number,
  dependent: number,
  wanted: string,
  lo: number[],
  hi: number[],
  heads: number[],
  labels: string[],
): number | null {
  let queue = [lifted];
  const seen = new Set<number>([lifted, dependent]);
  while (queue.length > 0) {
    const next: number[] = [];
    for (const parent of queue) {
      for (const child of liveChildren(parent, lo, hi, heads)) {
        if (seen.has(child)) continue;
        if (labels[child] === wanted) return child;
        seen.add(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return null;
}

/** The same over a whole document, summing the per-sentence counts. */
export function deprojectivizeSentences(sentences: Token[][]): {
  sentences: Token[][];
  stats: DeprojectivizeStats;
} {
  const total = emptyDeprojectivizeStats();
  const out = sentences.map((tokens) => {
    const { tokens: next, stats } = deprojectivizeSentence(tokens);
    total.decorated += stats.decorated;
    total.reattached += stats.reattached;
    total.failedClosed += stats.failedClosed;
    total.reverted = total.reverted || stats.reverted;
    return next;
  });
  return { sentences: out, stats: total };
}
