import { t } from "../i18n/i18n.ts";
import type { TokenTree } from "../parse/types.ts";
import { deleteSavedText, getSavedText, listSavedTexts, reorderSavedTexts, saveText } from "../parse/savedTexts.ts";

export interface SavedPanelCallbacks {
  /** Reopens an already-annotated tree straight from storage, without
   * re-parsing (which would discard any hand edits). */
  onOpenSaved: (source: string, tree: TokenTree) => void;
  /** The text currently in the input box, stored alongside the tree so
   * reopening can restore it. */
  currentSource: () => string;
}

export interface SavedPanelHandle {
  /** Enables the save button against this tree, or disables it (null). */
  setTree: (tree: TokenTree | null) => void;
  /** Rebuilds the list — needed after a language switch, since the
   * empty-state line and the delete labels are translated. */
  refresh: () => void;
}

/** The right-hand panel: save the current annotation, and reopen anything
 * saved before. Kept separate from the left sidebar (input/export) so the
 * two can collapse independently — this is the "library" side, consulted
 * occasionally, while the left side is the working input. */
export function renderSavedPanel(container: HTMLElement, callbacks: SavedPanelCallbacks): SavedPanelHandle {
  container.innerHTML = `
    <h2 data-i18n="sidebar.savedHeading"></h2>
    <button id="save-btn" type="button" class="secondary" data-i18n="sidebar.saveButton" disabled></button>
    <p class="status-line" id="saved-status" data-state="idle"></p>
    <ul class="saved-list" id="saved-list"></ul>
  `;

  const saveBtn = container.querySelector<HTMLButtonElement>("#save-btn")!;
  const statusLine = container.querySelector<HTMLElement>("#saved-status")!;
  const savedList = container.querySelector<HTMLUListElement>("#saved-list")!;
  let currentTree: TokenTree | null = null;

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
      open.title = entry.source;
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
      remove.title = t("sidebar.savedDelete");
      remove.setAttribute("aria-label", t("sidebar.savedDelete"));
      remove.addEventListener("click", () => {
        deleteSavedText(entry.id);
        // Deleting the entry the on-screen text came from leaves that text
        // unsaved rather than pointing at a row that no longer exists — so
        // the next save stores it afresh.
        if (openEntry?.id === entry.id) openEntry = null;
        refresh();
      });

      row.append(open, remove);
      savedList.append(row);
    }
  }

  function save(): void {
    if (!currentTree) {
      statusLine.textContent = t("error.nothingToSave");
      statusLine.dataset.state = "error";
      return;
    }
    // Only overwrite while the tree on screen is still the one that entry
    // was opened as — see `openEntry`.
    const target = openEntry?.tree === currentTree ? openEntry.id : undefined;
    const id = saveText(callbacks.currentSource(), currentTree, target);
    if (id) openEntry = { id, tree: currentTree };
    statusLine.textContent = id ? t("status.saved") : t("status.error");
    statusLine.dataset.state = id ? "idle" : "error";
    refresh();
  }

  saveBtn.addEventListener("click", save);

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

  refresh();

  return {
    setTree(tree) {
      currentTree = tree;
      saveBtn.disabled = !tree;
    },
    refresh,
  };
}
