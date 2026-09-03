import type { Token, TokenTree } from "./types.ts";

/** The source text's own line and paragraph structure, recorded onto the
 * tree so the panels can lay the text out as it was written.
 *
 * The parser throws this away: it is fed a string, segments it into
 * sentences by its own lights, and returns tokens with no offsets. Worse,
 * its sentence boundaries and the source's line boundaries do not agree —
 * a five-character verse line and the one after it come back as a single
 * sentence — so layout cannot be recovered from the tree's own shape and
 * has to be measured against the original string instead.
 *
 * That measurement is possible because every token's `text` is a
 * non-whitespace substring of the source, and they appear in order. Walking
 * the two together, skipping whitespace as it comes, gives each token its
 * source position and so the whitespace that preceded it.
 *
 * Stored in `misc`, which already carries hand-picked readings, so it
 * survives saving, CoNLL-U export and reopening by the same route.
 * Deliberately as an *interpretation* (a line break, a paragraph break, an
 * indent width) rather than UD's raw `SpacesBefore` escaping: the panels
 * need the interpretation, and an escaped newline in a MISC field is an
 * easy thing to get wrong on a round trip. */
const LINE_BREAK = "LineBreak";
const INDENT = "Indent";

/** Two or more newlines separate paragraphs; one starts a new line. */
export type LineBreakKind = "line" | "para";

export interface SourceLayout {
  /** Set when the token begins a new line, and how much of one. */
  breakBefore?: LineBreakKind;
  /** Leading whitespace on that line, in source characters. */
  indent: number;
}

/** What `token` carries, or null where it continues the current line. */
export function sourceLayoutOf(token: Token): SourceLayout | null {
  const kind = token.misc?.[LINE_BREAK];
  const indent = Number(token.misc?.[INDENT] ?? 0);
  if (kind !== "line" && kind !== "para") return indent > 0 ? { indent } : null;
  return { breakBefore: kind, indent };
}

function record(token: Token, kind: LineBreakKind | undefined, indent: number): void {
  if (!kind && indent === 0) return;
  token.misc = { ...token.misc };
  if (kind) token.misc[LINE_BREAK] = kind;
  if (indent > 0) token.misc[INDENT] = String(indent);
}

/** Measures `source`'s layout onto `tree`'s tokens, in place.
 *
 * Gives up quietly if the two stop lining up — a token that isn't found at
 * the cursor means the parser normalised something, and a half-applied
 * layout would be worse than none.
 *
 * `openingBreak` is for a `source` that is a **slice** of a longer document.
 * The first token of a whole document begins no line, however the file
 * begins, which is what `firstOfAll` below says; but the first token of a
 * slice taken out of the middle of one may very well begin a line, and the
 * slice itself no longer carries the newline that says so — it was consumed
 * as the *previous* slice's trailing whitespace. The caller that cut the
 * slice knows, so it passes the answer in. Left undefined (the ordinary
 * whole-document call) nothing changes: the first token begins no line.
 *
 * The progressive parse is the caller — see `waveSource` in `main.ts`, which
 * hands the parser one wave of the document at a time and needs each wave's
 * own tokens laid out before the wave can be drawn. The whole-document
 * measurement still runs at the end, over the assembled tree, so what is
 * saved and exported is measured exactly as it always was. */
export function annotateSourceLayout(tree: TokenTree, source: string, openingBreak?: LineBreakKind): void {
  const tokens: Token[] = tree.sentences.flatMap((s) => s.tokens);
  let cursor = 0;
  let firstOfAll = true;

  for (const token of tokens) {
    // Consume the whitespace before this token, counting what it means.
    let newlines = 0;
    let indent = 0;
    while (cursor < source.length && /\s/.test(source[cursor])) {
      if (source[cursor] === "\n") {
        newlines++;
        indent = 0; // only whitespace *after* the last newline indents
      } else {
        indent++;
      }
      cursor++;
    }

    if (!source.startsWith(token.text, cursor)) return; // out of step; leave the rest alone
    // The very first token starts no new line, however the file begins —
    // unless the caller cut this source out of a longer one and says
    // otherwise (see `openingBreak`).
    const kind: LineBreakKind | undefined = firstOfAll
      ? openingBreak
      : newlines >= 2
        ? "para"
        : newlines === 1
          ? "line"
          : undefined;
    record(token, kind, indent);
    cursor += token.text.length;
    firstOfAll = false;
  }
}
