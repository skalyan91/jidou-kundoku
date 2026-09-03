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
