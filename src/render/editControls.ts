import { getUiLang, onLangChange, t, type StringKey } from "../i18n/i18n.ts";
import { canRedo, canUndo, historyIsOpen, onHistoryAvailability, onHistoryChange } from "./editHistory.ts";
import { openHelpModal, undoModifier } from "./HelpModal.ts";
import { onLiveSelection, takeHistoryStep, type LiveSelection } from "./tokenInspector.ts";

/** The kundoku panel's own controls, in the row its heading sits on: an undo
 * and a redo button at the end of the row, and a one-line hint before them
 * that appears the first time a reader picks a character out.
 *
 * Both answer the same finding (the critique's "correction gestures are
 * invisible"): every way of correcting the analysis was a gesture nothing on
 * the page mentioned — a right click, a double click, a drag, ⌘Z — and a
 * reader who already reads kanbun, and came to correct a draft, had to find
 * them by accident or by opening the guide. The buttons make the one
 * reassurance that matters before a first edit visible, that the edit can be
 * taken back; the hint says, once, at the point of use, what the next gesture
 * is. Neither is a tour or a dialog: the reader is in the middle of reading a
 * text, and the help modal is a click away for the whole account.
 *
 * ── Where they sit, and why nothing moves when they appear ────────────────
 * The row is absolutely positioned in the panel, both parts centred in the
 * height of the top margin `.tategaki` keeps above the first character of every
 * column (`--panel-margin-top`, typography.css). It takes no space in the
 * panel's flow, so the hint arriving or going cannot re-break a column: the
 * text underneath is laid out exactly as it would be without it. See
 * `.kundoku-tools` in app.css for the measurements. */

/** The hint is retired for good once the reader has dismissed it or made an
 * edit — after either, they know what it would have told them. Named like
 * every other key the app stores (`jidou-kundoku:collapsed`,
 * `jidou-kundoku:ui-lang`). */
const HINT_KEY = "jidou-kundoku:edit-hint";
const HINT_RETIRED = "retired";

const SVG_ATTRS =
  'viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** **Drawn, not set.** A curved arrow turning back on itself, its mirror for
 * redo, and a cross: three marks in one stroke (1.5 on a 16 grid, round caps
 * and joins) so that the row reads as one set of controls. Not ↶ ↷ or ×,
 * which would be whatever the system's fallback face makes of them at
 * whatever weight that face has — the same objection the rails' note in
 * app.css makes to the toolbar arrows they replaced — and which the shipped
 * Noto subset does not all carry. */
const ICONS = {
  undo: `<svg ${SVG_ATTRS}><path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7h-3"/></svg>`,
  redo: `<svg ${SVG_ATTRS}><path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7h3"/></svg>`,
  close: `<svg ${SVG_ATTRS}><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>`,
};

/** The keystroke each button stands in for, as the reader's platform spells
 * it — ⌘Z and ⇧⌘Z on a Mac, Ctrl+Z and Ctrl+Y elsewhere. The listener accepts
 * either platform's keys (`setupTokenInspector`); this is only which pair to
 * *show*, decided by the same sniff the guide's keycaps use. */
function shortcut(step: "undo" | "redo"): string {
  const mac = undoModifier() === "⌘";
  if (step === "undo") return mac ? "⌘Z" : "Ctrl+Z";
  return mac ? "⇧⌘Z" : "Ctrl+Y";
}

function fill(key: StringKey, vars: Record<string, string>): string {
  return t(key).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

function hintRetired(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === HINT_RETIRED;
  } catch {
    return false;
  }
}

/** Builds the controls into `row` (an empty element in the panel markup in
 * main.ts) and keeps them current for the life of the page. */
export function setupEditControls(row: HTMLElement): void {
  row.innerHTML = `
    <div class="edit-hint" role="note" hidden>
      <span class="edit-hint-text"></span>
      <button type="button" class="edit-hint-help"></button>
      <button type="button" class="edit-hint-close">${ICONS.close}</button>
    </div>
    <div class="history-buttons">
      <button type="button" class="history-button" data-step="undo" disabled>${ICONS.undo}</button>
      <button type="button" class="history-button" data-step="redo" disabled>${ICONS.redo}</button>
    </div>
  `;
  const hint = row.querySelector<HTMLElement>(".edit-hint")!;
  const hintText = hint.querySelector<HTMLElement>(".edit-hint-text")!;
  const helpButton = hint.querySelector<HTMLButtonElement>(".edit-hint-help")!;
  const closeButton = hint.querySelector<HTMLButtonElement>(".edit-hint-close")!;
  const undoButton = row.querySelector<HTMLButtonElement>('[data-step="undo"]')!;
  const redoButton = row.querySelector<HTMLButtonElement>('[data-step="redo"]')!;

  // ── Undo and redo ─────────────────────────────────────────────────────────

  function syncButtons(): void {
    const focused = document.activeElement;
    const open = historyIsOpen();
    undoButton.disabled = !(open && canUndo());
    redoButton.disabled = !(open && canRedo());
    // A button disabled under the reader's focus drops that focus to the
    // body, and the next Tab starts again from the top of the page. Undoing
    // to the start of the history with the button is exactly how that
    // happens, so focus goes to the other button when it has something to
    // offer — a reader who has undone everything is likely to redo next.
    if (focused === undoButton && undoButton.disabled && !redoButton.disabled) redoButton.focus();
    if (focused === redoButton && redoButton.disabled && !undoButton.disabled) undoButton.focus();
  }

  function labelButtons(): void {
    for (const [button, step] of [
      [undoButton, "undo"],
      [redoButton, "redo"],
    ] as const) {
      const label = fill(step === "undo" ? "main.undo" : "main.redo", { shortcut: shortcut(step) });
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  }

  for (const button of [undoButton, redoButton]) {
    button.addEventListener("click", () => {
      // The same function the keystroke calls, so the two cannot drift
      // apart. A click on a disabled button never arrives, and a stale
      // enabled one (the history moved under it) does nothing here, as the
      // keystroke at the end of the history does nothing.
      takeHistoryStep(button.dataset.step === "redo" ? "redo" : "undo");
    });
  }

  // ── The first-selection hint ──────────────────────────────────────────────
  //
  // Two stages, in the order a reader meets them:
  //
  //   select    a character picked out, the analysis not shown: how to ask
  //             for the analysis, and that a character can be dragged onto
  //             its head;
  //   analysis  the analysis up: that the chip, the relation label and the
  //             reading each open a menu, and that any edit can be undone.
  //
  // It only goes forward. A reader who has seen the analysis and then picks
  // a character out with a plain click has not forgotten how to bring the
  // analysis up, and the second stage is the one still worth reading. The
  // wording follows the gesture that made the selection — pointer or
  // keyboard — because the two are told different keys for the same thing.

  let stage: "select" | "analysis" | null = null;
  let keyboard = false;
  let retired = hintRetired();

  function retire(): void {
    retired = true;
    try {
      localStorage.setItem(HINT_KEY, HINT_RETIRED);
    } catch {
      // Unavailable (private mode) — retired for this page, which is as long
      // as anything else is remembered there.
    }
    stopSelection();
    stopEdit();
    syncHint();
  }

  function syncHint(): void {
    const show = !retired && stage !== null && historyIsOpen();
    if (!show) {
      // Focus on the hint's own buttons would go down with them; give it to
      // the panel's next control rather than to the body.
      if (hint.contains(document.activeElement)) (undoButton.disabled ? redoButton : undoButton).focus();
      hint.hidden = true;
      return;
    }
    const key: StringKey =
      stage === "analysis"
        ? keyboard
          ? "hint.analysis.keyboard"
          : "hint.analysis.pointer"
        : keyboard
          ? "hint.select.keyboard"
          : "hint.select.pointer";
    // Markup from this app's own translation files — the English italicises
    // *furigana* as the guide does — as `data-i18n-html` puts it in; no user
    // input reaches these strings.
    hintText.innerHTML = fill(key, { undo: shortcut("undo") });
    // The whole sentence, for a run too narrow to show it even on three lines
    // (`.edit-hint-text` in app.css cuts it short with an ellipsis there).
    hintText.title = hintText.textContent ?? "";
    helpButton.textContent = t("help.button");
    closeButton.title = t("hint.dismiss");
    closeButton.setAttribute("aria-label", t("hint.dismiss"));
    hint.lang = getUiLang();
    hint.hidden = false;
    fitHint();
  }

  // ── Keeping the hint off the chip ─────────────────────────────────────────
  //
  // The hint is centred in the top margin, and so is the one thing of the
  // text that is ever drawn there: the 品詞 chip of the character being
  // analysed, when the arrow to its head comes up from below and the chip
  // hangs *above* the column (`.token-subtitle-above`). Only the analysed
  // character has a chip, so there is at most one in the margin at a time,
  // and what the hint has to keep clear of is one horizontal span.
  //
  // So the hint is given the run of margin to one side of that span, and
  // wraps to fit it — up to three lines, which is what the 55px margin holds
  // at the hint's 1rem line (app.css). **Left of the chip first**, because the
  // chip's own domain and sense pills fold out to the *right* of it on hover
  // (`.token-subtitle-semantics`), and a hint on that side would be what they
  // fold out over; the right-hand run is taken only when the left one is too
  // narrow to hold the sentence in three lines' worth of width. Measured and
  // written as inline `left`/`max-width`, because where the chip is depends on
  // which character is analysed and on how far the columns are scrolled —
  // nothing a stylesheet knows. With no chip in the margin both are removed,
  // and the hint has the whole margin again.
  //
  // The layering in app.css stays as the backstop: if a chip and the hint ever
  // did meet — a scroll mid-frame, say — the chip is drawn over the hint.

  const panel = row.closest<HTMLElement>(".kundoku-panel");
  const view = panel?.querySelector<HTMLElement>(".tategaki") ?? null;
  /** Room either side of the chip, so the hint does not butt against it. */
  const CHIP_CLEARANCE = 8;
  /** The narrowest run worth wrapping into: below this the hint would be a
   * tall, ragged column of a few words a line, and the other side is tried. */
  const MIN_RUN = 160;

  function chipSpan(): { left: number; right: number } | null {
    if (!panel || !view) return null;
    const chipRow = view.querySelector<HTMLElement>(
      ".token-inspector-overlay:not([data-leaving]) .token-subtitle-above",
    );
    if (!chipRow) return null;
    const panelBox = panel.getBoundingClientRect();
    const marginBottom = panelBox.top + (parseFloat(getComputedStyle(view).paddingTop) || 0);
    // The row and whatever of its pills is laid out, folded or not: the run
    // is chosen once per placement, not re-chosen as the pills fold out.
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    for (const el of [chipRow, ...chipRow.querySelectorAll<HTMLElement>(".token-subtitle")]) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      left = Math.min(left, box.left);
      right = Math.max(right, box.right);
      top = Math.min(top, box.top);
    }
    // A chip that has scrolled out of the panel, or that sits below the
    // margin, is in nobody's way.
    if (!Number.isFinite(left) || top >= marginBottom || right <= panelBox.left || left >= panelBox.right) return null;
    return { left: left - panelBox.left, right: right - panelBox.left };
  }

  function fitHint(): void {
    hint.style.removeProperty("left");
    hint.style.removeProperty("max-width");
    if (hint.hidden || !panel) return;
    const chip = chipSpan();
    if (!chip) return;
    // The hint's full run, as the stylesheet sets it: from the left side
    // margin to the right one. Read off the hint's own resolved `left` (the
    // inline one has just been removed) rather than off `--rail-band`, whose
    // computed value is the unresolved `calc(2.75rem * 1)` — parsed as a
    // number that is 2.75, and the run came out 41px too wide, straight
    // under the chip.
    const runLeft = parseFloat(getComputedStyle(hint).left) || 0;
    const band = runLeft;
    const runRight = panel.clientWidth - band;
    const leftRun = chip.left - CHIP_CLEARANCE - runLeft;
    const rightRun = runRight - (chip.right + CHIP_CLEARANCE);
    // Clear of the chip already: the hint's own width ends before it.
    if (hint.getBoundingClientRect().right - panel.getBoundingClientRect().left <= chip.left - CHIP_CLEARANCE) return;
    if (leftRun >= MIN_RUN || leftRun >= rightRun) {
      hint.style.maxWidth = `${Math.max(leftRun, 0)}px`;
    } else {
      hint.style.left = `${chip.right + CHIP_CLEARANCE}px`;
      hint.style.maxWidth = `${rightRun}px`;
    }
  }

  // Refitted whenever the chip may have moved or come and gone: a frame after
  // any change in the panel's subtree (an overlay built, faded or torn down,
  // a re-render), on the columns scrolling under the margin, on a resize — and
  // when a transition or animation in the panel ends. That last is not
  // belt-and-braces: the chip eases into place when the analysis comes up,
  // and the frame after the overlay is built finds it still on its way, 44px
  // short of where it stops (measured, 論語). Fitted then, the hint ran 36px
  // under the chip's final place. Coalesced to one measurement a frame, and
  // none at all while the hint is down.
  let fitQueued = false;
  function queueFit(): void {
    if (fitQueued || hint.hidden) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      fitHint();
    });
  }
  if (view) {
    new MutationObserver(queueFit).observe(view, { childList: true, subtree: true });
    view.addEventListener("scroll", queueFit, { passive: true });
    view.addEventListener("transitionend", queueFit);
    view.addEventListener("animationend", queueFit);
  }
  window.addEventListener("resize", queueFit);

  const stopSelection = onLiveSelection((selection: LiveSelection) => {
    if (retired) return;
    const next = selection.analysis ? "analysis" : stage === "analysis" ? "analysis" : "select";
    // The wording is that of the gesture that moved the hint on, and stays
    // so: a reader on the keyboard who clicks once is not told the pointer's
    // version of a stage they have already read.
    if (next !== stage) keyboard = selection.keyboard;
    stage = next;
    syncHint();
  });
  // A reader's first edit is the hint's purpose achieved. `onHistoryChange`
  // fires for edits, undos and redos and never for a document being opened
  // or cleared — the only way to it is through an edit.
  const stopEdit = onHistoryChange(retire);
  if (retired) {
    stopSelection();
    stopEdit();
  }

  helpButton.addEventListener("click", openHelpModal);
  closeButton.addEventListener("click", retire);

  // ── Kept current ──────────────────────────────────────────────────────────

  onHistoryAvailability(() => {
    syncButtons();
    syncHint();
  });
  onLangChange(() => {
    labelButtons();
    syncHint();
  });
  labelButtons();
  syncButtons();
}
