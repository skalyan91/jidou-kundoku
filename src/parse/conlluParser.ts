import { deprojectivizeSentence } from "./deprojectivize.ts";
import { type Sentence, type Token, type TokenTree } from "./types.ts";

/** The lzh_sud_kyoto parser relation inventory, from the shipped wheel's
 * meta.json. Used only to sanity-check uploaded CoNLL-U files, not to
 * restrict parsing — an unrecognized relation is still parsed, just flagged. */
const KNOWN_LZH_DEPRELS = new Set([
  "root",
  "cc",
  "clf",
  "comp:aux",
  "comp:obj",
  "comp:obl",
  "comp:obl@lmod",
  "comp:pred",
  "comp@expl",
  "compound",
  "compound@redup",
  "conj:coord",
  "conj:coord@emb",
  "dep",
  "det",
  "discourse",
  "discourse@sp",
  "dislocated",
  "flat",
  "flat@foreign",
  "flat@vv",
  "list",
  "mod",
  "mod@lmod",
  "mod@tmod",
  "parataxis",
  "punct",
  "subj",
  "udep",
  "udep@lmod",
  "udep@tmod",
  "unk",
  "unk@expl",
  "vocative",
]);

const CJK_RANGE =
  /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2FFFF}]/u;

function parseMisc(field: string): Record<string, string> | undefined {
  if (field === "_" || field === "") return undefined;
  const out: Record<string, string> = {};
  for (const pair of field.split("|")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** True for a CoNLL-U ID field that isn't a plain single-token integer id:
 * a multiword-token range ("3-4") or an empty node ("3.1"). Both are
 * skipped — this app only reorders/annotates ordinary single tokens. */
function isRangeOrEmptyNodeId(id: string): boolean {
  return id.includes("-") || id.includes(".");
}

/** Parses raw CoNLL-U text into a TokenTree. Sentence-relative token ids are
 * renumbered 0-based in document order (skipping MWT ranges/empty nodes),
 * independent of the file's own 1-based IDs. The root token's `head` is set
 * to its own id (self-loop), matching the Pyodide path's convention; a
 * lowercase `root` DEPREL is normalized to `"ROOT"` for the same reason. */
export function parseConllu(text: string): TokenTree {
  const sentences: Sentence[] = [];
  let block: string[] = [];

  const flush = () => {
    if (block.length === 0) return;
    sentences.push(parseSentenceBlock(block));
    block = [];
  };

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine;
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("#")) continue;
    block.push(line);
  }
  flush();

  return { sentences, source: "conllu" };
}

function parseSentenceBlock(lines: string[]): Sentence {
  // Pass 1: keep only ordinary token lines, and map each one's original
  // 1-based CoNLL-U ID to its new 0-based sentence-relative id.
  type Row = { fields: string[]; newId: number };
  const rows: Row[] = [];
  const idMap = new Map<string, number>();

  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length < 8) continue;
    const id = fields[0];
    if (isRangeOrEmptyNodeId(id)) continue;
    const newId = rows.length;
    idMap.set(id, newId);
    rows.push({ fields, newId });
  }

  const tokens: Token[] = rows.map(({ fields, newId }) => {
    const [, form, lemmaField, upos, xpos, feats, headField, deprelField] = fields;
    // Left decorated on purpose: `deprojectivizeSentence` below needs both
    // halves of a `a||b` label to find the head the arc was lifted off, and
    // collapses it itself once it has. The ROOT test therefore runs on the
    // first half only, so a lifted `root||x` is still recognised as the root.
    const deprel = deprelField.split("||")[0].toLowerCase() === "root" ? "ROOT" : deprelField;
    const head = headField === "0" ? newId : (idMap.get(headField) ?? newId);
    const misc = fields[9] !== undefined ? parseMisc(fields[9]) : undefined;

    const token: Token = {
      id: newId,
      text: form,
      lemma: lemmaField === "_" ? form : lemmaField,
      pos: upos === "_" ? "" : upos,
      xpos: xpos === "_" ? "" : xpos,
      dep: deprel,
      head,
    };
    if (feats !== "_" && feats !== "") token.morph = feats;
    if (misc) token.misc = misc;
    return token;
  });

  // Lowers any arc the file left lifted and collapses its label. A no-op on
  // an ordinary CoNLL-U file, which carries no decorated label at all —
  // checked against the user's own exports and the whole lzh SUD treebank,
  // both of which have none. See `deprojectivize.ts`.
  return { tokens: deprojectivizeSentence(tokens).tokens };
}

export interface ConlluValidation {
  valid: boolean;
  warnings: string[];
}

/** Heuristic plausibility check for "is this actually an lzh SUD treebank",
 * so the UI can warn instead of silently mis-rendering a mismatched upload
 * (e.g. a different language's UD/SUD treebank, or a non-SUD CoNLL-U file). */
export function validateConlluForLzh(tree: TokenTree): ConlluValidation {
  const warnings: string[] = [];
  const allTokens = tree.sentences.flatMap((s) => s.tokens);

  if (allTokens.length === 0) {
    return { valid: false, warnings: ["No tokens found in the uploaded file."] };
  }

  const cjkCount = allTokens.filter((t) => CJK_RANGE.test(t.text)).length;
  const cjkRatio = cjkCount / allTokens.length;
  if (cjkRatio < 0.5) {
    warnings.push(
      `Only ${Math.round(cjkRatio * 100)}% of tokens contain CJK characters — this may not be a Literary Chinese treebank.`,
    );
  }

  const deprels = new Set(allTokens.map((t) => t.dep.toLowerCase()));
  const recognized = [...deprels].filter((d) => KNOWN_LZH_DEPRELS.has(d));
  const recognizedRatio = recognized.length / deprels.size;
  if (recognizedRatio < 0.5) {
    warnings.push(
      "Most dependency relations in this file don't match the lzh_sud_kyoto relation inventory — it may be from a different treebank/language.",
    );
  }

  return { valid: warnings.length === 0, warnings };
}
