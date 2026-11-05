import type { TokenTree } from "../parse/types.ts";
import { READING_MISC_KEYS } from "../reading/chosenReading.ts";

/** Undo/redo for hand edits to the parse tree.
 *
 * Snapshots record only the fields an edit can touch — pos, xpos, dep, head,
 * and the hand-picked reading — and are restored *into* the existing `Token`
 * objects rather than by swapping in
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
  /** The four-field treebank tag — `n,名詞,人,姓氏` and the like. The three
   * POS category menus (`retag` in tokenInspector.ts) always write this and
   * only *sometimes* write `pos` alongside it (`uposForXpos` can leave the
   * UPOS untouched, and often does — moving between two domains under the
   * same 品詞 changes nothing above it). Omitting this field meant two
   * distinct failures at once: an edit that happened to leave `pos` alone
   * was invisible to `same()` below and never reached the undo stack at
   * all, and an edit that did change `pos` restored it while leaving `xpos`
   * at its new value — a token whose two tag fields then disagreed with
   * each other. Both are what "I'm not able to undo POS changes" was. */
  xpos: string;
  dep: string;
  head: number;
  /** The hand-picked furigana reading, if any — see `chosenReading.ts`.
   * Recorded alongside the structural fields so that choosing a reading is
   * undoable like every other edit, rather than being the one that Cmd+Z
   * silently skipped.
   *
   * Every key that module declares, in its order, rather than a named field
   * apiece: a choice is made of all of them at once, and one left out is a
   * key the undo does not put back. That was live in miniature the moment a
   * third key was added — the reading and its ending were restored while the
   * conjugation class stayed behind, leaving a paradigm attached to a reading
   * that never asked for one. Reading the list itself is what keeps this in
   * step with `chosenReading.ts` on its own. */
  readingMisc: (string | undefined)[];
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
      xpos: t.xpos,
      dep: t.dep,
      head: t.head,
      readingMisc: READING_MISC_KEYS.map((key) => t.misc?.[key]),
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
      token.xpos = state.xpos;
      token.dep = state.dep;
      token.head = state.head;
      // Written back through the same `misc` map the choice lives in, so
      // an undo that removes a reading really removes the key rather than
      // leaving an empty one the resolver would still honour.
      READING_MISC_KEYS.forEach((key, k) => {
        const value = state.readingMisc[k];
        if (value === undefined) delete token.misc?.[key];
        else token.misc = { ...token.misc, [key]: value };
      });
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
          s.xpos === other[j].xpos &&
          s.dep === other[j].dep &&
          s.head === other[j].head &&
          s.readingMisc.every((v, k) => v === other[j].readingMisc[k]),
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
  notifyAvailability();
}

/** A history lifted off the page whole — the tree and both stacks — so that
 * a document put away can come back with its undo intact.
 *
 * What the sidebar's Clear needs, and the reason it is not `setHistoryTree`
 * twice: clearing drops the history (an undo after a clear must not draw the
 * cleared text back over an empty page), and undoing the clear would then
 * bring the text back with nothing to undo — twenty minutes of corrections
 * returned as one fixed state. Held instead, the reader gets back exactly
 * the page they cleared, every step of it still reversible. */
export interface HeldHistory {
  tree: TokenTree;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
}

/** Detaches the current history and returns it, leaving none behind — the
 * same state `setHistoryTree(null)` leaves. Null when there was nothing to
 * hold. */
export function takeHistory(): HeldHistory | null {
  const held = tree ? { tree, undoStack, redoStack } : null;
  setHistoryTree(null);
  return held;
}

/** Puts a held history back. Only onto the tree it was taken from: the
 * snapshots are positional, so on any other tree they would describe tokens
 * that are not there. The caller re-renders that tree first, which points
 * the history at it with empty stacks; this then fills them. */
export function restoreHistory(held: HeldHistory): void {
  if (tree !== held.tree) return;
  undoStack = held.undoStack;
  redoStack = held.redoStack;
  notifyAvailability();
}

/** Called after every change a reader made to the tree — an edit recorded,
 * an undo, a redo. The saved panel listens, so that a correction is written
 * back within moments of being made rather than at the next minute's tick. */
const changeListeners = new Set<() => void>();

export function onHistoryChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
  notifyAvailability();
}

/** **Whether there is a step to take back, or one to take again** — what
 * the panel's undo and redo buttons are enabled by (`editControls.ts`).
 * False with no tree at all, which is "no document open": the stacks are
 * already empty then, but saying so here keeps the buttons from having to
 * know that. */
export function canUndo(): boolean {
  return tree !== null && undoStack.length > 0;
}

export function canRedo(): boolean {
  return tree !== null && redoStack.length > 0;
}

/** Whether a document is open for editing at all — a tree on the page that
 * the history is pointed at. */
export function historyIsOpen(): boolean {
  return tree !== null;
}

/** **Called whenever `canUndo`, `canRedo` or `historyIsOpen` may have
 * changed** — every reader's edit, undo and redo, and also the two resets,
 * a new tree (`setHistoryTree`) and a held history put back
 * (`restoreHistory`).
 *
 * A second channel and not `onHistoryChange` with more callers, because
 * the two answer different questions and the difference is load-bearing.
 * `onHistoryChange` means *the reader changed the text*, and the saved
 * panel writes the document back on it; firing it for a reset would save a
 * text nobody had touched the moment it was opened, and would save a cleared
 * page's history over the text it was cleared from. This one means only
 * *what the buttons can offer has moved*, which a reset does change and an
 * autosave must not hear about.
 *
 * Over-notifying is harmless — a listener reads the three getters and sets
 * the same state again — so it fires on every path that might have changed
 * them rather than working out whether each one did. */
const availabilityListeners = new Set<() => void>();

export function onHistoryAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

function notifyAvailability(): void {
  for (const listener of availabilityListeners) listener();
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
  notifyChange();
}

/** Reverts the most recent recorded edit. Returns false when there is
 * nothing to undo, so the caller can leave the keystroke alone. */
export function undo(): boolean {
  if (!tree || undoStack.length === 0) return false;
  redoStack.push(capture(tree));
  restore(tree, undoStack.pop()!);
  notifyChange();
  return true;
}

export function redo(): boolean {
  if (!tree || redoStack.length === 0) return false;
  undoStack.push(capture(tree));
  restore(tree, redoStack.pop()!);
  notifyChange();
  return true;
}
