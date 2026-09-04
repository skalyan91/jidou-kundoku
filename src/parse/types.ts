/** Shared token-tree schema produced by both the Pyodide parse path and the
 * CoNLL-U upload path. Everything downstream (reorder engine, reading
 * resolver, kakikudashi generator) operates only on this shape. */

export interface Token {
  /** 0-based, sentence-relative index. */
  id: number;
  text: string;
  lemma: string;
  /** UPOS. */
  pos: string;
  /** Treebank XPOS, e.g. "v,動詞,行為,動作". */
  xpos: string;
  /** SUD relation, "ROOT" at the root token. */
  dep: string;
  /** Sentence-relative index of the head token; equals `id` at the root. */
  head: number;
  /** Raw morphological feature string, spaCy `token.morph_` / CoNLL-U FEATS
   * format ("Key1=Val1|Key2=Val2"). Populated by the Pyodide worker and the
   * CoNLL-U importer; consumed by the kakikudashi generator's bungo
   * conjugation lookup. */
  morph?: string;
  /** sud_misc extension fields (Idiom/Subject/Reported/Shared), if present. */
  misc?: Record<string, string>;
}

export interface Sentence {
  tokens: Token[];
}

export interface TokenTree {
  sentences: Sentence[];
  source: "pyodide" | "conllu";
}

/** The relation a token really bears, given that this parser sometimes emits
 * two joined by `||` — `punct||mod` and the like.
 *
 * These are spaCy's **deprojectivization pseudo-labels**. A projective parser
 * cannot produce a crossing arc, so a non-projective training tree is first
 * *lifted* — the arc is re-attached to an ancestor — and the label rewritten
 * to record both halves: the dependent's own relation, then the relation of
 * the head it was lifted over. At inference the pair is meant to be undone by
 * lowering the arc back; where that does not happen, the pair reaches us
 * intact and matches none of the 34 relations every rule downstream is
 * written against, so the token falls through every classification silently.
 *
 * Taking the **first** member keeps the dependent's own relation, which is
 * the half that describes this token. It does *not* restore the head — the
 * arc stays lifted, so the tree is still the projective approximation the
 * parser chose.
 *
 * That is why this is the *label-only* half of the job, and not what either
 * entry point calls. Both of them go through `deprojectivizeSentence`, which
 * uses the second half of the pair to find the head the arc was lifted off
 * and lowers it back before collapsing the label — see `deprojectivize.ts`,
 * which also documents the encoding scheme and where the evidence for it is.
 *
 * What is left for this function is the case with no tree to lower into: the
 * argmax label `scoreArc` reads out of the parser's transition system is a
 * *move name*, and move names carry the decoration because the moves were
 * trained on decorated data (see `scoreArc` in `pyodideWorker.ts`, whose
 * label distribution keeps them on purpose). */
export function normalizeDeprel(dep: string): string {
  const bar = dep.indexOf("||");
  return bar === -1 ? dep : dep.slice(0, bar);
}

/** Whether this UPOS names a **用言 carrying lexical content of its own** — a
 * word kundoku reads with a conjugating Japanese ending, as against a nominal
 * that needs a copula synthesized for it or an AUX that is an ending already.
 *
 * **VERB *and* ADJ, and the ADJ half is new in parser 0.3.2.** Every version
 * up to 0.3.1 recoded nothing: a Classical Chinese stative predicate — 高, 深,
 * 大, 賢, 半, 肥, 貧 — came back `VERB` with `Degree=Pos` on it, and the ADJ tag
 * appeared in the morphologizer's inventory only as a few odd bundles the
 * gold treebank never used (0 ADJ tokens over its 433,169). Rules written for
 * a stative could therefore say `pos === "VERB"` and mean it. 0.3.2 recodes
 * the class: its morphologizer holds **8 ADJ bundles** where 0.3.1 held none
 * that mattered, `VERB` no longer carries `Degree=Pos` at all, and the release
 * notes put the share of tokens that move at ~16%. Against the recoded gold
 * (`…rulemerged.adjfix`, which is that recoding applied to the treebank the
 * model trains on) it is **22,368 of 137,358** former VERB tokens, 16.3%.
 *
 * **Which is why every such test had to be re-read one at a time**, and why
 * this predicate exists rather than a blanket rewrite. A `pos === "VERB"` in
 * this app meant one of two different things and the recoding splits them:
 *
 *  - "a predicate, something with a conjugated form" — a caused predicate, a
 *    nominalized clause, a protasis, a link in a coordination chain, a token
 *    the verb lexicon speaks for. A stative is all of those, so these sites
 *    want this function, and left alone they would silently drop ~16% of what
 *    they used to catch. This is the dangerous direction: no error, no crash.
 *  - "a genuine *verb*, as against an adjective" — the サ変 す supplied to a
 *    word read on'yomi (大破す, and never 高す), the transitivity of a kun'yomi.
 *    Those sites already wrote the exclusion out by hand, as `!isAdjective`
 *    or a `Degree=Pos` test, because they had to; under 0.3.2 the tag makes it
 *    for them and they stay `pos === "VERB"`.
 *
 * **Not the same question as "is this token descriptive".** All 8 of the
 * parser's ADJ bundles carry `Degree=Pos`, so a `Degree`-keyed test still
 * fires on every adjective the parser emits and needed no change — see
 * `bungoConjugation.ts`'s `isDescriptiveToken`, which is the test to use
 * where what is being asked is 形容動詞-hood rather than predicate-hood.
 *
 * AUX is deliberately absent: the modals 能/得/敢/欲 are predicates too, but
 * not every caller wants them, so a site that does adds `|| pos === "AUX"`
 * beside this the way it always did. */
export function isContentPredicatePos(pos: string | undefined): boolean {
  return pos === "VERB" || pos === "ADJ";
}
