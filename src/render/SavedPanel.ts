import { t } from "../i18n/i18n.ts";
import type { TokenTree } from "../parse/types.ts";
import {
  deleteSavedText,
  fullTitleOf,
  getSavedText,
  listSavedTexts,
  reorderSavedTexts,
  restoreSavedText,
  saveText,
  storedSignature,
} from "../parse/savedTexts.ts";
import { onHistoryChange } from "./editHistory.ts";
import { createStatusLine, type StatusState } from "./statusLine.ts";
import { watchEdgeFade } from "./edgeFade.ts";
import type { StringKey } from "../i18n/i18n.ts";

export interface SavedPanelCallbacks {
  /** Reopens an already-annotated tree straight from storage, without
   * re-parsing (which would discard any hand edits). */
  onOpenSaved: (source: string, tree: TokenTree) => void;
  /** What a save had to say — "Saved", or why it was not — for the status
   * line in the *input* sidebar, beside the Save button that asked for it.
   * This panel is a drawer, shut unless the reader opens it, so a message
   * written here would most often be written to no one; that includes an
   * auto-save failing, which is the one thing about saving the reader must
   * not miss. */
  onSaveStatus: (key: StringKey, state: StatusState) => void;
}

export interface SavedPanelHandle {
  /** Enables the save button against this tree, or disables it (null), and
   * records the source the tree was built from.
   *
   * **The source is passed rather than read from the input box, and that is
   * the whole of a data-loss bug.** Both saves below used to pair
   * `currentTree` with whatever the box held at the moment of writing, and
   * the two are not required to be the same document: `setTree` runs when a
   * document is opened and at no other time, so typing into the box changes
   * neither the tree nor the identity check that guards it. Type into the box
   * without pressing 訓読する and the next auto-save tick wrote that
   * uncommitted text as the `source` *and the title* of the entry the parsed
   * tree came from — silently, once a minute, with the tree left as it was.
   * The entry then held one text's source beside another text's annotation,
   * and the original source was gone.
   *
   * Nor was the tick avoidable: `storedSignature` covers the source, so
   * typing is exactly what makes a tick decide something has changed.
   *
   * Taking the source here binds it to the tree at the one moment they are
   * known to be the same document. The caller has it in hand at every such
   * moment — see `setTree` in `main.ts` for the three, one of which
   * (a CoNLL-U upload) never puts a source in the box at all, which is why
   * capturing it here from the box would not have been enough. */
  setTree: (tree: TokenTree | null, source: string, opts?: { shipped?: boolean }) => void;
  /** Saves the document on screen now — the input sidebar's Save button. */
  save: () => void;
  /** Rebuilds the list — needed after a language switch, since the
   * empty-state line and the delete buttons' names are translated. */
  refresh: () => void;
}

/** The right-hand panel: everything saved before, to reopen. Kept separate
 * from the left sidebar (input/export) so the two can collapse
 * independently — this is the "library" side, consulted occasionally, while
 * the left side is the working input.
 *
 * **A drawer, shut by default** (see the collapse restore in `main.ts`), and
 * the Save button is no longer in it. Open, it took 320px of every screen to
 * hold a list most readers consult once a session — at 1280px the edition
 * kept seven columns. Save sits beside Export instead, the two things done
 * *with* the text on screen, and since auto-save keeps every text the reader
 * works on, the drawer is where they go to find one, not somewhere they have
 * to visit to keep one. The saving itself — `save`, auto-save, the keyboard
 * shortcut — is still this module's, since this is what owns the store. */
export function renderSavedPanel(container: HTMLElement, callbacks: SavedPanelCallbacks): SavedPanelHandle {
  container.innerHTML = `
    <h2 data-i18n="sidebar.savedHeading"></h2>
    <p class="status-line" id="saved-status" data-state="idle"></p>
    <ul class="saved-list" id="saved-list"></ul>
  `;

  const status = createStatusLine(container.querySelector<HTMLElement>("#saved-status")!);
  const savedList = container.querySelector<HTMLUListElement>("#saved-list")!;
  // The same fade the text panels have at an edge with more beyond it, on the
  // list's own axis: a long list scrolls inside the panel, and a row cut clean
  // at the panel's foot read as the last one.
  watchEdgeFade(savedList, "y");
  let currentTree: TokenTree | null = null;
  /** The source `currentTree` was built from — see `SavedPanelHandle.setTree`.
   * Never the live contents of the input box. */
  let currentSource = "";

  /** The stored entry the tree on screen came from — set both by opening
   * one from the list and by saving, so that repeated saves keep updating
   * the same entry instead of leaving a copy behind each time.
   *
   * Held with the tree it belongs to rather than as a bare id, and matched
   * by object identity: a fresh parse (or a CoNLL-U upload) builds a new
   * `TokenTree`, so the check below fails on its own and that text saves
   * as a new entry. Nothing has to remember to clear this. */
  let openEntry: { id: string; tree: TokenTree } | null = null;

  /** The row being dragged, while one is. */
  let dragging: HTMLElement | null = null;

  /** **A moment in which a delete button cannot be clicked, after one has
   * been.** The list closes up over the deleted row, so the next row's ×
   * slides under a pointer that has not moved; a second click meant for
   * nothing — a double-click, or a press repeated because the first seemed
   * not to take — then deletes a text the reader never looked at. 400ms covers
   * that second press: it is the far end of the double-click intervals the
   * platforms ship with (Windows defaults to 500ms, and a repeat made in doubt
   * comes sooner than a deliberate double-click), while a deliberate second
   * delete has to read the title that moved up first, which takes longer.
   * Pointer only (`.saved-list[data-settling]` in app.css): the keyboard moves
   * focus on purpose, never by a row sliding under it. */
  const DELETE_SETTLE_MS = 400;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  function settle(): void {
    clearTimeout(settleTimer);
    savedList.toggleAttribute("data-settling", true);
    settleTimer = setTimeout(() => savedList.removeAttribute("data-settling"), DELETE_SETTLE_MS);
  }

  /** Puts focus on `selector` in the row at `index`, or in the row before it
   * when that was the last; on the empty line when there are no rows left.
   * Used where a rebuild has taken away the element that had focus, which
   * would otherwise leave it on `<body>` and send the reader's next Tab back
   * to the top of the page. */
  function focusRow(index: number, selector: string): void {
    const rows = savedList.querySelectorAll<HTMLElement>(".saved-row");
    const row = rows[Math.min(index, rows.length - 1)];
    (row?.querySelector<HTMLElement>(selector) ?? savedList.querySelector<HTMLElement>(".saved-empty"))?.focus();
  }

  /** Marks the row of the text on the screen, if it is one of these. The open
   * entry counts only while its tree is still the one on the screen, by the
   * same identity check a save makes (see `openEntry`): after a new parse or a
   * Clear, nothing in the list is open any more. `aria-current` for a screen
   * reader, and weight on the page (app.css), since a hue alone would not
   * survive the Not-By-Hue-Alone Rule. */
  function markCurrent(): void {
    const id = openEntry && openEntry.tree === currentTree ? openEntry.id : null;
    for (const row of savedList.querySelectorAll<HTMLElement>(".saved-row")) {
      const open = row.querySelector<HTMLElement>(".saved-open")!;
      if (row.dataset.id === id) open.setAttribute("aria-current", "true");
      else open.removeAttribute("aria-current");
    }
  }

  /** Alt+ArrowUp and Alt+ArrowDown on a row: the keyboard's way to do what a
   * drag does, one place at a time. The row keeps the focus, so the keys can
   * be pressed again to carry it further, and the new place is said in the
   * status line, which is a live region — the list itself does not announce
   * a change of order. */
  function move(id: string, by: -1 | 1): void {
    const ids = listSavedTexts().map((e) => e.id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    reorderSavedTexts(ids);
    refresh();
    focusRow(to, ".saved-open");
    status.set("status.moved", {
      vars: { title: getSavedText(id)?.title || "—", n: String(to + 1), of: String(ids.length) },
    });
  }

  /** Rearranges as the pointer moves rather than on the drop, so the list
   * shows the order it would leave behind instead of describing it with a
   * marker — the row travels, and the others part around it.
   *
   * Attached to the list once, not to each row on every rebuild: a row is
   * dragged *over its neighbours*, so the events arrive at whichever row the
   * pointer is above, and the list is the one element that sees them all. */
  savedList.addEventListener("dragover", (event) => {
    if (!dragging) return;
    // Without this the drop is refused and the drag springs back.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    // The first row whose middle is below the pointer is the one to go
    // before; past the last middle, the pointer is at the end.
    const after = [...savedList.querySelectorAll<HTMLElement>(".saved-row")]
      .filter((row) => row !== dragging)
      .find((row) => {
        const box = row.getBoundingClientRect();
        return event.clientY < box.top + box.height / 2;
      });
    if (after) savedList.insertBefore(dragging, after);
    else savedList.append(dragging);
  });

  // Rebuilt from storage on every change rather than patched in place —
  // the list is short, and this keeps it impossible for the DOM to drift
  // out of step with what is actually stored.
  function refresh(): void {
    const entries = listSavedTexts();
    savedList.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "saved-empty";
      empty.textContent = t("sidebar.savedEmpty");
      // Focusable by script only, so that deleting the last row leaves the
      // focus on the line that says the list is empty rather than on nothing.
      empty.tabIndex = -1;
      savedList.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("li");
      row.className = "saved-row";
      row.dataset.id = entry.id;
      // The row, not its buttons: a drag begun anywhere inside it — on the
      // title, on the delete button — is a drag of the whole row, and the
      // buttons still take their clicks, a drag only starting once the
      // pointer has actually travelled.
      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        dragging = row;
        row.classList.add("saved-row-dragging");
        event.dataTransfer?.setData("text/plain", entry.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("saved-row-dragging");
        dragging = null;
        // What the list looks like now *is* the new order: the row has been
        // moved through it during the drag rather than at the end of it, so
        // there is nothing left to work out.
        reorderSavedTexts([...savedList.querySelectorAll<HTMLElement>(".saved-row")].map((r) => r.dataset.id!));
      });

      const open = document.createElement("button");
      open.type = "button";
      open.className = "saved-open";
      open.textContent = entry.title || "—";
      // **The whole first line as the name**, where the row shows it cut to
      // 24 characters and an ellipsis. The visible text is where the name
      // starts, so a voice-control user can still say what they see.
      open.setAttribute("aria-label", fullTitleOf(entry.source) || entry.title || "—");
      open.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
      open.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        move(entry.id, event.key === "ArrowUp" ? -1 : 1);
      });
      // No `title` with the whole passage in it: a native tooltip opened over
      // the rows beneath the pointer and hid them, and the passage is one
      // click away — opening the entry puts it in the box.
      open.addEventListener("click", () => {
        const fresh = getSavedText(entry.id);
        if (!fresh) return refresh();
        // Bound to the very tree object handed to the app, so a later save
        // can tell it is still this entry that is on screen.
        openEntry = { id: fresh.id, tree: fresh.tree };
        callbacks.onOpenSaved(fresh.source, fresh.tree);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "saved-delete";
      remove.textContent = "×";
      // Named for the text it deletes: a list of buttons each called only
      // "Delete" gave a screen reader nothing to tell them apart by.
      remove.setAttribute("aria-label", t("sidebar.savedDeleteNamed").replace("{title}", entry.title || "—"));
      remove.addEventListener("click", () => {
        // **Deleted at once, and undoable**, rather than confirmed first. A
        // confirmation is a question asked every time to guard against the
        // rare time, and it is answered by reflex; an Undo costs nothing on
        // the ordinary path and is there on the one occasion it is wanted.
        //
        // What is held is the entry exactly as stored and the place it stood,
        // so the Undo puts back the same entry rather than a copy of it — see
        // `restoreSavedText`.
        const stored = getSavedText(entry.id);
        const index = listSavedTexts().findIndex((e) => e.id === entry.id);
        const wasOpen = openEntry?.id === entry.id ? openEntry : null;
        // Read before the rebuild takes this button away with its row.
        const hadFocus = savedList.contains(document.activeElement);
        deleteSavedText(entry.id);
        // Deleting the entry the on-screen text came from leaves that text
        // unsaved rather than pointing at a row that no longer exists — so
        // the next save stores it afresh.
        //
        // **But only once the reader changes it again.** Deleting it is a
        // decision about this text as it stands, and an auto-save already due
        // (an edit a second ago) would otherwise put it straight back, so the
        // delete appeared not to have happened. The pending write is dropped
        // and the text counted as settled; an edit after this is new work,
        // and is kept like any other.
        if (wasOpen) {
          openEntry = null;
          if (wasOpen.tree === currentTree && currentTree) {
            clearTimeout(editTimer);
            editTimer = undefined;
            savedSignature = storedSignature(currentSource, currentTree);
          }
        }
        refresh();
        settle();
        // Onto the delete button of the row that has taken this one's place,
        // which is the next text down — so a run of deletes is a run of the
        // same key — or of the row above, past the end of the list.
        if (hadFocus) focusRow(index, ".saved-delete");
        if (!stored) return;
        status.set("status.deleted", {
          vars: { title: stored.title || "—" },
          action: {
            label: "status.undo",
            run: () => {
              if (!restoreSavedText(stored, index)) {
                status.set("error.saveFailed", { state: "error" });
                return;
              }
              // The link back, too, so the document on screen saves into its
              // entry again rather than starting a second one — but only if
              // nothing has given it an entry of its own in the meantime.
              if (wasOpen && !openEntry && wasOpen.tree === currentTree) {
                openEntry = wasOpen;
                // What was put back is the entry as it was stored, which may
                // be a step behind the page (the write the delete dropped), so
                // the next tick compares against nothing and brings it level.
                savedSignature = null;
              }
              refresh();
              // The Undo button was taken down as it was pressed (see
              // `statusLine.ts`), and with it the focus; it goes to the text
              // that came back.
              if (document.activeElement === document.body || !document.activeElement) focusRow(index, ".saved-open");
            },
          },
        });
      });

      row.append(open, remove);
      savedList.append(row);
    }
    markCurrent();
  }

  function save(): void {
    if (!currentTree) {
      callbacks.onSaveStatus("error.nothingToSave", "error");
      return;
    }
    // Only overwrite while the tree on screen is still the one that entry
    // was opened as — see `openEntry`.
    const target = openEntry?.tree === currentTree ? openEntry.id : undefined;
    // `currentSource`, never the input box: the two part company the moment
    // the reader types without parsing. See `SavedPanelHandle.setTree`.
    const source = currentSource;
    const id = saveText(source, currentTree, target);
    if (id) {
      openEntry = { id, tree: currentTree };
      // The document is now stored as it stands, so the next auto-save tick
      // has nothing to do — see `autosave`, which compares against this.
      savedSignature = storedSignature(source, currentTree);
      autosaveFailed = false;
    }
    callbacks.onSaveStatus(id ? "status.saved" : "error.saveFailed", id ? "idle" : "error");
    refresh();
  }

  // Cmd+S / Ctrl+S. No guard for a focused text field: unlike undo, a
  // textarea has no save of its own to preserve, and "save what I am
  // working on" is exactly what the key means while typing in one. The
  // browser's own Save Page dialog is suppressed either way — including
  // when there is nothing to save, where `save` reports that instead.
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    save();
  });

  /* ── Auto-save ──────────────────────────────────────────────────────
   *
   * The document on screen is written back so that work is not lost to a
   * closed tab, a reload, or a click that replaces it: a moment after each
   * correction, whenever it leaves the screen, when the tab is hidden, and
   * once a minute behind all three (see the timers below and `setTree`).
   * Three things about it are worth stating, because each is a decision
   * rather than an obvious default.
   *
   * **It saves the open document, creating its entry if it has none.** A
   * text that has never been saved is exactly the text whose loss would
   * cost the most, so leaving it out would miss the case the feature is
   * for. The consequence is that the list stops being only "what the
   * reader chose to keep" and becomes that plus "what they are working
   * on": opening five texts in a session leaves five entries. Only the
   * first tick of a document adds one — every later tick updates it in
   * place, through the same `openEntry` identity check a manual save uses
   * — so it is one entry per document read, not one per minute.
   *
   * **It compares before it writes**, and the comparison is a full
   * `JSON.stringify` of what would be stored rather than a flag. A flag
   * cannot work here: `setTree` is called when a document is opened and at
   * no other time, while an annotation edit *mutates the tree in place*
   * (which is what lets `openEntry`'s identity check survive editing). So
   * nothing tells this that an edit happened, and the only honest question
   * is whether the bytes differ. Stringifying one tree a minute is cheap —
   * far cheaper than the write it avoids, which re-serialises the whole
   * list — and it cannot miss a field the way a hand-written signature
   * could.
   *
   * **It is quiet.** A save the reader did not ask for should not announce
   * itself where a save they did ask for reports, and it must not wipe a
   * message they are still reading. So the status line is left alone on
   * success, and the row's own timestamp in the list is what shows the
   * document was kept. A *failure* does speak — a full `localStorage` is
   * the one thing here the reader has to know about, since it means the
   * work is not being kept after all — but only once per run of failures,
   * so a wedged quota does not repaint the line every minute. */
  const AUTOSAVE_MS = 60_000;
  /** How long after a correction it is written back: long enough that a run
   * of them is one write, short enough that nothing the reader would miss
   * is ever only in memory. */
  const AUTOSAVE_AFTER_EDIT_MS = 1500;

  /** What the last successful save stored, as its serialisation. Null until
   * something has been saved, which makes the first tick of a new document
   * always write. */
  let savedSignature: string | null = null;
  /** Whether the last auto-save attempt failed, so a run of failures speaks
   * once rather than every minute. */
  let autosaveFailed = false;

  function autosave(): void {
    if (!currentTree) return;
    // The same pairing the manual save makes, and for the same reason — this
    // is the path the mismatch actually cost, since it writes unasked.
    const source = currentSource;
    const signature = storedSignature(source, currentTree);
    if (signature === savedSignature) return;

    const target = openEntry?.tree === currentTree ? openEntry.id : undefined;
    const id = saveText(source, currentTree, target);
    if (id) {
      openEntry = { id, tree: currentTree };
      savedSignature = signature;
      autosaveFailed = false;
      refresh();
      return;
    }
    // Left unset on failure, so the next tick tries again rather than
    // treating the unwritten state as stored.
    if (!autosaveFailed) {
      autosaveFailed = true;
      callbacks.onSaveStatus("status.autosaveError", "error");
    }
  }

  /** The write pending after a correction, if one is waiting. Each edit
   * pushes it back, so a run of corrections is written once, a moment after
   * the last of them, rather than once per click. */
  let editTimer: ReturnType<typeof setTimeout> | undefined;

  function autosaveNow(): void {
    clearTimeout(editTimer);
    editTimer = undefined;
    autosave();
  }

  onHistoryChange(() => {
    clearTimeout(editTimer);
    editTimer = setTimeout(autosaveNow, AUTOSAVE_AFTER_EDIT_MS);
  });

  // The minute's tick stays, behind the per-edit write, for the one change
  // that reaches the tree without passing through the history: the parser's
  // own relabel of a dragged attachment, which lands after its edit and is
  // deliberately not an undo step of its own (see `editHistory.ts`).
  const autosaveTimer = setInterval(autosave, AUTOSAVE_MS);
  // And on the way out. `visibilitychange` is the one a browser reliably
  // fires before it discards a tab — a laptop closing, a tab backgrounded
  // and reclaimed — and `pagehide` covers a reload or a navigation away. A
  // save is a `localStorage` write, which is synchronous, so it finishes
  // inside either event.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") autosaveNow();
  });
  window.addEventListener("pagehide", () => {
    autosaveNow();
    clearInterval(autosaveTimer);
  });

  refresh();

  return {
    setTree(tree, source, opts) {
      // **The document leaving the screen is written first**, whichever way it
      // is leaving: a new parse, a sample, an upload, a saved text opened, a
      // Clear. Each of those replaces it, and each used to replace it with up
      // to a minute of its corrections unwritten — so one mis-click on a
      // sample button, or on Clear, could take the end of a session with it.
      // Now what the reader leaves is in this list by the time the next text
      // is on the screen. A document that never changed writes nothing (the
      // signature check in `autosave`), which keeps a sample that was only
      // looked at out of the list, exactly as before.
      if (tree !== currentTree) autosaveNow();
      currentTree = tree;
      currentSource = tree ? source : "";
      // A new document has not been stored yet, whatever the old one's
      // state was: clear the comparison so its first tick writes.
      //
      // **Except a shipped one, which is seeded with its own signature
      // instead**, so the first tick finds nothing changed and the reader who
      // only *reads* one of the samples leaves no entry behind. The autosave's
      // argument for writing unasked — see it above — is that a text never
      // saved is the text whose loss costs the most; a sample costs nothing to
      // lose, being one click from being back, so the argument does not reach
      // it. The moment the reader edits one, the bytes differ from this seed
      // and it becomes a document like any other, entry and all: no second
      // mechanism, and nothing to remember to turn back on.
      //
      // Seeded here rather than at the call site because here is *after* the
      // render — `openCompleteTree` in main.ts draws first and calls this
      // second — so anything the render itself writes onto the tree is already
      // in the signature, and only an edge the reader made can move it.
      savedSignature = tree && opts?.shipped ? storedSignature(source, tree) : null;
      autosaveFailed = false;
      markCurrent();
    },
    refresh,
    save,
  };
}
