import type { Sentence, Token, TokenTree } from "./types.ts";

/** Serializes `misc` back to CoNLL-U's "Key1=Val1|Key2=Val2" MISC field. */
function formatMisc(misc: Record<string, string> | undefined): string {
  if (!misc || Object.keys(misc).length === 0) return "_";
  return Object.entries(misc)
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

function formatToken(token: Token, rootId: number): string {
  // CoNLL-U is 1-based; this app's Token.id is 0-based and sentence-
  // relative (see types.ts) — +1 converts back on the way out. The root's
  // HEAD field is the literal "0" (CoNLL-U's own root convention), not a
  // self-loop like this app's internal `head === id`.
  const id = token.id + 1;
  const head = token.id === rootId ? 0 : token.head + 1;
  const deprel = token.dep === "ROOT" ? "root" : token.dep;
  const feats = token.morph && token.morph.length > 0 ? token.morph : "_";
  return [id, token.text, token.lemma, token.pos || "_", token.xpos || "_", feats, head, deprel, "_", formatMisc(token.misc)].join(
    "\t",
  );
}

function formatSentence(sentence: Sentence, index: number): string {
  const rootId = sentence.tokens.find((t) => t.head === t.id)?.id;
  const text = sentence.tokens
    .filter((t) => t.dep !== "punct")
    .map((t) => t.text)
    .join("");
  const lines = [`# sent_id = ${index + 1}`, `# text = ${text}`, ...sentence.tokens.map((t) => formatToken(t, rootId ?? t.id))];
  return lines.join("\n");
}

/** Serializes a `TokenTree` back to plain CoNLL-U text — the inverse of
 * `conlluParser.ts`'s `parseConllu`, so a tree parsed via Pyodide (or
 * re-uploaded) can be downloaded and, round-tripped through the upload
 * path, reproduce the identical `Sentence[]` (modulo the id renumbering
 * `parseConllu` already does unconditionally on *any* input). */
export function exportConllu(tree: TokenTree): string {
  return tree.sentences.map((s, i) => formatSentence(s, i)).join("\n\n") + "\n";
}
