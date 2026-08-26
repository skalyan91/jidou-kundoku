import type { TokenTree } from "../parse/types.ts";
import { READING_MISC_KEYS } from "../reading/chosenReading.ts";

/** Undo/redo for hand edits to the parse tree.
 *
 * Snapshots record only the fields an edit can touch — pos, dep, head, and
 * the hand-picked reading — and are restored *into* the existing `Token` objects rather than by swapping in
 * a rebuilt tree. That matters because the same `TokenTree` object is held
 * in several places at once — `main.ts`'s `lastRender`, the sidebar's
 * CoNLL-U exporter, the saved-texts panel — and replacing it would leave
 * every one of those references pointing at a tree the user can no longer
 * see. Writing the old values back in place keeps them all valid with no
 * plumbing at all.
 *
 * A snapshot is taken *before* each edit (see `withUndo`), which is also
 * what makes the asynchronous deprel relabels behave correctly: they land
 * after their own edit and are deliberately not recorded, so they fold
 * into whatever step the next undo reverts back past, instead of leaving
 * a maddening extra press between the structural change and its labels. */
interface TokenState {
  pos: string;
  dep: string;
  head: number;
  /** The hand-picked furigana reading, if any — see `chosenReading.ts`.
   * Recorded alongside the structural fields so that choosing a reading is
   * undoable like every other edit, rather than being the one that Cmd+Z
   * silently skipped. */
  reading?: string;
  okurigana?: string;
}

/** Per sentence, per token — positional, since neither the sentence count
 * nor the token count can change through any edit the inspector offers. */
type Snapshot = TokenState[][];

/** Deep enough for a working session's worth of retagging without letting
 * a long one grow without bound. Each entry is three fields per token, so
 * even a long text's snapshot is small. */
const MAX_DEPTH = 100;

let tree: TokenTree | null = null;
let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

function capture(target: TokenTree): Snapshot {
  return target.sentences.map((sentence) =>
    sentence.tokens.map((t) => ({
      pos: t.pos,
      dep: t.dep,
      head: t.head,
      reading: t.misc?.[READING_MISC_KEYS[0]],
      okurigana: t.misc?.[READING_MISC_KEYS[1]],
    })),
  );
}

function restore(target: TokenTree, snapshot: Snapshot): void {
  target.sentences.forEach((sentence, i) => {
    const row = snapshot[i];
    if (!row) return;
    sentence.tokens.forEach((token, j) => {
      const state = row[j];
      if (!state) return;
      token.pos = state.pos;
      token.dep = state.dep;
      token.head = state.head;
      // Written back through the same `misc` map the choice lives in, so
      // an undo that removes a reading really removes the key rather than
      // leaving an empty one the resolver would still honour.
      for (const [key, value] of [
        [READING_MISC_KEYS[0], state.reading],
        [READING_MISC_KEYS[1], state.okurigana],
      ] as const) {
        if (value === undefined) delete token.misc?.[key];
        else token.misc = { ...token.misc, [key]: value };
      }
    });
  });
}

function same(a: Snapshot, b: Snapshot): boolean {
  return a.every((row, i) => {
    const other = b[i];
    return (
      other?.length === row.length &&
      row.every(
        (s, j) =>
          s.pos === other[j].pos &&
          s.dep === other[j].dep &&
          s.head === other[j].head &&
          s.reading === other[j].reading &&
          s.okurigana === other[j].okurigana,
      )
    );
  });
}

/** Points the history at the tree now on screen. A re-render passes the
 * same object and is a no-op; a genuinely different tree (a fresh parse, a
 * saved text reopened) drops the history, since its snapshots describe
 * token positions in a document that is no longer displayed. */
export function setHistoryTree(next: TokenTree | null): void {
  if (next === tree) return;
  tree = next;
  undoStack = [];
  redoStack = [];
}

/** Runs `edit`, keeping a snapshot of the state before it as an undo step
 * — but only if the edit actually changed something, so that re-picking a
 * token's current tag (or rooting what is already the root) doesn't leave
 * an undo press that appears to do nothing. */
export function withUndo(edit: () => void): void {
  if (!tree) {
    edit();
    return;
  }
  const before = capture(tree);
  edit();
  if (same(before, capture(tree))) return;
  undoStack.push(before);
  if (undoStack.length > MAX_DEPTH) undoStack.shift();
  // A fresh edit is a new branch: whatever had been undone is no longer
  // reachable from here.
  redoStack = [];
}

/** Reverts the most recent recorded edit. Returns false when there is
 * nothing to undo, so the caller can leave the keystroke alone. */
export function undo(): boolean {
  if (!tree || undoStack.length === 0) return false;
  redoStack.push(capture(tree));
  restore(tree, undoStack.pop()!);
  return true;
}

export function redo(): boolean {
  if (!tree || redoStack.length === 0) return false;
  undoStack.push(capture(tree));
  restore(tree, redoStack.pop()!);
  return true;
}
