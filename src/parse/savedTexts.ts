import type { TokenTree } from "./types.ts";

/** A text the user chose to keep, stored in `localStorage` as its parsed
 * tree rather than its source string: re-parsing on load would discard
 * every hand edit made through the inspector (a retagged token, a
 * re-parented one), and would need the Pyodide worker up just to reopen
 * something already annotated. `source` is kept alongside only to
 * repopulate the input box. */
export interface SavedText {
  id: string;
  /** The original input, so reopening restores the textarea too. */
  source: string;
  /** First line of the source, trimmed for display in the list. */
  title: string;
  savedAt: number;
  tree: TokenTree;
}

const STORAGE_KEY = "jidou-kundoku:saved-texts";
/** Enough to be useful without pushing at `localStorage`'s ~5MB ceiling —
 * a parsed tree is far bulkier than its source text. `save` evicts the
 * oldest beyond this. */
const MAX_ENTRIES = 50;

function read(): SavedText[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedText[]) : [];
  } catch {
    // Unreadable or unavailable (private mode, corrupt entry) — behave as
    // though nothing is saved rather than breaking the whole sidebar.
    return [];
  }
}

function write(entries: SavedText[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/** The first line of the source that has anything on it, trimmed and whole —
 * what `titleOf` cuts down. The saved list gives it to a row as its
 * accessible name, so that a screen reader hears the title the row is cut
 * from rather than the cut, which ends in an ellipsis the ear cannot see. */
export function fullTitleOf(source: string): string {
  return (source.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "").trim();
}

/** A short label for the list — the first line of the source, cut to a
 * sensible length. Han text has no spaces to break on, so this counts
 * characters rather than words. */
export function titleOf(source: string): string {
  const trimmed = fullTitleOf(source);
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/** The list in the order it is kept in, which is the order it is shown in.
 *
 * Stored order rather than newest-first: the list can be rearranged by hand
 * (see `reorderSavedTexts`), and an order the reader has chosen must not be
 * undone by the app's own idea of which text matters most. New entries are
 * still prepended, so the default is what it always was.
 *
 * One thing does change with it: re-saving a text that was opened from the
 * list used to lift it back to the top, its `savedAt` having moved. Now it
 * stays where it was put. Editing something is not a reason to rearrange the
 * shelf around it. */
export function listSavedTexts(): SavedText[] {
  return read();
}

/** Rewrites the list in the given order, which is what a drag leaves behind.
 *
 * Ids not in `ids` keep their relative order and follow at the end, and ids
 * that name nothing are ignored — the caller is a DOM listener reporting
 * what it can see, and another tab may have added or removed an entry since
 * the drag began. */
export function reorderSavedTexts(ids: string[]): void {
  const entries = read();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const ordered = ids.map((id) => byId.get(id)).filter((e): e is SavedText => !!e);
  const seen = new Set(ordered.map((e) => e.id));
  write([...ordered, ...entries.filter((e) => !seen.has(e.id))]);
}

/** Stores `tree` under `source`, returning the id it was stored as — or
 * null if `localStorage` refused the write (quota, private mode) so the
 * caller can say so.
 *
 * Passing `id` updates that entry in place instead of adding another,
 * which is what saving a text that was *opened* from this list does: the
 * alternative leaves a trail of near-identical copies behind every round
 * of editing. An `id` no longer in storage (the entry was deleted from
 * another tab) falls through to a fresh save rather than losing the work.
 * An update is also exempt from the eviction below — it isn't making the
 * list any longer. */
export function saveText(source: string, tree: TokenTree, id?: string): string | null {
  const entries = read();
  const savedAt = Date.now();

  const existing = id ? entries.findIndex((e) => e.id === id) : -1;
  if (existing >= 0) {
    entries[existing] = { ...entries[existing], source, title: titleOf(source), savedAt, tree };
    return write(entries) ? entries[existing].id : null;
  }

  const entry: SavedText = {
    id: `${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    title: titleOf(source),
    savedAt,
    tree,
  };
  return write([entry, ...entries].slice(0, MAX_ENTRIES)) ? entry.id : null;
}

/** What a save of this document would store, as a string, for telling
 * "nothing has changed" from "something has".
 *
 * A full serialisation rather than a flag or a hand-picked signature, and
 * the reason is in how an edit reaches the page: `setTree` is called when a
 * document is *opened* and at no other time, while an annotation edit
 * **mutates the tree in place** — which is exactly what lets `SavedPanel`'s
 * `openEntry` keep matching by object identity across a round of editing.
 * So no flag is set when a token's head or reading changes, and object
 * identity says the tree is the same tree. The only question that can be
 * answered honestly is whether the bytes a save would write differ from the
 * bytes it wrote last time.
 *
 * It is also the cheap half of the comparison it guards: this serialises one
 * document, where the write it may avoid re-serialises the entire list.
 *
 * Keyed on the same two things `saveText` stores and nothing else, so a
 * field added to `SavedText` that a save persists is covered here the day it
 * is added, without anyone remembering to extend a signature. */
export function storedSignature(source: string, tree: TokenTree): string {
  return JSON.stringify({ source, tree });
}

/** Puts a deleted entry back where it stood — the same id, the same
 * timestamp, the same place in the list — which is what undoing a delete
 * means. Saving it again would not do: that is a new entry at the top with a
 * new id, and the open document's own link to its entry (`openEntry` in
 * `SavedPanel.ts`) is by id.
 *
 * Returns false if storage refused the write, and does nothing if an entry
 * with that id is already back (a second click, or another tab). */
export function restoreSavedText(entry: SavedText, index: number): boolean {
  const entries = read();
  if (entries.some((e) => e.id === entry.id)) return true;
  const at = Math.max(0, Math.min(index, entries.length));
  return write([...entries.slice(0, at), entry, ...entries.slice(at)]);
}

export function deleteSavedText(id: string): void {
  write(read().filter((e) => e.id !== id));
}

export function getSavedText(id: string): SavedText | undefined {
  return read().find((e) => e.id === id);
}
