import { getUiLang, onLangChange, t, type StringKey } from "../i18n/i18n.ts";
import { canRedo, canUndo, historyIsOpen, onHistoryAvailability, onHistoryChange } from "./editHistory.ts";
import { openHelpModal, undoModifier } from "./HelpModal.ts";
import {
  demonstrationCell,
  onCorrectionDone,
  onLiveSelection,
  takeHistoryStep,
  type CorrectionDone,
} from "./tokenInspector.ts";

/** The kundoku panel's own controls: an undo, a redo and a "?" button stacked
 * in the right-hand margin, and a hint, in a speech balloon, that appears the
 * first time a reader picks a character out and points at that character —
 * and again whenever the "?" asks for it.
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
 * Both are absolutely positioned in the panel and take no space in its flow,
 * so the hint arriving or going cannot re-break a column: the text underneath
 * is laid out exactly as it would be without it. The buttons have a fixed
 * place in the right-hand margin (`.history-buttons` in app.css); the balloon
 * is placed beside the selected character by `placeHint` below.
 *
 * **No native tooltips.** Nothing here carries a `title`: a browser tooltip is
 * drawn over whatever is under the pointer, and on this page that is the text
 * the reader is looking at. The buttons are named by `aria-label`, and the
 * hint, which used to need a `title` for the part of it a three-line clamp
 * cut off, is now shown whole. */

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
  // The hook a 6px arc ending in a short stem, and the dot a zero-length
  // stroke, which the round cap draws as a 1.5px disc: the same pen as the
  // arrows, rather than the face's "?" at the face's weight.
  hints: `<svg ${SVG_ATTRS}><path d="M5.75 6a2.25 2.25 0 1 1 3.4 1.93c-.68.4-1.15.9-1.15 1.7v.62"/><path d="M8 12.6v.01"/></svg>`,
};

/** **Retired for good, until asked for again.** Once the reader has dismissed
 * the balloon or made an edit, they know what it would have told them, and it
 * stays down on every later visit — until the "?" under the history pair
 * brings it back, which takes it out of retirement for later visits too.
 * Named like every other key the app stores (`jidou-kundoku:collapsed`,
 * `jidou-kundoku:ui-lang`). */
const HINT_KEY = "jidou-kundoku:edit-hint";
const HINT_RETIRED = "retired";

/** For a page whose storage is unavailable (private mode): retired for this
 * page, which is as long as anything else is remembered there. */
let retiredHere = false;

function hintRetired(): boolean {
  if (retiredHere) return true;
  try {
    return localStorage.getItem(HINT_KEY) === HINT_RETIRED;
  } catch {
    return false;
  }
}

function storeRetired(retired: boolean): void {
  retiredHere = retired;
  try {
    if (retired) localStorage.setItem(HINT_KEY, HINT_RETIRED);
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Unavailable — `retiredHere` carries it for this page.
  }
}

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

/** Builds the controls into `row` (an empty element in the panel markup in
 * main.ts) and keeps them current for the life of the page. */
export function setupEditControls(row: HTMLElement): void {
  // The close square comes *first*: it is floated into the balloon's top
  // right-hand corner (app.css, `.edit-hint .edit-hint-close`), and a float
  // only takes room from the lines that come after it in the source. So the
  // sentence's first line runs up to the square and every line below it runs
  // the card's full width, instead of the whole sentence keeping a column's
  // worth of blank card clear down its right side for a square one line tall.
  // Tab order is close, then the guide link, then "Back" and "Next"; a
  // reader tabbing into a note meets its dismissal first, as in a dialog.
  //
  // Under the sentence, one line: how far through the steps the reader is,
  // the way to the guide, and "Back" and "Next" together at the end of the
  // line, where a reader who has read the sentence looks for the way on —
  // back before on, in the order the steps go. "Back" wears the class of
  // "Next" (`.edit-hint-next` in app.css: the indigo, the weight, the
  // underline under the pointer, the focus ring), because the two are one
  // pair of the same kind of control, an action on the steps; it is told
  // apart by `.edit-hint-back`. The class also brings `margin-left: auto`,
  // the push to the end of the line, which the pair must take once and not
  // twice — two auto margins share the free space and would set "Back"
  // adrift in the middle of the line. So while "Back" is shown it takes the
  // push and "Next" is written flush against it (`.edit-hint-back +
  // .edit-hint-on` in app.css); on step 1, with "Back" hidden, "Next" takes
  // the push back.
  row.innerHTML = `
    <div class="edit-hint" role="note" hidden data-adrift>
      <button type="button" class="edit-hint-close">${ICONS.close}</button>
      <span class="edit-hint-text"></span>
      <span class="edit-hint-foot">
        <span class="edit-hint-progress"></span>
        <button type="button" class="edit-hint-help"></button>
        <button type="button" class="edit-hint-next edit-hint-back"></button>
        <button type="button" class="edit-hint-next edit-hint-on"></button>
      </span>
    </div>
    <div class="history-buttons">
      <button type="button" class="history-button" data-step="undo" disabled>${ICONS.undo}</button>
      <button type="button" class="history-button" data-step="redo" disabled>${ICONS.redo}</button>
      <button type="button" class="history-button history-hints" aria-pressed="false" disabled>${ICONS.hints}</button>
    </div>
  `;
  const hint = row.querySelector<HTMLElement>(".edit-hint")!;
  const hintText = hint.querySelector<HTMLElement>(".edit-hint-text")!;
  const helpButton = hint.querySelector<HTMLButtonElement>(".edit-hint-help")!;
  const closeButton = hint.querySelector<HTMLButtonElement>(".edit-hint-close")!;
  const progress = hint.querySelector<HTMLElement>(".edit-hint-progress")!;
  const foot = hint.querySelector<HTMLElement>(".edit-hint-foot")!;
  const backButton = hint.querySelector<HTMLButtonElement>(".edit-hint-back")!;
  const nextButton = hint.querySelector<HTMLButtonElement>(".edit-hint-on")!;
  const undoButton = row.querySelector<HTMLButtonElement>('[data-step="undo"]')!;
  const redoButton = row.querySelector<HTMLButtonElement>('[data-step="redo"]')!;
  const hintsButton = row.querySelector<HTMLButtonElement>(".history-hints")!;

  // ── Undo and redo ─────────────────────────────────────────────────────────

  function syncButtons(): void {
    const focused = document.activeElement;
    const open = historyIsOpen();
    undoButton.disabled = !(open && canUndo());
    redoButton.disabled = !(open && canRedo());
    // The hints are about a text's analysis, which there is none of until a
    // text has been annotated — the condition `syncHint` shows them on.
    hintsButton.disabled = !open;
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
      button.setAttribute("aria-label", label);
    }
    // Named for what it toggles, not for the act: with `aria-pressed` beside
    // it, "Show editing hints, pressed" would read as a contradiction.
    hintsButton.setAttribute("aria-label", t("main.hints"));
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

  // ── The hints, one to a step of the guide ─────────────────────────────────
  //
  // **The guide's steps, nearly in the guide's order** (`STEPS` in
  // HelpModal.ts, `help.step.*` in the translations), said at the thing each
  // is about and when the reader can do it. It used to be two balloons, the
  // second of which named the chip, the label, the furigana and undo in one
  // sentence, and the reader saw it as one hint: four instructions at once,
  // of which they could follow one. One step at a time, the balloon is about
  // one thing, its tail points at that thing, and the reader does it before
  // the next is said.
  //
  // **One instruction to a balloon, and one the step can see done.** Even
  // one to a step, the sentences still asked for two things at a time —
  // "click a character to select it; right-click it to see its analysis as
  // well", "press A, choose the character with the arrow keys, and press
  // Enter", an arrow key *and* Escape — and the reader asked for each to give
  // exactly one thing to do. So every sentence now has one imperative and no
  // "or else do this" after it, and a sentence that had two became two:
  //
  //   - **Two things in a row became two steps** where both halves are
  //     steps of the guide in their own right. The guide's first step is to
  //     pick a character out *and* see its analysis; here they are `select`
  //     and `analyse`, in that order. A right click does both at once, and
  //     `advance` then steps over `analyse`, which is already done.
  //   - **What was a second instruction and nothing more was dropped**:
  //     Escape (the guide says it), the pills that slide out of the chip,
  //     redo. The guide is one click away, in the balloon itself.
  //
  // **One action, said for the mouse and for the keyboard.** "One
  // instruction" is one *thing to do*, and the reader then asked for every
  // balloon to name both ways of doing it — the click and the keys — rather
  // than one of them chosen by a guess at which the reader was using. So
  // each balloon is the pointer's sentence and then the keyboard's, "On the
  // keyboard, …", two ways to the same end and not two ends: a reader does
  // one or the other, and either ends the step. The pointer's comes first
  // because it is the one the page shows — the thing to click is what the
  // tail points at — and the keyboard's is said as a manner of doing the
  // same, which is why it can be a sentence of its own without being a
  // second instruction.
  //
  // That took away two pieces of machinery that only existed because the
  // balloon said one modality at a time:
  //
  //   - **The modality guess.** The wording used to follow the reader's last
  //     gesture as the step began, and a reader who had clicked the "?" and
  //     then reached for the keys was told about the mouse. There is no
  //     guess now and nothing to get wrong.
  //   - **The keyboard's phases.** A keyboard step that takes more than one
  //     key — Tab to the chip *then* Enter; A, *then* the arrows, *then*
  //     Enter — used to be said one key at a time, the balloon changing as
  //     the focus or attach mode showed that the key before had been
  //     pressed. Said beside the pointer's sentence, that is a balloon whose
  //     second half rewrites itself under the reader's eye with every key,
  //     and grows and shrinks and is placed again as it does, while its
  //     first half stands still; and the half that changed was the half the
  //     reader was following, so each key pressed was followed by a moment
  //     of finding the place again in a card that had moved. One sentence
  //     that gives the keys in order ("press Tab until the part of speech
  //     has the focus, and then press Enter") is read once and then done
  //     without looking back at it, which is how a reader follows a short
  //     sequence of keys anyway. The count of steps does not change: each
  //     sequence is still one step, as the pointer's single gesture is.
  //
  // **The reading third, and "follow it across" folded into it.** The guide
  // has a step between the analysis and the arrow keys about finding the
  // character again in the *kakikudashibun* ("Follow it across"), and the
  // hints had it as step 3. It was the one step with nothing to do but look,
  // and so the one step that could not be seen done: it went on at the
  // reader's next click anywhere, which was as often a click meant for
  // something else. The reader asked for step 3 to be the readings menu
  // instead — the furigana is the part of the analysis nearest the
  // character, and the first correction most readers make is to a reading.
  // What "follow it across" said survives as the first sentence of the
  // reading step's balloon, a statement and not an instruction — the
  // *kakikudashibun* marks this reading as well — because the furigana the
  // tail points at is what the mark in the other panel stands for, and the
  // sentence that tells the reader to look there is the one beside it. The
  // balloon still asks for one thing. The guide now takes this order too
  // (`steps` in HelpModal.ts, where the argument is), with "follow it
  // across" kept as a section of its own just before the reading: a reader
  // who opens the guide from the balloon at a step finds that step at the
  // same point of the guide.
  //
  //   select     a character, the first in sight while none is picked out
  //              (on the keyboard: the one with the focus, if one has it);
  //   analyse    the picked-out character;
  //   reading    its furigana;
  //   navigate   the picked-out character (the arrow keys);
  //   pos        the part-of-speech chip;
  //   relation   the relation label on the arrow;
  //   head       the picked-out character, to be dragged or moved by keys;
  //   undo       the undo button.
  //
  // **On to the next when the reader has *finished* what the step asked —
  // not when they have begun it.** The steps used to go on at the first sign
  // of the gesture: a menu opening, a drag starting, an arrow key going
  // down. The next balloon then came up over the gesture still in progress —
  // the relation step's menu open, and the head step's balloon laid across
  // it — and told the reader what to do next while they were still choosing
  // a row. So each step now waits for the end of its own gesture, and the
  // end is something that happens, never a state the page is in (see
  // "Back" below for why that matters):
  //
  //   select     a character picked out (`onLiveSelection`, which a click, a
  //              right click, a double click or Space all report);
  //   analyse    an analysis drawn that was not up when the step began — an
  //              overlay built, by the view's observer below — or the
  //              step's own gesture (a right click, a double click, Enter)
  //              on a character whose analysis is already up;
  //   reading,   a row picked in the step's own menu (`onCorrectionDone`,
  //   pos,       from tokenInspector.ts), or the menu closed without a pick
  //   relation   by Escape or by a press outside it (`menuLeft`, below). A
  //              pick of the row already marked current counts: the reader
  //              has answered the menu, if only with "as it was", and a step
  //              that waited for an edit would hold a reader who found the
  //              analysis right there until they spoiled it. Closing the
  //              menu unanswered counts for the same reason, one step
  //              further: the step was to *see* the other readings, the
  //              other parts of speech, the other relations, and a reader
  //              who has looked down the column and found nothing better has
  //              done that. These used to count as the reader calling the
  //              step off, like Escape out of attach mode below, and the
  //              step then held until they opened the menu again only to
  //              pick the row already marked — a pick they had no reason
  //              to make. The reader asked for Escape to count. A press
  //              outside counts with it because it is the pointer's Escape,
  //              and the balloon over an open menu names it as such (see
  //              "With a menu open" below); a balloon that named a way out
  //              and then did not go on when the reader took it would read
  //              as broken. Tab, which also closes a menu the keyboard
  //              opened, does not count: the balloon names Escape and not
  //              Tab, and Tab is the reader moving the focus on through the
  //              page, the menu closed on the way rather than answered.
  //              Nor does a menu that closes because something else took
  //              its place — another mark's menu opened over it, a scroll, a
  //              re-render — none of which is the reader leaving this menu;
  //   navigate   the arrow key let go (`keyup`), after the selection has
  //              moved under it — held down, the key repeats and the
  //              selection runs on, and the step is over when it stops; or,
  //              with the mouse, a click that has moved the selection onto
  //              another character (`clickedAcross`);
  //   head       a character let go on a head (the drop) or committed to one
  //              (Enter in attach mode) — `onCorrectionDone` again — or
  //              Escape out of attach mode (`attachLeft`).
  //              Not the drag starting nor A pressed, nor a drop on empty
  //              paper. Escape counts here for the reason it counts in a
  //              menu: it is the reader leaving the step's own context, and
  //              the reader asked for that to close the hint about it (see
  //              "Escape" below). A drop on empty paper does not, because
  //              nothing names it as a way out: it is a drag that missed;
  //   undo       an undo (`onHistoryChange` with something left to redo).
  //
  // "Next" in every balloon skips a step the reader cannot do yet or does
  // not want; the last step's is "Done", and the end of the last step
  // retires the hints.
  //
  // **Back.** Every balloon after the first has "Back", to the step before
  // it, said again even though its action has been done — the reader asked
  // for it to see the previous hint again, not to be told that they had
  // already done it. Which is why every ending above is an event and none
  // is a state: a step that went on whenever the page *looked* done (the
  // analysis up, say, which is how `analyse` used to end) would go on again
  // the moment "Back" brought it up, and "Back" would do nothing visible.
  // `analyse` is the one step whose ending has to be told from a state, the
  // overlay, and it is told by the overlay being a *new* one
  // (`overlayAtStart`), or by the gesture that asks for it
  // (`askedForAnalysis`). Going back is literal, one step and no skipping;
  // so is "Next" — only a step ending of itself steps over `analyse`.
  //
  // **Waiting for its target.** A step about the chip or the label needs the
  // analysis up. With a character picked out and the analysis down, the
  // balloon says how to bring it up, at the character (`needsAnalysis`). With
  // nothing picked out as a step begins, the step picks a character out
  // itself, to have something to say "this" of (`demonstrate`); a reader who
  // then lets it go leaves the step waiting, out of sight (`data-adrift`),
  // for the next.
  //
  // **Escape.** The reader asked for Escape to close a hint, "either by
  // escaping out of the relevant context, or by escaping when there is
  // nothing else to escape". So one press of Escape does exactly one of
  // these, the first that applies, and never two:
  //
  //   1. **Out of an open menu**, which tokenInspector.ts closes. If the
  //      menu is the step's own, that ends the step (`menuLeft`), and the
  //      next balloon comes up; any other menu just goes, and the step's own
  //      sentence comes back.
  //   2. **Out of attach mode**, the A key's, which tokenInspector.ts
  //      cancels (`attachKey`). On the head step that ends the step
  //      (`attachLeft`). A *pointer* drag is the same body class but takes
  //      no keys — tokenInspector.ts lets an Escape during one fall through
  //      to the selection, and the drag goes on to its release — so an
  //      Escape then is left to do that, and is not the hint's either: the
  //      reader has a button held down and is in the middle of something.
  //   3. **Out of the hint itself**, when the balloon is up and in sight and
  //      Escape has nothing else here to do: it closes the hints as the ×
  //      does, retirement and all (`escapeHint`). The key is spent on that
  //      and stopped, so that nothing behind the balloon answers it too.
  //   4. Otherwise it is left alone: a dialog's own Escape, a text field's,
  //      and — with the balloon down or adrift — the selection's, and after
  //      the selection the focus, which Escape takes off whatever has it
  //      when nothing else wants the press (tokenInspector.ts,
  //      `setupEscapeReleasesFocus`, where the rest of the order is argued).
  //
  // **The hint before the selection, and not after it.** tokenInspector.ts
  // also answers Escape when nothing is open but a character is picked out:
  // it lets the character go (the guide's "Escape lets the selection go").
  // Read strictly, that is "something else to escape", and the hint would
  // close only on an Escape with nothing picked out. It does not, for three
  // reasons. Most balloons are *about* the picked-out character, and only
  // shown while there is one (`data-adrift`), so under the strict reading
  // the press that was meant to close the balloon would instead put down the
  // reader's place and the analysis they had asked for, the balloon would
  // vanish with it only to come back at the next click, and a second Escape
  // would have nothing in sight to close — from the keyboard, the hint about
  // a picked-out character could never be closed by Escape at all. Second,
  // the balloon is laid over the page as a menu is, a thing of the moment;
  // the selection is not — it is where the reader is in the text — and
  // Escape everywhere puts away the thing of the moment first. Third, it
  // costs nothing that matters: the selection is one more Escape away, as it
  // is behind a menu. What the strict reading would have kept is the rule
  // that Escape always does the same to the *page*; the page is untouched by
  // a press that only closes the balloon, so that rule still holds wherever
  // the balloon is not.
  //
  // **Menus and attach mode before the hint**, on the other hand, because
  // there the reader is in the middle of something, and an Escape that took
  // the balloon away and left the menu open would make the reader press it
  // twice to do what they pressed it for. And Escape out of the step's own
  // menu or mode closes this hint anyway, by ending the step.

  const STEPS = ["select", "analyse", "reading", "navigate", "pos", "relation", "head", "undo"] as const;
  type Stage = (typeof STEPS)[number];
  // Step 1 from the first visit, shown once a text has been annotated.
  let stage: Stage | null = STEPS[0];
  /** The analysis that was up when the step began, if any — so that
   * `analyse` ends at an analysis drawn *since*, and a balloon brought back
   * to it by "Back", over the analysis it asked for, waits for the reader to
   * ask again rather than going straight on. */
  let overlayAtStart: Element | null = null;
  // Retired for good once the reader has dismissed it or finished the last
  // step, and brought back only by the "?" button. So the listeners below
  // stay subscribed while it is retired, and only look at `retired` before
  // they act: a revived hint needs them again.
  let retired = hintRetired();

  function retire(): void {
    if (retired) return;
    retired = true;
    storeRetired(true);
    syncHint();
  }

  /** On to the step after this one, or retired after the last. `done` for a
   * step that ended of itself (see "On to the next when the reader has
   * finished"), which steps over `analyse` when the analysis is already up:
   * a right click or a double click brings it up in the same gesture that
   * picks the character out, so the reader has done step 2 with step 1, and
   * a balloon asking them to do it again would be asking for what is on the
   * page. "Next" is not `done`, and goes to the very next step whatever the
   * page shows — the reader who went back to `select` and on again asked to
   * see `analyse`. */
  function advance(done: boolean): void {
    if (stage === null) return;
    let next = STEPS.indexOf(stage) + 1;
    if (done && STEPS[next] === "analyse" && analysisUp()) next += 1;
    if (next >= STEPS.length) {
      retire();
      return;
    }
    startStep(STEPS[next]);
  }

  /** "Back": the step before this one, as it was said the first time. */
  function goBack(): void {
    if (stage === null) return;
    const at = STEPS.indexOf(stage);
    if (at > 0) startStep(STEPS[at - 1]);
  }

  function startStep(next: Stage): void {
    stage = next;
    overlayAtStart = liveOverlay();
    navigateKey = null;
    demonstrate(next);
    syncHint();
  }

  /** **A character to talk about, when the step needs one and there is
   * none.** The user's decision, for a reader who presses "Next" through the
   * steps without clicking anything — the natural way to see what the hints
   * have to say before doing any of it. Every step after the first is about
   * a picked-out character: "right-click this character", "click the
   * *furigana*", the chip, the label on the arrow, "drag this character".
   * With nothing picked out those sentences have no referent, and the
   * balloon used to wait, adrift and out of sight (`data-adrift`), for a
   * selection that the reader had not been asked to make — so "Next" seemed
   * to close the hints rather than go on through them.
   *
   * So the step picks one out itself. `demonstrationCell` chooses it: the
   * first character in reading order, in sight, that hangs on another, so
   * that its analysis has a relation label and a boxed head for the later
   * steps to point at. It is picked out by **the very gesture a reader's
   * pointer would make**, dispatched on its glyph: a click for `analyse`,
   * whose own sentence asks the reader to bring the analysis up and must
   * not find it up already, and a right click for every later step, which
   * is about something the analysis shows. Through the same listeners, the
   * selection, the overlay, the panel's live region and the scroll into view
   * all behave exactly as they would for the reader's own click, and nothing
   * here has to know how any of them work. The focus is left where it is,
   * as a dispatched event leaves it: a keyboard reader pressing "Next" stays
   * on "Next".
   *
   * **Not the step done.** Each step ends at an event of its own gesture
   * (see "On to the next when the reader has *finished*"), and this raises
   * none of them: `select` is not the step being started, `analyse` ends at
   * an overlay drawn since it began and this one draws none, and the menus,
   * the drop and the undo are never touched. The `onLiveSelection` the click
   * reports arrives with the stage already moved on, which `select`'s
   * listener ignores.
   *
   * **The analysis too, on the character this picked.** "Next" from
   * `analyse` goes on without the right click that step asked for, so the
   * character picked out for `analyse` reaches `reading` and the steps after
   * it with its analysis down, and the chip and the label those steps point
   * at are not there. On a character this function picked out (`demoCell`,
   * still the selection), a later step therefore brings its analysis up by
   * the right click, as it would have done from nothing.
   *
   * **Never over the reader's own choice.** A character the reader picked
   * out is left as it is: the step is shown on that one, as before, with
   * `needsAnalysis` asking for its analysis where the step needs it. Not on
   * `select`, whose target is any character, nor on `undo`, whose target is
   * the button. */
  let demoCell: Element | null = null;
  function demonstrate(next: Stage): void {
    if (next === "select" || next === "undo" || retired || !view || !historyIsOpen()) return;
    const picked = view.querySelector(".token-cell-selected");
    let cell: Element | null;
    if (picked) {
      if (picked !== demoCell || next === "analyse" || liveOverlay()) return;
      cell = picked;
    } else {
      cell = demonstrationCell(view);
    }
    demoCell = cell;
    const glyph = cell?.querySelector<HTMLElement>(".kanji-glyph");
    if (!glyph) return;
    const r = glyph.getBoundingClientRect();
    const right = next !== "analyse";
    glyph.dispatchEvent(
      new MouseEvent(right ? "contextmenu" : "click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: right ? 2 : 0,
        detail: 1,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  }

  /** **The "?" button: the hints back, at once, from where the reader is.**
   * It used to be a button inside the guide, which a reader who had
   * dismissed the balloon had to know to open first; next to undo it is
   * where the reader's eye already goes for the editing controls.
   *
   * Pressed while the balloon is up, it takes it down — the same as the
   * balloon's own close, retirement included, so the button is a toggle and
   * says so (`aria-pressed`). Otherwise it brings the hints back, out of
   * retirement, at the step the reader is in the middle of
   * (`stepInProgress`) — step 1 for a reader who has nothing picked out,
   * whose target, a character, is on the page whenever the button is
   * enabled. Every step it can start at has its target on the page by the
   * state that chose it, so the balloon is up at once rather than at some
   * later gesture: a button that answered with nothing would read as
   * broken.
   *
   * A pointer press is read from the snapshot taken as it went down
   * (`pressedIn`), not from the page at the click: by then the press has put
   * an open menu away (the dismissal in `setupTokenContextMenu`), and the
   * menu was the evidence of which step the reader was on. */
  function toggleHints(event: MouseEvent): void {
    const from = event.detail > 0 && pressedIn !== null ? pressedIn : stepInProgress();
    pressedIn = null;
    if (hintShowing()) {
      retire();
      return;
    }
    retired = false;
    storeRetired(false);
    startStep(from);
  }

  /** What `stepInProgress` made of the page as the pointer went down on the
   * "?", for the click that follows (see `toggleHints`). */
  let pressedIn: Stage | null = null;

  /** **Which step the reader is in the middle of, read off the page.** A
   * reader who opens the hints with a menu open, or a character half-way to
   * a new head, wants to be told about what they are doing, not sent back to
   * "Click a character" for the ninth time. The answer is the marks the
   * other modules leave on the page, most specific first — a later step's
   * mark implies an earlier one's (a menu needs the analysis or at least a
   * selection, the analysis a selection), so the first match is the
   * furthest step:
   *
   *   1. **Attach mode** — `token-dragging` on `<body>` (a pointer drag, or
   *      the A key's mode: `startAttach`), or an overlay marked
   *      `data-moving` (`markMoving`, the arrow restyled as a candidate):
   *      the `head` step.
   *   2. **An open menu** — a `.token-context-menu` in `<body>` that is not
   *      fading out (`data-leaving`, `fadeOutAndRemove`), told apart by what
   *      it was opened from (`menuOpened`): the chip's or a pill's menu is
   *      `pos`, the label's `relation`, the furigana's `reading`. A menu
   *      none of those names (a kunten mark's) says nothing about the steps
   *      and falls through to what is under it. Each of these steps ends at
   *      a pick in its menu, so a menu open is a step under way and not one
   *      already done.
   *   3. **The analysis up** for a picked-out character: past `select` and
   *      `analyse`, so `reading`, the first step about what the analysis
   *      shows, and the step after `analyse` in `STEPS`.
   *   4. **A character picked out**, analysis down: `analyse`.
   *   5. Otherwise `select`, step 1.
   *
   * Not the keyboard focus: a reader pressing the "?" from the keyboard has
   * the focus on the "?", and wherever it was before says less than the
   * selection and the analysis, which the move to the button leaves as they
   * were (`data-keeps-selection` on the row). */
  function stepInProgress(): Stage {
    if (
      document.body.classList.contains("token-dragging") ||
      view?.querySelector(".token-inspector-overlay[data-moving]:not([data-leaving])")
    ) {
      return "head";
    }
    const menu = openMenuElement();
    const about = menu ? menuOpened(menu) : null;
    if (about) return about;
    if (analysisUp()) return "reading";
    if (view?.querySelector(".token-cell-selected")) return "analyse";
    return "select";
  }

  /** The menu that is up — in `<body>`, and not on its way out. */
  function openMenuElement(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(":scope > .token-context-menu:not([data-leaving])");
  }

  /** Up and in sight — not merely due, waiting adrift for its target. */
  function hintShowing(): boolean {
    return !hint.hidden && !("adrift" in hint.dataset);
  }

  function syncPressed(): void {
    hintsButton.setAttribute("aria-pressed", String(hintShowing()));
  }

  function liveOverlay(): Element | null {
    return view?.querySelector(".token-inspector-overlay:not([data-leaving])") ?? null;
  }

  /** The step is about the analysis (the chip, the label), a character is
   * picked out, and the analysis is down: what to say is how to bring it up. */
  function needsAnalysis(): boolean {
    return (
      (stage === "pos" || stage === "relation") &&
      !liveOverlay() &&
      !!view?.querySelector(".token-cell-selected")
    );
  }

  /** A character picked out, with its analysis drawn — what `analyse` asks
   * for, and what a right click or a double click does at once. */
  function analysisUp(): boolean {
    return !!liveOverlay() && !!view?.querySelector(".token-cell-selected");
  }

  /** **Attach mode, as this module has seen it** (`token-dragging` on
   * `<body>`, watched below): on during a pointer drag and during the A
   * key's mode alike. Read by the navigate step, whose arrow keys in attach
   * mode are moving the candidate and not the selection. */
  let attaching = false;

  /** **With a menu open, how to close it — in place of the step's
   * sentence, not beside it.** Any of the token menus: the step's own, the
   * menu of another step, a kunten mark's. The reader asked for the balloon
   * to say how a menu is put away, which nothing on the menu does; a reader
   * who opened one by accident, or to look, had to guess at Escape.
   *
   * *Instead of* the step's sentence, because while the menu is up that
   * sentence is either done or beside the point. With the step's own menu
   * open, it has been done — "click the furigana to choose another
   * reading" is what opened the menu — and said again, over the menu it
   * asked for, it would read as asking for a second menu. With another
   * menu open, the step's sentence is about something the menu now stands
   * in the way of, and the one thing the reader needs before it is the way
   * out. Two sentences in one balloon would also have been two
   * instructions, which "One instruction to a balloon" rules out. The
   * step's sentence comes back when the menu goes (the body's observer
   * below, and `menuLeft`), unless the menu's going ended the step and the
   * next step's sentence is due instead.
   *
   * **One action: the way out, with "without choosing" as its manner.**
   * The obvious sentence is "pick an entry, or press Escape to close this
   * menu", and it is two instructions joined by "or" — the very shape the
   * rule above took apart everywhere else. Of the two, the pick needs no
   * saying: a menu is a list of things to pick, its rows answer the
   * pointer as it moves over them, and the current one is marked. The way
   * out is the one thing the menu does not show. So the balloon gives that
   * one imperative, and "without choosing" names the alternative as its
   * manner rather than as a second command: it tells the reader that
   * choosing is the other thing to do here without asking them to do it.
   *
   * **Both ways out in one sentence.** Like every balloon (see "One action,
   * said for the mouse and for the keyboard"), this one names the pointer's
   * way and the keyboard's — a click outside, which is the pointer's Escape
   * (the dismissal in `setupTokenContextMenu`), and Escape — and here the
   * two fit one sentence with one verb phrase each, "click outside this
   * menu or press Escape", since they share the purpose that follows. It
   * used to say one of them, chosen by whether the menu had the focus (a
   * menu the keyboard opens takes it, `focusIntoMenu`); with both said there
   * is nothing to choose. */

  /** The translation the balloon is showing, so that a change of what it
   * should show (the analysis coming up under a `needsAnalysis` balloon, a
   * menu opening or closing) is seen and the balloon said again. */
  let shownKey = "";
  function textKey(): StringKey {
    if (openMenuElement()) return "hint.menu";
    if (needsAnalysis()) return "hint.needsAnalysis";
    // **The undo step with nothing to undo.** "Click this button to undo
    // your last edit" is an instruction the page refuses while the history
    // is empty: the button is disabled, at half strength (`.history-button:
    // disabled` in app.css), and a click on it does nothing. A reader who has
    // come to this step by "Next" without editing anything — the usual way
    // through the steps on a first look — would press it and conclude that
    // undo is broken. So the sentence says when the button will answer, with
    // the same one action and the same keys, and changes to the plain one the
    // moment there is an edit to take back (`onHistoryChange` below).
    if (stage === "undo" && !canUndo()) return "hint.undoEmpty";
    return `hint.${stage ?? "select"}`;
  }

  // **A click hides nothing.** For a while the reader's next click anywhere
  // took the balloon down, on the theory that by then they were doing what it
  // said. It got in the way of the steps instead: the click that ended one
  // step was as often the one the next step's balloon needed to be up for —
  // a step hidden by a click on the sidebar stayed hidden until the reader
  // happened on that step's action unprompted — and the reader asked for it
  // to go. The balloon now goes only by its close, "Done", or the "?". (A
  // click also used to end "follow it across", the step with nothing to do;
  // that step is gone — see "The reading third".)
  //
  // What a press still does here is take the snapshot the "?" reads, and
  // see a press outside an open menu for what it is.
  window.addEventListener(
    "pointerdown",
    (event) => {
      // The page as it is before this press changes it, for the "?" (see
      // `toggleHints`). On `window`, in the capture phase, so that it runs
      // before the menu's dismissal, which is on `document`.
      if (event.target instanceof Node && hintsButton.contains(event.target)) pressedIn = stepInProgress();
      // A press outside an open menu, which the dismissal is about to act
      // on: the pointer's Escape (`menuLeft`). Not a press on the "?" or on
      // the balloon, which also put the menu away but are presses *on the
      // hints* — "Next" there already goes on by itself, and counting the
      // press as the menu's step done as well would go on twice.
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest(".token-context-menu") &&
        !hintsButton.contains(target) &&
        !hint.contains(target)
      ) {
        menuLeft();
      }
    },
    { capture: true },
  );
  // **A click on the menu's own trigger**, which closes it as surely as a
  // press outside does: the relation label, the chip, the furigana each
  // toggle their menu. The press above lets that one through untouched —
  // the dismissal leaves the menu up for the click that follows to act on
  // (see `menuLeft`) — so it is the click that is looked at, the same way.
  // Nothing is counted twice: a menu already put away by the press is gone
  // or fading by now, and `openMenuElement` sees neither; a click that
  // opens another menu in its place leaves one up, which `menuLeft` does
  // not count either.
  window.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest(".token-context-menu") &&
        !hintsButton.contains(target) &&
        !hint.contains(target)
      ) {
        menuLeft();
      }
    },
    { capture: true },
  );

  /** The arrow key that moved the selection in the navigate step, until it
   * is let go — when the step is over (see "On to the next"). */
  let navigateKey: string | null = null;
  window.addEventListener(
    "keydown",
    (event) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      // Escape, in the order argued under "Escape" above: a menu, then
      // attach mode, then the hint. Each branch is the whole of what this
      // module does with the press, so one press never does two of them.
      if (event.key === "Escape") {
        if (openMenuElement()) menuLeft();
        else if (document.body.classList.contains("token-dragging")) attachLeft();
        else escapeHint(event);
      }
      // A key in attach mode can move the candidate, which the balloon on
      // the head step keeps clear of.
      if (attaching) queuePlace();
      // The navigate step's own gesture: an arrow key in the text, with a
      // character picked out to move — not one in a menu, which is moving in
      // the menu, nor one in attach mode, which is moving the candidate.
      // Noted on the way down and acted on when it comes up (`keyup`).
      if (
        !retired &&
        stage === "navigate" &&
        !attaching &&
        event.key.startsWith("Arrow") &&
        event.target instanceof Node &&
        view?.contains(event.target) &&
        view.querySelector(".token-cell-selected")
      ) {
        navigateKey = event.key;
      }
    },
    { capture: true },
  );
  // **The move over when the key comes up.** By then the selection has
  // moved — as often as the key repeated, if it was held — and the balloon
  // for the next step comes up on the character the reader stopped at,
  // rather than on the first one the key went past.
  window.addEventListener(
    "keyup",
    (event) => {
      if (navigateKey === null || event.key !== navigateKey) return;
      navigateKey = null;
      if (!retired && stage === "navigate") advance(true);
    },
    { capture: true },
  );
  // A key let go in another window never comes up here; the next press
  // starts the watch again.
  window.addEventListener("blur", () => {
    navigateKey = null;
  });

  /** **Which step a menu belongs to, seen from outside.** The menus are
   * tokenInspector.ts's; what they leave on the page says which mark opened
   * one. A menu is put in `<body>` (`openRetagMenu`, `openReadingMenu`), and
   * the mark it was opened from wears `data-menu-tab` from the same task
   * (`markMenuTab`): on the 品詞 pill or a pill beside it for the part of
   * speech, on the label for the relation, and on nothing for a reading,
   * whose menu is named for the reading (`dressMenu`). */
  function menuOpened(menu: Element): Stage | null {
    const tab = view?.querySelector("[data-menu-tab]");
    if (tab?.classList.contains("token-arrow-label")) return "relation";
    if (tab?.classList.contains("token-subtitle")) return "pos";
    if (!tab && menu.getAttribute("aria-label") === t("field.reading")) return "reading";
    return null;
  }

  /** The step a finished correction ends (see "On to the next"): a pick in
   * the 品詞, domain or sense menu ends `pos`, as all three are the chip's;
   * a pick of a reading, of 自動 or of the topic particle — the rows of the
   * readings menu — ends `reading`. */
  function stepDoneBy(done: CorrectionDone): Stage | null {
    if (done.kind === "attach") return "head";
    switch (done.field) {
      case "field.pos":
      case "field.domain":
      case "field.sense":
        return "pos";
      case "field.relation":
        return "relation";
      case "field.reading":
      case "field.topic":
        return "reading";
      default:
        return null;
    }
  }

  onCorrectionDone((done) => {
    if (!retired && stage !== null && stepDoneBy(done) === stage) advance(true);
  });

  /** **A menu put away without a pick: Escape, or a press outside it** —
   * the step's end as much as a pick is (see "On to the next", where the
   * case for counting it is argued). Called as the gesture begins, from the
   * capture-phase listeners on `window`, which run before tokenInspector.ts
   * sees the key or the press; and acted on a task later, when it has.
   *
   * **Noted before, judged after.** Which step a menu belongs to is read off
   * the mark that opened it (`menuOpened`, by `data-menu-tab`), and closing
   * the menu takes that mark off (`markMenuTab(null)` in
   * `closeContextMenu`), so it is read now, while the menu is up. Whether
   * the gesture closed the menu is read afterwards, from the menu itself:
   * gone, or fading out (`data-leaving`). A press that the dismissal lets
   * through — on the relation label or an unfolded pill, which open their
   * own menu on the click that follows — leaves the menu up at that point,
   * and is not counted; nor is a gesture after which another menu is up,
   * since the reader has then gone on to that menu rather than left this
   * one.
   *
   * **Nothing here acts on the key.** It does not prevent the default nor
   * stop the event, so Escape reaches tokenInspector.ts exactly as it would
   * with the hints down, and is spent there on the menu alone: its keydown
   * listener closes the innermost thing open and returns, so the selection
   * under the menu stays picked out. The step that comes up next (the
   * reading's next is `navigate`, the relation's `head`) has no use for
   * Escape either, and the key was looked at once, here, before the step
   * changed — a later step cannot take the same press as its own. */
  function menuLeft(): void {
    const menu = openMenuElement();
    if (!menu) return;
    const about = menuOpened(menu);
    setTimeout(() => {
      if (menu.isConnected && !menu.hasAttribute("data-leaving")) return;
      // The balloon said how to close the menu; it says something else now
      // whether or not this ends the step, and the menu that fades out is
      // not observed going (only its removal is, after the fade).
      queuePlace(true);
      if (openMenuElement()) return;
      if (!retired && stage !== null && about === stage) advance(true);
    }, 0);
  }

  /** **Escape out of attach mode, on the head step** — the
   * step's end, as Escape out of the step's own menu is (`menuLeft`, and
   * "Escape" above for why leaving the step's context counts). Called from
   * the capture-phase keydown on `window`, before tokenInspector.ts cancels
   * the mode (`attachKey`), and judged a task later, when it has: if the
   * mode is over, the reader has left it. Nothing here touches the key,
   * which tokenInspector.ts spends on the cancel alone. During a pointer
   * drag, which wears the same `token-dragging` and is sent here too, the
   * key does not end the drag, the class is still on a task later, and
   * nothing happens here. */
  function attachLeft(): void {
    if (retired || stage !== "head") return;
    setTimeout(() => {
      if (document.body.classList.contains("token-dragging")) return;
      if (!retired && stage === "head") advance(true);
    }, 0);
  }

  /** **Escape with nothing else for it to do: the hints closed**, as the ×
   * closes them (`retire`). Reached only when no menu is open and no mode is
   * on (the keydown above has already sent those elsewhere), and acted on
   * only when the balloon is up and in sight — a balloon adrift has nothing
   * on the page for the reader to be closing, and Escape then goes on to
   * whatever it would have done without the hints.
   *
   * Not where Escape belongs to something else that this module cannot see
   * from the menu and the mode:
   *
   *   - **a dialog** — the guide, the about box (`dialog[open]`): its own
   *     Escape closes it, and the balloon is behind it, inert, until it
   *     does. tokenInspector.ts stands aside for the same test
   *     (`modalIsOpen`);
   *   - **a field the reader is typing in** — the sidebar's text, a search
   *     box: Escape there is the field's, and a reader typing is not looking
   *     at the balloon. The same list tokenInspector.ts stands aside for,
   *     with `<select>` and editable content added, which it has no
   *     occasion to meet but this listener, on all of `window`, does.
   *
   * **Spent, so that it does nothing else.** The press is stopped here, in
   * the capture phase on `window`, ahead of every listener on `document` —
   * tokenInspector.ts's among them, which would otherwise take the same
   * press as "let the selection go" (see "The hint before the selection"
   * above for why the hint comes first). Default prevented too, so that a
   * browser that gives Escape a meaning of its own (stopping a page load)
   * does not do that as well. */
  function escapeHint(event: KeyboardEvent): void {
    if (retired || !hintShowing()) return;
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    retire();
  }

  /** **The navigate step done with the mouse**: a click on another character
   * that has moved the selection onto it, which is the pointer's way of
   * moving the selection, as the arrow keys are the keyboard's. Seen on its
   * way down (`window`, capture) and judged a task later, by which time
   * tokenInspector.ts has acted on it: the selection must exist and be a
   * different character from the one picked out before the click. So a
   * click that only put a menu away (`dismissedMenu` swallows it), a click
   * on the character already picked out (which puts its analysis down and
   * keeps it), and a click on a mark of the analysis (a menu) all leave the
   * step where it was. */
  function clickedAcross(event: MouseEvent): void {
    if (retired || stage !== "navigate" || !view) return;
    const target = event.target;
    if (!(target instanceof Element) || !view.contains(target)) return;
    const before = view.querySelector(".token-cell-selected");
    if (!before || !target.closest(".kanji-cell[data-token-id]")) return;
    setTimeout(() => {
      const after = view.querySelector(".token-cell-selected");
      if (after && after !== before && !retired && stage === "navigate") advance(true);
    }, 0);
  }
  window.addEventListener("click", clickedAcross, { capture: true });

  /** The gloss balloon a menu hangs under the row the pointer is on
   * (`.token-menu-balloon`, `showMenuBalloon`): one element, made once and
   * then shown, hidden and moved, so it is watched where it is rather than
   * found in a record of `<body>`'s children. */
  let watchedMenuBalloon: Element | null = null;
  const menuBalloonObserver = new MutationObserver(() => {
    // Re-placed only when it has come over the hint: a balloon that moves
    // with every row the pointer crosses would take the hint with it,
    // which is a hint that will not stay still to be read.
    if (hint.hidden || !watchedMenuBalloon || (watchedMenuBalloon as HTMLElement).hidden) return;
    const a = hint.getBoundingClientRect();
    const b = watchedMenuBalloon.getBoundingClientRect();
    if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) {
      queuePlace(true);
    }
  });
  function watchMenuBalloon(): void {
    const balloon = document.body.querySelector(":scope > .token-menu-balloon");
    if (!balloon || balloon === watchedMenuBalloon) return;
    menuBalloonObserver.disconnect();
    watchedMenuBalloon = balloon;
    menuBalloonObserver.observe(balloon, { attributes: true, attributeFilter: ["hidden", "style"], childList: true });
  }

  new MutationObserver((records) => {
    // **Attach mode, on and off**, followed whether or not the hints are
    // up, for the navigate step's arrow keys. Its end does not end the head
    // step by itself: the drop or the commit does (`onCorrectionDone`), and
    // so does Escape (`attachLeft`), which is told by the key and not by the
    // mode going — a drop on nothing ends the mode too, and is not a way
    // out the balloon names.
    const dragging = document.body.classList.contains("token-dragging");
    if (dragging !== attaching) {
      attaching = dragging;
      queuePlace();
    }
    // **A menu in or out.** The balloon keeps clear of an open menu
    // (`menuBoxes`), so it is placed again when one opens — out of the
    // menu's way — and when one is taken out of the page, back to where it
    // would rather be.
    for (const record of records) {
      if (record.type === "attributes") continue;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains("token-menu-balloon")) watchMenuBalloon();
        if (node.classList.contains("token-context-menu")) queuePlace(true);
      }
    }
  }).observe(document.body, { childList: true, attributes: true, attributeFilter: ["class"] });
  watchMenuBalloon();

  function syncHint(): void {
    if (retired || stage === null || !historyIsOpen()) {
      // Focus on the hint's own buttons would go down with them; give it to
      // the "?", the control that brings them back, rather than to the body.
      if (hint.contains(document.activeElement)) hintsButton.focus();
      hint.hidden = true;
      placedFor = null;
      rest = null;
      syncPressed();
      return;
    }
    const key = textKey();
    shownKey = key;
    // Markup from this app's own translation files — the English italicises
    // *furigana* as the guide does — as `data-i18n-html` puts it in; no user
    // input reaches these strings.
    hintText.innerHTML = fill(key, { undo: shortcut("undo"), redo: shortcut("redo") });
    const at = STEPS.indexOf(stage);
    progress.textContent = fill("hint.progress", { n: String(at + 1), of: String(STEPS.length) });
    // "Back" from step 2 on. Focus on it as it goes (step 2's "Back" pressed
    // from the keyboard, to step 1) would drop to the body; "Next", beside
    // it, is where the reader's hand already is.
    const first = at === 0;
    if (first && document.activeElement === backButton) nextButton.focus();
    backButton.hidden = first;
    backButton.textContent = t("hint.back");
    nextButton.textContent = t(at === STEPS.length - 1 ? "hint.done" : "hint.next");
    helpButton.textContent = t("help.button");
    closeButton.setAttribute("aria-label", t("hint.dismiss"));
    hint.lang = getUiLang();
    // Coming up from hidden, it is not seen until `placeHint` has put it by
    // its target, rather than for a frame wherever it last was.
    if (hint.hidden) hint.dataset.adrift = "";
    hint.hidden = false;
    // The words may have changed, and with them the balloon's size.
    queuePlace(true);
  }

  // ── The balloon, and what it points at ────────────────────────────────────
  //
  // **At the thing the sentence is about** — each step's target, listed
  // under "The hints, one to a step of the guide" and found by `targetOf`.
  // The reading step is about the furigana and, in its first sentence, the
  // kakikudashibun's mark for the same reading; its tail goes to the
  // furigana, in this panel, and the sentence names the other. A balloon
  // here cannot point into the other panel without leaving this one, and
  // the furigana is the half of the pair the reader's eye is already beside.
  //
  // **Against the ink, not a column's width off it.** The tip stops
  // `TAIL_GAP` short of the target's own box — the glyph's em square, or the
  // chip's pill, which is all ink — rather than of the selected cell. The
  // cell is the glyph plus a half-gap either side for the readings, half a
  // glyph's width each, and measuring from it left the tip some 26px from the
  // character it was pointing at, with nothing between the two.
  //
  // It used to be fitted into the 55px top margin, wrapped to whatever run
  // of that margin the chip left it and cut off at three lines. Floating, it
  // has room for the whole sentence, and what it has to keep clear of is no
  // longer one span of one margin but a handful of boxes anywhere in the
  // panel: **the selected glyph and its readings, the chip and its pills,
  // the relation labels, and the undo buttons** — the things the hint is
  // telling the reader to click, and the character it is about. Everything
  // else of the text it may cover; it is a note laid over the page for a
  // moment, and the close button is on it.
  //
  // **Where, in order of preference.** Beside the target, left first: the
  // left is the side the text goes on to, so what it covers is what the
  // reader has not reached yet, and the chip's domain and sense pills fold
  // out to the *right* (`.token-subtitle-semantics`), where a balloon would
  // be what they fold out over. Then the right; then below the target and
  // above it. The first place that fits inside the panel and covers none of
  // those boxes is taken. If none does — a narrow panel — it is tried again
  // beside the target, narrowed to the run of panel there and so taller;
  // then each of those places slid along the edge its tail comes out of, as
  // far as the tail can still reach the target; then, tail-less, the clear
  // place nearest the first choice. Failing all of those, the boxes are no
  // longer all equal: a place that covers nothing this step or the next
  // sends the reader to, with its tail on if it can, covering least of the
  // rest. Only when nothing in the panel is clear even of that is the place
  // that covers least taken. What the reader is to click outranks the tail.
  // Between places these rules leave equal, the one that covers least of the
  // rest of the text is taken (`textBoxes`). Along the edge the tail comes
  // out of, it is centred on the target where it can be, slid to stay
  // inside the panel, and the tail slides the other way, so it still points
  // at the target's middle.
  //
  // **Measured, because nothing else knows.** Where the character is depends
  // on which one was picked and on how far the columns are scrolled. So the
  // balloon is placed again a frame after anything that can move it: a new
  // stage or new words, a change of selection or of analysis (a cell's
  // classes, an overlay built or torn down), the columns scrolling, a
  // resize, and the end of a transition or an animation in the text — the
  // overlay settles after it is built, and measured the frame after, it is
  // still on its way. Coalesced to one measurement a frame, and none while
  // the hint is down.
  //
  // **When the chip unfolds, sideways and no further.** Resting the pointer
  // on the chip slides its domain and sense pills out to the right, and at
  // the panel's right edge pulls the whole row left so they are not cut
  // (`--semantics-pullback`). Both are the reader looking at the chip, not
  // the page changing under the balloon, and a balloon that jumped away as
  // the pointer reached the chip — which the balloon itself had just sent it
  // to — was what the reader reported. So the balloon is not placed again
  // for it: a subtree change is acted on only when it changes what the
  // balloon is placed *for* (`placementKey`: the stage, the selected cells,
  // the overlay), and a transition or an animation inside the chip's row is
  // not listened to at all. Its place is worked out for the chip at rest —
  // measured with the pullback added back, folded, so that it can stand as
  // near the chip as the chip itself allows — and kept (`rest`).
  //
  // What the unfolding may do is slide it along the line it is already on,
  // which the reader allowed: its height never changes, so the sentence they
  // are reading does not drop away from their eye, and it moves only as far
  // as the pills need (`slideHint`). Beside the chip on the left, it follows
  // the chip as the pullback carries it, so the tail stays against the chip;
  // on the right, it steps out to the end of the unfolded run, so the tail
  // touches the sense pill — the end of the chip as it now is. Above or
  // below the chip it follows the pullback too, and its tail stays where it
  // was along its edge. When the pills fold back, so does it.
  //
  // **With nothing selected there is nothing to point at**, and the balloon
  // is hidden until there is again (`data-adrift`); the stage it had reached
  // is kept. A deselection is not reported to `onLiveSelection`, which is why
  // the subtree observer watches the selection's class as well. The one
  // exception is a balloon with the keyboard focus on its own buttons: it
  // stays where it was, rather than throw the focus to the body.

  const panel = row.closest<HTMLElement>(".kundoku-panel");
  const view = panel?.querySelector<HTMLElement>(".tategaki") ?? null;
  const historyButtons = row.querySelector<HTMLElement>(".history-buttons")!;
  /** Between the balloon's tail tip and the ink it points at: near enough
   * that the two read as touching, far enough that the tip is not drawn
   * over the ink. A glyph's em square carries a pixel or two of side
   * bearing, so the tip is that much further from a character's strokes. */
  const TAIL_GAP = 3;
  /** The tail's reach out of the balloon's edge (`--edit-hint-tail`). */
  const TAIL = 7;
  /** The least the balloon keeps from the panel's edges. */
  const INSET = 8;
  /** The narrowest the balloon is squeezed to beside its target (9rem): a few
   * words a line, past which it reads as a ragged strip. */
  const NARROWEST = 144;
  /** How far a balloon slid along its edge may also stand off its target,
   * the tail's tip that much further from the ink than `TAIL_GAP`. A chip
   * is wider than the glyph above it, so a balloon beside the glyph, slid
   * down past the relation label beside it, can come down onto the corner
   * of the chip by a pixel; standing off a few pixels clears it, and the
   * tail, a few pixels short, still reads as touching. Past this it reads
   * as pointing at the gap, which is the 26px the reader reported. */
  const GIVE = 6;

  type Box = { left: number; top: number; right: number; bottom: number };
  type Side = "left" | "right" | "below" | "above";
  /** A box `keepClear` lists, with what it is: the selected character's
   * ink, its reading, the chip's row, a relation label, the undo buttons. */
  type Kept = Box & { kind: "glyph" | "reading" | "chip" | "label" | "history" };

  function boxOf(el: Element, origin: DOMRect): Box | null {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
  }

  function union(boxes: Box[]): Box | null {
    if (boxes.length === 0) return null;
    return {
      left: Math.min(...boxes.map((b) => b.left)),
      top: Math.min(...boxes.map((b) => b.top)),
      right: Math.max(...boxes.map((b) => b.right)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
    };
  }

  function overlap(a: Box, b: Box): number {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /** How far left the chip's row is pulled while its pills are out (see "And
   * not when the chip unfolds"), to be added back to anything measured in
   * it. Written by `pullBackSemantics` in tokenInspector.ts as a length in
   * px, or absent at rest. */
  function pullback(overlay: Element): number {
    const value = overlay instanceof HTMLElement ? overlay.style.getPropertyValue("--semantics-pullback") : "";
    return parseFloat(value) || 0;
  }

  function shifted(box: Box, dx: number): Box {
    return { ...box, left: box.left + dx, right: box.right + dx };
  }

  /** What the balloon must not cover, in the panel's coordinates: the
   * selected glyphs and their readings (the reading step sends the reader to
   * the *furigana*), but not the empty half-gaps of their cells, which are
   * what kept the balloon a column's width off. The chip's row is the 品詞
   * pill alone (the domain and the sense are out of its flow) and is taken
   * at rest, folded, when the balloon is pointing at the chip and so slides
   * out of the run's way as it unfolds (`slideHint`), and a place on the
   * chip's right is then only taken with that room beside it (`candidate`).
   * Pointing at anything else the balloon does not slide, and the room the
   * run takes unfolded is kept clear from the start.
   *
   * **Everything of the selected character that the guide sends the reader
   * to click**, then, and not only what the current step names: the glyph
   * (selected, dragged, right-clicked), its furigana and okurigana (the
   * reading step's menu opens from them), the marks written into the cell
   * with it — the kaeriten (`.kunten-glyph`, which hangs below the em square
   * and so outside the glyph's box), a reread's second reading, an odoriji:
   * KundokuView.ts's `ANNOTATION_PARTS`, all of them part of the character
   * as the reader sees it — and, in the analysis drawn round it, the chip's
   * row with its pills and every relation label. The reader reported the
   * reading step's balloon laid over the 品詞 chip of 而 in the title line:
   * the chip was already on this list, but the steps follow one another
   * over the same few boxes, so the balloon for one step is where the
   * reader's pointer is going for the next, and a balloon that only kept
   * clear of the box its own sentence named would still be in the way a
   * click later. The empty half-gaps of the cell stay off the list (see
   * above), as does the arrow's line, which takes no click. */
  function keepClear(origin: DOMRect, cells: HTMLElement[], sliding: boolean): Kept[] {
    const boxes: Kept[] = [];
    for (const cell of cells) {
      for (const el of cell.querySelectorAll(
        ".kanji-glyph, .kanji-reading, .kaki-reading, .furigana, .okurigana, .reread-second, .kunten-glyph, .odoriji",
      )) {
        const box = boxOf(el, origin);
        const kind = el.matches(".kanji-glyph, .kunten-glyph, .odoriji") ? "glyph" : "reading";
        if (box) boxes.push({ ...box, kind });
      }
    }
    const overlay = view?.querySelector(".token-inspector-overlay:not([data-leaving])");
    if (overlay) {
      const dx = pullback(overlay);
      for (const el of overlay.querySelectorAll(".token-subtitle-row, .token-arrow-label")) {
        const measured = boxOf(el, origin);
        if (!measured) continue;
        if (!el.classList.contains("token-subtitle-row")) {
          boxes.push({ ...measured, kind: "label" });
          continue;
        }
        const box = shifted(measured, dx);
        const run = el.querySelector<HTMLElement>(".token-subtitle-semantics");
        if (run && !sliding) box.right += run.offsetWidth;
        boxes.push({ ...box, kind: "chip" });
      }
    }
    const buttons = boxOf(historyButtons, origin);
    if (buttons) boxes.push({ ...buttons, kind: "history" });
    return boxes;
  }

  /** **The rest of the text, as a soft cost.** Every glyph in sight in the
   * panel but the selected character's own, which `keepClear` already
   * holds. A balloon may cover the text — it is a note laid over the page
   * for a moment (see "At the thing the sentence is about") — but where two
   * places are otherwise as good, the one that covers less of it is better,
   * and on step 1 that is the whole question. Its sentence is "click a
   * character", its tail is on the first in sight, and every other
   * character is one the reader may click: measured at 1440px, the balloon
   * on the first choice, left of 學, lay across the tops of 學, 之 and 自 in
   * the next three columns, and in Japanese at 1024px across 學, 習 and 有 —
   * the very characters it was asking the reader to click, with a taller
   * balloon covering more. Beside the first column, slid up along its edge,
   * or below the character, the same balloon covers less or none.
   *
   * Soft, and last: weighed only between places that the harder rules —
   * clear of a menu, then of what this step and the next click on, then of
   * the rest of `keepClear` — leave equal, so it reorders places within a
   * rank and never lifts one over a rank. Among equally clear places the
   * order of preference still breaks ties, so where some place covers none
   * of the text the first such one is taken, as before. Glyphs only, by
   * their em squares: the furigana and kunten beside them are a narrow
   * strip each, and a balloon that clears the glyphs of a column clears
   * nearly all of what is written with them. */
  function textBoxes(origin: DOMRect, cells: HTMLElement[]): Box[] {
    const width = panel?.clientWidth ?? 0;
    const height = panel?.clientHeight ?? 0;
    const boxes: Box[] = [];
    for (const glyph of view?.querySelectorAll(".kanji-glyph") ?? []) {
      if (cells.some((cell) => cell.contains(glyph))) continue;
      const box = boxOf(glyph, origin);
      if (box && box.right > 0 && box.left < width && box.bottom > 0 && box.top < height) boxes.push(box);
    }
    return boxes;
  }

  /** **What this step and the next send the pointer to**, of the kinds of
   * box `keepClear` lists. All of them are kept clear while any place does
   * that; past that point (see "Clear of what is to be clicked now" in
   * `placeHint`) these are kept clear harder than the rest. The step ahead
   * is counted because "Next" is on the balloon: the reader who presses it
   * gets a balloon laid out afresh for that step, but a reader who does the
   * next thing straight from this one — the relation label's menu, say,
   * opened while the part-of-speech step's balloon is still up — finds the
   * balloon where this step left it. The navigate step's "click another character"
   * names no box of the selected one; its glyph stands for it, as the
   * character the arrow keys move from. */
  const CLICKED: Record<Stage, readonly Kept["kind"][]> = {
    select: ["glyph"],
    analyse: ["glyph"],
    reading: ["reading"],
    navigate: ["glyph"],
    pos: ["chip"],
    relation: ["label"],
    head: ["glyph"],
    undo: ["history"],
  };
  function mustClear(): Set<Kept["kind"]> {
    if (stage === null) return new Set(["glyph", "reading", "chip", "label", "history"]);
    const next = STEPS[STEPS.indexOf(stage) + 1];
    return new Set([...CLICKED[stage], ...(next ? CLICKED[next] : [])]);
  }

  /** The box the tail points at (see "At the thing the sentence is about"),
   * whether it is the chip, which the balloon slides beside, and, for a
   * target that is part of a character, the whole character (`near`). Null when
   * the step's target is not on the page, or not in the panel: the balloon
   * then waits, adrift. */
  function targetOf(origin: DOMRect, cells: HTMLElement[]): { box: Box; chip: boolean; near?: Box } | null {
    const glyphs = (): Box | null =>
      union(
        cells.flatMap((cell) => {
          const glyph = cell.querySelector(".kanji-glyph");
          const box = glyph && boxOf(glyph, origin);
          return box ? [box] : [];
        }),
      );
    const of = (box: Box | null, chip = false) => (box ? { box, chip } : null);
    const overlay = liveOverlay();
    switch (stage) {
      case "undo":
        return of(boxOf(undoButton, origin));
      case "select": {
        if (cells.length > 0) return of(glyphs());
        // The character Space would pick out, if one has the focus: the
        // balloon's keyboard sentence ends in "press Space", and the tail is
        // then on what that press would select. With no character focused
        // — the pointer reader's case, and the keyboard reader's before the
        // first Tab — the first in sight, below.
        const focused = document.activeElement;
        const cell = focused instanceof Element && view?.contains(focused) ? focused.closest(".kanji-cell") : null;
        const own = cell?.querySelector(".kanji-glyph");
        const ownBox = own && boxOf(own, origin);
        if (ownBox) return of(ownBox);
        // The first character in sight in the panel, which is the first of
        // the text on a text just opened.
        const width = panel?.clientWidth ?? 0;
        const height = panel?.clientHeight ?? 0;
        for (const glyph of view?.querySelectorAll(".kanji-glyph") ?? []) {
          const box = boxOf(glyph, origin);
          if (box && box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height) return of(box);
        }
        return null;
      }
      case "reading": {
        // The reading, as `keepClear` takes it; the glyph for a character
        // that is written with none.
        const readings = cells.flatMap((cell) =>
          [...cell.querySelectorAll(".furigana, .kanji-reading, .kaki-reading")].flatMap((el) => {
            const box = boxOf(el, origin);
            return box ? [box] : [];
          }),
        );
        // And the character it is the reading of, glyph and reading
        // together, for a balloon that finds no clear place beside the
        // reading alone (`near`; see "At the character" in `placeHint`).
        const glyph = glyphs();
        const reading = union(readings);
        if (!reading) return of(glyph);
        return { box: reading, chip: false, near: union(glyph ? [glyph, reading] : [reading]) ?? undefined };
      }
      case "pos": {
        const chip = overlay?.querySelector(".token-subtitle-pos");
        const box = chip && boxOf(chip, origin);
        return box ? of(shifted(box, pullback(overlay!)), true) : needsAnalysis() ? of(glyphs()) : null;
      }
      case "relation": {
        const label = overlay?.querySelector(".token-arrow-label");
        const box = label && boxOf(label, origin);
        return box ? of(box) : needsAnalysis() ? of(glyphs()) : null;
      }
      default:
        return of(glyphs());
    }
  }

  /** The chip at rest and the room its run takes unfolded, in the panel's
   * coordinates: the 品詞 pill with the pullback added back, and the row
   * widened to the right by the laid-out width of the domain and sense
   * (`.token-subtitle-semantics`, `left: 100%` of the row), which the slide
   * (a transform) and the fade (opacity) never change. Null with no overlay,
   * or a tag with no semantics to unfold. */
  function chipAtRest(origin: DOMRect): { chip: Box; run: Box } | null {
    const overlay = view?.querySelector(".token-inspector-overlay:not([data-leaving])");
    const rowEl = overlay?.querySelector(".token-subtitle-row");
    const chipEl = overlay?.querySelector(".token-subtitle-pos");
    const runEl = rowEl?.querySelector<HTMLElement>(".token-subtitle-semantics");
    const rowBox = rowEl && boxOf(rowEl, origin);
    const chipBox = chipEl && boxOf(chipEl, origin);
    if (!overlay || !rowBox || !chipBox || !runEl || runEl.offsetWidth === 0) return null;
    const dx = pullback(overlay);
    const row = shifted(rowBox, dx);
    return { chip: shifted(chipBox, dx), run: { ...row, right: row.right + runEl.offsetWidth } };
  }

  /** Where `placeHint` put the balloon for the chip at rest, which
   * `slideHint` slides from and back to. */
  type Rest = {
    left: number;
    top: number;
    w: number;
    h: number;
    side: Side;
    tailAt: number;
    chip: { chip: Box; run: Box } | null;
  };
  let rest: Rest | null = null;
  /** What `slideHint` last slid for — whether the run was out, and the
   * pullback — so that a style written in the overlay that changes neither
   * does not slide the balloon again. */
  let slidFor = "";

  const tailAt = (along: number, span: number) => Math.min(Math.max(along, 14), span - 14);

  /** **The balloon along its line, for the chip as it is now** (see "When
   * the chip unfolds"). `animate` for the unfolding itself; a placement that
   * lands while the run is out goes straight to the slid place.
   *
   * On the right of the chip, where the run unfolds into it, it steps out
   * to the run's end. If that would put it past the panel's edge — which
   * `placeHint` avoids, but a narrow panel can leave no better place — it
   * crosses to the chip's left, its tail turned to face the chip, if there
   * is room there; and if there is none on either side it stays where it is
   * and covers the pills, which is the least of the moves left: anything
   * else would take it off the line the reader is reading it on, or off the
   * panel. That crossing is not animated, as a card sliding over the very
   * pills it is getting out of the way of would cover them on its way. */
  function slideHint(animate: boolean): void {
    if (!rest || !panel) return;
    const overlay = view?.querySelector(".token-inspector-overlay:not([data-leaving])");
    const out = !!overlay?.classList.contains("token-semantics-shown");
    const dx = out && overlay ? pullback(overlay) : 0;
    slidFor = `${out}:${dx}`;
    let { left, side, tailAt: along } = rest;
    if (out && rest.chip) {
      const width = panel.clientWidth;
      const reach = TAIL + TAIL_GAP;
      const chip = shifted(rest.chip.chip, -dx);
      const run = shifted(rest.chip.run, -dx);
      if (rest.side === "right") {
        left = run.right + reach;
        if (left + rest.w > width - INSET) {
          const across = chip.left - reach - rest.w;
          if (across >= INSET) {
            left = across;
            side = "left";
            animate = false;
          } else {
            left = rest.left;
          }
        }
      } else {
        // Left of the chip, or above or below it: with the chip, so the tail
        // stays on it, as far as the panel allows.
        left = Math.min(Math.max(rest.left - dx, INSET), width - INSET - rest.w);
        if (rest.side !== "left") along = tailAt((chip.left + chip.right) / 2 - left, rest.w);
      }
    }
    if (animate) hint.dataset.slide = "";
    else delete hint.dataset.slide;
    hint.dataset.side = side;
    hint.style.left = `${left}px`;
    hint.style.setProperty("--edit-hint-tail-at", `${along}px`);
  }

  /** **Hugging the words.** `width: max-content` sizes the balloon to its
   * sentence laid out on one line, and `max-width` then wraps it — but the
   * box keeps the width it was capped at, so every wrapped balloon carried a
   * strip of blank card to the right of its longest line (9–12px at 18rem).
   * The words' own extent is measured off the line boxes, and the balloon
   * narrowed to it: the lines break where they already broke, since each is
   * no wider than the room it now has. Rounded up a pixel, so that a line
   * that fitted to the subpixel does not wrap again; and undone if it
   * wraps anyway. */
  function hug(): void {
    const range = document.createRange();
    range.selectNodeContents(hintText);
    const lines = [...range.getClientRects()];
    if (lines.length === 0) return;
    const start = hintText.getBoundingClientRect().left;
    // The line under the sentence is as wide as its pieces and the gaps
    // between them, whatever the flex line stretches it to — the pieces that
    // are shown: "Back" is hidden on step 1, and a hidden piece has no gap.
    const pieces = [...foot.children]
      .filter((el) => !(el as HTMLElement).hidden)
      .map((el) => el.getBoundingClientRect().width);
    const gap = parseFloat(getComputedStyle(foot).columnGap) || 0;
    const footWidth = pieces.reduce((sum, w) => sum + w, 0) + gap * (pieces.length - 1);
    const words = Math.max(...lines.map((r) => r.right - start), footWidth);
    const slack = Math.floor(hintText.getBoundingClientRect().width - Math.ceil(words + 1));
    if (slack <= 0) return;
    const { offsetWidth: before, offsetHeight: height } = hint;
    hint.style.width = `${before - slack}px`;
    if (hint.offsetHeight !== height) hint.style.removeProperty("width");
  }

  /** **Clear of an open menu, before anything else.** The balloon is laid
   * over the page, and what it may cover is argued above; a menu is not
   * among it. A menu that is up is what the reader is reading and choosing
   * from at that moment, and a balloon across it — the head step's balloon
   * laid over the relation menu still open from the step before, which is
   * what the reader reported — hides the rows they came to pick. So the
   * open menu (`.token-context-menu` in `<body>`, not on its way out) and
   * the gloss balloon it hangs under a row (`.token-menu-balloon`, not
   * hidden) are kept clear *harder* than the boxes `keepClear` lists: a
   * place that covers any of a menu is taken only when there is no place in
   * the panel that does not (`placeHint`). Each is padded by `MENU_CLEAR`,
   * so the two cards, both with shadows, do not touch.
   *
   * In the panel's coordinates, like everything else here, though a menu
   * is in `<body>` and fixed, and may hang off the panel: only the part
   * over the panel can meet the balloon, which never leaves it. */
  const MENU_CLEAR = 6;
  function menuBoxes(origin: DOMRect): Box[] {
    const boxes: Box[] = [];
    for (const el of document.body.querySelectorAll(
      ":scope > .token-context-menu:not([data-leaving]), :scope > .token-menu-balloon:not([hidden])",
    )) {
      const box = boxOf(el, origin);
      if (box) {
        boxes.push({
          left: box.left - MENU_CLEAR,
          top: box.top - MENU_CLEAR,
          right: box.right + MENU_CLEAR,
          bottom: box.bottom + MENU_CLEAR,
        });
      }
    }
    return boxes;
  }

  function placeHint(): void {
    if (hint.hidden || !panel || !view) return;
    const cells = [...view.querySelectorAll<HTMLElement>(".token-cell-selected")];
    const origin = panel.getBoundingClientRect();
    const aimed = targetOf(origin, cells);
    const target = aimed?.box ?? null;
    const width = panel.clientWidth;
    const height = panel.clientHeight;
    const visible =
      aimed !== null && target !== null && target.right > 0 && target.left < width && target.bottom > 0 && target.top < height;
    if (!visible) {
      if (!hint.contains(document.activeElement)) hint.dataset.adrift = "";
      syncPressed();
      return;
    }
    delete hint.dataset.adrift;
    syncPressed();
    // Placed without a slide: a balloon measured at the origin, or moved for
    // a scroll, must not be seen travelling there.
    delete hint.dataset.slide;
    const atRest = aimed?.chip ? chipAtRest(origin) : null;
    const avoid = keepClear(origin, cells, atRest !== null);
    const menus = menuBoxes(origin);
    const text = textBoxes(origin, cells);

    // Measured with the balloon put back at the origin, so that nothing of
    // its last place squeezes it, at the width the stylesheet allows or at a
    // narrower one written over it — and then hugged to its words.
    hint.style.left = "0px";
    hint.style.top = "0px";
    function measure(maxWidth: number | null): { w: number; h: number } {
      hint.style.removeProperty("width");
      if (maxWidth === null) hint.style.removeProperty("max-width");
      else hint.style.maxWidth = `min(18rem, ${maxWidth}px)`; // never past app.css's own cap
      hug();
      return { w: hint.offsetWidth, h: hint.offsetHeight };
    }
    const reach = TAIL + TAIL_GAP;

    /** A place for the balloon: on `side` of the target, with its tail on
     * it, or `"none"` — off it altogether, tail-less ("Off its target, when
     * nothing beside it is clear", below). `shift` is how far it was slid
     * along its edge from the place centred on the target, or, off it, how
     * far it is from the first choice. `aim` is the box its tail points at:
     * the step's target, or the character it belongs to (`near`). */
    type Candidate = {
      side: Side | "none";
      aim: Box;
      box: Box;
      fits: boolean;
      maxWidth: number | null;
      w: number;
      h: number;
      shift: number;
    };
    function candidate(side: Side, maxWidth: number | null, aim: Box): Candidate {
      const { w, h } = measure(maxWidth);
      const midX = (aim.left + aim.right) / 2;
      const midY = (aim.top + aim.bottom) / 2;
      const clampX = (x: number) => Math.min(Math.max(x, INSET), width - INSET - w);
      const clampY = (y: number) => Math.min(Math.max(y, INSET), height - INSET - h);
      let x: number;
      let y: number;
      let fits: boolean;
      if (side === "left" || side === "right") {
        x = side === "left" ? aim.left - reach - w : aim.right + reach;
        y = clampY(midY - h / 2);
        // On the chip's right only with room to step out past its run when
        // it unfolds (`slideHint`), so that the slide never has to cross.
        const slid = side === "right" && atRest ? atRest.run.right - atRest.chip.right : 0;
        fits = x >= INSET && x + slid + w <= width - INSET && h <= height - 2 * INSET;
      } else {
        x = clampX(midX - w / 2);
        y = side === "below" ? aim.bottom + reach : aim.top - reach - h;
        fits = y >= INSET && y + h <= height - INSET && w <= width - 2 * INSET;
      }
      return { side, aim, box: { left: x, top: y, right: x + w, bottom: y + h }, fits, maxWidth, w, h, shift: 0 };
    }
    const must = mustClear();
    const cost = (c: Candidate) => avoid.reduce((sum, b) => sum + overlap(c.box, b), 0);
    /** What it covers of the boxes this step and the next click on. */
    const hard = (c: Candidate) => avoid.reduce((sum, b) => sum + (must.has(b.kind) ? overlap(c.box, b) : 0), 0);
    const blocked = (c: Candidate) => menus.some((m) => overlap(c.box, m) > 0);
    const clear = (c: Candidate) => c.fits && !blocked(c) && cost(c) === 0;
    /** What it covers of the rest of the text (`textBoxes`): the soft cost,
     * weighed only between places that are otherwise equal. */
    const covers = (c: Candidate) => text.reduce((sum, b) => sum + overlap(c.box, b), 0);
    /** Of `pool`, in order of preference, the first that covers least of the
     * text — so the order above still decides between places that cover the
     * same, and decides everything where none covers any. */
    const leastText = (pool: Candidate[]) =>
      pool.reduce<{ c: Candidate; t: number } | undefined>((best, c) => {
        const t = covers(c);
        return !best || t < best.t ? { c, t } : best;
      }, undefined)?.c;

    /** Every place with its tail on `aim`, in the order argued above, and
     * the first of them that is clear, if any. */
    function beside(aim: Box): { candidates: Candidate[]; slid: Candidate[]; chosen: Candidate | undefined } {
      // At the full width first, on each of the four sides.
      const candidates = (["left", "right", "below", "above"] as const).map((side) => candidate(side, null, aim));
      let chosen = candidates.find((c) => clear(c) && covers(c) === 0);
      // **Narrower, beside the target.** In a narrow panel the full balloon
      // fits on no side of it without covering the chip or the label on the
      // arc below it — and the label is what the relation step tells the
      // reader to click. The run of panel beside the target is often still
      // wide enough for the sentence on more lines, so that is tried before
      // anything is covered, down to `NARROWEST`.
      if (!chosen) {
        for (const side of ["left", "right"] as const) {
          const room = side === "left" ? aim.left - reach - INSET : width - INSET - aim.right - reach;
          if (room < NARROWEST) continue;
          const c = candidate(side, room, aim);
          candidates.push(c);
          if (clear(c) && covers(c) === 0) {
            chosen = c;
            break;
          }
        }
      }
      // **Slid along its edge.** The places above are each centred on the
      // target, and the boxes to keep clear lie round it on every side: the
      // furigana to its right, the chip below it, a relation label beside it
      // on the arc. In the title line, where the overlay for 而 has its label
      // on the left and its chip below, every one of those places covered
      // something, and the least-covering of them — the old last resort — was
      // the one below, laid over the chip the next step asks the reader to
      // click. Yet a place of the same kind slid along the edge the tail comes
      // out of was free: the balloon beside the character, but higher, its
      // tail still on it. So every such place on every side, at either width,
      // is tried before anything is covered: up or down beside the target,
      // across above or below it, as far as the tail can still come out
      // between the rounded corners (`tailAt`, 14px in from each) and touch
      // some of the target — and at each, out from the target by up to
      // `GIVE`. In 2px steps; of those that fit the panel, the
      // one slid least that covers none of `keepClear`'s boxes and none of a
      // menu is taken — the nearest to where the balloon would have been.
      //
      // The same search is what clears an open menu: the balloon beside the
      // relation label, say, with the relation menu hung from that label, is
      // slid off the menu along its edge.
      const slid: Candidate[] = [];
      if (!chosen) {
        for (const base of [...candidates]) {
          const sideways = base.side === "left" || base.side === "right";
          const span = sideways ? base.h : base.w;
          // The range of the edge's start that keeps the tail's run,
          // [start + 14, start + span − 14], meeting the target's own run.
          const lo = (sideways ? aim.top : aim.left) - (span - 14);
          const hi = (sideways ? aim.bottom : aim.right) - 14;
          const room = sideways ? height : width;
          const from = Math.max(lo, INSET);
          const to = Math.min(hi, room - INSET - span);
          const home = sideways ? base.box.top : base.box.left;
          // Out from the target by up to `GIVE`, the tail then stopping that
          // much further from the ink (see `GIVE`).
          const out = { left: [-1, 0], right: [1, 0], below: [0, 1], above: [0, -1] }[base.side as Side];
          // The room the chip's run unfolds into, on its right (`candidate`).
          const unfold = base.side === "right" && atRest ? atRest.run.right - atRest.chip.right : 0;
          for (let at = from; at <= to; at += 2) {
            const d = at - home;
            const along = sideways
              ? { ...base.box, top: at, bottom: at + base.h }
              : { ...base.box, left: at, right: at + base.w };
            for (let give = 0; give <= GIVE; give += 2) {
              const [dx, dy] = [out[0] * give, out[1] * give];
              const box = {
                left: along.left + dx,
                right: along.right + dx,
                top: along.top + dy,
                bottom: along.bottom + dy,
              };
              // Slid along the edge, the side's own test of the other axis
              // still holds, but for the give, which is checked again; the
              // run along the edge is inside the panel by `from` and `to`.
              const inside =
                box.left >= INSET && box.right + unfold <= width - INSET && box.top >= INSET && box.bottom <= height - INSET;
              // A pixel of give is worth some five of slide: the tail standing
              // off the ink shows more than the card sitting higher.
              const c: Candidate = { ...base, box, shift: Math.abs(d) + give * 5 };
              if (c.fits && inside) slid.push(c);
            }
          }
        }
        // Of the clear places, the one that covers least of the text, and of
        // those the first in the order above: the centred places in their
        // order of sides, then the slid ones, least slid first.
        const bySlide = slid.filter(clear).sort((a, b) => a.shift - b.shift);
        chosen = leastText([...candidates.filter(clear), ...bySlide]);
      }
      return { candidates, slid, chosen };
    }
    const first = beside(aimed.box);
    let { chosen } = first;
    const candidates = [...first.candidates];
    const slid = [...first.slid];
    // **At the character, when its reading is fenced in.** The reading
    // step points at the furigana, which sits in the narrow strip between
    // the glyph and the next column, with the chip below the glyph and the
    // relation label often beside it: in the title line, at the panel's top
    // right, no place with the tail on 而's furigana alone was clear. The
    // furigana is a part of the character, and the character as a whole —
    // glyph and reading together (`near`) — has the glyph's free side to
    // offer; a tail on that is still on what the sentence is about, which
    // is better than none. Tried only after the target itself, and before
    // the balloon is cast off without a tail.
    if (!chosen && aimed.near) {
      const second = beside(aimed.near);
      chosen = second.chosen;
      candidates.push(...second.candidates);
      slid.push(...second.slid);
    }
    // **Off its target, when nothing beside it is clear.** If no place with
    // the tail on the target is clear — a menu hung over the target and
    // everything round it, or an analysis whose chip, labels and readings
    // fence the character in on a short panel — the balloon still does not
    // go over a menu, nor over anything `keepClear` lists: it goes to the
    // place in the panel nearest its first choice that is clear of both, at
    // the full width, and without its tail (`data-side="none"`, the tail's
    // size zeroed), since a tail pointing out of a balloon at nothing would
    // be pointing at whatever happened to be there. A balloon a little way
    // off, which the reader can still read and close, costs them less than
    // one over a control the guide sends them to, which they cannot use at
    // all — and it is the steps *after* this one that make that so: the
    // chip that the reading step's balloon was laid over is clicked two
    // steps on, at the part-of-speech step. Searched on an 8px grid, fine
    // enough for a card some 200px wide.
    // **The undo step keeps its tail, beside the buttons.** "Click this
    // button" means nothing pointing nowhere, and the buttons sit in the
    // panel's margin, where what a balloon beside them can cover is at most
    // a strip of a label or a reading that this step does not send the
    // reader to (the reader asked for the tail over that, and for the
    // balloon to stay next to the button "without worrying about overlap").
    // So here the first place with its tail on the buttons that fits the
    // panel and clears any menu is taken, in the order of the sides and
    // least slid, whatever it covers, before any place off them is looked
    // for.
    if (!chosen && stage === "undo") {
      chosen = [...candidates, ...slid]
        .filter((c) => c.fits && !blocked(c))
        .reduce<Candidate | undefined>((best, c) => (!best || c.shift < best.shift ? c : best), undefined);
    }
    const adrift: Candidate[] = [];
    if (!chosen) {
      const { w, h } = measure(null);
      const want = candidates[0].box;
      for (let y = INSET; y + h <= height - INSET; y += 8) {
        for (let x = INSET; x + w <= width - INSET; x += 8) {
          const c: Candidate = {
            side: "none",
            aim: aimed.box,
            box: { left: x, top: y, right: x + w, bottom: y + h },
            fits: true,
            maxWidth: null,
            w,
            h,
            // How far off its first choice, for the nearest below.
            shift: Math.hypot(x - want.left, y - want.top),
          };
          if (!blocked(c)) adrift.push(c);
        }
      }
      chosen = adrift
        .filter((c) => cost(c) === 0)
        .reduce<Candidate | undefined>((best, c) => (!best || c.shift < best.shift ? c : best), undefined);
    }
    // **Clear of what is to be clicked now.** With no place in the panel
    // clear of all of `keepClear`'s boxes — a short panel, a character in
    // its corner — they are no longer all equal: what this step and the
    // next send the reader to (`mustClear`) is kept clear, and of the rest
    // as little covered as can be. A place with its tail on the target
    // first, as a balloon that must cover something may as well still say
    // what it is about; then one off it. Of each, the one that covers least
    // of the rest, and then the one slid least, or nearest.
    const firm = (pool: Candidate[]) =>
      pool
        .filter((c) => c.fits && !blocked(c) && hard(c) === 0)
        .reduce<Candidate | undefined>((best, c) => {
          if (!best) return c;
          const [cc, bc] = [cost(c), cost(best)];
          if (cc !== bc) return cc < bc ? c : best;
          const [ct, bt] = [covers(c), covers(best)];
          if (ct !== bt) return ct < bt ? c : best;
          return c.shift < best.shift ? c : best;
        }, undefined);
    chosen ??= firm([...candidates, ...slid]) ?? firm(adrift);
    // **With nothing clear anywhere, the place that covers least**, of
    // those that fit the panel and clear any menu: a place with its tail on
    // the target, slid or not, before one off it, as a balloon that must
    // cover something may as well still say what it is about; among those,
    // the least covered of what is to be clicked, then of the rest, and then
    // the least slid. Only with nothing in the
    // panel clear of the menu may it cover the menu, and then the place
    // that covers least of it.
    if (!chosen) {
      const least = (pool: Candidate[]) =>
        pool
          .filter((c) => c.fits && !blocked(c))
          .reduce<Candidate | undefined>((best, c) => {
            if (!best) return c;
            const [ch, bh] = [hard(c), hard(best)];
            if (ch !== bh) return ch < bh ? c : best;
            const [cc, bc] = [cost(c), cost(best)];
            if (cc !== bc) return cc < bc ? c : best;
            return c.shift < best.shift ? c : best;
          }, undefined);
      chosen = least([...candidates, ...slid]) ?? least(adrift);
    }
    if (!chosen) {
      const fitting = candidates.filter((c) => c.fits);
      const worst = (c: Candidate) => cost(c) + hard(c) * 100 + menus.reduce((sum, m) => sum + overlap(c.box, m) * 1000, 0);
      chosen = (fitting.length > 0 ? fitting : candidates).reduce((best, c) => (worst(c) < worst(best) ? c : best));
    }
    const { w, h } = measure(chosen.maxWidth);
    const left = Math.min(Math.max(chosen.box.left, INSET), width - INSET - w);
    const top = Math.min(Math.max(chosen.box.top, INSET), height - INSET - h);
    hint.dataset.side = chosen.side;
    hint.style.left = `${left}px`;
    hint.style.top = `${top}px`;
    if (chosen.side === "none") {
      // No tail, and nothing to slide with the chip: it is not beside it.
      hint.style.setProperty("--edit-hint-tail-size", "0px");
      rest = null;
      return;
    }
    hint.style.removeProperty("--edit-hint-tail-size");
    // The tail, along the edge it comes out of, at the target's middle —
    // kept off the rounded corners, where it would come out of nothing.
    const sideways = chosen.side === "left" || chosen.side === "right";
    const midX = (chosen.aim.left + chosen.aim.right) / 2;
    const midY = (chosen.aim.top + chosen.aim.bottom) / 2;
    const along = tailAt(sideways ? midY - top : midX - left, sideways ? h : w);
    hint.style.setProperty("--edit-hint-tail-at", `${along}px`);
    rest = { left, top, w, h, side: chosen.side, tailAt: along, chip: atRest };
    slideHint(false);
  }

  /** What the balloon is placed for: the stage, the selected cells and the
   * overlay drawn for them, by identity. A subtree change that leaves all
   * three as they were — the chip unfolding, a hover's class — has nothing
   * to move the balloon for. */
  type PlacementKey = { stage: Stage | null; cells: Element[]; overlay: Element | null };
  let placedFor: PlacementKey | null = null;

  function placementKey(): PlacementKey {
    return {
      stage,
      cells: view ? [...view.querySelectorAll(".token-cell-selected")] : [],
      overlay: view?.querySelector(".token-inspector-overlay:not([data-leaving])") ?? null,
    };
  }

  function sameKey(a: PlacementKey | null, b: PlacementKey): boolean {
    return (
      a !== null &&
      a.stage === b.stage &&
      a.overlay === b.overlay &&
      a.cells.length === b.cells.length &&
      a.cells.every((cell, i) => cell === b.cells[i])
    );
  }

  let placeQueued = false;
  let placeForced = false;
  /** `force` for whatever moves the page or the balloon's words; without it,
   * only a change of `placementKey` places it again. */
  function queuePlace(force = false): void {
    if (hint.hidden) return;
    placeForced ||= force;
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      // The analysis coming up (or going) under a balloon that asks for it
      // changes what it says, and with that its size: said again, and placed.
      if (textKey() !== shownKey) {
        syncHint();
        return;
      }
      const key = placementKey();
      const due = placeForced || !sameKey(placedFor, key);
      placeForced = false;
      if (due) {
        placedFor = key;
        placeHint();
        return;
      }
      // Not placed again — but the run may have come out or gone back.
      const overlay = key.overlay;
      const out = !!overlay?.classList.contains("token-semantics-shown");
      if (`${out}:${out && overlay ? pullback(overlay) : 0}` !== slidFor) slideHint(true);
    });
  }
  const placeAgain = () => queuePlace(true);
  /** Settling in the text, but not in the chip's row: the pills' slide and
   * fade and the row's pullback are the chip unfolding. */
  const settled = (event: Event) => {
    if (event.target instanceof Element && event.target.closest(".token-subtitle-row")) return;
    queuePlace(true);
  };
  if (view) {
    new MutationObserver(() => {
      // Step 2 is done when an analysis is drawn, which is an overlay built
      // in this subtree — by a right click, a double click, or Enter, and in
      // the same task as the selection or a later one. A *new* overlay, not
      // the one that was up when the step began (`overlayAtStart`): "Back"
      // to this step over the analysis it asks for must not go straight on.
      if (!retired && stage === "analyse" && analysisUp() && liveOverlay() !== overlayAtStart) {
        advance(true);
        return;
      }
      queuePlace();
    }).observe(view, {
      childList: true,
      subtree: true,
      attributes: true,
      // `style` for the pullback, which is written onto the overlay as the
      // run comes out (`pullBackSemantics`).
      attributeFilter: ["class", "style"],
    });
    // **And the gesture itself, over an analysis already up.** "Back" to
    // step 2 leaves the analysis it asks for on the page, and a right click
    // on a character whose analysis is up draws nothing new — the overlay is
    // the one there was, and the observer above, rightly, does not take it
    // for the step done. A reader doing what the balloon says would then be
    // left with a balloon that did not answer. So the step's own gestures on
    // a character — a right click, a double click, Enter on one with the
    // focus — end it too, if the analysis is up once the gesture has been
    // acted on: the counterpart of picking the row already current in a menu.
    // Heard on `window` in the capture phase, ahead of anything in
    // tokenInspector.ts that might stop the event on its way, and looked at
    // a task later, when those listeners have done their work.
    const askedForAnalysis = (event: Event) => {
      if (retired || stage !== "analyse") return;
      const target = event.target;
      if (!(target instanceof Element) || !view.contains(target) || !target.closest(".kanji-cell")) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter") return;
      setTimeout(() => {
        if (!retired && stage === "analyse" && analysisUp()) advance(true);
      }, 0);
    };
    for (const type of ["contextmenu", "dblclick", "keydown"]) {
      window.addEventListener(type, askedForAnalysis, { capture: true });
    }
    view.addEventListener("scroll", placeAgain, { passive: true });
    view.addEventListener("transitionend", settled);
    view.addEventListener("animationend", settled);
  }
  window.addEventListener("resize", placeAgain);
  // A move of the focus is no mutation, and step 1 points at the character
  // with the focus (`targetOf`): told here, and forced on that step only,
  // so that a focus that changes nothing the balloon points at leaves it
  // where it is.
  document.addEventListener("focusin", () => queuePlace(stage === "select"));

  onLiveSelection(() => {
    if (retired) return;
    // Step 1 is done by picking a character out, however it was done.
    if (stage === "select") advance(true);
  });
  // The last step is done by undoing something. `onHistoryChange` fires for
  // edits, undos and redos alike, and an undo is the one that leaves a step
  // to redo — the edits the earlier steps lead to are the reader exploring,
  // and no longer retire the hints as the first edit used to.
  onHistoryChange(() => {
    if (!retired && stage === "undo" && canRedo()) advance(true);
    // And the undo step's sentence follows whether there is anything to undo
    // (`textKey`), so an edit made under it turns "once you have made an
    // edit" into "your last edit".
    else if (!retired && textKey() !== shownKey) syncHint();
  });
  // **On `window`, in the capture phase**, not on the button. A press
  // outside an open menu puts the menu away and then swallows the click that
  // follows (`dismissedMenu` in `setupTokenContextMenu`), so that a click
  // meant only to close the menu does nothing else; on the "?" that ate the
  // very click that asks for the hints about that menu, and the reader had
  // to press twice. This runs before that listener, on `document`, does.
  //
  // **The balloon's own buttons the same way, and for the same reason.** The
  // balloon now stands beside an open menu rather than under it (`menuBoxes`),
  // and a reader who reads it there and presses "Next", "Back", the guide or
  // the close with the menu still open would have that press spent on
  // putting the menu away. So their clicks are taken here too, before the
  // swallow, and not on the buttons themselves, where the two would both act
  // on a click that was not swallowed. A click from the keyboard (Enter or
  // Space on the button) comes this way as well.
  window.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (hintsButton.contains(target)) {
        if (!hintsButton.disabled) toggleHints(event);
        return;
      }
      if (hint.hidden) return;
      if (nextButton.contains(target)) advance(false);
      else if (backButton.contains(target)) goBack();
      else if (helpButton.contains(target)) openHelpModal();
      else if (closeButton.contains(target)) retire();
    },
    { capture: true },
  );

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
