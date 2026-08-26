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
